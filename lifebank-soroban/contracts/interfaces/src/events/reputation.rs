//! Event payloads for the reputation contract.

use soroban_sdk::{contracttype, Address, String};

/// Emitted when a delivery outcome is recorded and the score is updated.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScoreUpdatedEvent {
    pub subject: Address,
    /// Materialized score ×100 (0–100_00).
    pub score: i64,
    /// Confidence ×100 (0–100_00).
    pub confidence: i64,
    pub sample_size: u32,
    pub timestamp: u64,
}

/// Emitted when a velocity spike is detected for a (subject, counterparty) pair
/// in a single epoch. Intended for off-chain anomaly review — not judged on-chain.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AnomalyEvent {
    pub subject: Address,
    pub counterparty: Address,
    pub epoch_index: u32,
    pub event_count: u32,
}

/// Emitted for every admin-authored score adjustment (appeal / incident-review).
/// Every adjustment is a visible, evented, reasoned entry — no silent edits.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdjustmentAppliedEvent {
    pub subject: Address,
    pub adjustment_id: u32,
    /// Delta applied to score ×100 (may be negative).
    pub delta: i64,
    pub reason: String,
    pub applied_by: Address,
    pub timestamp: u64,
}

/// Emitted when a new authorized invoker is registered.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InvokerAddedEvent {
    pub invoker: Address,
}
