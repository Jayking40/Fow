#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, Address, Env, Map, Vec,
};

// ── Scoring constants (×100 fixed-point) ──────────────────────────────────────

const MAX_SCORE: i64 = 100_00;
const MIN_SCORE: i64 = 0;

/// Neutral-low prior for new/probation subjects (40.00)
const PRIOR_SCORE: i64 = 40_00;

/// Number of deliveries before full weight is applied (probation window)
const PROBATION_VOLUME: u32 = 5;

/// Epoch length in seconds (7 days). Scores are bucketed per epoch.
const EPOCH_SECS: u64 = 7 * 24 * 3600;

/// Number of epochs kept in the ring buffer (≈ 26 weeks)
const RING_SIZE: u32 = 26;

/// Decay shift divisor: score weight halves every 7 epochs (≈ 46-day half-life).
const DECAY_HALF_LIFE_EPOCHS: i64 = 7;

/// Per-counterparty contribution cap: after this many interactions the marginal
/// weight drops to 1/4 of the base weight (diminishing returns).
const COUNTERPARTY_CAP: u32 = 5;

/// Velocity spike threshold: more than this many signals in one epoch triggers anomaly event.
const VELOCITY_SPIKE_THRESHOLD: u32 = 20;

/// Signals are in score-point units ×100 (i.e. 500 = +5.00 score points).
/// These are added directly to the weighted accumulator.
const SIGNAL_POSITIVE: i64 = 500;      // +5.00 pts per clean delivery
const SIGNAL_MINOR_ISSUE: i64 = 100;   // +1.00 pt
const SIGNAL_DISPUTE_MINOR: i64 = -800;  // -8.00 pts
const SIGNAL_DISPUTE_MAJOR: i64 = -2000; // -20.00 pts

// ── Types ──────────────────────────────────────────────────────────────────────

/// Outcome of a completed delivery workflow, as reported by the coordinator.
#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeliveryOutcome {
    /// On-time, no excursion, no dispute — full positive signal.
    Clean,
    /// Late or minor excursion, no dispute — reduced positive signal.
    MinorIssue,
    /// Dispute resolved against this subject — minor negative signal.
    DisputeAgainstMinor,
    /// Dispute resolved against this subject — major negative signal.
    DisputeAgainstMajor,
}

/// One epoch's accumulated signal data.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EpochBucket {
    pub epoch_index: u32,
    /// Sum of weighted signals in this epoch (×100).
    pub signal_sum: i64,
    /// Total weight applied in this epoch.
    pub weight_sum: i64,
    /// Number of delivery events in this epoch (for velocity check).
    pub event_count: u32,
}

/// Compact subject state — O(1) storage regardless of history length.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SubjectState {
    /// Identity credential subject (from identity contract).
    pub identity_subject: Address,
    /// Ring buffer of epoch buckets (max RING_SIZE entries).
    pub epochs: Vec<EpochBucket>,
    /// Rolled-up tail: weighted average of all epochs older than the ring.
    pub tail_score: i64,
    /// Total delivery count (for probation logic).
    pub total_deliveries: u32,
    /// Per-counterparty interaction counts (for diminishing weight).
    pub counterparty_counts: Map<Address, u32>,
    /// Current materialized score (×100). Updated on every signal.
    pub score: i64,
    /// Confidence: 0–100_00, grows with sample size, shrinks with decay.
    pub confidence: i64,
    /// Ledger timestamp of last signal.
    pub last_updated: u64,
}

/// Public score view returned by get_score.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScoreView {
    /// Materialized score ×100 (0–100_00). 0 = worst, 100_00 = best.
    pub score: i64,
    /// Confidence ×100 (0–100_00). Low confidence → treat score as near-prior.
    pub confidence: i64,
    /// Total delivery events contributing to this score.
    pub sample_size: u32,
    /// Ledger timestamp of last score update.
    pub last_updated: u64,
}

/// An admin-authored score adjustment record (appeal/incident-review outcome).
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdjustmentRecord {
    pub id: u32,
    /// Delta applied to score ×100 (may be negative).
    pub delta: i64,
    /// Free-form reason string (max 64 bytes enforced off-chain).
    pub reason: soroban_sdk::String,
    pub applied_by: Address,
    pub timestamp: u64,
}

#[contracterror]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum Error {
    NotAuthorized = 403,
    SubjectNotFound = 404,
    AlreadyInitialized = 405,
    NotInitialized = 406,
    ContractPaused = 407,
    MigrationAlreadyApplied = 408,
    InvalidCaller = 409,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DataKey {
    Admin,
    /// Authorized invoker addresses (coordinator, delivery contracts).
    Invoker(Address),
    Subject(Address),
    /// Adjustment log for a subject.
    Adjustments(Address),
    Paused,
}

// ── Contract ───────────────────────────────────────────────────────────────────

#[contract]
pub struct ReputationContract;

#[contractimpl]
impl ReputationContract {
    pub fn __constructor(env: Env, admin: Address) {
        admin.require_auth();
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        events::emit_initialized(&env, &admin);
    }

    // ── Admin: invoker management ──────────────────────────────────────────────

    /// Register an authorized invoker (coordinator or delivery contract address).
    pub fn add_invoker(env: Env, invoker: Address) -> Result<(), Error> {
        Self::require_admin(&env)?;
        env.storage()
            .instance()
            .set(&DataKey::Invoker(invoker.clone()), &true);
        events::emit_invoker_added(&env, &invoker);
        Ok(())
    }

    pub fn remove_invoker(env: Env, invoker: Address) -> Result<(), Error> {
        Self::require_admin(&env)?;
        env.storage()
            .instance()
            .remove(&DataKey::Invoker(invoker.clone()));
        Ok(())
    }

    pub fn is_invoker(env: Env, invoker: Address) -> bool {
        env.storage()
            .instance()
            .get::<_, bool>(&DataKey::Invoker(invoker))
            .unwrap_or(false)
    }

    // ── Subject registration ───────────────────────────────────────────────────

    /// Register a new identity-bound subject. Starts at neutral-low prior with
    /// zero confidence (probation). Can only be called by an authorized invoker.
    pub fn register_subject(
        env: Env,
        caller: Address,
        identity_subject: Address,
    ) -> Result<(), Error> {
        caller.require_auth();
        Self::require_invoker(&env, &caller)?;
        Self::require_not_paused(&env)?;

        if env
            .storage()
            .persistent()
            .has(&DataKey::Subject(identity_subject.clone()))
        {
            return Ok(()); // idempotent
        }

        let state = SubjectState {
            identity_subject: identity_subject.clone(),
            epochs: Vec::new(&env),
            tail_score: PRIOR_SCORE,
            total_deliveries: 0,
            counterparty_counts: Map::new(&env),
            score: PRIOR_SCORE,
            confidence: 0,
            last_updated: env.ledger().timestamp(),
        };
        env.storage()
            .persistent()
            .set(&DataKey::Subject(identity_subject), &state);
        Ok(())
    }

    // ── Core mutation: record_outcome ──────────────────────────────────────────

    /// Record a delivery outcome for a subject. ONLY callable by a registered
    /// invoker (coordinator/delivery contract). This is the sole path that
    /// mutates scores — no free-form rating entrypoint exists.
    ///
    /// `counterparty` is the other party in the delivery (hospital or rider),
    /// used for per-counterparty diminishing weight.
    pub fn record_outcome(
        env: Env,
        caller: Address,
        subject: Address,
        counterparty: Address,
        outcome: DeliveryOutcome,
    ) -> Result<ScoreView, Error> {
        caller.require_auth();
        Self::require_invoker(&env, &caller)?;
        Self::require_not_paused(&env)?;

        let mut state: SubjectState = env
            .storage()
            .persistent()
            .get(&DataKey::Subject(subject.clone()))
            .ok_or(Error::SubjectNotFound)?;

        let now = env.ledger().timestamp();
        let epoch_index = (now / EPOCH_SECS) as u32;

        // Per-counterparty diminishing weight: 4 after cap, 1 before (integer ratio)
        let cp_count = state
            .counterparty_counts
            .get(counterparty.clone())
            .unwrap_or(0);
        // weight_num / weight_den represents the fractional weight
        let (weight_num, weight_den): (i64, i64) = if cp_count < COUNTERPARTY_CAP {
            (4, 4) // full weight
        } else {
            (1, 4) // 1/4 weight
        };
        state
            .counterparty_counts
            .set(counterparty.clone(), cp_count + 1);

        // Probation: first PROBATION_VOLUME deliveries earn at half weight
        let (prob_num, prob_den): (i64, i64) = if state.total_deliveries < PROBATION_VOLUME {
            (1, 2)
        } else {
            (1, 1)
        };

        let base_signal: i64 = match outcome {
            DeliveryOutcome::Clean => SIGNAL_POSITIVE,
            DeliveryOutcome::MinorIssue => SIGNAL_MINOR_ISSUE,
            DeliveryOutcome::DisputeAgainstMinor => SIGNAL_DISPUTE_MINOR,
            DeliveryOutcome::DisputeAgainstMajor => SIGNAL_DISPUTE_MAJOR,
        };

        // Apply both weight fractions to signal and accumulator weight
        let effective_signal = base_signal * weight_num / weight_den * prob_num / prob_den;
        // weight stored as 4 (full) or 1 (capped), scaled by probation
        let effective_weight = weight_num * prob_num / (weight_den * prob_den).max(1);

        state.total_deliveries += 1;

        // Upsert epoch bucket in ring buffer
        let bucket_idx = Self::find_or_create_epoch(&env, &mut state, epoch_index);
        let mut bucket = state.epochs.get(bucket_idx).unwrap();
        bucket.signal_sum += effective_signal;
        bucket.weight_sum += effective_weight;
        bucket.event_count += 1;
        let event_count = bucket.event_count;
        state.epochs.set(bucket_idx, bucket);

        // Velocity spike detection
        if event_count > VELOCITY_SPIKE_THRESHOLD {
            events::emit_anomaly(&env, &subject, &counterparty, epoch_index, event_count);
        }

        // Recompute materialized score
        Self::recompute_score(&env, &mut state, now);

        state.last_updated = now;
        env.storage()
            .persistent()
            .set(&DataKey::Subject(subject.clone()), &state);

        let view = ScoreView {
            score: state.score,
            confidence: state.confidence,
            sample_size: state.total_deliveries,
            last_updated: now,
        };

        events::emit_score_updated(&env, &subject, &view);
        Ok(view)
    }

    // ── Admin: evented adjustment (appeal / incident-review) ──────────────────

    /// Apply a reasoned score adjustment after an incident review. Every
    /// adjustment is a visible, evented, immutable record — admin cannot
    /// silently edit scores.
    pub fn apply_adjustment(
        env: Env,
        subject: Address,
        delta: i64,
        reason: soroban_sdk::String,
    ) -> Result<ScoreView, Error> {
        Self::require_admin(&env)?;
        Self::require_not_paused(&env)?;

        let mut state: SubjectState = env
            .storage()
            .persistent()
            .get(&DataKey::Subject(subject.clone()))
            .ok_or(Error::SubjectNotFound)?;

        let admin = Self::get_admin_addr(&env)?;
        let now = env.ledger().timestamp();

        // Load existing adjustments
        let mut adjustments: Vec<AdjustmentRecord> = env
            .storage()
            .persistent()
            .get(&DataKey::Adjustments(subject.clone()))
            .unwrap_or(Vec::new(&env));

        let id = adjustments.len();
        let record = AdjustmentRecord {
            id,
            delta,
            reason: reason.clone(),
            applied_by: admin.clone(),
            timestamp: now,
        };
        adjustments.push_back(record.clone());
        env.storage()
            .persistent()
            .set(&DataKey::Adjustments(subject.clone()), &adjustments);

        // Apply delta with clamping
        state.score = (state.score + delta).clamp(MIN_SCORE, MAX_SCORE);
        state.last_updated = now;
        env.storage()
            .persistent()
            .set(&DataKey::Subject(subject.clone()), &state);

        let view = ScoreView {
            score: state.score,
            confidence: state.confidence,
            sample_size: state.total_deliveries,
            last_updated: now,
        };

        events::emit_adjustment_applied(&env, &subject, &record);
        events::emit_score_updated(&env, &subject, &view);
        Ok(view)
    }

    // ── Read API ───────────────────────────────────────────────────────────────

    /// O(1) score read. Returns None if subject not registered.
    pub fn get_score(env: Env, subject: Address) -> Option<ScoreView> {
        let state: SubjectState = env
            .storage()
            .persistent()
            .get(&DataKey::Subject(subject))?;
        Some(ScoreView {
            score: state.score,
            confidence: state.confidence,
            sample_size: state.total_deliveries,
            last_updated: state.last_updated,
        })
    }

    /// Return the full adjustment log for a subject (audit trail).
    pub fn get_adjustments(env: Env, subject: Address) -> Vec<AdjustmentRecord> {
        env.storage()
            .persistent()
            .get(&DataKey::Adjustments(subject))
            .unwrap_or(Vec::new(&env))
    }

    // ── Pause ──────────────────────────────────────────────────────────────────

    pub fn pause(env: Env) -> Result<(), Error> {
        Self::require_admin(&env)?;
        env.storage().instance().set(&DataKey::Paused, &true);
        Ok(())
    }

    pub fn unpause(env: Env) -> Result<(), Error> {
        Self::require_admin(&env)?;
        env.storage().instance().set(&DataKey::Paused, &false);
        Ok(())
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    // ── Upgrade ────────────────────────────────────────────────────────────────

    pub fn upgrade(env: Env, new_wasm_hash: soroban_sdk::BytesN<32>) -> Result<(), Error> {
        Self::require_admin(&env)?;
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    pub fn version(_env: Env) -> u32 {
        CONTRACT_VERSION
    }

    // ── Internal helpers ───────────────────────────────────────────────────────

    fn require_admin(env: &Env) -> Result<(), Error> {
        let admin = Self::get_admin_addr(env)?;
        admin.require_auth();
        Ok(())
    }

    fn get_admin_addr(env: &Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)
    }

    fn require_invoker(env: &Env, caller: &Address) -> Result<(), Error> {
        let is_auth: bool = env
            .storage()
            .instance()
            .get(&DataKey::Invoker(caller.clone()))
            .unwrap_or(false);
        if !is_auth {
            return Err(Error::InvalidCaller);
        }
        Ok(())
    }

    fn require_not_paused(env: &Env) -> Result<(), Error> {
        if env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
        {
            return Err(Error::ContractPaused);
        }
        Ok(())
    }

    /// Find the bucket for `epoch_index` in the ring buffer, or create it
    /// (evicting the oldest bucket into the tail when the ring is full).
    fn find_or_create_epoch(_env: &Env, state: &mut SubjectState, epoch_index: u32) -> u32 {
        // Search for existing bucket
        for i in 0..state.epochs.len() {
            if state.epochs.get(i).unwrap().epoch_index == epoch_index {
                return i;
            }
        }

        // Not found — create new bucket
        let new_bucket = EpochBucket {
            epoch_index,
            signal_sum: 0,
            weight_sum: 0,
            event_count: 0,
        };

        if state.epochs.len() < RING_SIZE {
            state.epochs.push_back(new_bucket);
            return state.epochs.len() - 1;
        }

        // Ring full: evict oldest (lowest epoch_index) into tail
        let mut oldest_idx: u32 = 0;
        let mut oldest_epoch: u32 = state.epochs.get(0).unwrap().epoch_index;
        for i in 1..state.epochs.len() {
            let e = state.epochs.get(i).unwrap().epoch_index;
            if e < oldest_epoch {
                oldest_epoch = e;
                oldest_idx = i;
            }
        }

        // Roll evicted bucket into tail (exponential moving average)
        let evicted = state.epochs.get(oldest_idx).unwrap();
        if evicted.weight_sum > 0 {
            let evicted_score = PRIOR_SCORE
                + evicted.signal_sum / evicted.weight_sum.max(1);
            // Blend into tail (exponential moving average, weight 1:3)
            state.tail_score = (state.tail_score * 3 + evicted_score) / 4;
        }

        state.epochs.set(oldest_idx, new_bucket);
        oldest_idx
    }

    /// Recompute the materialized score from the ring buffer + tail.
    /// Applies epoch-based decay: each epoch older than the current one
    /// contributes with exponentially reduced weight.
    fn recompute_score(_env: &Env, state: &mut SubjectState, now: u64) {
        let current_epoch = (now / EPOCH_SECS) as u32;

        let mut weighted_signal_sum: i64 = 0;
        let mut total_weight: i64 = 0;

        for i in 0..state.epochs.len() {
            let bucket = state.epochs.get(i).unwrap();
            if bucket.weight_sum == 0 {
                continue;
            }
            let age_epochs = current_epoch.saturating_sub(bucket.epoch_index) as i64;
            // Decay: bucket weight halves every DECAY_HALF_LIFE_EPOCHS epochs
            let decay_shift = (age_epochs / DECAY_HALF_LIFE_EPOCHS).min(10) as u32;
            let epoch_weight = (bucket.weight_sum >> decay_shift).max(1);

            // Weighted contribution: bucket's average signal × decayed weight
            // bucket.signal_sum / bucket.weight_sum = average signal per unit weight
            // Then multiply by epoch_weight to blend across epochs
            weighted_signal_sum += (bucket.signal_sum / bucket.weight_sum.max(1)) * epoch_weight;
            total_weight += epoch_weight;
        }

        // Blend tail into the weighted sum (tail counts as 1 unit of weight)
        let tail_signal = state.tail_score - PRIOR_SCORE;
        weighted_signal_sum += tail_signal;
        total_weight += 1;

        // Score = PRIOR + average signal across all epochs.
        // Signals are already in ×100 score-point units; divide by total_weight
        // to get the per-delivery average, then add to prior.
        let raw_score = if total_weight > 0 {
            PRIOR_SCORE + weighted_signal_sum / total_weight.max(1)
        } else {
            PRIOR_SCORE
        };

        state.score = raw_score.clamp(MIN_SCORE, MAX_SCORE);

        // Confidence: grows with sample size, capped at 100_00
        // confidence = min(total_deliveries × 500, 100_00)
        state.confidence = ((state.total_deliveries as i64) * 500).min(MAX_SCORE);
    }
}

mod events;

#[cfg(test)]
mod test;

pub const CONTRACT_VERSION: u32 = 2;
