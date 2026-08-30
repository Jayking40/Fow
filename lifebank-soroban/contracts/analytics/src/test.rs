#![cfg(test)]

use soroban_sdk::{testutils::Address as _, Address, Env, Symbol, TryFromVal, Val};

use super::{AnalyticsContract, AnalyticsContractClient, AnalyticsError, PeriodType};
use lifebank_interfaces::events::analytics as ev;

/// Decode the `(contract_domain, event_name, schema_version)` topic triple
/// from the most recently published event.
fn last_event_topics(env: &Env) -> (Symbol, Symbol, u32) {
    let all = env.events().all();
    let (_, topics, _) = all.last().unwrap();
    let domain: Symbol = TryFromVal::try_from_val(env, &topics.get(0).unwrap()).unwrap();
    let name: Symbol = TryFromVal::try_from_val(env, &topics.get(1).unwrap()).unwrap();
    let version: u32 = TryFromVal::try_from_val(env, &topics.get(2).unwrap()).unwrap();
    (domain, name, version)
}

/// Decode the data payload of the most recently published event as `T`.
fn last_event_payload<T: TryFromVal<Env, Val>>(env: &Env) -> T {
    let all = env.events().all();
    let (_, _, data) = all.last().unwrap();
    T::try_from_val(env, &data).unwrap()
}

fn setup<'a>() -> (Env, Address, AnalyticsContractClient<'a>) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let inventory = Address::generate(&env);
    let requests = Address::generate(&env);
    let payments = Address::generate(&env);
    let reputation = Address::generate(&env);

    // Pass constructor args at register time — atomic deploy+init.
    let id = env.register(
        AnalyticsContract,
        (&admin, &inventory, &requests, &payments, &reputation),
    );
    let client = AnalyticsContractClient::new(&env, &id);

    (env, admin, client)
}

// ── Initialization ────────────────────────────────────────────────────────────

#[test]
fn test_initialize_succeeds() {
    let (_, _, client) = setup();
    assert!(client.is_initialized());
}

#[test]
fn test_initialize_sets_config() {
    let (env, admin, client) = setup();
    let cfg = client.get_config();
    assert_eq!(cfg.admin, admin);
    assert_eq!(cfg.reporting_period.duration_secs, 86_400);
    assert_eq!(cfg.initialized_at, env.ledger().timestamp());
}

#[test]
fn test_double_initialize_fails() {
    let (_, _, client) = setup();
    let admin2 = Address::generate(&client.env);
    let dummy = Address::generate(&client.env);
    let result = client.try_initialize(&admin2, &dummy, &dummy, &dummy, &dummy);
    assert_eq!(result, Err(Ok(AnalyticsError::AlreadyInitialized)));
}

// ── Guard: double-init via legacy initialize() ────────────────────────────────

/// `is_initialized` is always true after register because `__constructor`
/// runs atomically at deploy time.  The legacy `initialize` must return
/// `AlreadyInitialized` on a second call.
#[test]
fn test_is_initialized_true_after_register() {
    let (_, _, client) = setup();
    assert!(client.is_initialized());
}

#[test]
fn test_legacy_initialize_fails_when_already_initialized() {
    let (_, _, client) = setup();
    let admin2 = Address::generate(&client.env);
    let dummy = Address::generate(&client.env);
    let result = client.try_initialize(&admin2, &dummy, &dummy, &dummy, &dummy);
    assert_eq!(result, Err(Ok(AnalyticsError::AlreadyInitialized)));
}

// ── Lifetime counters start at zero ──────────────────────────────────────────

#[test]
fn test_lifetime_totals_zero_after_init() {
    let (_, _, client) = setup();
    let totals = client.get_lifetime_totals();
    assert_eq!(totals.total_donations, 0);
    assert_eq!(totals.total_requests, 0);
    assert_eq!(totals.total_deliveries, 0);
    assert_eq!(totals.total_payments_released, 0);
    assert_eq!(totals.total_volume, 0);
}

// ── Metric recording ──────────────────────────────────────────────────────────

#[test]
fn test_record_donation_increments_counters() {
    let (_, _, client) = setup();
    client.record_donation();
    client.record_donation();

    let snap = client.get_current_snapshot();
    assert_eq!(snap.total_donations, 2);

    let totals = client.get_lifetime_totals();
    assert_eq!(totals.total_donations, 2);
}

#[test]
fn test_record_request_increments_counters() {
    let (_, _, client) = setup();
    client.record_request();

    let snap = client.get_current_snapshot();
    assert_eq!(snap.total_requests, 1);
}

#[test]
fn test_record_delivery_increments_counters() {
    let (_, _, client) = setup();
    client.record_delivery();

    let snap = client.get_current_snapshot();
    assert_eq!(snap.total_deliveries, 1);
}

#[test]
fn test_record_payment_released_increments_counters() {
    let (_, _, client) = setup();
    client.record_payment_released(&500_i128);
    client.record_payment_released(&300_i128);

    let snap = client.get_current_snapshot();
    assert_eq!(snap.total_payments_released, 2);
    assert_eq!(snap.total_volume, 800);

    let totals = client.get_lifetime_totals();
    assert_eq!(totals.total_volume, 800);
}

// ── Reporting period ──────────────────────────────────────────────────────────

#[test]
fn test_set_reporting_period_weekly() {
    let (_, _, client) = setup();
    client.set_reporting_period(&PeriodType::Weekly);
    let cfg = client.get_config();
    assert_eq!(cfg.reporting_period.duration_secs, 604_800);
}

#[test]
fn test_set_reporting_period_monthly() {
    let (_, _, client) = setup();
    client.set_reporting_period(&PeriodType::Monthly);
    let cfg = client.get_config();
    assert_eq!(cfg.reporting_period.duration_secs, 2_592_000);
}

// ── Period snapshot isolation ─────────────────────────────────────────────────

#[test]
fn test_get_snapshot_not_found_returns_error() {
    let (_, _, client) = setup();
    let result = client.try_get_snapshot(&9999u64);
    assert_eq!(result, Err(Ok(AnalyticsError::PeriodNotFound)));
}

#[test]
fn test_get_snapshot_returns_correct_period() {
    let (env, _, client) = setup();
    client.record_donation();

    let period_index = env.ledger().timestamp() / 86_400;
    let snap = client.get_snapshot(&period_index);
    assert_eq!(snap.total_donations, 1);
    assert_eq!(snap.period_index, period_index);
}

// ── Guard: not initialized ────────────────────────────────────────────────────

/// With `__constructor`, a contract registered with `()` (no init args) is
/// uninitialized.  The legacy `initialize` path sets storage; calling
/// `record_donation` before that must still return `NotInitialized`.
///
/// This test uses the legacy `initialize` path (not the constructor) so
/// we can create a pre-init snapshot.  In production the constructor makes
/// this state structurally unreachable.
#[test]
fn test_record_donation_fails_when_not_initialized() {
    let env = Env::default();
    env.mock_all_auths();
    // Register with no constructor args — simulates the legacy deploy path
    // before `initialize` is called.
    let id = env.register(AnalyticsContract, ());
    let client = AnalyticsContractClient::new(&env, &id);
    let result = client.try_record_donation();
    assert_eq!(result, Err(Ok(AnalyticsError::NotInitialized)));
}

// ── Upgradeability tests (#31) ────────────────────────────────────────────────

#[test]
fn test_version_returns_contract_version() {
    let (_, _, client) = setup();
    assert_eq!(client.version(), super::CONTRACT_VERSION);
}

#[test]
fn test_schema_version_written_at_init() {
    let (_, _, client) = setup();
    assert_eq!(client.schema_version(), super::TARGET_SCHEMA_VERSION);
}

#[test]
fn test_non_admin_upgrade_rejected() {
    let (env, _, client) = setup();
    let attacker = Address::generate(&env);
    let cid = client.address.clone();
    let hash = soroban_sdk::BytesN::from_array(&env, &[0u8; 32]);
    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &attacker,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &cid,
            fn_name: "upgrade",
            args: (hash.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    let result = client.try_upgrade(&hash);
    assert!(result.is_err(), "non-admin must not be able to upgrade");
}
