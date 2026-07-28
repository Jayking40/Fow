use soroban_sdk::{contracttype, Address, String};

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BloodType {
    APositive,
    ANegative,
    BPositive,
    BNegative,
    ABPositive,
    ABNegative,
    OPositive,
    ONegative,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BloodStatus {
    Available,
    Reserved,
    InTransit,
    Delivered,
    Expired,
    Compromised,
    Disposed,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InitializedEvent {
    pub admin: Address,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BloodRegisteredEvent {
    pub blood_unit_id: u64,
    pub bank_id: Address,
    pub blood_type: BloodType,
    pub quantity_ml: u32,
    pub expiration_timestamp: u64,
    pub registered_at: u64,
}

/// Canonical audit event: immutable on-chain record of every status transition.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StatusChangedEvent {
    pub unit_id: u64,
    pub previous_status: BloodStatus,
    pub new_status: BloodStatus,
    pub actor: Address,
    pub timestamp: u64,
    pub reason: Option<String>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InvalidTransitionEvent {
    pub blood_unit_id: u64,
    pub from_status: BloodStatus,
    pub to_status: BloodStatus,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BloodReservedEvent {
    pub reservation_id: u64,
    pub requester: Address,
    pub unit_count: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReservationReleasedEvent {
    pub reservation_id: u64,
}
