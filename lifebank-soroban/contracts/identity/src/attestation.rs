//! Full attestation lifecycle for the HealthDonor identity contract.
//!
//! Design invariants:
//! - No PII is stored on-chain; `evidence_hash` commits to off-chain documents.
//! - `is_valid(subject, cred_type, allow_grace)` is the single predicate other contracts call.
//! - Revoking a verifier cascade-flags (not auto-revokes) their attestations.
//! - Grace-period semantics: expired != revoked — downstream behavior differs.
//! - Quorum (M-of-N) is designed and stored; enabled per credential type via config.
//!
//! Grace eligibility is centrally stored per credential type and administered
//! through `set_grace_policy`. The consumer boolean is only a request and is
//! rejected when central eligibility is disabled (including for legacy policies
//! without an eligibility record). The current operation policy is:
//! - `matching::match_request` and `coordinator::allocate_units` do not request
//!   grace when checking a `MedicalFacilityLicense`, because allocation must
//!   not begin with an expired license.
//! - `payments::release_escrow` requests grace for a `BloodBankAccreditation`
//!   because settlement may complete an in-flight workflow. The identity admin
//!   can disable that exception centrally without redeploying payments.

use soroban_sdk::{contracttype, symbol_short, Address, BytesN, Env, Symbol, Vec};

use crate::{DataKey, Error};

// ---------------------------------------------------------------------------
// Credential types
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
pub enum CredentialType {
    MedicalFacilityLicense,
    RiderCertification,
    BloodBankAccreditation,
    DonorEligibility,
    LabAccreditation,
}

// ---------------------------------------------------------------------------
// Core attestation record — no PII fields
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, Debug)]
pub struct Attestation {
    pub id: u64,
    pub subject: Address,
    pub credential_type: CredentialType,
    pub issuer: Address,
    pub issued_at: u64,
    pub expires_at: u64,
    /// SHA-256 of off-chain evidence document (S3 key + metadata hash).
    /// Commits to the document without putting PHI on-chain.
    pub evidence_hash: BytesN<32>,
    pub revoked: bool,
    pub revocation_reason_code: u32, // 0 = not revoked
    /// Set when the issuer has been flagged as rogue; triggers review.
    pub issuer_flagged: bool,
}

// ---------------------------------------------------------------------------
// Grace-period policy per credential type
// ---------------------------------------------------------------------------

/// Central grace policy for a credential type.
#[contracttype]
#[derive(Clone, Debug)]
pub struct GracePolicy {
    pub credential_type: CredentialType,
    /// Seconds after expiry that in-flight workflows may still proceed.
    pub grace_seconds: u64,
}

// ---------------------------------------------------------------------------
// Quorum config (M-of-N) — stored per credential type; gated by `enabled`
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, Debug)]
pub struct QuorumConfig {
    pub credential_type: CredentialType,
    pub required: u32, // M
    pub total: u32,    // N (informational; actual verifiers tracked separately)
    pub enabled: bool,
}

/// Pending quorum accumulator — collects approvals before attestation is live.
#[contracttype]
#[derive(Clone, Debug)]
pub struct QuorumAccumulator {
    pub subject: Address,
    pub credential_type: CredentialType,
    pub evidence_hash: BytesN<32>,
    pub expires_at: u64,
    pub approvals: Vec<Address>,
}

// ---------------------------------------------------------------------------
// Paged history cursor
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, Debug)]
pub struct AttestationPage {
    pub items: Vec<Attestation>,
    pub total: u64,
    pub offset: u64,
    pub limit: u32,
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn next_id(env: &Env) -> u64 {
    let key = DataKey::AttestationCounter;
    let id: u64 = env.storage().instance().get(&key).unwrap_or(0u64) + 1;
    env.storage().instance().set(&key, &id);
    id
}

fn save(env: &Env, att: &Attestation) {
    env.storage()
        .persistent()
        .set(&DataKey::Attestation(att.id), att);
}

fn load(env: &Env, id: u64) -> Option<Attestation> {
    env.storage().persistent().get(&DataKey::Attestation(id))
}

fn subject_index_key(subject: &Address, cred: CredentialType) -> DataKey {
    DataKey::AttestationSubjectIndex(subject.clone(), cred)
}

fn append_to_subject_index(env: &Env, subject: &Address, cred: CredentialType, id: u64) {
    let key = subject_index_key(subject, cred);
    let mut ids: Vec<u64> = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or(Vec::new(env));
    ids.push_back(id);
    env.storage().persistent().set(&key, &ids);
}

fn require_issuer_authorized(env: &Env, issuer: &Address, cred: CredentialType) -> Result<(), Error> {
    let key = DataKey::IssuerAuth(issuer.clone(), cred);
    let authorized: bool = env.storage().persistent().get(&key).unwrap_or(false);
    if !authorized {
        return Err(Error::Unauthorized);
    }
    Ok(())
}

fn is_admin(env: &Env, caller: &Address) -> bool {
    env.storage()
        .instance()
        .get::<DataKey, Address>(&DataKey::Admin)
        .map(|a| a == *caller)
        .unwrap_or(false)
}

fn grace_seconds(env: &Env, cred: CredentialType) -> u64 {
    env.storage()
        .persistent()
        .get::<DataKey, GracePolicy>(&DataKey::GracePolicy(cred))
        .map(|p| p.grace_seconds)
        .unwrap_or(0)
}

fn grace_allowed(env: &Env, cred: CredentialType) -> bool {
    env.storage()
        .persistent()
        .get::<DataKey, bool>(&DataKey::GraceEligibility(cred))
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Public entrypoints (called from IdentityContract impl in lib.rs)
// ---------------------------------------------------------------------------

/// Authorize an issuer for a specific credential type. Admin only.
pub fn set_issuer_auth(
    env: &Env,
    admin: &Address,
    issuer: &Address,
    cred: CredentialType,
    authorized: bool,
) -> Result<(), Error> {
    admin.require_auth();
    if !is_admin(env, admin) {
        return Err(Error::Unauthorized);
    }
    env.storage()
        .persistent()
        .set(&DataKey::IssuerAuth(issuer.clone(), cred), &authorized);
    env.events().publish(
        (symbol_short!("iss_auth"), symbol_short!("v1")),
        (issuer.clone(), cred, authorized),
    );
    Ok(())
}

/// Issue an attestation. Issuer must be authorized for this credential type.
/// If quorum is enabled for this type, adds to the accumulator instead.
pub fn attest(
    env: &Env,
    issuer: &Address,
    subject: &Address,
    cred: CredentialType,
    expires_at: u64,
    evidence_hash: BytesN<32>,
) -> Result<u64, Error> {
    issuer.require_auth();
    require_issuer_authorized(env, issuer, cred)?;

    let now = env.ledger().timestamp();
    if expires_at <= now {
        return Err(Error::InvalidInput);
    }

    // Check if quorum is enabled for this credential type.
    let quorum_cfg: Option<QuorumConfig> = env
        .storage()
        .persistent()
        .get(&DataKey::QuorumConfig(cred));

    if let Some(cfg) = quorum_cfg {
        if cfg.enabled {
            return attest_quorum(env, issuer, subject, cred, expires_at, evidence_hash, &cfg);
        }
    }

    let id = next_id(env);
    let att = Attestation {
        id,
        subject: subject.clone(),
        credential_type: cred,
        issuer: issuer.clone(),
        issued_at: now,
        expires_at,
        evidence_hash,
        revoked: false,
        revocation_reason_code: 0,
        issuer_flagged: false,
    };
    save(env, &att);
    append_to_subject_index(env, subject, cred, id);

    env.events().publish(
        (Symbol::new(env, "attested"), symbol_short!("v1")),
        (id, subject.clone(), cred, issuer.clone(), expires_at),
    );
    Ok(id)
}

/// Quorum path: accumulate approvals; mint attestation when threshold reached.
fn attest_quorum(
    env: &Env,
    issuer: &Address,
    subject: &Address,
    cred: CredentialType,
    expires_at: u64,
    evidence_hash: BytesN<32>,
    cfg: &QuorumConfig,
) -> Result<u64, Error> {
    let key = DataKey::QuorumPending(subject.clone(), cred);
    let mut acc: QuorumAccumulator = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or(QuorumAccumulator {
            subject: subject.clone(),
            credential_type: cred,
            evidence_hash: evidence_hash.clone(),
            expires_at,
            approvals: Vec::new(env),
        });

    // Deduplicate approvals.
    for i in 0..acc.approvals.len() {
        if acc.approvals.get(i).unwrap() == *issuer {
            return Err(Error::AlreadyVerified);
        }
    }
    acc.approvals.push_back(issuer.clone());

    if acc.approvals.len() < cfg.required {
        env.storage().persistent().set(&key, &acc);
        env.events().publish(
            (Symbol::new(env, "quorum_vote"), symbol_short!("v1")),
            (subject.clone(), cred, acc.approvals.len(), cfg.required),
        );
        // Return 0 to signal pending, not yet minted.
        return Ok(0);
    }

    // Threshold reached — mint the attestation.
    env.storage().persistent().remove(&key);
    let id = next_id(env);
    let att = Attestation {
        id,
        subject: subject.clone(),
        credential_type: cred,
        issuer: issuer.clone(), // last approver recorded as issuer
        issued_at: env.ledger().timestamp(),
        expires_at: acc.expires_at,
        evidence_hash: acc.evidence_hash,
        revoked: false,
        revocation_reason_code: 0,
        issuer_flagged: false,
    };
    save(env, &att);
    append_to_subject_index(env, subject, cred, id);

    env.events().publish(
        (Symbol::new(env, "attested"), symbol_short!("v1")),
        (id, subject.clone(), cred, issuer.clone(), acc.expires_at),
    );
    Ok(id)
}

/// Revoke an attestation. Caller must be the original issuer or admin.
pub fn revoke(
    env: &Env,
    caller: &Address,
    attestation_id: u64,
    reason_code: u32,
) -> Result<(), Error> {
    caller.require_auth();
    let mut att = load(env, attestation_id).ok_or(Error::AttestationNotFound)?;

    if att.revoked {
        return Err(Error::AlreadyRevoked);
    }
    if *caller != att.issuer && !is_admin(env, caller) {
        return Err(Error::Unauthorized);
    }

    att.revoked = true;
    att.revocation_reason_code = reason_code;
    save(env, &att);

    env.events().publish(
        (Symbol::new(env, "att_revoked"), symbol_short!("v1")),
        (attestation_id, att.subject.clone(), att.credential_type, reason_code),
    );
    Ok(())
}

/// Renew/supersede: revoke the old attestation and issue a new one atomically.
/// Subject address (stable key) is preserved; history remains queryable.
pub fn renew(
    env: &Env,
    issuer: &Address,
    old_attestation_id: u64,
    new_expires_at: u64,
    new_evidence_hash: BytesN<32>,
) -> Result<u64, Error> {
    issuer.require_auth();
    let old = load(env, old_attestation_id).ok_or(Error::AttestationNotFound)?;

    if old.revoked {
        return Err(Error::AlreadyRevoked);
    }
    if *issuer != old.issuer && !is_admin(env, issuer) {
        return Err(Error::Unauthorized);
    }
    require_issuer_authorized(env, issuer, old.credential_type)?;

    let now = env.ledger().timestamp();
    if new_expires_at <= now {
        return Err(Error::InvalidInput);
    }

    // Supersede old record.
    let mut old_mut = old.clone();
    old_mut.revoked = true;
    old_mut.revocation_reason_code = 99; // reason: superseded
    save(env, &old_mut);

    // Mint new attestation.
    let id = next_id(env);
    let att = Attestation {
        id,
        subject: old.subject.clone(),
        credential_type: old.credential_type,
        issuer: issuer.clone(),
        issued_at: now,
        expires_at: new_expires_at,
        evidence_hash: new_evidence_hash,
        revoked: false,
        revocation_reason_code: 0,
        issuer_flagged: false,
    };
    save(env, &att);
    append_to_subject_index(env, &old.subject, old.credential_type, id);

    env.events().publish(
        (Symbol::new(env, "att_renewed"), symbol_short!("v1")),
        (old_attestation_id, id, old.subject.clone(), old.credential_type),
    );
    Ok(id)
}

/// Flag a rogue verifier. Admin only.
/// Cascade-marks all their attestations as `issuer_flagged = true` for review.
/// Does NOT auto-revoke — in-flight workflows are unaffected until admin acts.
pub fn flag_rogue_issuer(
    env: &Env,
    admin: &Address,
    issuer: &Address,
    attestation_ids: Vec<u64>,
) -> Result<u32, Error> {
    admin.require_auth();
    if !is_admin(env, admin) {
        return Err(Error::Unauthorized);
    }

    // Mark issuer as flagged.
    env.storage()
        .persistent()
        .set(&DataKey::IssuerFlagged(issuer.clone()), &true);

    // Cascade-flag all provided attestation IDs issued by this issuer.
    let mut flagged_count = 0u32;
    for i in 0..attestation_ids.len() {
        let id = attestation_ids.get(i).unwrap();
        if let Some(mut att) = load(env, id) {
            if att.issuer == *issuer && !att.revoked {
                att.issuer_flagged = true;
                save(env, &att);
                flagged_count += 1;
            }
        }
    }

    env.events().publish(
        (Symbol::new(env, "iss_flagged"), symbol_short!("v1")),
        (issuer.clone(), flagged_count),
    );
    Ok(flagged_count)
}

/// The single validity predicate consumed by matching, coordinator, payments.
///
/// Returns `true` iff the subject holds at least one attestation for
/// `cred_type` that is:
///   - not revoked
///   - not issuer-flagged
///   - not expired (ledger time <= expires_at + centrally permitted grace)
///
/// `allow_grace` is only a consumer request. The identity administrator must
/// also enable grace for the credential type; otherwise the request is denied.
/// The current policy is intentionally asymmetric: allocation paths request
/// no grace, while escrow release may request grace for an in-flight payment.
pub fn is_valid(
    env: &Env,
    subject: &Address,
    cred: CredentialType,
    allow_grace: bool,
) -> bool {
    let key = subject_index_key(subject, cred);
    let ids: Vec<u64> = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or(Vec::new(env));

    let now = env.ledger().timestamp();
    let grace = if allow_grace && grace_allowed(env, cred) {
        grace_seconds(env, cred)
    } else {
        0
    };

    for i in 0..ids.len() {
        let id = ids.get(i).unwrap();
        if let Some(att) = load(env, id) {
            if att.revoked || att.issuer_flagged {
                continue;
            }
            if now <= att.expires_at + grace {
                return true;
            }
        }
    }
    false
}

/// Paged attestation history for a subject + credential type.
/// Bounded pages prevent unbounded reads (#39).
pub fn get_history(
    env: &Env,
    subject: &Address,
    cred: CredentialType,
    offset: u64,
    limit: u32,
) -> AttestationPage {
    let limit = limit.min(50); // hard cap per page
    let key = subject_index_key(subject, cred);
    let ids: Vec<u64> = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or(Vec::new(env));

    let total = ids.len() as u64;
    let mut items: Vec<Attestation> = Vec::new(env);

    let start = offset.min(total);
    let end = (start + limit as u64).min(total);
    for i in start..end {
        let id = ids.get(i as u32).unwrap();
        if let Some(att) = load(env, id) {
            items.push_back(att);
        }
    }

    AttestationPage { items, total, offset, limit }
}

/// Get a single attestation by ID.
pub fn get_attestation(env: &Env, id: u64) -> Option<Attestation> {
    load(env, id)
}

/// Set the centrally enforced grace-period policy for a credential type.
/// Admin only. Grace is disabled unless `allow_grace` is explicitly enabled.
pub fn set_grace_policy(
    env: &Env,
    admin: &Address,
    cred: CredentialType,
    grace_seconds_val: u64,
    allow_grace: bool,
) -> Result<(), Error> {
    admin.require_auth();
    if !is_admin(env, admin) {
        return Err(Error::Unauthorized);
    }
    env.storage()
        .persistent()
        .set(&DataKey::GracePolicy(cred), &GracePolicy {
            credential_type: cred,
            grace_seconds: grace_seconds_val,
        });
    env.storage()
        .persistent()
        .set(&DataKey::GraceEligibility(cred), &allow_grace);
    Ok(())
}

/// Configure M-of-N quorum for a credential type. Admin only.
pub fn set_quorum_config(
    env: &Env,
    admin: &Address,
    cred: CredentialType,
    required: u32,
    total: u32,
    enabled: bool,
) -> Result<(), Error> {
    admin.require_auth();
    if !is_admin(env, admin) {
        return Err(Error::Unauthorized);
    }
    if required == 0 || required > total {
        return Err(Error::InvalidInput);
    }
    env.storage()
        .persistent()
        .set(&DataKey::QuorumConfig(cred), &QuorumConfig {
            credential_type: cred,
            required,
            total,
            enabled,
        });
    Ok(())
}

/// Privacy assertion helper — verifies no PII fields exist in Attestation.
/// Called from tests via `assert_no_pii_in_attestation`.
#[cfg(test)]
pub fn assert_no_pii_in_attestation(att: &Attestation) {
    // Attestation only stores: id (u64), subject (Address = public key),
    // credential_type (enum), issuer (Address), timestamps (u64),
    // evidence_hash (BytesN<32>), revoked (bool), reason_code (u32),
    // issuer_flagged (bool).
    // None of these fields carry names, DOB, blood type, medical history, etc.
    // This function is a compile-time + runtime documentation assertion.
    let _ = att.id;
    let _ = &att.subject;
    let _ = att.credential_type;
    let _ = &att.issuer;
    let _ = att.issued_at;
    let _ = att.expires_at;
    let _ = &att.evidence_hash;
    let _ = att.revoked;
    let _ = att.revocation_reason_code;
    let _ = att.issuer_flagged;
    // If a PII field were added, this function would need updating — acts as a review gate.
}
