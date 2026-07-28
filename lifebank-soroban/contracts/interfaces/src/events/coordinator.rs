//! Event payloads for the coordinator contract. Populated as part of the
//! events-catalog migration (see EVENTS.md).
//!
//! The coordinator's `InitializedEvent` and upgrade-governance events
//! (`propose_upgrade` / `cancel_upgrade` / `execute_upgrade`) reuse the
//! shared structs in `events::common` rather than being redefined here.

use soroban_sdk::{contracttype, Address};

/// Emitted when inventory units are reserved against a pending request
/// (workflow transition: Pending -> Allocated).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UnitsAllocatedEvent {
    pub request_id: u64,
    pub payment_id: u64,
    pub unit_count: u32,
    pub actor: Address,
    pub timestamp: u64,
}

/// Emitted once all allocated units have been marked Delivered
/// (workflow transition: Allocated -> Delivered).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DeliveryConfirmedEvent {
    pub request_id: u64,
    pub payment_id: u64,
    pub unit_count: u32,
    pub actor: Address,
    pub timestamp: u64,
}

/// Emitted when the escrowed payment for a delivered request is released
/// (workflow transition: Delivered -> Settled).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaymentSettledEvent {
    pub request_id: u64,
    pub payment_id: u64,
    pub actor: Address,
    pub timestamp: u64,
}

/// Emitted when an allocated workflow expires after its allocation deadline
/// without delivery (workflow transition: Allocated -> Expired). This entry
/// point is permissionless (callable by anyone once the deadline elapses),
/// so there is no authenticated actor to record.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkflowExpiredEvent {
    pub request_id: u64,
    pub payment_id: u64,
    pub unit_count: u32,
    pub timestamp: u64,
}

/// Emitted when the admin rolls back an in-flight (not yet settled)
/// workflow, releasing reserved units and refunding the locked payment.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkflowRolledBackEvent {
    pub request_id: u64,
    pub payment_id: u64,
    pub actor: Address,
    pub timestamp: u64,
}

/// Emitted when the temperature contract relays a sustained cold-chain
/// excursion and the linked payment is moved Locked -> Disputed.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TemperatureBreachEvent {
    pub payment_id: u64,
    pub unit_id: u64,
    pub violation_count: u32,
    pub peak_celsius_x100: i32,
    pub actor: Address,
    /// When the temperature contract originally detected the excursion.
    pub detected_at: u64,
    /// When the coordinator processed the flag and disputed the payment
    /// (may lag `detected_at` if relaying was delayed).
    pub flagged_at: u64,
}

/// Emitted when the admin pauses all state-mutating entrypoints
/// (circuit breaker engaged).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PausedEvent {
    pub actor: Address,
    pub timestamp: u64,
}

/// Emitted when the admin resumes state-mutating entrypoints
/// (circuit breaker released).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UnpausedEvent {
    pub actor: Address,
    pub timestamp: u64,
}

/// Emitted when an admin-triggered storage-schema migration has been
/// applied, recording the version transition.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SchemaMigratedEvent {
    pub from_version: u32,
    pub to_version: u32,
    pub actor: Address,
    pub timestamp: u64,
}
