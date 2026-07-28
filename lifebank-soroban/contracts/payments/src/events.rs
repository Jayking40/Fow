//! Typed event emitters for the payments contract. Every mutation below
//! publishes exactly one cataloged event via the shared envelope
//! `(domain="payments", event_name, schema_version)`. See EVENTS.md.

use crate::{DisputeReason, PaymentStatus};
use lifebank_interfaces::envelope::{self, SCHEMA_V1};
use lifebank_interfaces::events::common;
use lifebank_interfaces::events::payments as ev;
use soroban_sdk::{symbol_short, Address, Env, String, Symbol};

fn domain(_env: &Env) -> Symbol {
    symbol_short!("payments")
}

impl From<PaymentStatus> for ev::PaymentStatus {
    fn from(v: PaymentStatus) -> Self {
        match v {
            PaymentStatus::Pending => ev::PaymentStatus::Pending,
            PaymentStatus::Locked => ev::PaymentStatus::Locked,
            PaymentStatus::Released => ev::PaymentStatus::Released,
            PaymentStatus::Refunded => ev::PaymentStatus::Refunded,
            PaymentStatus::Disputed => ev::PaymentStatus::Disputed,
            PaymentStatus::Cancelled => ev::PaymentStatus::Cancelled,
        }
    }
}

impl From<DisputeReason> for ev::DisputeReason {
    fn from(v: DisputeReason) -> Self {
        match v {
            DisputeReason::FailedDelivery => ev::DisputeReason::FailedDelivery,
            DisputeReason::TemperatureExcursion => ev::DisputeReason::TemperatureExcursion,
            DisputeReason::PaymentContested => ev::DisputeReason::PaymentContested,
            DisputeReason::WrongItem => ev::DisputeReason::WrongItem,
            DisputeReason::DamagedGoods => ev::DisputeReason::DamagedGoods,
            DisputeReason::LateDelivery => ev::DisputeReason::LateDelivery,
            DisputeReason::Other => ev::DisputeReason::Other,
        }
    }
}

/// Emitted once by the constructor / legacy `initialize` entrypoint.
pub fn emit_initialized(env: &Env, admin: &Address, requests_contract: Option<Address>) {
    envelope::publish(
        env,
        domain(env),
        symbol_short!("init"),
        SCHEMA_V1,
        common::InitializedEvent {
            admin: admin.clone(),
            linked_contract: requests_contract,
        },
    );
}

pub fn emit_paused(env: &Env, admin: &Address) {
    let timestamp = env.ledger().timestamp();
    envelope::publish(
        env,
        domain(env),
        symbol_short!("paused"),
        SCHEMA_V1,
        ev::PauseStateChangedEvent {
            admin: admin.clone(),
            paused: true,
            timestamp,
        },
    );
}

pub fn emit_unpaused(env: &Env, admin: &Address) {
    let timestamp = env.ledger().timestamp();
    envelope::publish(
        env,
        domain(env),
        symbol_short!("unpaused"),
        SCHEMA_V1,
        ev::PauseStateChangedEvent {
            admin: admin.clone(),
            paused: false,
            timestamp,
        },
    );
}

#[allow(clippy::too_many_arguments)]
pub fn emit_payment_created(
    env: &Env,
    payment_id: u64,
    request_id: u64,
    payer: &Address,
    payee: &Address,
    amount: i128,
    created_at: u64,
) {
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "payment_created"),
        SCHEMA_V1,
        ev::PaymentCreatedEvent {
            payment_id,
            request_id,
            payer: payer.clone(),
            payee: payee.clone(),
            amount,
            created_at,
        },
    );
}

#[allow(clippy::too_many_arguments)]
pub fn emit_payment_escrowed(
    env: &Env,
    payment_id: u64,
    request_id: u64,
    payer: &Address,
    payee: &Address,
    amount: i128,
    token: &Address,
    created_at: u64,
) {
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "payment_escrowed"),
        SCHEMA_V1,
        ev::PaymentEscrowedEvent {
            payment_id,
            request_id,
            payer: payer.clone(),
            payee: payee.clone(),
            amount,
            token: token.clone(),
            created_at,
        },
    );
}

pub fn emit_payment_released(env: &Env, payment_id: u64, payee: &Address, amount: i128) {
    let released_at = env.ledger().timestamp();
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "payment_released"),
        SCHEMA_V1,
        ev::PaymentReleasedEvent {
            payment_id,
            payee: payee.clone(),
            amount,
            released_at,
        },
    );
}

/// Shared by `refund_escrow` and the `process_expired_disputes` batch sweep —
/// both settle a Locked/Disputed escrow back to the payer with the same
/// payload shape.
pub fn emit_payment_refunded(env: &Env, payment_id: u64, payer: &Address, amount: i128) {
    let refunded_at = env.ledger().timestamp();
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "payment_refunded"),
        SCHEMA_V1,
        ev::PaymentRefundedEvent {
            payment_id,
            payer: payer.clone(),
            amount,
            refunded_at,
        },
    );
}

/// Canonical audit event for `update_status` — carries old and new status so
/// off-chain projections can reconcile the transition.
pub fn emit_payment_status_changed(
    env: &Env,
    payment_id: u64,
    from_status: PaymentStatus,
    to_status: PaymentStatus,
) {
    let timestamp = env.ledger().timestamp();
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "payment_status_changed"),
        SCHEMA_V1,
        ev::PaymentStatusChangedEvent {
            payment_id,
            previous_status: from_status.into(),
            new_status: to_status.into(),
            timestamp,
        },
    );
}

pub fn emit_payment_disputed(env: &Env, payment_id: u64, reason: DisputeReason, case_id: String) {
    let disputed_at = env.ledger().timestamp();
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "payment_disputed"),
        SCHEMA_V1,
        ev::PaymentDisputedEvent {
            payment_id,
            reason: reason.into(),
            case_id,
            disputed_at,
        },
    );
}

pub fn emit_payment_resolved(env: &Env, payment_id: u64, resolved: bool) {
    let resolved_at = env.ledger().timestamp();
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "payment_resolved"),
        SCHEMA_V1,
        ev::PaymentResolvedEvent {
            payment_id,
            resolved,
            resolved_at,
        },
    );
}

pub fn emit_pledge_created(
    env: &Env,
    pledge_id: u64,
    donor: &Address,
    amount_per_period: i128,
    interval_secs: u64,
    emergency_pool: bool,
    created_at: u64,
) {
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "pledge_created"),
        SCHEMA_V1,
        ev::PledgeCreatedEvent {
            pledge_id,
            donor: donor.clone(),
            amount_per_period,
            interval_secs,
            emergency_pool,
            created_at,
        },
    );
}

pub fn emit_pledge_status_changed(env: &Env, pledge_id: u64, donor: &Address, active: bool) {
    let timestamp = env.ledger().timestamp();
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "pledge_status_changed"),
        SCHEMA_V1,
        ev::PledgeStatusChangedEvent {
            pledge_id,
            donor: donor.clone(),
            active,
            timestamp,
        },
    );
}

pub fn emit_vesting_created(
    env: &Env,
    donor: &Address,
    total_amount: i128,
    cliff_timestamp: u64,
    vest_end_timestamp: u64,
) {
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "vesting_created"),
        SCHEMA_V1,
        ev::VestingCreatedEvent {
            donor: donor.clone(),
            total_amount,
            cliff_timestamp,
            vest_end_timestamp,
        },
    );
}

pub fn emit_vesting_claimed(env: &Env, donor: &Address, claimed_amount: i128, total_claimed: i128) {
    let timestamp = env.ledger().timestamp();
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "vesting_claimed"),
        SCHEMA_V1,
        ev::VestingClaimedEvent {
            donor: donor.clone(),
            claimed_amount,
            total_claimed,
            timestamp,
        },
    );
}

/// Off-chain-facing notice that the linked request was cancelled as a side
/// effect of a payments-side settlement.
pub fn emit_request_cancelled(env: &Env, request_id: u64, payment_id: u64, cancelled_at: u64) {
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "request_cancelled"),
        SCHEMA_V1,
        ev::RequestCancelledEvent {
            request_id,
            payment_id,
            cancelled_at,
        },
    );
}

pub fn emit_dispute_timeout_updated(env: &Env, admin: &Address, timeout_secs: u64) {
    let updated_at = env.ledger().timestamp();
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "dispute_timeout_updated"),
        SCHEMA_V1,
        ev::DisputeTimeoutUpdatedEvent {
            admin: admin.clone(),
            timeout_secs,
            updated_at,
        },
    );
}

pub fn emit_migration_applied(env: &Env, previous_version: u32, new_version: u32) {
    let migrated_at = env.ledger().timestamp();
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "migration_applied"),
        SCHEMA_V1,
        ev::MigrationAppliedEvent {
            previous_version,
            new_version,
            migrated_at,
        },
    );
}

pub fn emit_upgrade_proposed(env: &Env, executable_at: u64) {
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "upgrade_proposed"),
        SCHEMA_V1,
        common::UpgradeProposedEvent { executable_at },
    );
}

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
