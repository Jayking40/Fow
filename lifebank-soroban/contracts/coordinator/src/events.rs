//! Typed event emitters for the coordinator contract. Every mutation below
//! publishes exactly one cataloged event via the shared envelope
//! `(domain="coordinator", event_name, schema_version)`. See EVENTS.md.

use crate::ExcursionSummary;
use lifebank_interfaces::envelope::{self, SCHEMA_V1};
use lifebank_interfaces::events::common;
use lifebank_interfaces::events::coordinator as ev;
use soroban_sdk::{symbol_short, Address, Env, Symbol};

/// `contract_domain` for every coordinator event. "coordinator" is 11
/// characters, so it must use `Symbol::new` — `symbol_short!` only supports
/// up to 9 characters of `[a-zA-Z0-9_]`.
fn domain(env: &Env) -> Symbol {
    Symbol::new(env, "coordinator")
}

/// Emitted by both the atomic constructor and the legacy `initialize`
/// entrypoint — they represent the same logical event.
pub fn emit_initialized(env: &Env, admin: &Address) {
    envelope::publish(
        env,
        domain(env),
        symbol_short!("init"),
        SCHEMA_V1,
        common::InitializedEvent {
            admin: admin.clone(),
            // The coordinator wires in three downstream contracts (request,
            // inventory, payment) at init time, not one — the shared
            // `linked_contract: Option<Address>` field can't represent all
            // three, so it is left `None` here rather than picking one
            // arbitrarily. See migration report for discussion.
            linked_contract: None,
        },
    );
}

/// Step 1 complete: inventory units reserved against a pending request.
pub fn emit_units_allocated(
    env: &Env,
    request_id: u64,
    payment_id: u64,
    unit_count: u32,
    actor: &Address,
) {
    let timestamp = env.ledger().timestamp();
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "units_allocated"),
        SCHEMA_V1,
        ev::UnitsAllocatedEvent {
            request_id,
            payment_id,
            unit_count,
            actor: actor.clone(),
            timestamp,
        },
    );
}

/// Step 2 complete: all allocated units marked Delivered.
pub fn emit_delivery_confirmed(
    env: &Env,
    request_id: u64,
    payment_id: u64,
    unit_count: u32,
    actor: &Address,
) {
    let timestamp = env.ledger().timestamp();
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "delivery_confirmed"),
        SCHEMA_V1,
        ev::DeliveryConfirmedEvent {
            request_id,
            payment_id,
            unit_count,
            actor: actor.clone(),
            timestamp,
        },
    );
}

/// Step 3 complete: escrowed payment released to the blood bank.
pub fn emit_payment_settled(env: &Env, request_id: u64, payment_id: u64, actor: &Address) {
    let timestamp = env.ledger().timestamp();
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "payment_settled"),
        SCHEMA_V1,
        ev::PaymentSettledEvent {
            request_id,
            payment_id,
            actor: actor.clone(),
            timestamp,
        },
    );
}

/// An allocated workflow expired past its deadline; units released and
/// payment refunded. Permissionless entrypoint — no actor to record.
pub fn emit_workflow_expired(env: &Env, request_id: u64, payment_id: u64, unit_count: u32) {
    let timestamp = env.ledger().timestamp();
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "workflow_expired"),
        SCHEMA_V1,
        ev::WorkflowExpiredEvent {
            request_id,
            payment_id,
            unit_count,
            timestamp,
        },
    );
}

/// Admin rolled back an in-flight workflow; units released and payment
/// refunded.
pub fn emit_workflow_rolled_back(env: &Env, request_id: u64, payment_id: u64, actor: &Address) {
    let timestamp = env.ledger().timestamp();
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "workflow_rolled_back"),
        SCHEMA_V1,
        ev::WorkflowRolledBackEvent {
            request_id,
            payment_id,
            actor: actor.clone(),
            timestamp,
        },
    );
}

/// A sustained cold-chain excursion was relayed from the temperature
/// contract and the linked payment moved Locked -> Disputed.
pub fn emit_temperature_breach(
    env: &Env,
    payment_id: u64,
    excursion_summary: &ExcursionSummary,
    actor: &Address,
) {
    let flagged_at = env.ledger().timestamp();
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "temperature_breach"),
        SCHEMA_V1,
        ev::TemperatureBreachEvent {
            payment_id,
            unit_id: excursion_summary.unit_id,
            violation_count: excursion_summary.violation_count,
            peak_celsius_x100: excursion_summary.peak_celsius_x100,
            actor: actor.clone(),
            detected_at: excursion_summary.detected_at,
            flagged_at,
        },
    );
}

/// Admin engaged the circuit breaker, pausing all state-mutating entrypoints.
pub fn emit_paused(env: &Env, actor: &Address) {
    let timestamp = env.ledger().timestamp();
    envelope::publish(
        env,
        domain(env),
        symbol_short!("paused"),
        SCHEMA_V1,
        ev::PausedEvent {
            actor: actor.clone(),
            timestamp,
        },
    );
}

/// Admin released the circuit breaker, resuming state-mutating entrypoints.
pub fn emit_unpaused(env: &Env, actor: &Address) {
    let timestamp = env.ledger().timestamp();
    envelope::publish(
        env,
        domain(env),
        symbol_short!("unpaused"),
        SCHEMA_V1,
        ev::UnpausedEvent {
            actor: actor.clone(),
            timestamp,
        },
    );
}

/// A timelocked WASM upgrade was proposed.
pub fn emit_upgrade_proposed(env: &Env, executable_at: u64) {
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "upgrade_proposed"),
        SCHEMA_V1,
        common::UpgradeProposedEvent { executable_at },
    );
}

/// A pending upgrade proposal was canceled before it executed.
pub fn emit_upgrade_canceled(env: &Env) {
    let canceled_at = env.ledger().timestamp();
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "upgrade_canceled"),
        SCHEMA_V1,
        common::UpgradeCanceledEvent { canceled_at },
    );
}

/// A proposed upgrade executed (WASM swapped) once its timelock elapsed.
pub fn emit_upgrade_executed(env: &Env) {
    let executed_at = env.ledger().timestamp();
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "upgrade_executed"),
        SCHEMA_V1,
        common::UpgradeExecutedEvent { executed_at },
    );
}

/// A storage-schema migration was applied post-upgrade.
pub fn emit_schema_migrated(env: &Env, from_version: u32, to_version: u32, actor: &Address) {
    let timestamp = env.ledger().timestamp();
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "schema_migrated"),
        SCHEMA_V1,
        ev::SchemaMigratedEvent {
            from_version,
            to_version,
            actor: actor.clone(),
            timestamp,
        },
    );
}
