//! Typed event emitters for the delivery contract. Every mutation below
//! publishes exactly one cataloged event via the shared envelope
//! `(domain="delivery", event_name, schema_version)`. See EVENTS.md.

use lifebank_interfaces::envelope::{self, SCHEMA_V1};
use lifebank_interfaces::events::delivery as ev;
use soroban_sdk::{symbol_short, Address, Bytes, Env, Symbol};

fn domain(_env: &Env) -> Symbol {
    symbol_short!("delivery")
}

pub fn emit_initialized(env: &Env, admin: &Address, request_contract: &Address) {
    envelope::publish(
        env,
        domain(env),
        symbol_short!("init"),
        SCHEMA_V1,
        ev::InitializedEvent {
            admin: admin.clone(),
            request_contract: request_contract.clone(),
        },
    );
}

/// Canonical audit event for a recorded compliance attestation — carries the
/// delivery id, the off-chain-produced compliance hash, and the pass/fail
/// verdict so the transition can be reconstructed from the event alone.
pub fn emit_compliance_recorded(
    env: &Env,
    delivery_id: u64,
    compliance_hash: Bytes,
    is_compliant: bool,
) {
    envelope::publish(
        env,
        domain(env),
        symbol_short!("comply"),
        SCHEMA_V1,
        ev::ComplianceRecordedEvent {
            delivery_id,
            compliance_hash,
            is_compliant,
        },
    );
}
