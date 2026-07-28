//! Event payloads for the matching contract. Populated as part of the
//! events-catalog migration (see EVENTS.md).

use super::inventory::BloodType;
use soroban_sdk::{contracttype, Address, Vec};

/// Emitted once by the atomic constructor / legacy `initialize` entrypoint.
/// Matching wires in *two* downstream contracts at init time (inventory and
/// requests), so it defines its own `InitializedEvent` rather than reusing
/// `events::common::InitializedEvent`, whose single `linked_contract` field
/// cannot represent both.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InitializedEvent {
    pub admin: Address,
    pub inventory_contract: Address,
    pub requests_contract: Address,
}

/// Admin engaged the circuit breaker, pausing all state-mutating entrypoints.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PausedEvent {
    pub actor: Address,
    pub timestamp: u64,
}

/// Admin released the circuit breaker, resuming state-mutating entrypoints.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UnpausedEvent {
    pub actor: Address,
    pub timestamp: u64,
}

/// The matching engine computed candidate units for a request. This is the
/// canonical record of the match: `match_request` never writes its result to
/// this contract's own storage (it only reads inventory/requests via
/// cross-contract calls and returns `MatchResult` to the caller), so this
/// event is the *only* on-chain trace that a match was proposed and what it
/// contained. `matched_unit_ids` preserves selection order (exact-match tier
/// first, then compatible tier, each FIFO by expiration) so the transition
/// can be replayed without re-querying inventory state.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MatchProposedEvent {
    pub request_id: u64,
    pub blood_type: BloodType,
    pub quantity_requested_ml: u32,
    pub matched_unit_ids: Vec<u64>,
    pub total_matched_ml: u32,
    pub remaining_ml: u32,
    pub partial_fulfillment: bool,
    pub timestamp: u64,
}
