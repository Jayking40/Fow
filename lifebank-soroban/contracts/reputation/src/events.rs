//! Typed event emitters for the reputation contract.

use crate::{AdjustmentRecord, ScoreView};
use soroban_sdk::{symbol_short, Address, Env, Symbol};

fn domain(env: &Env) -> Symbol {
    Symbol::new(env, "reputation")
}

pub fn emit_initialized(env: &Env, admin: &Address) {
    env.events().publish(
        (domain(env), symbol_short!("init")),
        admin.clone(),
    );
}

pub fn emit_invoker_added(env: &Env, invoker: &Address) {
    env.events().publish(
        (domain(env), symbol_short!("inv_add")),
        invoker.clone(),
    );
}

/// Emitted when a delivery outcome is recorded and the score changes.
pub fn emit_score_updated(env: &Env, subject: &Address, view: &ScoreView) {
    env.events().publish(
        (domain(env), Symbol::new(env, "score_updated")),
        (
            subject.clone(),
            view.score,
            view.confidence,
            view.sample_size,
            view.last_updated,
        ),
    );
}

/// Emitted when a velocity spike is detected for a (subject, counterparty) pair
/// in a single epoch — flagged for off-chain anomaly review.
pub fn emit_anomaly(
    env: &Env,
    subject: &Address,
    counterparty: &Address,
    epoch_index: u32,
    event_count: u32,
) {
    env.events().publish(
        (domain(env), symbol_short!("anomaly")),
        (
            subject.clone(),
            counterparty.clone(),
            epoch_index,
            event_count,
        ),
    );
}

/// Emitted for every admin-authored score adjustment (appeal / incident-review).
/// Every adjustment is visible and evented — no silent edits.
pub fn emit_adjustment_applied(env: &Env, subject: &Address, record: &AdjustmentRecord) {
    env.events().publish(
        (domain(env), Symbol::new(env, "adjustment")),
        (
            subject.clone(),
            record.id,
            record.delta,
            record.reason.clone(),
            record.applied_by.clone(),
            record.timestamp,
        ),
    );
}
