//! Typed event emitters for the temperature contract. Every mutation below
//! publishes exactly one cataloged event via the shared envelope
//! `(domain="temperature", event_name, schema_version)`. See EVENTS.md.

use crate::types::ExcursionSummary;
use lifebank_interfaces::envelope::{self, SCHEMA_V1};
use lifebank_interfaces::events::common::InitializedEvent;
use lifebank_interfaces::events::temperature as ev;
use soroban_sdk::{Address, Env, Symbol};

fn domain(env: &Env) -> Symbol {
    // "temperature" is 11 chars, over the 9-char symbol_short! limit.
    Symbol::new(env, "temperature")
}

pub fn emit_initialized(env: &Env, admin: &Address) {
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "initialized"),
        SCHEMA_V1,
        InitializedEvent {
            admin: admin.clone(),
            linked_contract: None,
        },
    );
}

pub fn emit_paused(env: &Env, admin: &Address) {
    let timestamp = env.ledger().timestamp();
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "paused"),
        SCHEMA_V1,
        ev::PausedEvent {
            admin: admin.clone(),
            timestamp,
        },
    );
}

pub fn emit_unpaused(env: &Env, admin: &Address) {
    let timestamp = env.ledger().timestamp();
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "unpaused"),
        SCHEMA_V1,
        ev::UnpausedEvent {
            admin: admin.clone(),
            timestamp,
        },
    );
}

pub fn emit_threshold_set(
    env: &Env,
    unit_id: u64,
    admin: &Address,
    previous_min_celsius_x100: Option<i32>,
    previous_max_celsius_x100: Option<i32>,
    min_celsius_x100: i32,
    max_celsius_x100: i32,
) {
    let timestamp = env.ledger().timestamp();
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "threshold_set"),
        SCHEMA_V1,
        ev::ThresholdSetEvent {
            unit_id,
            admin: admin.clone(),
            previous_min_celsius_x100,
            previous_max_celsius_x100,
            min_celsius_x100,
            max_celsius_x100,
            timestamp,
        },
    );
}

pub fn emit_reading_recorded(
    env: &Env,
    unit_id: u64,
    temperature_celsius_x100: i32,
    timestamp: u64,
    is_violation: bool,
    consecutive_violation_streak: u32,
) {
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "reading_recorded"),
        SCHEMA_V1,
        ev::ReadingRecordedEvent {
            unit_id,
            temperature_celsius_x100,
            timestamp,
            is_violation,
            consecutive_violation_streak,
        },
    );
}

pub fn emit_violation_detected(
    env: &Env,
    unit_id: u64,
    temperature_celsius_x100: i32,
    timestamp: u64,
    min_celsius_x100: i32,
    max_celsius_x100: i32,
    consecutive_violation_streak: u32,
) {
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "violation_detected"),
        SCHEMA_V1,
        ev::ViolationDetectedEvent {
            unit_id,
            temperature_celsius_x100,
            timestamp,
            min_celsius_x100,
            max_celsius_x100,
            consecutive_violation_streak,
        },
    );
}

pub fn emit_unit_compromised(env: &Env, unit_id: u64, consecutive_violation_streak: u32) {
    let detected_at = env.ledger().timestamp();
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "unit_compromised"),
        SCHEMA_V1,
        ev::UnitCompromisedEvent {
            unit_id,
            consecutive_violation_streak,
            detected_at,
        },
    );
}

pub fn emit_compromised_status_reset(
    env: &Env,
    unit_id: u64,
    admin: &Address,
    previous_streak: u32,
) {
    let timestamp = env.ledger().timestamp();
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "compromised_status_reset"),
        SCHEMA_V1,
        ev::CompromisedStatusResetEvent {
            unit_id,
            admin: admin.clone(),
            previous_streak,
            timestamp,
        },
    );
}

pub fn emit_coordinator_set(env: &Env, admin: &Address, coordinator: &Address) {
    let timestamp = env.ledger().timestamp();
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "coordinator_set"),
        SCHEMA_V1,
        ev::CoordinatorSetEvent {
            admin: admin.clone(),
            coordinator: coordinator.clone(),
            timestamp,
        },
    );
}

pub fn emit_oracle_added(env: &Env, admin: &Address, oracle: &Address) {
    let timestamp = env.ledger().timestamp();
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "oracle_added"),
        SCHEMA_V1,
        ev::OracleAddedEvent {
            admin: admin.clone(),
            oracle: oracle.clone(),
            timestamp,
        },
    );
}

pub fn emit_excursion_reported(
    env: &Env,
    unit_id: u64,
    payment_id: u64,
    reported_by: &Address,
    excursion_summary: &ExcursionSummary,
) {
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "excursion_reported"),
        SCHEMA_V1,
        ev::ExcursionReportedEvent {
            unit_id,
            payment_id,
            violation_count: excursion_summary.violation_count,
            peak_celsius_x100: excursion_summary.peak_celsius_x100,
            detected_at: excursion_summary.detected_at,
            reported_by: reported_by.clone(),
        },
    );
}
