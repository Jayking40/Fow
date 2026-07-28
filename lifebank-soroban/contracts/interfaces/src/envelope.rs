use soroban_sdk::{Env, IntoVal, Symbol, Val};

/// Default schema version for events that have not been through a breaking
/// change yet. Individual emit_* helpers pass this unless they are on a later
/// version of their specific event.
pub const SCHEMA_V1: u32 = 1;

/// Publish an event using the standard workspace-wide envelope:
/// topics = `(contract_domain, event_name, schema_version)`, data = `payload`.
///
/// `contract_domain` identifies which contract emitted the event (e.g.
/// `"inventory"`, `"payments"`); `event_name` identifies the event within
/// that domain (e.g. `"blood_registered"`); `schema_version` is bumped only
/// when the payload for that specific event name makes a breaking change.
#[allow(deprecated)] // Events::publish is the only API that lets us fix the exact
// (contract_domain, event_name, schema_version) topic shape mandated by
// EVENTS.md; #[contractevent] derives its own topic convention instead.
pub fn publish<T>(env: &Env, contract_domain: Symbol, event_name: Symbol, schema_version: u32, payload: T)
where
    T: IntoVal<Env, Val>,
{
    env.events()
        .publish((contract_domain, event_name, schema_version), payload);
}
