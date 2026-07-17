#![cfg(test)]

//! Cross-contract integration tests for the coordinator workflow.
//!
//! Each test registers mock implementations of the four domain contracts
//! alongside the coordinator in a single Soroban test environment, then
//! drives the full request → allocation → delivery → settlement sequence.

use soroban_sdk::{
    contract, contractimpl, contracttype, testutils::Address as _, vec, Address, Env, String, Vec,
};

use super::{
    BloodRequest, BloodStatus, BloodUnit, CoordinatorContract, CoordinatorContractClient,
    CoordinatorError, Payment, PaymentStatus, RequestStatus, WorkflowStatus,
};

// ── Mock: Request contract ────────────────────────────────────────────────────

#[contracttype]
enum ReqKey {
    Request(u64),
    Counter,
}

#[contract]
struct MockRequestContract;

#[contractimpl]
impl MockRequestContract {
    pub fn version() -> u32 {
        1
    }

    pub fn seed_request(env: Env, id: u64, status: RequestStatus) {
        env.storage()
            .persistent()
            .set(&ReqKey::Request(id), &BloodRequest { id, status });
    }

    pub fn get_request(env: Env, request_id: u64) -> BloodRequest {
        env.storage()
            .persistent()
            .get(&ReqKey::Request(request_id))
            .unwrap()
    }
}

// ── Mock: Inventory contract ──────────────────────────────────────────────────

#[contracttype]
enum InvKey {
    Unit(u64),
    Admin,
    Counter,
}

#[contract]
struct MockInventoryContract;

#[contractimpl]
impl MockInventoryContract {
    pub fn version() -> u32 {
        1
    }

    pub fn initialize(env: Env, admin: Address) {
        env.storage().instance().set(&InvKey::Admin, &admin);
        env.storage().instance().set(&InvKey::Counter, &0u64);
    }

    pub fn get_admin(env: Env) -> Address {
        env.storage().instance().get(&InvKey::Admin).unwrap()
    }

    pub fn register_unit(env: Env) -> u64 {
        let id: u64 = env
            .storage()
            .instance()
            .get(&InvKey::Counter)
            .unwrap_or(0u64)
            + 1;
        env.storage().instance().set(&InvKey::Counter, &id);
        env.storage().persistent().set(
            &InvKey::Unit(id),
            &BloodUnit {
                id,
                status: BloodStatus::Available,
            },
        );
        id
    }

    pub fn get_blood_unit(env: Env, blood_unit_id: u64) -> BloodUnit {
        env.storage()
            .persistent()
            .get(&InvKey::Unit(blood_unit_id))
            .unwrap()
    }

    pub fn update_status(
        env: Env,
        unit_id: u64,
        new_status: BloodStatus,
        _authorized_by: Address,
        _reason: Option<String>,
    ) -> BloodUnit {
        let mut unit: BloodUnit = env
            .storage()
            .persistent()
            .get(&InvKey::Unit(unit_id))
            .unwrap();
        unit.status = new_status;
        env.storage().persistent().set(&InvKey::Unit(unit_id), &unit);
        unit
    }

    pub fn mark_delivered(
        env: Env,
        unit_id: u64,
        authorized_by: Address,
        delivery_location: String,
    ) -> BloodUnit {
        Self::update_status(env, unit_id, BloodStatus::Delivered, authorized_by, Some(delivery_location))
    }
}

// ── Mock: Payment contract ────────────────────────────────────────────────────

#[contracttype]
enum PayKey {
    Payment(u64),
    Counter,
}

#[contract]
struct MockPaymentContract;

#[contractimpl]
impl MockPaymentContract {
    pub fn version() -> u32 {
        1
    }

    pub fn create_payment(env: Env, request_id: u64, status: PaymentStatus) -> u64 {
        let id: u64 = env
            .storage()
            .instance()
            .get(&PayKey::Counter)
            .unwrap_or(0u64)
            + 1;
        env.storage().instance().set(&PayKey::Counter, &id);
        env.storage().persistent().set(
            &PayKey::Payment(id),
            &Payment { id, request_id, status },
        );
        id
    }

    pub fn get_payment(env: Env, payment_id: u64) -> Payment {
        env.storage()
            .persistent()
            .get(&PayKey::Payment(payment_id))
            .unwrap()
    }

    pub fn update_status(env: Env, payment_id: u64, status: PaymentStatus) {
        let mut p: Payment = env
            .storage()
            .persistent()
            .get(&PayKey::Payment(payment_id))
            .unwrap();
        p.status = status;
        env.storage()
            .persistent()
            .set(&PayKey::Payment(payment_id), &p);
    }

    pub fn record_dispute(env: Env, payment_id: u64, _reason: super::payment_client::DisputeReason, _case_id: String) {
        let mut p: Payment = env
            .storage()
            .persistent()
            .get(&PayKey::Payment(payment_id))
            .unwrap();
        p.status = PaymentStatus::Disputed;
        env.storage()
            .persistent()
            .set(&PayKey::Payment(payment_id), &p);
    }
}

// ── Harness ───────────────────────────────────────────────────────────────────

struct Harness<'a> {
    env: Env,
    admin: Address,
    coord: CoordinatorContractClient<'a>,
    req_id: Address,
    inv_id: Address,
    pay_id: Address,
}

fn setup<'a>() -> Harness<'a> {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);

    let req_id = env.register(MockRequestContract, ());
    let inv_id = env.register(MockInventoryContract, ());
    let pay_id = env.register(MockPaymentContract, ());
    let coord_id = env.register(CoordinatorContract, ());

    // Initialize inventory mock with admin
    let inv = MockInventoryContractClient::new(&env, &inv_id);
    inv.initialize(&admin);

    let coord = CoordinatorContractClient::new(&env, &coord_id);
    coord.initialize(&admin, &req_id, &inv_id, &pay_id);

    Harness { env, admin, coord, req_id, inv_id, pay_id }
}

fn seed_pending_request(h: &Harness, id: u64) {
    MockRequestContractClient::new(&h.env, &h.req_id)
        .seed_request(&id, &RequestStatus::Pending);
}

fn register_unit(h: &Harness) -> u64 {
    MockInventoryContractClient::new(&h.env, &h.inv_id).register_unit()
}

fn create_locked_payment(h: &Harness, request_id: u64) -> u64 {
    MockPaymentContractClient::new(&h.env, &h.pay_id)
        .create_payment(&request_id, &PaymentStatus::Locked)
}

// ── Happy path ────────────────────────────────────────────────────────────────

#[test]
fn test_full_happy_path() {
    let h = setup();
    seed_pending_request(&h, 1);
    let unit_id = register_unit(&h);
    let payment_id = create_locked_payment(&h, 1);

    h.coord.allocate_units(&1u64, &vec![&h.env, unit_id], &payment_id, &h.admin);

    let wf = h.coord.get_workflow(&1u64);
    assert_eq!(wf.status, WorkflowStatus::Allocated);
    assert!(!wf.delivery_confirmed);

    let unit = MockInventoryContractClient::new(&h.env, &h.inv_id).get_blood_unit(&unit_id);
    assert_eq!(unit.status, BloodStatus::Reserved);

    h.coord.confirm_delivery(&1u64, &h.admin);

    let wf = h.coord.get_workflow(&1u64);
    assert_eq!(wf.status, WorkflowStatus::Delivered);
    assert!(wf.delivery_confirmed);

    let unit = MockInventoryContractClient::new(&h.env, &h.inv_id).get_blood_unit(&unit_id);
    assert_eq!(unit.status, BloodStatus::Delivered);

    h.coord.settle_payment(&1u64, &h.admin);

    let wf = h.coord.get_workflow(&1u64);
    assert_eq!(wf.status, WorkflowStatus::Settled);

    let payment = MockPaymentContractClient::new(&h.env, &h.pay_id).get_payment(&payment_id);
    assert_eq!(payment.status, PaymentStatus::Released);
}

// ── Sequence enforcement ──────────────────────────────────────────────────────

#[test]
fn test_settle_blocked_without_delivery() {
    let h = setup();
    seed_pending_request(&h, 1);
    let unit_id = register_unit(&h);
    let payment_id = create_locked_payment(&h, 1);

    h.coord.allocate_units(&1u64, &vec![&h.env, unit_id], &payment_id, &h.admin);

    let result = h.coord.try_settle_payment(&1u64, &h.admin);
    assert_eq!(result, Err(Ok(CoordinatorError::DeliveryNotConfirmed)));

    let payment = MockPaymentContractClient::new(&h.env, &h.pay_id).get_payment(&payment_id);
    assert_eq!(payment.status, PaymentStatus::Locked);
}

#[test]
fn test_double_allocation_blocked() {
    let h = setup();
    seed_pending_request(&h, 1);
    let unit_id = register_unit(&h);
    let payment_id = create_locked_payment(&h, 1);

    h.coord.allocate_units(&1u64, &vec![&h.env, unit_id], &payment_id, &h.admin);

    let unit_id2 = register_unit(&h);
    let result = h.coord.try_allocate_units(
        &1u64,
        &vec![&h.env, unit_id2],
        &payment_id,
        &h.admin,
    );
    assert_eq!(result, Err(Ok(CoordinatorError::WorkflowAlreadyStarted)));
}

#[test]
fn test_allocate_blocked_for_unavailable_unit() {
    let h = setup();
    seed_pending_request(&h, 1);
    let unit_id = register_unit(&h);
    let payment_id = create_locked_payment(&h, 1);

    // Pre-reserve the unit
    MockInventoryContractClient::new(&h.env, &h.inv_id)
        .update_status(&unit_id, &BloodStatus::Reserved, &h.admin, &None);

    let result = h.coord.try_allocate_units(
        &1u64,
        &vec![&h.env, unit_id],
        &payment_id,
        &h.admin,
    );
    assert_eq!(result, Err(Ok(CoordinatorError::UnitNotAvailable)));
}

#[test]
fn test_settle_blocked_for_pending_payment() {
    let h = setup();
    seed_pending_request(&h, 1);
    let unit_id = register_unit(&h);
    // Payment left Pending (not Locked)
    let payment_id = MockPaymentContractClient::new(&h.env, &h.pay_id)
        .create_payment(&1u64, &PaymentStatus::Pending);

    h.coord.allocate_units(&1u64, &vec![&h.env, unit_id], &payment_id, &h.admin);
    h.coord.confirm_delivery(&1u64, &h.admin);

    let result = h.coord.try_settle_payment(&1u64, &h.admin);
    assert_eq!(result, Err(Ok(CoordinatorError::InvalidPaymentState)));
}

#[test]
fn test_confirm_delivery_blocked_before_allocation() {
    let h = setup();
    let result = h.coord.try_confirm_delivery(&99u64, &h.admin);
    assert_eq!(result, Err(Ok(CoordinatorError::WorkflowNotFound)));
}

#[test]
fn test_allocate_blocked_for_non_pending_request() {
    let h = setup();
    // Seed request with Approved status (not Pending)
    MockRequestContractClient::new(&h.env, &h.req_id)
        .seed_request(&1u64, &RequestStatus::Approved);
    let unit_id = register_unit(&h);
    let payment_id = create_locked_payment(&h, 1);

    let result = h.coord.try_allocate_units(
        &1u64,
        &vec![&h.env, unit_id],
        &payment_id,
        &h.admin,
    );
    assert_eq!(result, Err(Ok(CoordinatorError::InvalidRequestState)));
}

// ── Rollback ──────────────────────────────────────────────────────────────────

#[test]
fn test_rollback_releases_units_and_refunds_payment() {
    let h = setup();
    seed_pending_request(&h, 1);
    let unit_id = register_unit(&h);
    let payment_id = create_locked_payment(&h, 1);

    h.coord.allocate_units(&1u64, &vec![&h.env, unit_id], &payment_id, &h.admin);
    h.coord.rollback(&1u64);

    let wf = h.coord.get_workflow(&1u64);
    assert_eq!(wf.status, WorkflowStatus::RolledBack);

    let unit = MockInventoryContractClient::new(&h.env, &h.inv_id).get_blood_unit(&unit_id);
    assert_eq!(unit.status, BloodStatus::Available);

    let payment = MockPaymentContractClient::new(&h.env, &h.pay_id).get_payment(&payment_id);
    assert_eq!(payment.status, PaymentStatus::Refunded);
}

#[test]
fn test_rollback_blocked_after_settlement() {
    let h = setup();
    seed_pending_request(&h, 1);
    let unit_id = register_unit(&h);
    let payment_id = create_locked_payment(&h, 1);

    h.coord.allocate_units(&1u64, &vec![&h.env, unit_id], &payment_id, &h.admin);
    h.coord.confirm_delivery(&1u64, &h.admin);
    h.coord.settle_payment(&1u64, &h.admin);

    let result = h.coord.try_rollback(&1u64);
    assert_eq!(result, Err(Ok(CoordinatorError::CannotRollbackSettled)));
}

// ── Circuit breaker tests ─────────────────────────────────────────────────────

#[test]
fn test_coordinator_pause_blocks_allocate_units() {
    let h = setup();
    h.coord.pause(&h.admin);
    assert!(h.coord.is_paused());

    seed_pending_request(&h, 1);
    let unit_id = register_unit(&h);
    let pay_id = create_locked_payment(&h, 1);

    let result = h.coord.try_allocate_units(&1u64, &vec![&h.env, unit_id], &pay_id, &h.admin);
    assert!(result.is_err());
}

#[test]
fn test_coordinator_pause_allows_get_workflow() {
    let h = setup();

    // Create a workflow first
    seed_pending_request(&h, 10);
    let unit_id = register_unit(&h);
    let pay_id = create_locked_payment(&h, 10);
    h.coord.allocate_units(&10u64, &vec![&h.env, unit_id], &pay_id, &h.admin);

    h.coord.pause(&h.admin);

    // Read still works
    let wf = h.coord.get_workflow(&10u64);
    assert_eq!(wf.request_id, 10);
}

#[test]
fn test_coordinator_unpause_restores_writes() {
    let h = setup();
    h.coord.pause(&h.admin);
    h.coord.unpause(&h.admin);
    assert!(!h.coord.is_paused());

    seed_pending_request(&h, 20);
    let unit_id = register_unit(&h);
    let pay_id = create_locked_payment(&h, 20);
    h.coord.allocate_units(&20u64, &vec![&h.env, unit_id], &pay_id, &h.admin);
    assert_eq!(h.coord.get_workflow(&20u64).status, WorkflowStatus::Allocated);
}

#[test]
#[should_panic]
fn test_coordinator_non_admin_cannot_pause() {
    let h = setup();
    let attacker = Address::generate(&h.env);
    h.coord.pause(&attacker);
}

// ── Temperature excursion → dispute integration tests (issue #477) ────────────

use super::ExcursionSummary;

fn make_excursion(unit_id: u64) -> ExcursionSummary {
    ExcursionSummary {
        unit_id,
        violation_count: 3,
        peak_celsius_x100: 1200, // 12.00°C — above threshold
        detected_at: 1000,
    }
}

/// Full chain: flag_temperature_breach transitions Locked → Disputed.
#[test]
fn test_flag_temperature_breach_transitions_locked_to_disputed() {
    let h = setup();
    let payment_id = create_locked_payment(&h, 99);

    let excursion = make_excursion(42);
    h.coord
        .flag_temperature_breach(&h.admin, &payment_id, &excursion);

    let payment = MockPaymentContractClient::new(&h.env, &h.pay_id).get_payment(&payment_id);
    assert_eq!(
        payment.status,
        PaymentStatus::Disputed,
        "Payment must be Disputed after temperature breach"
    );
}

/// flag_temperature_breach on a non-Locked payment returns InvalidPaymentState.
#[test]
fn test_flag_temperature_breach_non_locked_payment_fails() {
    let h = setup();
    // Create a Released payment
    let payment_id = MockPaymentContractClient::new(&h.env, &h.pay_id)
        .create_payment(&1u64, &PaymentStatus::Released);

    let excursion = make_excursion(1);
    let result = h
        .coord
        .try_flag_temperature_breach(&h.admin, &payment_id, &excursion);
    assert_eq!(
        result,
        Err(Ok(CoordinatorError::InvalidPaymentState)),
        "Non-Locked payment must return InvalidPaymentState"
    );
}

/// flag_temperature_breach on a missing payment returns PaymentNotFound.
#[test]
fn test_flag_temperature_breach_missing_payment_fails() {
    let h = setup();
    let excursion = make_excursion(1);
    let result = h
        .coord
        .try_flag_temperature_breach(&h.admin, &9999u64, &excursion);
    assert_eq!(
        result,
        Err(Ok(CoordinatorError::PaymentNotFound)),
        "Missing payment must return PaymentNotFound"
    );
}

/// Paused coordinator rejects flag_temperature_breach.
#[test]
fn test_flag_temperature_breach_blocked_when_paused() {
    let h = setup();
    let payment_id = create_locked_payment(&h, 1);
    h.coord.pause(&h.admin);

    let excursion = make_excursion(1);
    let result = h
        .coord
        .try_flag_temperature_breach(&h.admin, &payment_id, &excursion);
    assert_eq!(result, Err(Ok(CoordinatorError::ContractPaused)));

    // Payment must remain Locked
    let payment = MockPaymentContractClient::new(&h.env, &h.pay_id).get_payment(&payment_id);
    assert_eq!(payment.status, PaymentStatus::Locked);
}

// ── Timelocked upgradeability, schema migration & version gates (#31) ─────────

mod upgrade_tests {
    use super::*;
    use crate::{CONTRACT_VERSION, TARGET_SCHEMA_VERSION, UPGRADE_TIMELOCK_SECS};
    use soroban_sdk::testutils::Ledger as _;
    use soroban_sdk::{contract, contractimpl, BytesN};

    #[test]
    fn test_version_and_default_schema_version() {
        let h = setup();
        assert_eq!(h.coord.version(), CONTRACT_VERSION);
        assert_eq!(h.coord.schema_version(), 1);
    }

    #[test]
    fn test_propose_upgrade_queues_behind_timelock() {
        let h = setup();
        h.env.ledger().with_mut(|l| l.timestamp = 10_000);

        let hash = BytesN::from_array(&h.env, &[9u8; 32]);
        let executable_at = h.coord.propose_upgrade(&hash);
        assert_eq!(executable_at, 10_000 + UPGRADE_TIMELOCK_SECS);

        let pending = h.coord.get_pending_upgrade().unwrap();
        assert_eq!(pending.new_wasm_hash, hash);
        assert_eq!(pending.executable_at, executable_at);
    }

    #[test]
    fn test_execute_upgrade_before_timelock_elapses_fails() {
        let h = setup();
        h.env.ledger().with_mut(|l| l.timestamp = 10_000);

        let hash = BytesN::from_array(&h.env, &[9u8; 32]);
        let executable_at = h.coord.propose_upgrade(&hash);

        h.env.ledger().with_mut(|l| l.timestamp = executable_at - 1);
        assert_eq!(
            h.coord.try_execute_upgrade(),
            Err(Ok(CoordinatorError::TimelockNotElapsed))
        );
        assert!(h.coord.get_pending_upgrade().is_some());
    }

    #[test]
    fn test_propose_upgrade_twice_fails() {
        let h = setup();
        let hash = BytesN::from_array(&h.env, &[9u8; 32]);
        h.coord.propose_upgrade(&hash);
        assert_eq!(
            h.coord.try_propose_upgrade(&hash),
            Err(Ok(CoordinatorError::UpgradeAlreadyPending))
        );
    }

    #[test]
    fn test_cancel_upgrade_clears_pending_proposal() {
        let h = setup();
        let hash = BytesN::from_array(&h.env, &[9u8; 32]);
        h.coord.propose_upgrade(&hash);
        h.coord.cancel_upgrade();

        assert!(h.coord.get_pending_upgrade().is_none());
        assert_eq!(
            h.coord.try_execute_upgrade(),
            Err(Ok(CoordinatorError::NoPendingUpgrade))
        );
    }

    #[test]
    fn test_migrate_double_run_guard() {
        let h = setup();

        // Simulate storage written by an older binary (schema 0 < target).
        let coord_id = h.env.register(CoordinatorContract, ());
        let coord = CoordinatorContractClient::new(&h.env, &coord_id);
        coord.initialize(&h.admin, &h.req_id, &h.inv_id, &h.pay_id);
        h.env.as_contract(&coord_id, || {
            h.env
                .storage()
                .instance()
                .set(&crate::SCHEMA_VERSION_KEY, &0u32)
        });

        assert_eq!(coord.schema_version(), 0);
        assert_eq!(coord.migrate(), TARGET_SCHEMA_VERSION);
        assert_eq!(
            coord.try_migrate(),
            Err(Ok(CoordinatorError::MigrationAlreadyApplied))
        );
    }

    // ── Cross-contract version compatibility gate ─────────────────────────────

    #[contract]
    struct MockIncompatibleContract;

    #[contractimpl]
    impl MockIncompatibleContract {
        pub fn version() -> u32 {
            999
        }
    }

    /// A version-mismatched domain contract must fail the workflow with a
    /// distinct error before any state change.
    #[test]
    fn test_version_mismatched_domain_contract_fails_closed() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);

        // The requests contract reports an unsupported code version.
        let req_id = env.register(MockIncompatibleContract, ());
        let inv_id = env.register(MockInventoryContract, ());
        let pay_id = env.register(MockPaymentContract, ());
        let coord_id = env.register(CoordinatorContract, ());
        MockInventoryContractClient::new(&env, &inv_id).initialize(&admin);

        let coord = CoordinatorContractClient::new(&env, &coord_id);
        coord.initialize(&admin, &req_id, &inv_id, &pay_id);

        let result = coord.try_allocate_units(&1u64, &vec![&env, 1u64], &1u64, &admin);
        assert_eq!(
            result,
            Err(Ok(CoordinatorError::IncompatibleContractVersion))
        );

        // Fail-closed: no workflow was created.
        assert!(coord.try_get_workflow(&1u64).is_err());
    }

    /// A contract that does not expose `version()` at all must also fail
    /// closed rather than mis-execute.
    #[contract]
    struct MockVersionlessContract;

    #[contractimpl]
    impl MockVersionlessContract {
        pub fn noop() {}
    }

    #[test]
    fn test_versionless_domain_contract_fails_closed() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);

        let req_id = env.register(MockVersionlessContract, ());
        let inv_id = env.register(MockInventoryContract, ());
        let pay_id = env.register(MockPaymentContract, ());
        let coord_id = env.register(CoordinatorContract, ());
        MockInventoryContractClient::new(&env, &inv_id).initialize(&admin);

        let coord = CoordinatorContractClient::new(&env, &coord_id);
        coord.initialize(&admin, &req_id, &inv_id, &pay_id);

        let result = coord.try_allocate_units(&1u64, &vec![&env, 1u64], &1u64, &admin);
        assert_eq!(
            result,
            Err(Ok(CoordinatorError::IncompatibleContractVersion))
        );
    }
}

/// Full upgrade rehearsal against the real compiled WASM: start a workflow,
/// swap the coordinator binary mid-flight (propose → timelock → execute),
/// then prove the in-flight workflow completes correctly on the new binary.
///
/// Requires the workspace WASMs to be built first — run via
/// `scripts/test-upgrade-rehearsal.sh`.
#[cfg(feature = "upgrade-rehearsal")]
mod upgrade_rehearsal {
    use super::*;
    use soroban_sdk::testutils::Ledger as _;

    const COORDINATOR_WASM: &[u8] = include_bytes!(
        "../../../target/wasm32v1-none/release/coordinator_contract.wasm"
    );

    #[test]
    fn test_upgrade_rehearsal_inflight_workflow_completes_after_upgrade() {
        let h = setup();
        h.env.ledger().with_mut(|l| l.timestamp = 1_000_000);

        // Realistic in-flight state: an allocated (unsettled) workflow with
        // reserved units and a locked payment.
        seed_pending_request(&h, 1);
        let unit_id = register_unit(&h);
        let payment_id = create_locked_payment(&h, 1);
        h.coord
            .allocate_units(&1u64, &vec![&h.env, unit_id], &payment_id, &h.admin);
        assert_eq!(h.coord.get_workflow(&1u64).status, WorkflowStatus::Allocated);

        // Propose → wait out the 48h timelock → execute the WASM swap.
        let wasm_hash = h.env.deployer().upload_contract_wasm(COORDINATOR_WASM);
        let executable_at = h.coord.propose_upgrade(&wasm_hash);
        h.env.ledger().with_mut(|l| l.timestamp = executable_at + 1);
        h.coord.execute_upgrade();

        // Same contract ID, storage intact, new binary answering.
        assert_eq!(h.coord.version(), crate::CONTRACT_VERSION);
        let wf = h.coord.get_workflow(&1u64);
        assert_eq!(wf.status, WorkflowStatus::Allocated);

        // The in-flight workflow completes correctly post-upgrade.
        h.coord.confirm_delivery(&1u64, &h.admin);
        h.coord.settle_payment(&1u64, &h.admin);
        assert_eq!(h.coord.get_workflow(&1u64).status, WorkflowStatus::Settled);

        let payment = MockPaymentContractClient::new(&h.env, &h.pay_id).get_payment(&payment_id);
        assert_eq!(payment.status, PaymentStatus::Released);
    }
}
