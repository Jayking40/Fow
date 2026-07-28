//! Event payloads for the delivery contract. Populated as part of the
//! events-catalog migration (see EVENTS.md).

use soroban_sdk::{contracttype, Address, Bytes};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InitializedEvent {
    pub admin: Address,
    pub request_contract: Address,
}

/// Emitted when a compliance attestation hash is recorded for a delivery.
/// The hash itself is produced off-chain by the backend after evaluating
/// telemetry (e.g. cold-chain temperature logs) for the delivery.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ComplianceRecordedEvent {
    pub delivery_id: u64,
    pub compliance_hash: Bytes,
    pub is_compliant: bool,
}
