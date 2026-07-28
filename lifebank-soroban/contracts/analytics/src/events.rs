//! Typed event emitters for the analytics contract. Every mutation below
//! publishes exactly one cataloged event via the shared envelope
//! `(domain="analytics", event_name, schema_version)`. See EVENTS.md.

use crate::types::PeriodType;
use lifebank_interfaces::envelope::{self, SCHEMA_V1};
use lifebank_interfaces::events::analytics as ev;
use soroban_sdk::{symbol_short, Address, Env, Symbol};

fn domain(_env: &Env) -> Symbol {
    symbol_short!("analytics")
}

impl From<PeriodType> for ev::PeriodType {
    fn from(v: PeriodType) -> Self {
        match v {
            PeriodType::Daily => ev::PeriodType::Daily,
            PeriodType::Weekly => ev::PeriodType::Weekly,
            PeriodType::Monthly => ev::PeriodType::Monthly,
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn emit_initialized(
    env: &Env,
    admin: &Address,
    inventory_contract: &Address,
    requests_contract: &Address,
    payments_contract: &Address,
    reputation_contract: &Address,
) {
    envelope::publish(
        env,
        domain(env),
        symbol_short!("init"),
        SCHEMA_V1,
        ev::InitializedEvent {
            admin: admin.clone(),
            inventory_contract: inventory_contract.clone(),
            requests_contract: requests_contract.clone(),
            payments_contract: payments_contract.clone(),
            reputation_contract: reputation_contract.clone(),
        },
    );
}

/// Emitted when the admin changes the reporting period granularity via
/// `set_reporting_period`.
pub fn emit_reporting_period_updated(
    env: &Env,
    previous_period_type: PeriodType,
    new_period_type: PeriodType,
    duration_secs: u64,
    configured_at: u64,
) {
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "reporting_period_updated"),
        SCHEMA_V1,
        ev::ReportingPeriodUpdatedEvent {
            previous_period_type: previous_period_type.into(),
            new_period_type: new_period_type.into(),
            duration_secs,
            configured_at,
        },
    );
}

/// Emitted every time `record_donation` increments the donation counters.
pub fn emit_donation_recorded(
    env: &Env,
    period_index: u64,
    period_total: u64,
    lifetime_total: u64,
    timestamp: u64,
) {
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "donation_recorded"),
        SCHEMA_V1,
        ev::DonationRecordedEvent {
            period_index,
            period_total,
            lifetime_total,
            timestamp,
        },
    );
}

/// Emitted every time `record_request` increments the request counters.
pub fn emit_request_recorded(
    env: &Env,
    period_index: u64,
    period_total: u64,
    lifetime_total: u64,
    timestamp: u64,
) {
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "request_recorded"),
        SCHEMA_V1,
        ev::RequestRecordedEvent {
            period_index,
            period_total,
            lifetime_total,
            timestamp,
        },
    );
}

/// Emitted every time `record_delivery` increments the delivery counters.
pub fn emit_delivery_recorded(
    env: &Env,
    period_index: u64,
    period_total: u64,
    lifetime_total: u64,
    timestamp: u64,
) {
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "delivery_recorded"),
        SCHEMA_V1,
        ev::DeliveryRecordedEvent {
            period_index,
            period_total,
            lifetime_total,
            timestamp,
        },
    );
}

/// Emitted every time `record_payment_released` increments the payment
/// counters and volume totals.
#[allow(clippy::too_many_arguments)]
pub fn emit_payment_recorded(
    env: &Env,
    period_index: u64,
    amount: i128,
    period_total_payments: u64,
    period_volume: i128,
    lifetime_total_payments: u64,
    lifetime_volume: i128,
    timestamp: u64,
) {
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "payment_recorded"),
        SCHEMA_V1,
        ev::PaymentRecordedEvent {
            period_index,
            amount,
            period_total_payments,
            period_volume,
            lifetime_total_payments,
            lifetime_volume,
            timestamp,
        },
    );
}
