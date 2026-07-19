#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Bytes, BytesN, Env,
};

const DEFAULT_MIN_TEMPERATURE_C: i32 = 2;
const DEFAULT_MAX_TEMPERATURE_C: i32 = 6;
/// ~24 hours at 5 seconds per ledger.
const DEFAULT_CONFIRMATION_WINDOW_LEDGERS: u32 = 17_280;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 700,
    NotInitialized = 701,
    DeliveryNotFound = 702,
    ProofAlreadySubmitted = 703,
    ProofNotFound = 704,
    ProofAlreadyConfirmed = 705,
    HashMismatch = 706,
    ConfirmationWindowExpired = 707,
    ConfirmationWindowNotExpired = 708,
    MissingRequiredProof = 709,
    CourierEqualsFacility = 710,
    UnauthorizedFacility = 711,
    InvalidConfirmationWindow = 712,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TemperatureThresholds {
    pub min_celsius: i32,
    pub max_celsius: i32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProofRequirements {
    pub requires_photo_proof: bool,
    pub requires_recipient_signature: bool,
    pub requires_temperature_log: bool,
}

/// Lifecycle of a two-phase proof commitment.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DeliveryStatus {
    Submitted,
    Confirmed,
    ContestableTimeout,
}

/// Cryptographic commitment binding an on-chain delivery to the off-chain
/// evidence bundle assembled by the backend proof-bundle module.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProofCommitment {
    pub delivery_id: u64,
    pub bundle_hash: BytesN<32>,
    pub courier: Address,
    pub facility: Address,
    pub submitted_at: u64,
    pub confirmed_at: Option<u64>,
    pub status: DeliveryStatus,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    RequestContract,
    DeliveryCounter,
    TemperatureThresholds,
    ProofRequirements,
    ConfirmationWindow,
    ComplianceAttestation(u64),
    ProofCommitment(u64),
}

#[contract]
pub struct DeliveryContract;

#[contractimpl]
impl DeliveryContract {
    #[allow(deprecated)] // events pending migration to #[contractevent]
    pub fn initialize(env: Env, admin: Address, request_contract: Address) -> Result<(), Error> {
        admin.require_auth();

        if Self::is_initialized(env.clone()) {
            return Err(Error::AlreadyInitialized);
        }

        let thresholds = TemperatureThresholds {
            min_celsius: DEFAULT_MIN_TEMPERATURE_C,
            max_celsius: DEFAULT_MAX_TEMPERATURE_C,
        };
        let proof_requirements = ProofRequirements {
            requires_photo_proof: true,
            requires_recipient_signature: true,
            requires_temperature_log: true,
        };

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::RequestContract, &request_contract);
        env.storage()
            .instance()
            .set(&DataKey::DeliveryCounter, &0u64);
        env.storage()
            .instance()
            .set(&DataKey::TemperatureThresholds, &thresholds);
        env.storage()
            .instance()
            .set(&DataKey::ProofRequirements, &proof_requirements);
        env.storage().instance().set(
            &DataKey::ConfirmationWindow,
            &DEFAULT_CONFIRMATION_WINDOW_LEDGERS,
        );

        env.events().publish(
            (symbol_short!("init"), symbol_short!("v1")),
            (admin, request_contract),
        );

        Ok(())
    }

    pub fn is_initialized(env: Env) -> bool {
        env.storage().instance().has(&DataKey::Admin)
    }

    pub fn get_admin(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)
    }

    pub fn get_request_contract(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::RequestContract)
            .ok_or(Error::NotInitialized)
    }

    pub fn get_delivery_counter(env: Env) -> Result<u64, Error> {
        env.storage()
            .instance()
            .get(&DataKey::DeliveryCounter)
            .ok_or(Error::NotInitialized)
    }

    pub fn get_temperature_thresholds(env: Env) -> Result<TemperatureThresholds, Error> {
        env.storage()
            .instance()
            .get(&DataKey::TemperatureThresholds)
            .ok_or(Error::NotInitialized)
    }

    pub fn get_proof_requirements(env: Env) -> Result<ProofRequirements, Error> {
        env.storage()
            .instance()
            .get(&DataKey::ProofRequirements)
            .ok_or(Error::NotInitialized)
    }

    /// Record a compliance attestation hash for a completed delivery.
    /// The hash is produced off-chain by the backend after evaluating telemetry.
    #[allow(deprecated)] // events pending migration to #[contractevent]
    pub fn record_compliance_attestation(
        env: Env,
        admin: Address,
        delivery_id: u64,
        compliance_hash: Bytes,
        is_compliant: bool,
    ) -> Result<(), Error> {
        admin.require_auth();
        if !Self::is_initialized(env.clone()) {
            return Err(Error::NotInitialized);
        }

        env.storage().persistent().set(
            &DataKey::ComplianceAttestation(delivery_id),
            &(compliance_hash.clone(), is_compliant),
        );

        env.events().publish(
            (symbol_short!("comply"), symbol_short!("v1")),
            (delivery_id, compliance_hash, is_compliant),
        );

        Ok(())
    }

    /// Retrieve the stored compliance attestation for a delivery.
    pub fn get_compliance_attestation(env: Env, delivery_id: u64) -> Result<(Bytes, bool), Error> {
        env.storage()
            .persistent()
            .get(&DataKey::ComplianceAttestation(delivery_id))
            .ok_or(Error::DeliveryNotFound)
    }

    /// Ledgers the facility has to confirm a submitted proof.
    pub fn get_confirmation_window(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::ConfirmationWindow)
            .unwrap_or(DEFAULT_CONFIRMATION_WINDOW_LEDGERS)
    }

    #[allow(deprecated)] // events pending migration to #[contractevent]
    pub fn set_confirmation_window(env: Env, window_ledgers: u32) -> Result<(), Error> {
        let admin = Self::get_admin(env.clone())?;
        admin.require_auth();
        if window_ledgers == 0 {
            return Err(Error::InvalidConfirmationWindow);
        }

        env.storage()
            .instance()
            .set(&DataKey::ConfirmationWindow, &window_ledgers);

        env.events().publish(
            (symbol_short!("cfg_win"), symbol_short!("v1")),
            window_ledgers,
        );

        Ok(())
    }

    #[allow(deprecated)] // events pending migration to #[contractevent]
    pub fn set_proof_requirements(env: Env, requirements: ProofRequirements) -> Result<(), Error> {
        let admin = Self::get_admin(env.clone())?;
        admin.require_auth();

        env.storage()
            .instance()
            .set(&DataKey::ProofRequirements, &requirements);

        env.events().publish(
            (symbol_short!("cfg_req"), symbol_short!("v1")),
            requirements,
        );

        Ok(())
    }

    /// Phase 1 of two-phase confirmation: the courier commits to the hash of
    /// the off-chain evidence bundle. `declared_proofs` states which proof
    /// artifacts the bundle contains; every proof required by the configured
    /// `ProofRequirements` must be declared.
    #[allow(deprecated)] // events pending migration to #[contractevent]
    pub fn submit_proof(
        env: Env,
        courier: Address,
        facility: Address,
        delivery_id: u64,
        bundle_hash: BytesN<32>,
        declared_proofs: ProofRequirements,
    ) -> Result<(), Error> {
        courier.require_auth();

        let required = Self::get_proof_requirements(env.clone())?;
        if courier == facility {
            return Err(Error::CourierEqualsFacility);
        }
        if env
            .storage()
            .persistent()
            .has(&DataKey::ProofCommitment(delivery_id))
        {
            return Err(Error::ProofAlreadySubmitted);
        }
        if (required.requires_photo_proof && !declared_proofs.requires_photo_proof)
            || (required.requires_recipient_signature
                && !declared_proofs.requires_recipient_signature)
            || (required.requires_temperature_log && !declared_proofs.requires_temperature_log)
        {
            return Err(Error::MissingRequiredProof);
        }

        let commitment = ProofCommitment {
            delivery_id,
            bundle_hash: bundle_hash.clone(),
            courier: courier.clone(),
            facility: facility.clone(),
            submitted_at: env.ledger().sequence() as u64,
            confirmed_at: None,
            status: DeliveryStatus::Submitted,
        };
        env.storage()
            .persistent()
            .set(&DataKey::ProofCommitment(delivery_id), &commitment);

        env.events().publish(
            (symbol_short!("submit"), symbol_short!("v1")),
            (delivery_id, bundle_hash, courier, facility),
        );

        Ok(())
    }

    /// Phase 2: the receiving facility independently confirms the delivery by
    /// presenting the exact bundle hash it verified off-chain. A mismatch is a
    /// distinct, retryable error that leaves the submission open. Confirmation
    /// must land within the configured window (inclusive) of submission.
    #[allow(deprecated)] // events pending migration to #[contractevent]
    pub fn confirm_receipt(
        env: Env,
        facility: Address,
        delivery_id: u64,
        bundle_hash: BytesN<32>,
    ) -> Result<(), Error> {
        facility.require_auth();

        let mut commitment = Self::get_proof_commitment(env.clone(), delivery_id)?;
        if facility != commitment.facility {
            return Err(Error::UnauthorizedFacility);
        }
        match commitment.status {
            DeliveryStatus::Confirmed => return Err(Error::ProofAlreadyConfirmed),
            DeliveryStatus::ContestableTimeout => return Err(Error::ConfirmationWindowExpired),
            DeliveryStatus::Submitted => {}
        }

        let now = env.ledger().sequence() as u64;
        let deadline = commitment.submitted_at + Self::get_confirmation_window(env.clone()) as u64;
        if now > deadline {
            return Err(Error::ConfirmationWindowExpired);
        }

        if bundle_hash != commitment.bundle_hash {
            // Diagnostic only: a returned error rolls the event back on-chain,
            // but it surfaces in simulation traces.
            env.events().publish(
                (symbol_short!("mismatch"), symbol_short!("v1")),
                (delivery_id, bundle_hash, facility),
            );
            return Err(Error::HashMismatch);
        }

        commitment.confirmed_at = Some(now);
        commitment.status = DeliveryStatus::Confirmed;
        env.storage()
            .persistent()
            .set(&DataKey::ProofCommitment(delivery_id), &commitment);

        env.events().publish(
            (symbol_short!("confirm"), symbol_short!("v1")),
            (delivery_id, bundle_hash, facility),
        );

        Ok(())
    }

    /// Persist the timeout transition once the confirmation window has passed
    /// without facility confirmation. Callable by anyone — expiry is an
    /// objective ledger fact — and leaves the delivery contestable rather than
    /// confirmed or silently failed.
    #[allow(deprecated)] // events pending migration to #[contractevent]
    pub fn mark_timeout(env: Env, delivery_id: u64) -> Result<(), Error> {
        let mut commitment = Self::get_proof_commitment(env.clone(), delivery_id)?;
        match commitment.status {
            DeliveryStatus::Confirmed => return Err(Error::ProofAlreadyConfirmed),
            DeliveryStatus::ContestableTimeout => return Err(Error::ConfirmationWindowExpired),
            DeliveryStatus::Submitted => {}
        }

        let now = env.ledger().sequence() as u64;
        let deadline = commitment.submitted_at + Self::get_confirmation_window(env.clone()) as u64;
        if now <= deadline {
            return Err(Error::ConfirmationWindowNotExpired);
        }

        commitment.status = DeliveryStatus::ContestableTimeout;
        env.storage()
            .persistent()
            .set(&DataKey::ProofCommitment(delivery_id), &commitment);

        env.events().publish(
            (symbol_short!("timeout"), symbol_short!("v1")),
            (delivery_id, commitment.bundle_hash, commitment.courier),
        );

        Ok(())
    }

    pub fn get_proof_commitment(env: Env, delivery_id: u64) -> Result<ProofCommitment, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::ProofCommitment(delivery_id))
            .ok_or(Error::ProofNotFound)
    }

    /// Effective status: reports `ContestableTimeout` for an expired-but-not-
    /// yet-marked submission so readers never see a stale `Submitted`.
    pub fn get_delivery_status(env: Env, delivery_id: u64) -> Result<DeliveryStatus, Error> {
        let commitment = Self::get_proof_commitment(env.clone(), delivery_id)?;
        if commitment.status == DeliveryStatus::Submitted {
            let deadline =
                commitment.submitted_at + Self::get_confirmation_window(env.clone()) as u64;
            if (env.ledger().sequence() as u64) > deadline {
                return Ok(DeliveryStatus::ContestableTimeout);
            }
        }
        Ok(commitment.status)
    }
}

mod test;
