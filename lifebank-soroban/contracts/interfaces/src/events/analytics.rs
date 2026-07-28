//! Event payloads for the analytics contract. Populated as part of the
//! events-catalog migration (see EVENTS.md).

use soroban_sdk::{contracttype, Address};

/// Reporting period granularity, mirrored from the analytics contract's
/// internal `PeriodType` for cross-crate event payload use.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PeriodType {
    Daily,
    Weekly,
    Monthly,
}

/// Emitted once by the analytics contract's constructor / legacy
/// `initialize` entrypoint. Carries every contract address wired in at init
/// time (analytics aggregates data across all of them, so — unlike the
/// single-`linked_contract` shape in `events::common::InitializedEvent` —
/// each dependency gets its own field).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InitializedEvent {
    pub admin: Address,
    pub inventory_contract: Address,
    pub requests_contract: Address,
    pub payments_contract: Address,
    pub reputation_contract: Address,
}

/// Emitted when the admin changes the reporting period granularity.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReportingPeriodUpdatedEvent {
    pub previous_period_type: PeriodType,
    pub new_period_type: PeriodType,
    pub duration_secs: u64,
    pub configured_at: u64,
}

/// Emitted every time `record_donation` increments the donation counters.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DonationRecordedEvent {
    pub period_index: u64,
    pub period_total: u64,
    pub lifetime_total: u64,
    pub timestamp: u64,
}

/// Emitted every time `record_request` increments the request counters.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RequestRecordedEvent {
    pub period_index: u64,
    pub period_total: u64,
    pub lifetime_total: u64,
    pub timestamp: u64,
}

/// Emitted every time `record_delivery` increments the delivery counters.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DeliveryRecordedEvent {
    pub period_index: u64,
    pub period_total: u64,
    pub lifetime_total: u64,
    pub timestamp: u64,
}

/// Emitted every time `record_payment_released` increments the payment
/// counters and volume totals.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaymentRecordedEvent {
    pub period_index: u64,
    pub amount: i128,
    pub period_total_payments: u64,
    pub period_volume: i128,
    pub lifetime_total_payments: u64,
    pub lifetime_volume: i128,
    pub timestamp: u64,
}
