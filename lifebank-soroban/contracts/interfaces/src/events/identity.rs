//! Event payloads for the identity contract. Populated as part of the
//! events-catalog migration (see EVENTS.md).

use soroban_sdk::{contracttype, Address, String};

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OrgType {
    BloodBank,
    Hospital,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BadgeType {
    TopRated,
    HighCompliance,
    FastResponse,
    LongService,
    VerifiedProvider,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OrganizationRegisteredEvent {
    pub org_id: Address,
    pub org_type: OrgType,
    pub name: String,
}

/// Canonical audit event for an organization being verified by an admin.
/// This is the single `org_verified` emission point — both the
/// `IdentityContract::verify_organization` entrypoint and the (currently
/// unreachable) `verification::VerificationImpl` helper publish through the
/// same `emit_org_verified` helper in `contracts/identity/src/events.rs` so
/// the event can never be published twice for one verification.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OrgVerifiedEvent {
    pub org_id: Address,
    pub admin: Address,
    pub verified_at: u64,
}

/// Canonical audit event for an organization being unverified/revoked.
/// See `OrgVerifiedEvent` for the single-emission-point note.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OrgUnverifiedEvent {
    pub org_id: Address,
    pub admin: Address,
    pub reason: String,
    pub unverified_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OrgRatedEvent {
    pub org_id: Address,
    pub rater: Address,
    pub rating: u32,
    pub request_id: u64,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BadgeAwardedEvent {
    pub org_id: Address,
    pub badge_type: BadgeType,
    pub admin: Address,
    pub awarded_at: u64,
}

/// Emitted by `revoke_badge` — previously silent (no event at all).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BadgeRevokedEvent {
    pub org_id: Address,
    pub badge_type: BadgeType,
    pub admin: Address,
    pub revoked_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DeliveryVerifiedEvent {
    pub request_id: u64,
    pub org_id: Address,
    pub recipient: Address,
    pub quantity_delivered: u32,
    pub temperature_ok: bool,
    pub verified_at: u64,
}
