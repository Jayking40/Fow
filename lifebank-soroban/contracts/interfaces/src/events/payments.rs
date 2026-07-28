//! Event payloads for the payments contract. See
//! `contracts/payments/src/events.rs` for the typed `emit_*` helpers that
//! publish these under the shared `(domain="payments", event_name,
//! schema_version)` envelope.

use soroban_sdk::{contracttype, Address, String};

/// Mirrors `payment_contract::PaymentStatus` for event payloads.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PaymentStatus {
    Pending,
    Locked,
    Released,
    Refunded,
    Disputed,
    Cancelled,
}

/// Mirrors `payment_contract::DisputeReason` for event payloads.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DisputeReason {
    FailedDelivery,
    TemperatureExcursion,
    PaymentContested,
    WrongItem,
    DamagedGoods,
    LateDelivery,
    Other,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaymentCreatedEvent {
    pub payment_id: u64,
    pub request_id: u64,
    pub payer: Address,
    pub payee: Address,
    pub amount: i128,
    pub created_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaymentEscrowedEvent {
    pub payment_id: u64,
    pub request_id: u64,
    pub payer: Address,
    pub payee: Address,
    pub amount: i128,
    pub token: Address,
    pub created_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaymentReleasedEvent {
    pub payment_id: u64,
    pub payee: Address,
    pub amount: i128,
    pub released_at: u64,
}

/// Emitted for both admin-initiated refunds (`refund_escrow`) and the
/// dispute-timeout batch sweep (`process_expired_disputes`) — same shape
/// either way.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaymentRefundedEvent {
    pub payment_id: u64,
    pub payer: Address,
    pub amount: i128,
    pub refunded_at: u64,
}

/// Canonical audit event for a raw status transition via `update_status`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaymentStatusChangedEvent {
    pub payment_id: u64,
    pub previous_status: PaymentStatus,
    pub new_status: PaymentStatus,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaymentDisputedEvent {
    pub payment_id: u64,
    pub reason: DisputeReason,
    pub case_id: String,
    pub disputed_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaymentResolvedEvent {
    pub payment_id: u64,
    pub resolved: bool,
    pub resolved_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PledgeCreatedEvent {
    pub pledge_id: u64,
    pub donor: Address,
    pub amount_per_period: i128,
    pub interval_secs: u64,
    pub emergency_pool: bool,
    pub created_at: u64,
}

/// Emitted when a donor activates/deactivates a recurring pledge.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PledgeStatusChangedEvent {
    pub pledge_id: u64,
    pub donor: Address,
    pub active: bool,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VestingCreatedEvent {
    pub donor: Address,
    pub total_amount: i128,
    pub cliff_timestamp: u64,
    pub vest_end_timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VestingClaimedEvent {
    pub donor: Address,
    pub claimed_amount: i128,
    pub total_claimed: i128,
    pub timestamp: u64,
}

/// Off-chain-facing notice that the linked blood request was cancelled as a
/// side effect of a payments-side settlement (currently: the
/// dispute-timeout auto-refund sweep in `process_expired_disputes`).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RequestCancelledEvent {
    pub request_id: u64,
    pub payment_id: u64,
    pub cancelled_at: u64,
}

/// Emitted when the admin overrides the dispute auto-refund timeout.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisputeTimeoutUpdatedEvent {
    pub admin: Address,
    pub timeout_secs: u64,
    pub updated_at: u64,
}

/// Shared by `pause` and `unpause` — `paused` distinguishes direction.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PauseStateChangedEvent {
    pub admin: Address,
    pub paused: bool,
    pub timestamp: u64,
}

/// Emitted when a version-gated storage migration is applied.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigrationAppliedEvent {
    pub previous_version: u32,
    pub new_version: u32,
    pub migrated_at: u64,
}
