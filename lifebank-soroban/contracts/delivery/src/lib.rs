#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Bytes, BytesN, Env,
};

mod events;

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
    MigrationAlreadyApplied = 703,
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

fn do_delivery_init(env: &Env, admin: Address, request_contract: Address) {
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

    events::emit_initialized(env, &admin, &request_contract);
}

#[contractimpl]
impl DeliveryContract {
    /// Atomic constructor — deploy + init in a single transaction.
    pub fn __constructor(env: Env, admin: Address, request_contract: Address) {
        admin.require_auth();
        if Self::is_initialized(env.clone()) {
            panic!("already initialized");
        }
        do_delivery_init(&env, admin, request_contract);
    }

    #[allow(deprecated)] // events pending migration to #[contractevent]
    pub fn initialize(env: Env, admin: Address, request_contract: Address) -> Result<(), Error> {
        admin.require_auth();

        if Self::is_initialized(env.clone()) {
            return Err(Error::AlreadyInitialized);
        }

        do_delivery_init(&env, admin, request_contract);
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

    // ── Upgradeability & versioned storage schema (#31) ──────────────────────

    /// Code version of the currently deployed binary.
    pub fn version(_env: Env) -> u32 {
        CONTRACT_VERSION
    }

    /// Storage schema version currently recorded on-chain (1 when unset).
    pub fn schema_version(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&SCHEMA_VERSION_KEY)
            .unwrap_or(1)
    }

    /// Replace the running WASM with an already-installed hash. Admin only.
    /// The contract ID and all storage are preserved; call `migrate` after
    /// the upgrade when the new binary bumps `TARGET_SCHEMA_VERSION`.
    pub fn upgrade(env: Env, new_wasm_hash: soroban_sdk::BytesN<32>) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    /// Apply version-gated storage migrations after an upgrade. Admin only.
    /// Refuses to run once storage already sits at `TARGET_SCHEMA_VERSION`,
    /// so a migration can never be applied twice.
    pub fn migrate(env: Env) -> Result<u32, Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        let current = Self::schema_version(env.clone());
        if current >= TARGET_SCHEMA_VERSION {
            return Err(Error::MigrationAlreadyApplied);
        }
        // Version-gated transformations run here as the schema evolves, e.g.
        // `if current < 2 { /* rewrite v1 entries into the v2 layout */ }`.
        env.storage()
            .instance()
            .set(&SCHEMA_VERSION_KEY, &TARGET_SCHEMA_VERSION);
        Ok(TARGET_SCHEMA_VERSION)
    }
}

mod test;

// ── Upgradeability & versioned storage schema (#31) ───────────────────────────
//
// Invariant: after an upgrade, the new binary must be able to read every
// prior storage schema version until `migrate` has completed. Absence of the
// stored schema version means schema 1.

/// Code version compiled into this binary. Bump on every release.
pub const CONTRACT_VERSION: u32 = 1;

/// Storage schema version this binary writes. Bump only together with a
/// version-gated transformation in `migrate`.
pub const TARGET_SCHEMA_VERSION: u32 = 1;

const SCHEMA_VERSION_KEY: soroban_sdk::Symbol = soroban_sdk::symbol_short!("SCHEMA_V");
