//! Event payloads for the temperature contract. Populated as part of the
//! events-catalog migration (see EVENTS.md).

use soroban_sdk::{contracttype, Address};

/// Admin paused all state-mutating entrypoints.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PausedEvent {
    pub admin: Address,
    pub timestamp: u64,
}

/// Admin lifted a prior pause.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UnpausedEvent {
    pub admin: Address,
    pub timestamp: u64,
}

/// Admin set (or replaced) the acceptable temperature band for a blood unit.
/// `previous_*` are `None` the first time a threshold is configured for the
/// unit, letting consumers distinguish "created" from "replaced".
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ThresholdSetEvent {
    pub unit_id: u64,
    pub admin: Address,
    pub previous_min_celsius_x100: Option<i32>,
    pub previous_max_celsius_x100: Option<i32>,
    pub min_celsius_x100: i32,
    pub max_celsius_x100: i32,
    pub timestamp: u64,
}

/// Canonical audit event: one per `log_reading` call, whether or not it
/// violated the configured threshold. Carries the post-write consecutive
/// violation streak so readers can reconstruct streak history without
/// re-deriving it from individual violation events.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReadingRecordedEvent {
    pub unit_id: u64,
    pub temperature_celsius_x100: i32,
    pub timestamp: u64,
    pub is_violation: bool,
    pub consecutive_violation_streak: u32,
}

/// Emitted in addition to `ReadingRecordedEvent` whenever a reading falls
/// outside the configured threshold. Includes the threshold band that was
/// violated so the breach is self-contained without joining against
/// `ThresholdSetEvent`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ViolationDetectedEvent {
    pub unit_id: u64,
    pub temperature_celsius_x100: i32,
    pub timestamp: u64,
    pub min_celsius_x100: i32,
    pub max_celsius_x100: i32,
    pub consecutive_violation_streak: u32,
}

/// Emitted exactly once per compromise episode: the reading that pushed the
/// consecutive-violation streak to the compromise threshold (3), on the
/// transition from not-compromised to compromised only (not repeated on
/// every subsequent violating reading while already compromised).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UnitCompromisedEvent {
    pub unit_id: u64,
    pub consecutive_violation_streak: u32,
    pub detected_at: u64,
}

/// Admin cleared a unit's compromised flag and violation streak.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompromisedStatusResetEvent {
    pub unit_id: u64,
    pub admin: Address,
    pub previous_streak: u32,
    pub timestamp: u64,
}

/// Admin configured (or replaced) the linked coordinator contract address.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CoordinatorSetEvent {
    pub admin: Address,
    pub coordinator: Address,
    pub timestamp: u64,
}

/// Admin whitelisted an IoT oracle address for excursion reporting.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OracleAddedEvent {
    pub admin: Address,
    pub oracle: Address,
    pub timestamp: u64,
}

/// A sustained excursion was reported to the coordinator contract, which
/// transitions the linked payment from Locked to Disputed on its side.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExcursionReportedEvent {
    pub unit_id: u64,
    pub payment_id: u64,
    pub violation_count: u32,
    pub peak_celsius_x100: i32,
    pub detected_at: u64,
    pub reported_by: Address,
}
