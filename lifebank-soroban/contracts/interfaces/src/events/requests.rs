use super::inventory::BloodType;
use soroban_sdk::{contracttype, Address};

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RequestStatus {
    Pending,
    Approved,
    Fulfilled,
    Cancelled,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InitializedEvent {
    pub admin: Address,
    pub inventory_contract: Address,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RequestCreatedEvent {
    pub request_id: u64,
    pub hospital: Address,
    pub blood_type: BloodType,
    pub quantity_ml: u32,
    pub urgency: u32,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RequestCancelledEvent {
    pub request_id: u64,
    pub actor: Address,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RequestStatusUpdatedEvent {
    pub request_id: u64,
    pub actor: Address,
    pub old_status: RequestStatus,
    pub new_status: RequestStatus,
    pub timestamp: u64,
}
