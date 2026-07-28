//! One module per contract domain. Each module's structs are the payloads
//! documented for that domain in `EVENTS.md`.

pub mod analytics;
pub mod common;
pub mod coordinator;
pub mod delivery;
pub mod identity;
pub mod inventory;
pub mod matching;
pub mod payments;
pub mod reputation;
pub mod requests;
pub mod temperature;
