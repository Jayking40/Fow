//! Typed event emitters for the matching contract. Every mutation below
//! publishes exactly one cataloged event via the shared envelope
//! `(domain="matching", event_name, schema_version)`. See EVENTS.md.
//!
//! `match_request` (and `match_multiple_requests`, which calls it
//! internally) never writes its computed result to this contract's own
//! storage — it only reads inventory/requests state through cross-contract
//! calls and returns the `MatchResult` to the caller. `emit_match_proposed`
//! is therefore the sole on-chain record that a match was computed and what
//! it selected; without it, reconciliation would have no way to see matching
//! decisions short of re-deriving them off-chain from inventory/requests
//! state at an arbitrary point in time.

use crate::types::{BloodType, MatchResult};
use lifebank_interfaces::envelope::{self, SCHEMA_V1};
use lifebank_interfaces::events::matching as ev;
use soroban_sdk::{symbol_short, Address, Env, Symbol, Vec};

fn domain(_env: &Env) -> Symbol {
    symbol_short!("matching")
}

impl From<BloodType> for lifebank_interfaces::events::inventory::BloodType {
    fn from(v: BloodType) -> Self {
        use lifebank_interfaces::events::inventory::BloodType as I;
        match v {
            BloodType::APositive => I::APositive,
            BloodType::ANegative => I::ANegative,
            BloodType::BPositive => I::BPositive,
            BloodType::BNegative => I::BNegative,
            BloodType::ABPositive => I::ABPositive,
            BloodType::ABNegative => I::ABNegative,
            BloodType::OPositive => I::OPositive,
            BloodType::ONegative => I::ONegative,
        }
    }
}

pub fn emit_initialized(
    env: &Env,
    admin: &Address,
    inventory_contract: &Address,
    requests_contract: &Address,
) {
    envelope::publish(
        env,
        domain(env),
        symbol_short!("init"),
        SCHEMA_V1,
        ev::InitializedEvent {
            admin: admin.clone(),
            inventory_contract: inventory_contract.clone(),
            requests_contract: requests_contract.clone(),
        },
    );
}

pub fn emit_paused(env: &Env, actor: &Address) {
    let timestamp = env.ledger().timestamp();
    envelope::publish(
        env,
        domain(env),
        symbol_short!("paused"),
        SCHEMA_V1,
        ev::PausedEvent {
            actor: actor.clone(),
            timestamp,
        },
    );
}

pub fn emit_unpaused(env: &Env, actor: &Address) {
    let timestamp = env.ledger().timestamp();
    envelope::publish(
        env,
        domain(env),
        symbol_short!("unpaused"),
        SCHEMA_V1,
        ev::UnpausedEvent {
            actor: actor.clone(),
            timestamp,
        },
    );
}

/// Emit the canonical record of a computed match. `quantity_requested_ml` and
/// `blood_type` are passed separately (rather than re-read from `result`)
/// because `MatchResult` doesn't carry the original request's blood type.
pub fn emit_match_proposed(
    env: &Env,
    blood_type: BloodType,
    quantity_requested_ml: u32,
    result: &MatchResult,
) {
    let timestamp = env.ledger().timestamp();
    let mut matched_unit_ids: Vec<u64> = Vec::new(env);
    for i in 0..result.matched_units.len() {
        matched_unit_ids.push_back(result.matched_units.get(i).unwrap().unit_id);
    }

    envelope::publish(
        env,
        domain(env),
        Symbol::new(env, "match_proposed"),
        SCHEMA_V1,
        ev::MatchProposedEvent {
            request_id: result.request_id,
            blood_type: blood_type.into(),
            quantity_requested_ml,
            matched_unit_ids,
            total_matched_ml: result.total_matched_ml,
            remaining_ml: result.remaining_ml,
            partial_fulfillment: result.partial_fulfillment,
            timestamp,
        },
    );
}
