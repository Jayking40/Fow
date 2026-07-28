//! Payload structs shared verbatim across multiple contract domains (the
//! governance/init events look identical everywhere they occur). Domain-
//! specific events still live in their own `events::<domain>` module even
//! when the shape happens to match one of these.

use soroban_sdk::{contracttype, Address};

/// Emitted once by every contract's constructor / legacy `initialize` entrypoint.
/// `linked_contract` is the other contract address wired in at init time, if any
/// (e.g. requests -> inventory, coordinator -> its dependency set), else `None`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InitializedEvent {
    pub admin: Address,
    pub linked_contract: Option<Address>,
}

/// Emitted when a timelocked contract upgrade is proposed.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpgradeProposedEvent {
    pub executable_at: u64,
}

/// Emitted when a pending upgrade is canceled before it executes.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpgradeCanceledEvent {
    pub canceled_at: u64,
}

/// Emitted when a pending upgrade is executed (WASM swapped).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpgradeExecutedEvent {
    pub executed_at: u64,
}
