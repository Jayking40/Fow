//! Typed event emitters for the reputation contract. Every mutation below
//! publishes exactly one cataloged event via the shared envelope
//! `(domain="reputation", event_name, schema_version)`. See EVENTS.md.

use crate::ViolationType;
use lifebank_interfaces::envelope::{self, SCHEMA_V1};
use lifebank_interfaces::events::common::InitializedEvent;
use lifebank_interfaces::events::reputation as ev;
use soroban_sdk::{symbol_short, Address, Env, Symbol};

fn domain(env: &Env) -> Symbol {
    // "reputation" is 10 chars — too long for symbol_short! (max 9).
    Symbol::new(env, "reputation")
}

impl From<ViolationType> for ev::ViolationType {
    fn from(v: ViolationType) -> Self {
        match v {
            ViolationType::Minor => ev::ViolationType::Minor,
            ViolationType::Medium => ev::ViolationType::Medium,
            ViolationType::Serious => ev::ViolationType::Serious,
        }
    }
}

pub fn emit_initialized(env: &Env, admin: &Address) {
    envelope::publish(
        env,
        domain(env),
        symbol_short!("init"),
        SCHEMA_V1,
        InitializedEvent {
            admin: admin.clone(),
            linked_contract: None,
        },
    );
}

/// The individual rating action that will feed into the next score
/// recalculation — recorded separately so a reconciliation engine can see
/// exactly which rating was submitted, not just the resulting aggregate.
pub fn emit_rating_submitted(env: &Env, entity_id: u64, score: i64, timestamp: u64) {
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "rating_submitted"),
        SCHEMA_V1,
        ev::RatingSubmittedEvent {
            entity_id,
            score,
            timestamp,
        },
    );
}

/// The individual assignment-completion action that will feed into the next
/// score recalculation.
pub fn emit_assignment_recorded(
    env: &Env,
    entity_id: u64,
    completed: bool,
    response_secs: u64,
    timestamp: u64,
) {
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "assignment_recorded"),
        SCHEMA_V1,
        ev::AssignmentRecordedEvent {
            entity_id,
            completed,
            response_secs,
            timestamp,
        },
    );
}

/// The individual fraud-flag action that will feed into the next score
/// recalculation. `total_flags` is the cumulative confirmed-fraud count
/// after this flag was applied.
pub fn emit_fraud_flagged(env: &Env, entity_id: u64, total_flags: u32, timestamp: u64) {
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "fraud_flagged"),
        SCHEMA_V1,
        ev::FraudFlaggedEvent {
            entity_id,
            total_flags,
            timestamp,
        },
    );
}

/// A penalty was applied by an admin for a violation.
pub fn emit_penalty_applied(
    env: &Env,
    entity_id: u64,
    penalty_id: u32,
    violation_type: ViolationType,
    admin: &Address,
    timestamp: u64,
) {
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "penalty_applied"),
        SCHEMA_V1,
        ev::PenaltyAppliedEvent {
            entity_id,
            penalty_id,
            violation_type: violation_type.into(),
            admin: admin.clone(),
            timestamp,
        },
    );
}

/// A penalty was appealed.
pub fn emit_penalty_appealed(env: &Env, entity_id: u64, penalty_id: u32) {
    let timestamp = env.ledger().timestamp();
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "penalty_appealed"),
        SCHEMA_V1,
        ev::PenaltyAppealedEvent {
            entity_id,
            penalty_id,
            timestamp,
        },
    );
}

/// A penalty was resolved (marked resolved) or dismissed (removed) by an admin.
pub fn emit_penalty_resolved(
    env: &Env,
    entity_id: u64,
    penalty_id: u32,
    removed: bool,
    admin: &Address,
) {
    let timestamp = env.ledger().timestamp();
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "penalty_resolved"),
        SCHEMA_V1,
        ev::PenaltyResolvedEvent {
            entity_id,
            penalty_id,
            removed,
            admin: admin.clone(),
            timestamp,
        },
    );
}

/// Canonical audit event for a score recalculation — the single event that
/// carries the final score and its full breakdown for reconciliation.
#[allow(clippy::too_many_arguments)]
pub fn emit_score_updated(
    env: &Env,
    entity_id: u64,
    score: i64,
    rating_component: i64,
    completion_component: i64,
    response_component: i64,
    consistency_bonus: i64,
    fraud_penalty: i64,
    decay_applied: i64,
    penalty_points: i64,
    timestamp: u64,
) {
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "score_updated"),
        SCHEMA_V1,
        ev::ScoreUpdatedEvent {
            entity_id,
            score,
            rating_component,
            completion_component,
            response_component,
            consistency_bonus,
            fraud_penalty,
            decay_applied,
            penalty_points,
            timestamp,
        },
    );
}
