import {
  CONTRACT_EVENT_SCHEMA_VERSION,
  ContractEventDecodeFailureReason,
  LEGACY_CONTRACT_EVENT_SCHEMA_VERSION,
  UnsupportedContractEventSchemaVersionError,
  assertSupportedContractEventSchemaVersion,
  decodeContractEvent,
  getContractEventSchemaVersion,
  resolveContractEventType,
} from './event-schema-version';

describe('contract event schema versioning', () => {
  it('treats events without a version marker as explicit legacy events', () => {
    expect(getContractEventSchemaVersion({ eventData: {} })).toBe(
      LEGACY_CONTRACT_EVENT_SCHEMA_VERSION,
    );
  });

  it('distinguishes current payload schema versions from legacy payloads', () => {
    const legacy = getContractEventSchemaVersion({ eventData: {} });
    const current = getContractEventSchemaVersion({
      eventData: { schemaVersion: CONTRACT_EVENT_SCHEMA_VERSION },
    });

    expect(legacy).toBe(0);
    expect(current).toBe(1);
    expect(current).not.toBe(legacy);
  });

  it('can decode the Soroban topic version marker used by contract events', () => {
    expect(
      getContractEventSchemaVersion({
        topics: ['blood', 'request', 'v1'],
        eventData: {},
      }),
    ).toBe(CONTRACT_EVENT_SCHEMA_VERSION);
  });

  it('decodes the EVENTS.md envelope, where the trailing topic segment is a raw u32', () => {
    expect(
      getContractEventSchemaVersion({
        topics: ['inventory', 'blood_registered', 1],
        eventData: {},
      }),
    ).toBe(CONTRACT_EVENT_SCHEMA_VERSION);
  });

  it('rejects unknown future versions instead of silently decoding them', () => {
    expect(() =>
      assertSupportedContractEventSchemaVersion({
        eventData: { schemaVersion: 2 },
      }),
    ).toThrow(UnsupportedContractEventSchemaVersionError);
  });
});

describe('contract event schema registry', () => {
  it('resolves the event type from an explicit field', () => {
    expect(
      resolveContractEventType({
        eventType: 'blood_registered',
        eventData: {},
      }),
    ).toBe('blood_registered');
  });

  it('resolves the event type from the EVENTS.md topic tuple', () => {
    expect(
      resolveContractEventType({
        topics: ['inventory', 'blood_registered', 1],
        eventData: {},
      }),
    ).toBe('blood_registered');
  });

  it('decodes a registered event with a valid payload', () => {
    const result = decodeContractEvent({
      eventType: 'blood_registered',
      eventData: { schemaVersion: CONTRACT_EVENT_SCHEMA_VERSION, unitId: 42 },
    });

    expect(result).toEqual({
      ok: true,
      eventType: 'blood_registered',
      version: CONTRACT_EVENT_SCHEMA_VERSION,
      data: { schemaVersion: CONTRACT_EVENT_SCHEMA_VERSION, unitId: 42 },
    });
  });

  it('flags an unregistered event type as undecodable instead of throwing', () => {
    const result = decodeContractEvent({
      eventType: 'totally_unknown_event',
      eventData: {},
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(
        ContractEventDecodeFailureReason.UNREGISTERED_EVENT_TYPE,
      );
    }
  });

  it('flags an unsupported future schema version as undecodable', () => {
    const result = decodeContractEvent({
      eventType: 'blood_registered',
      eventData: { schemaVersion: 99, unitId: 1 },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(
        ContractEventDecodeFailureReason.UNSUPPORTED_SCHEMA_VERSION,
      );
      expect(result.version).toBe(99);
    }
  });

  it('flags a registered event with a missing required field', () => {
    const result = decodeContractEvent({
      eventType: 'custody_transferred',
      eventData: { schemaVersion: CONTRACT_EVENT_SCHEMA_VERSION },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(
        ContractEventDecodeFailureReason.SCHEMA_VALIDATION_FAILED,
      );
      expect(result.detail).toContain('unitId');
    }
  });

  it('flags a malformed envelope with no event type', () => {
    const result = decodeContractEvent({ eventData: {} });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(
        ContractEventDecodeFailureReason.MALFORMED_ENVELOPE,
      );
    }
  });

  it('never throws for an unparseable schema version marker', () => {
    const result = decodeContractEvent({
      eventType: 'blood_registered',
      eventData: { schemaVersion: 'not-a-version', unitId: 1 },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(
        ContractEventDecodeFailureReason.UNSUPPORTED_SCHEMA_VERSION,
      );
    }
  });
});
