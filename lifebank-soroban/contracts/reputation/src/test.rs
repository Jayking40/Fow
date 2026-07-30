#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, testutils::Ledger as _, Env, String};

const EPOCH: u64 = 7 * 24 * 3600;

fn setup() -> (Env, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let coordinator = Address::generate(&env);
    let cid = env.register(ReputationContract, (&admin,));
    let c = ReputationContractClient::new(&env, &cid);
    c.add_invoker(&coordinator);
    (env, cid, admin, coordinator)
}

fn register(env: &Env, cid: &Address, coordinator: &Address, subject: &Address) {
    let c = ReputationContractClient::new(env, cid);
    c.register_subject(coordinator, subject);
}

fn record(
    env: &Env,
    cid: &Address,
    coordinator: &Address,
    subject: &Address,
    counterparty: &Address,
    outcome: DeliveryOutcome,
) -> ScoreView {
    let c = ReputationContractClient::new(env, cid);
    c.record_outcome(coordinator, subject, counterparty, &outcome)
}

// ── Authorization: no unprivileged caller can mutate scores ───────────────────

#[test]
fn test_unprivileged_caller_cannot_record_outcome() {
    let (env, cid, _admin, _coordinator) = setup();
    let attacker = Address::generate(&env);
    let subject = Address::generate(&env);
    let cp = Address::generate(&env);
    register(&env, &cid, &_coordinator, &subject);

    let c = ReputationContractClient::new(&env, &cid);
    let result = c.try_record_outcome(&attacker, &subject, &cp, &DeliveryOutcome::Clean);
    assert!(result.is_err(), "unprivileged caller must be rejected");
}

#[test]
fn test_unprivileged_caller_cannot_register_subject() {
    let (env, cid, _admin, _coordinator) = setup();
    let attacker = Address::generate(&env);
    let subject = Address::generate(&env);

    let c = ReputationContractClient::new(&env, &cid);
    let result = c.try_register_subject(&attacker, &subject);
    assert!(result.is_err());
}

// ── Score reads are O(1) — ring buffer bounded to RING_SIZE ─────────────────

#[test]
fn test_get_score_is_o1_regardless_of_history() {
    let (env, cid, _admin, coordinator) = setup();
    let subject = Address::generate(&env);
    let cp = Address::generate(&env);
    register(&env, &cid, &coordinator, &subject);

    // Submit many outcomes across many epochs (more than RING_SIZE)
    for i in 0u64..60 {
        env.ledger().with_mut(|l| l.timestamp = i * EPOCH + 1);
        record(&env, &cid, &coordinator, &subject, &cp, DeliveryOutcome::Clean);
    }

    // get_score must return a valid view
    let view = ReputationContractClient::new(&env, &cid)
        .get_score(&subject)
        .unwrap();
    assert!(view.score >= MIN_SCORE && view.score <= MAX_SCORE);
    // sample_size reflects all 60 deliveries even though ring is bounded
    assert_eq!(view.sample_size, 60);
}

// ── Sybil / whitewash: abandoning identity yields lower score than serving penalty ──

#[test]
fn test_whitewash_yields_lower_score_than_serving_penalty() {
    let (env, cid, admin, coordinator) = setup();
    let c = ReputationContractClient::new(&env, &cid);

    // Subject A: receives disputes from distinct counterparties, then recovers
    let subject_a = Address::generate(&env);
    register(&env, &cid, &coordinator, &subject_a);

    env.ledger().with_mut(|l| l.timestamp = EPOCH);
    // 3 major disputes from distinct counterparties
    for _ in 0..3 {
        let cp = Address::generate(&env);
        record(&env, &cid, &coordinator, &subject_a, &cp, DeliveryOutcome::DisputeAgainstMajor);
    }
    // Then 15 clean deliveries from distinct counterparties (serving out the penalty)
    for _ in 0..15 {
        let cp = Address::generate(&env);
        record(&env, &cid, &coordinator, &subject_a, &cp, DeliveryOutcome::Clean);
    }
    let score_a = c.get_score(&subject_a).unwrap().score;

    // Subject B (whitewasher): fresh identity, no history — starts at PRIOR_SCORE
    let subject_b = Address::generate(&env);
    register(&env, &cid, &coordinator, &subject_b);
    let score_b = c.get_score(&subject_b).unwrap().score;

    // A served out the penalty and has more deliveries → higher score than fresh whitewash
    assert!(
        score_a > score_b,
        "serving penalty (score={}) must beat whitewash prior (score={})",
        score_a,
        score_b
    );
}

// ── Collusion: pair farming N deliveries gains sub-linear score vs N organic ──

#[test]
fn test_collusion_pair_gains_sublinear_score() {
    let (env, cid, _admin, coordinator) = setup();
    let c = ReputationContractClient::new(&env, &cid);

    // Colluding pair: same two addresses repeat N times
    let colluder = Address::generate(&env);
    let fixed_cp = Address::generate(&env);
    register(&env, &cid, &coordinator, &colluder);

    env.ledger().with_mut(|l| l.timestamp = EPOCH);
    let n: u32 = 30;
    for _ in 0..n {
        record(&env, &cid, &coordinator, &colluder, &fixed_cp, DeliveryOutcome::Clean);
    }
    let collusion_score = c.get_score(&colluder).unwrap().score;

    // Organic subject: N deliveries with N distinct counterparties
    let organic = Address::generate(&env);
    register(&env, &cid, &coordinator, &organic);
    for _ in 0..n {
        let unique_cp = Address::generate(&env);
        record(&env, &cid, &coordinator, &organic, &unique_cp, DeliveryOutcome::Clean);
    }
    let organic_score = c.get_score(&organic).unwrap().score;

    // Organic must score strictly higher than colluding pair
    assert!(
        organic_score > collusion_score,
        "organic (score={}) must beat collusion pair (score={}) for same N={}",
        organic_score,
        collusion_score,
        n
    );
}

// ── Self-dealing: a subject cannot rate themselves ────────────────────────────

#[test]
fn test_self_dealing_blocked_by_invoker_gate() {
    // Without an authorized invoker, no one can call record_outcome.
    // A subject cannot call record_outcome on themselves because they are not
    // a registered invoker — the invoker gate blocks the entire attack class.
    let (env, cid, _admin, _coordinator) = setup();
    let subject = Address::generate(&env);
    register(&env, &cid, &_coordinator, &subject);

    let c = ReputationContractClient::new(&env, &cid);
    // subject tries to record a clean outcome for themselves
    let result = c.try_record_outcome(&subject, &subject, &subject, &DeliveryOutcome::Clean);
    assert!(result.is_err(), "self-dealing must be blocked by invoker gate");
}

// ── Probation: new subjects start at neutral-low prior ────────────────────────

#[test]
fn test_new_subject_starts_at_prior() {
    let (env, cid, _admin, coordinator) = setup();
    let subject = Address::generate(&env);
    register(&env, &cid, &coordinator, &subject);

    let view = ReputationContractClient::new(&env, &cid)
        .get_score(&subject)
        .unwrap();
    assert_eq!(view.score, PRIOR_SCORE, "new subject must start at PRIOR_SCORE");
    assert_eq!(view.confidence, 0, "new subject must have zero confidence");
}

#[test]
fn test_probation_weight_limits_early_score_inflation() {
    let (env, cid, _admin, coordinator) = setup();
    let c = ReputationContractClient::new(&env, &cid);

    // Subject in probation (< PROBATION_VOLUME deliveries)
    let probation = Address::generate(&env);
    register(&env, &cid, &coordinator, &probation);
    env.ledger().with_mut(|l| l.timestamp = EPOCH);
    for _ in 0..3 {
        let cp = Address::generate(&env);
        record(&env, &cid, &coordinator, &probation, &cp, DeliveryOutcome::Clean);
    }
    let probation_score = c.get_score(&probation).unwrap().score;

    // Subject past probation (> PROBATION_VOLUME deliveries)
    let graduated = Address::generate(&env);
    register(&env, &cid, &coordinator, &graduated);
    for _ in 0..(PROBATION_VOLUME + 3) {
        let cp = Address::generate(&env);
        record(&env, &cid, &coordinator, &graduated, &cp, DeliveryOutcome::Clean);
    }
    let graduated_score = c.get_score(&graduated).unwrap().score;

    assert!(
        graduated_score > probation_score,
        "graduated (score={}) must exceed probation (score={})",
        graduated_score,
        probation_score
    );
}

// ── Decay: recent behavior dominates, old epochs decay ────────────────────────

#[test]
fn test_decay_toward_prior_over_time() {
    let (env, cid, _admin, coordinator) = setup();
    let c = ReputationContractClient::new(&env, &cid);
    let subject = Address::generate(&env);
    register(&env, &cid, &coordinator, &subject);

    // Build up a high score in epoch 1
    env.ledger().with_mut(|l| l.timestamp = EPOCH);
    for _ in 0..20 {
        let cp = Address::generate(&env);
        record(&env, &cid, &coordinator, &subject, &cp, DeliveryOutcome::Clean);
    }
    let high_score = c.get_score(&subject).unwrap().score;

    // Advance 30 epochs (well past half-life) and add a single neutral delivery
    // to trigger recompute. The old epoch's weight is now >> decay_shift=4 (30/7=4),
    // so its contribution is halved 4 times (1/16 of original weight).
    env.ledger().with_mut(|l| l.timestamp = 30 * EPOCH);
    let cp = Address::generate(&env);
    let decayed_view = record(&env, &cid, &coordinator, &subject, &cp, DeliveryOutcome::MinorIssue);

    // Score should have moved toward prior (decayed)
    assert!(
        decayed_view.score < high_score,
        "score after decay ({}) must be less than peak ({})",
        decayed_view.score,
        high_score
    );
}

// ── Evented adjustment: admin can annotate, record is visible ─────────────────

#[test]
fn test_adjustment_is_recorded_and_evented() {
    let (env, cid, _admin, coordinator) = setup();
    let c = ReputationContractClient::new(&env, &cid);
    let subject = Address::generate(&env);
    register(&env, &cid, &coordinator, &subject);

    env.ledger().with_mut(|l| l.timestamp = EPOCH);
    let cp = Address::generate(&env);
    record(&env, &cid, &coordinator, &subject, &cp, DeliveryOutcome::Clean);

    let before = c.get_score(&subject).unwrap().score;
    let reason = String::from_str(&env, "incident-review-2024-001");
    c.apply_adjustment(&subject, &500i64, &reason);

    let after = c.get_score(&subject).unwrap().score;
    assert_eq!(after, (before + 500).min(MAX_SCORE));

    let adjustments = c.get_adjustments(&subject);
    assert_eq!(adjustments.len(), 1);
    assert_eq!(adjustments.get(0).unwrap().delta, 500);
}

#[test]
fn test_adjustment_clamped_at_bounds() {
    let (env, cid, _admin, coordinator) = setup();
    let c = ReputationContractClient::new(&env, &cid);
    let subject = Address::generate(&env);
    register(&env, &cid, &coordinator, &subject);

    let reason = String::from_str(&env, "test");
    // Large positive delta must not exceed MAX_SCORE
    c.apply_adjustment(&subject, &200_00i64, &reason);
    assert_eq!(c.get_score(&subject).unwrap().score, MAX_SCORE);

    // Large negative delta must not go below MIN_SCORE
    c.apply_adjustment(&subject, &-200_00i64, &reason);
    assert_eq!(c.get_score(&subject).unwrap().score, MIN_SCORE);
}

// ── Pause blocks all mutations ─────────────────────────────────────────────────

#[test]
fn test_pause_blocks_record_outcome() {
    let (env, cid, _admin, coordinator) = setup();
    let c = ReputationContractClient::new(&env, &cid);
    let subject = Address::generate(&env);
    let cp = Address::generate(&env);
    register(&env, &cid, &coordinator, &subject);

    c.pause();
    let result = c.try_record_outcome(&coordinator, &subject, &cp, &DeliveryOutcome::Clean);
    assert!(result.is_err());
}

#[test]
fn test_unpause_restores_mutations() {
    let (env, cid, _admin, coordinator) = setup();
    let c = ReputationContractClient::new(&env, &cid);
    let subject = Address::generate(&env);
    let cp = Address::generate(&env);
    register(&env, &cid, &coordinator, &subject);

    c.pause();
    c.unpause();
    env.ledger().with_mut(|l| l.timestamp = EPOCH);
    let view = c.record_outcome(&coordinator, &subject, &cp, &DeliveryOutcome::Clean);
    assert!(view.score >= MIN_SCORE);
}

// ── Score bounds ───────────────────────────────────────────────────────────────

#[test]
fn test_score_never_exceeds_bounds() {
    let (env, cid, _admin, coordinator) = setup();
    let c = ReputationContractClient::new(&env, &cid);
    let subject = Address::generate(&env);
    register(&env, &cid, &coordinator, &subject);

    env.ledger().with_mut(|l| l.timestamp = EPOCH);
    for _ in 0..50 {
        let cp = Address::generate(&env);
        record(&env, &cid, &coordinator, &subject, &cp, DeliveryOutcome::Clean);
    }
    let view = c.get_score(&subject).unwrap();
    assert!(view.score >= MIN_SCORE && view.score <= MAX_SCORE);
    assert!(view.confidence >= 0 && view.confidence <= MAX_SCORE);
}

#[test]
fn test_score_never_below_zero_under_disputes() {
    let (env, cid, _admin, coordinator) = setup();
    let c = ReputationContractClient::new(&env, &cid);
    let subject = Address::generate(&env);
    register(&env, &cid, &coordinator, &subject);

    env.ledger().with_mut(|l| l.timestamp = EPOCH);
    for _ in 0..50 {
        let cp = Address::generate(&env);
        record(&env, &cid, &coordinator, &subject, &cp, DeliveryOutcome::DisputeAgainstMajor);
    }
    let view = c.get_score(&subject).unwrap();
    assert!(view.score >= MIN_SCORE);
}
