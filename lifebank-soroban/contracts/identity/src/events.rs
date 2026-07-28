//! Typed event emitters for the identity contract. Every mutation below
//! publishes exactly one cataloged event via the shared envelope
//! `(domain="identity", event_name, schema_version)`. See EVENTS.md.
//!
//! `emit_org_verified` / `emit_org_unverified` are the single emission
//! points for organization verification state changes: both the live
//! `IdentityContract::verify_organization` / `unverify_organization`
//! entrypoints in `lib.rs` and the (currently unreachable —
//! `verification::VerificationImpl` is never wired into a `#[contractimpl]`
//! block) helpers in `verification.rs` call through these two functions
//! instead of publishing raw events themselves, so the event can never be
//! published twice for a single verification/unverification.

use crate::{BadgeType, OrgType};
use lifebank_interfaces::envelope::{self, SCHEMA_V1};
use lifebank_interfaces::events::common::InitializedEvent;
use lifebank_interfaces::events::identity as ev;
use soroban_sdk::{symbol_short, Address, Env, String, Symbol};

fn domain(_env: &Env) -> Symbol {
    symbol_short!("identity")
}

impl From<OrgType> for ev::OrgType {
    fn from(v: OrgType) -> Self {
        match v {
            OrgType::BloodBank => ev::OrgType::BloodBank,
            OrgType::Hospital => ev::OrgType::Hospital,
        }
    }
}

impl From<BadgeType> for ev::BadgeType {
    fn from(v: BadgeType) -> Self {
        match v {
            BadgeType::TopRated => ev::BadgeType::TopRated,
            BadgeType::HighCompliance => ev::BadgeType::HighCompliance,
            BadgeType::FastResponse => ev::BadgeType::FastResponse,
            BadgeType::LongService => ev::BadgeType::LongService,
            BadgeType::VerifiedProvider => ev::BadgeType::VerifiedProvider,
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

pub fn emit_org_registered(env: &Env, org_id: &Address, org_type: OrgType, name: String) {
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "org_registered"),
        SCHEMA_V1,
        ev::OrganizationRegisteredEvent {
            org_id: org_id.clone(),
            org_type: org_type.into(),
            name,
        },
    );
}

/// Single emission point for `org_verified` — see module doc comment.
pub fn emit_org_verified(env: &Env, org_id: &Address, admin: &Address, verified_at: u64) {
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "org_verified"),
        SCHEMA_V1,
        ev::OrgVerifiedEvent {
            org_id: org_id.clone(),
            admin: admin.clone(),
            verified_at,
        },
    );
}

/// Single emission point for `org_unverified` — see module doc comment.
pub fn emit_org_unverified(
    env: &Env,
    org_id: &Address,
    admin: &Address,
    reason: String,
    unverified_at: u64,
) {
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "org_unverified"),
        SCHEMA_V1,
        ev::OrgUnverifiedEvent {
            org_id: org_id.clone(),
            admin: admin.clone(),
            reason,
            unverified_at,
        },
    );
}

pub fn emit_org_rated(
    env: &Env,
    org_id: &Address,
    rater: &Address,
    rating: u32,
    request_id: u64,
    timestamp: u64,
) {
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "org_rated"),
        SCHEMA_V1,
        ev::OrgRatedEvent {
            org_id: org_id.clone(),
            rater: rater.clone(),
            rating,
            request_id,
            timestamp,
        },
    );
}

pub fn emit_badge_awarded(
    env: &Env,
    org_id: &Address,
    badge_type: BadgeType,
    admin: &Address,
    awarded_at: u64,
) {
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "badge_awarded"),
        SCHEMA_V1,
        ev::BadgeAwardedEvent {
            org_id: org_id.clone(),
            badge_type: badge_type.into(),
            admin: admin.clone(),
            awarded_at,
        },
    );
}

/// Emitted by `revoke_badge` — previously silent (no event at all). Added
/// for completeness: `award_badge`'s counterpart mutation must be equally
/// observable in the event stream.
pub fn emit_badge_revoked(
    env: &Env,
    org_id: &Address,
    badge_type: BadgeType,
    admin: &Address,
    revoked_at: u64,
) {
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "badge_revoked"),
        SCHEMA_V1,
        ev::BadgeRevokedEvent {
            org_id: org_id.clone(),
            badge_type: badge_type.into(),
            admin: admin.clone(),
            revoked_at,
        },
    );
}

pub fn emit_delivery_verified(
    env: &Env,
    request_id: u64,
    org_id: &Address,
    recipient: &Address,
    quantity_delivered: u32,
    temperature_ok: bool,
    verified_at: u64,
) {
    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "delivery_verified"),
        SCHEMA_V1,
        ev::DeliveryVerifiedEvent {
            request_id,
            org_id: org_id.clone(),
            recipient: recipient.clone(),
            quantity_delivered,
            temperature_ok,
            verified_at,
        },
    );
}
