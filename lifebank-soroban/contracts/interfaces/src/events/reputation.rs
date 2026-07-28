//! Event payloads for the reputation contract. Populated as part of the
//! events-catalog migration (see EVENTS.md).

use soroban_sdk::{contracttype, Address};

/// Mirrors the contract-internal `ViolationType` enum used for penalties.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ViolationType {
    Minor,
    Medium,
    Serious,
}

/// Emitted whenever a rating is submitted for an entity, before the score is
/// recalculated. Carries the raw (unscaled 1-5) score as supplied by the caller.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RatingSubmittedEvent {
    pub entity_id: u64,
    pub score: i64,
    pub timestamp: u64,
}

/// Emitted whenever an assignment (completed or failed) is recorded against
/// an entity, before the score is recalculated.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssignmentRecordedEvent {
    pub entity_id: u64,
    pub completed: bool,
    pub response_secs: u64,
    pub timestamp: u64,
}

/// Emitted whenever an entity is flagged for fraud, before the score is
/// recalculated. `total_flags` is the cumulative confirmed-fraud count after
/// this flag was applied.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FraudFlaggedEvent {
    pub entity_id: u64,
    pub total_flags: u32,
    pub timestamp: u64,
}

/// Emitted when an admin applies a penalty for a violation, before the score
/// is recalculated.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PenaltyAppliedEvent {
    pub entity_id: u64,
    pub penalty_id: u32,
    pub violation_type: ViolationType,
    pub admin: Address,
    pub timestamp: u64,
}

/// Emitted when a penalty is appealed by/for an entity.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PenaltyAppealedEvent {
    pub entity_id: u64,
    pub penalty_id: u32,
    pub timestamp: u64,
}

/// Emitted when an admin resolves (or dismisses/removes) a penalty.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PenaltyResolvedEvent {
    pub entity_id: u64,
    pub penalty_id: u32,
    pub removed: bool,
    pub admin: Address,
    pub timestamp: u64,
}

/// Canonical audit event: the final recalculated score and its full
/// breakdown, emitted every time `calculate_reputation` runs. Combined with
/// the action-specific events above, this lets a reconciliation engine
/// reconstruct exactly which action drove any given score change.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScoreUpdatedEvent {
    pub entity_id: u64,
    pub score: i64,
    pub rating_component: i64,
    pub completion_component: i64,
    pub response_component: i64,
    pub consistency_bonus: i64,
    pub fraud_penalty: i64,
    pub decay_applied: i64,
    pub penalty_points: i64,
    pub timestamp: u64,
}
