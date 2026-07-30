#![cfg(test)]

use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, BytesN, Env, Vec,
};

use crate::{
    attestation::{assert_no_pii_in_attestation, CredentialType},
    IdentityContract, IdentityContractClient,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn make_contract<'a>(env: &'a Env, admin: &Address) -> IdentityContractClient<'a> {
    let id = env.register(IdentityContract, (admin,));
    IdentityContractClient::new(env, &id)
}

fn evidence() -> [u8; 32] {
    [0xABu8; 32]
}

fn evidence_hash(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &evidence())
}

// ---------------------------------------------------------------------------
// Task 1: Attestation storage + lifecycle + events
// ---------------------------------------------------------------------------

#[test]
fn test_attest_stores_record_and_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let client = make_contract(&env, &admin);

    let issuer = Address::generate(&env);
    let subject = Address::generate(&env);

    client.set_issuer_auth(&admin, &issuer, &CredentialType::DonorEligibility, &true);

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let id = client.attest(
        &issuer,
        &subject,
        &CredentialType::DonorEligibility,
        &5000u64,
        &evidence_hash(&env),
    );
    assert!(id > 0);

    let att = client.get_attestation(&id).unwrap();
    assert_eq!(att.subject, subject);
    assert_eq!(att.issuer, issuer);
    assert!(!att.revoked);
    assert_eq!(att.expires_at, 5000);

    // Privacy: no PII in stored record.
    assert_no_pii_in_attestation(&att);
}

#[test]
fn test_attest_requires_issuer_authorization() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let client = make_contract(&env, &admin);

    let issuer = Address::generate(&env);
    let subject = Address::generate(&env);

    env.ledger().with_mut(|l| l.timestamp = 1000);
    // Issuer not authorized — must fail.
    let result = client.try_attest(
        &issuer,
        &subject,
        &CredentialType::BloodBankAccreditation,
        &5000u64,
        &evidence_hash(&env),
    );
    assert!(result.is_err());
}

#[test]
fn test_attest_rejects_past_expiry() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let client = make_contract(&env, &admin);

    let issuer = Address::generate(&env);
    let subject = Address::generate(&env);
    client.set_issuer_auth(&admin, &issuer, &CredentialType::DonorEligibility, &true);

    env.ledger().with_mut(|l| l.timestamp = 5000);
    // expires_at <= now — must fail.
    let result = client.try_attest(
        &issuer,
        &subject,
        &CredentialType::DonorEligibility,
        &4999u64,
        &evidence_hash(&env),
    );
    assert!(result.is_err());
}

// ---------------------------------------------------------------------------
// Task 2: Per-credential-type issuer scoping + rogue-verifier cascade flags
// ---------------------------------------------------------------------------

#[test]
fn test_issuer_scoped_per_credential_type() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let client = make_contract(&env, &admin);

    let lab = Address::generate(&env);
    let subject = Address::generate(&env);

    // Lab authorized for DonorEligibility only.
    client.set_issuer_auth(&admin, &lab, &CredentialType::DonorEligibility, &true);

    env.ledger().with_mut(|l| l.timestamp = 1000);

    // DonorEligibility — allowed.
    let id = client.attest(
        &lab,
        &subject,
        &CredentialType::DonorEligibility,
        &9000u64,
        &evidence_hash(&env),
    );
    assert!(id > 0);

    // MedicalFacilityLicense — not authorized for lab.
    let result = client.try_attest(
        &lab,
        &subject,
        &CredentialType::MedicalFacilityLicense,
        &9000u64,
        &evidence_hash(&env),
    );
    assert!(result.is_err());
}

#[test]
fn test_flag_rogue_issuer_cascade_flags_without_auto_revoke() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let client = make_contract(&env, &admin);

    let issuer = Address::generate(&env);
    let subject1 = Address::generate(&env);
    let subject2 = Address::generate(&env);

    client.set_issuer_auth(&admin, &issuer, &CredentialType::BloodBankAccreditation, &true);
    env.ledger().with_mut(|l| l.timestamp = 1000);

    let id1 = client.attest(
        &issuer,
        &subject1,
        &CredentialType::BloodBankAccreditation,
        &9000u64,
        &evidence_hash(&env),
    );
    let id2 = client.attest(
        &issuer,
        &subject2,
        &CredentialType::BloodBankAccreditation,
        &9000u64,
        &evidence_hash(&env),
    );

    let mut ids: Vec<u64> = Vec::new(&env);
    ids.push_back(id1);
    ids.push_back(id2);

    let flagged = client.flag_rogue_issuer(&admin, &issuer, &ids);
    assert_eq!(flagged, 2);

    // Attestations are flagged but NOT revoked.
    let att1 = client.get_attestation(&id1).unwrap();
    assert!(att1.issuer_flagged);
    assert!(!att1.revoked); // no auto-revoke

    let att2 = client.get_attestation(&id2).unwrap();
    assert!(att2.issuer_flagged);
    assert!(!att2.revoked);

    // is_valid returns false for flagged attestations.
    assert!(!client.is_valid(&subject1, &CredentialType::BloodBankAccreditation, &false));
    assert!(!client.is_valid(&subject2, &CredentialType::BloodBankAccreditation, &false));
}

// ---------------------------------------------------------------------------
// Task 3: is_valid predicate + grace-period policies
// ---------------------------------------------------------------------------

#[test]
fn test_is_valid_true_for_active_attestation() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let client = make_contract(&env, &admin);

    let issuer = Address::generate(&env);
    let subject = Address::generate(&env);
    client.set_issuer_auth(&admin, &issuer, &CredentialType::MedicalFacilityLicense, &true);

    env.ledger().with_mut(|l| l.timestamp = 1000);
    client.attest(
        &issuer,
        &subject,
        &CredentialType::MedicalFacilityLicense,
        &9000u64,
        &evidence_hash(&env),
    );

    assert!(client.is_valid(&subject, &CredentialType::MedicalFacilityLicense, &false));
}

#[test]
fn test_is_valid_false_after_expiry_no_grace() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let client = make_contract(&env, &admin);

    let issuer = Address::generate(&env);
    let subject = Address::generate(&env);
    client.set_issuer_auth(&admin, &issuer, &CredentialType::MedicalFacilityLicense, &true);

    env.ledger().with_mut(|l| l.timestamp = 1000);
    client.attest(
        &issuer,
        &subject,
        &CredentialType::MedicalFacilityLicense,
        &2000u64,
        &evidence_hash(&env),
    );

    // Advance past expiry — new allocation blocked immediately.
    env.ledger().with_mut(|l| l.timestamp = 2001);
    assert!(!client.is_valid(&subject, &CredentialType::MedicalFacilityLicense, &false));
}

#[test]
fn test_grace_period_allows_in_flight_workflow() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let client = make_contract(&env, &admin);

    let issuer = Address::generate(&env);
    let subject = Address::generate(&env);
    client.set_issuer_auth(&admin, &issuer, &CredentialType::MedicalFacilityLicense, &true);

    // Set 3-day grace period for MedicalFacilityLicense.
    let grace = 3 * 24 * 3600u64;
    client.set_grace_policy(&admin, &CredentialType::MedicalFacilityLicense, &grace);

    env.ledger().with_mut(|l| l.timestamp = 1000);
    client.attest(
        &issuer,
        &subject,
        &CredentialType::MedicalFacilityLicense,
        &2000u64,
        &evidence_hash(&env),
    );

    // Just past expiry but within grace window.
    env.ledger().with_mut(|l| l.timestamp = 2001);

    // New allocation blocked (allow_grace=false).
    assert!(!client.is_valid(&subject, &CredentialType::MedicalFacilityLicense, &false));
    // In-flight workflow allowed (allow_grace=true).
    assert!(client.is_valid(&subject, &CredentialType::MedicalFacilityLicense, &true));

    // Past grace window — both blocked.
    env.ledger().with_mut(|l| l.timestamp = 2000 + grace + 1);
    assert!(!client.is_valid(&subject, &CredentialType::MedicalFacilityLicense, &true));
}

#[test]
fn test_is_valid_false_for_revoked_credential() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let client = make_contract(&env, &admin);

    let issuer = Address::generate(&env);
    let subject = Address::generate(&env);
    client.set_issuer_auth(&admin, &issuer, &CredentialType::RiderCertification, &true);

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let id = client.attest(
        &issuer,
        &subject,
        &CredentialType::RiderCertification,
        &9000u64,
        &evidence_hash(&env),
    );

    assert!(client.is_valid(&subject, &CredentialType::RiderCertification, &false));

    // Revoke — blocks new allocations in same ledger.
    client.revoke_attestation(&issuer, &id, &1u32);
    assert!(!client.is_valid(&subject, &CredentialType::RiderCertification, &false));
}

// ---------------------------------------------------------------------------
// Task 4: Expiry-race — credential expires between request and allocation
// ---------------------------------------------------------------------------

#[test]
fn test_expired_credential_blocks_new_allocation_same_ledger() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let client = make_contract(&env, &admin);

    let issuer = Address::generate(&env);
    let subject = Address::generate(&env);
    client.set_issuer_auth(&admin, &issuer, &CredentialType::BloodBankAccreditation, &true);

    env.ledger().with_mut(|l| l.timestamp = 1000);
    client.attest(
        &issuer,
        &subject,
        &CredentialType::BloodBankAccreditation,
        &2000u64,
        &evidence_hash(&env),
    );

    // Credential valid at request time.
    assert!(client.is_valid(&subject, &CredentialType::BloodBankAccreditation, &false));

    // Credential expires — allocation step re-checks and must block.
    env.ledger().with_mut(|l| l.timestamp = 2001);
    assert!(!client.is_valid(&subject, &CredentialType::BloodBankAccreditation, &false));
}

// ---------------------------------------------------------------------------
// Task 5: Renewal / supersede flow + paged history
// ---------------------------------------------------------------------------

#[test]
fn test_renew_supersedes_old_and_mints_new() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let client = make_contract(&env, &admin);

    let issuer = Address::generate(&env);
    let subject = Address::generate(&env);
    client.set_issuer_auth(&admin, &issuer, &CredentialType::MedicalFacilityLicense, &true);

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let old_id = client.attest(
        &issuer,
        &subject,
        &CredentialType::MedicalFacilityLicense,
        &5000u64,
        &evidence_hash(&env),
    );

    let new_id = client.renew_attestation(
        &issuer,
        &old_id,
        &15000u64,
        &evidence_hash(&env),
    );

    // Old is superseded (revoked with reason 99).
    let old = client.get_attestation(&old_id).unwrap();
    assert!(old.revoked);
    assert_eq!(old.revocation_reason_code, 99);

    // New is active.
    let new = client.get_attestation(&new_id).unwrap();
    assert!(!new.revoked);
    assert_eq!(new.subject, subject); // stable subject address
    assert_eq!(new.expires_at, 15000);

    // Subject is still valid.
    assert!(client.is_valid(&subject, &CredentialType::MedicalFacilityLicense, &false));
}

#[test]
fn test_paged_history_returns_all_attestations_including_superseded() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let client = make_contract(&env, &admin);

    let issuer = Address::generate(&env);
    let subject = Address::generate(&env);
    client.set_issuer_auth(&admin, &issuer, &CredentialType::MedicalFacilityLicense, &true);

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let id1 = client.attest(
        &issuer,
        &subject,
        &CredentialType::MedicalFacilityLicense,
        &5000u64,
        &evidence_hash(&env),
    );
    client.renew_attestation(&issuer, &id1, &15000u64, &evidence_hash(&env));

    // History contains both old (superseded) and new.
    let page = client.get_attestation_history(
        &subject,
        &CredentialType::MedicalFacilityLicense,
        &0u64,
        &50u32,
    );
    assert_eq!(page.total, 2);
    assert_eq!(page.items.len(), 2);
}

#[test]
fn test_paged_history_respects_offset_and_limit() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let client = make_contract(&env, &admin);

    let issuer = Address::generate(&env);
    let subject = Address::generate(&env);
    client.set_issuer_auth(&admin, &issuer, &CredentialType::DonorEligibility, &true);

    env.ledger().with_mut(|l| l.timestamp = 1000);
    for i in 0u64..5 {
        client.attest(
            &issuer,
            &subject,
            &CredentialType::DonorEligibility,
            &(9000 + i),
            &evidence_hash(&env),
        );
    }

    let page = client.get_attestation_history(
        &subject,
        &CredentialType::DonorEligibility,
        &2u64,
        &2u32,
    );
    assert_eq!(page.total, 5);
    assert_eq!(page.items.len(), 2);
    assert_eq!(page.offset, 2);
}

// ---------------------------------------------------------------------------
// Task 6: M-of-N quorum design + flagged implementation
// ---------------------------------------------------------------------------

#[test]
fn test_quorum_pending_until_threshold_reached() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let client = make_contract(&env, &admin);

    let v1 = Address::generate(&env);
    let v2 = Address::generate(&env);
    let subject = Address::generate(&env);

    client.set_issuer_auth(&admin, &v1, &CredentialType::LabAccreditation, &true);
    client.set_issuer_auth(&admin, &v2, &CredentialType::LabAccreditation, &true);

    // Enable 2-of-2 quorum.
    client.set_quorum_config(&admin, &CredentialType::LabAccreditation, &2u32, &2u32, &true);

    env.ledger().with_mut(|l| l.timestamp = 1000);

    // First vote — returns 0 (pending).
    let pending_id = client.attest(
        &v1,
        &subject,
        &CredentialType::LabAccreditation,
        &9000u64,
        &evidence_hash(&env),
    );
    assert_eq!(pending_id, 0); // not yet minted
    assert!(!client.is_valid(&subject, &CredentialType::LabAccreditation, &false));

    // Second vote — threshold reached, attestation minted.
    let real_id = client.attest(
        &v2,
        &subject,
        &CredentialType::LabAccreditation,
        &9000u64,
        &evidence_hash(&env),
    );
    assert!(real_id > 0);
    assert!(client.is_valid(&subject, &CredentialType::LabAccreditation, &false));
}

#[test]
fn test_quorum_duplicate_vote_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let client = make_contract(&env, &admin);

    let v1 = Address::generate(&env);
    let subject = Address::generate(&env);

    client.set_issuer_auth(&admin, &v1, &CredentialType::LabAccreditation, &true);
    client.set_quorum_config(&admin, &CredentialType::LabAccreditation, &2u32, &3u32, &true);

    env.ledger().with_mut(|l| l.timestamp = 1000);
    client.attest(
        &v1,
        &subject,
        &CredentialType::LabAccreditation,
        &9000u64,
        &evidence_hash(&env),
    );

    // Same verifier votes again — must fail.
    let result = client.try_attest(
        &v1,
        &subject,
        &CredentialType::LabAccreditation,
        &9000u64,
        &evidence_hash(&env),
    );
    assert!(result.is_err());
}

// ---------------------------------------------------------------------------
// Task 7: Privacy review — no PII in any stored type
// ---------------------------------------------------------------------------

#[test]
fn test_no_pii_in_attestation_type_layout() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let client = make_contract(&env, &admin);

    let issuer = Address::generate(&env);
    let subject = Address::generate(&env);
    client.set_issuer_auth(&admin, &issuer, &CredentialType::DonorEligibility, &true);

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let id = client.attest(
        &issuer,
        &subject,
        &CredentialType::DonorEligibility,
        &9000u64,
        &evidence_hash(&env),
    );

    let att = client.get_attestation(&id).unwrap();
    // Compile-time + runtime assertion: no PII fields.
    assert_no_pii_in_attestation(&att);
}

// ---------------------------------------------------------------------------
// Acceptance criteria: revoked credential blocks new allocations same ledger
// ---------------------------------------------------------------------------

#[test]
fn test_revoked_credential_blocks_allocation_same_ledger() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let client = make_contract(&env, &admin);

    let issuer = Address::generate(&env);
    let subject = Address::generate(&env);
    client.set_issuer_auth(&admin, &issuer, &CredentialType::BloodBankAccreditation, &true);

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let id = client.attest(
        &issuer,
        &subject,
        &CredentialType::BloodBankAccreditation,
        &9000u64,
        &evidence_hash(&env),
    );

    assert!(client.is_valid(&subject, &CredentialType::BloodBankAccreditation, &false));

    // Revoke — same ledger timestamp.
    client.revoke_attestation(&issuer, &id, &2u32);

    // Blocked in same ledger.
    assert!(!client.is_valid(&subject, &CredentialType::BloodBankAccreditation, &false));
}

// ---------------------------------------------------------------------------
// Acceptance criteria: rogue verifier revocation flags without collateral revoke
// ---------------------------------------------------------------------------

#[test]
fn test_rogue_verifier_flags_without_collateral_auto_revocation() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let client = make_contract(&env, &admin);

    let rogue = Address::generate(&env);
    let honest = Address::generate(&env);
    let subject_rogue = Address::generate(&env);
    let subject_honest = Address::generate(&env);

    client.set_issuer_auth(&admin, &rogue, &CredentialType::BloodBankAccreditation, &true);
    client.set_issuer_auth(&admin, &honest, &CredentialType::BloodBankAccreditation, &true);

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let rogue_id = client.attest(
        &rogue,
        &subject_rogue,
        &CredentialType::BloodBankAccreditation,
        &9000u64,
        &evidence_hash(&env),
    );
    let honest_id = client.attest(
        &honest,
        &subject_honest,
        &CredentialType::BloodBankAccreditation,
        &9000u64,
        &evidence_hash(&env),
    );

    let mut rogue_ids: Vec<u64> = Vec::new(&env);
    rogue_ids.push_back(rogue_id);
    client.flag_rogue_issuer(&admin, &rogue, &rogue_ids);

    // Rogue's attestation is flagged → is_valid = false.
    assert!(!client.is_valid(&subject_rogue, &CredentialType::BloodBankAccreditation, &false));

    // Honest issuer's attestation is unaffected — no collateral revocation.
    let honest_att = client.get_attestation(&honest_id).unwrap();
    assert!(!honest_att.revoked);
    assert!(!honest_att.issuer_flagged);
    assert!(client.is_valid(&subject_honest, &CredentialType::BloodBankAccreditation, &false));
}
