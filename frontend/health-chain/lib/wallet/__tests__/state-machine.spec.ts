import { describe, expect, it } from 'vitest';
import {
  initialWalletState,
  isNetworkMismatch,
  walletReducer,
  type WalletState,
} from '../state-machine';
import { NETWORK_PASSPHRASES, truncateAddress } from '../config';

const TESTNET = NETWORK_PASSPHRASES.TESTNET;
const PUBLIC = NETWORK_PASSPHRASES.PUBLIC;

const ADDRESS = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSWXYZ';

function connectedState(): WalletState {
  let state = walletReducer(initialWalletState, { type: 'CONNECT_REQUESTED' });
  state = walletReducer(state, {
    type: 'CONNECT_SUCCEEDED',
    address: ADDRESS,
    network: 'TESTNET',
    networkPassphrase: TESTNET,
  });
  return state;
}

describe('walletReducer', () => {
  it('starts disconnected with unknown install state', () => {
    expect(initialWalletState.status).toBe('disconnected');
    expect(initialWalletState.installed).toBeNull();
    expect(initialWalletState.address).toBeNull();
  });

  it('records extension detection without changing connection status', () => {
    const state = walletReducer(initialWalletState, { type: 'DETECTED', installed: false });
    expect(state.installed).toBe(false);
    expect(state.status).toBe('disconnected');
  });

  it('transitions disconnected → connecting → connected', () => {
    const connecting = walletReducer(initialWalletState, { type: 'CONNECT_REQUESTED' });
    expect(connecting.status).toBe('connecting');
    expect(connecting.error).toBeNull();

    const connected = walletReducer(connecting, {
      type: 'CONNECT_SUCCEEDED',
      address: ADDRESS,
      network: 'TESTNET',
      networkPassphrase: TESTNET,
    });
    expect(connected.status).toBe('connected');
    expect(connected.address).toBe(ADDRESS);
    expect(connected.network).toBe('TESTNET');
    expect(connected.installed).toBe(true);
  });

  it('transitions connecting → error on failure and keeps the error details', () => {
    const connecting = walletReducer(initialWalletState, { type: 'CONNECT_REQUESTED' });
    const failed = walletReducer(connecting, {
      type: 'CONNECT_FAILED',
      code: 'USER_REJECTED',
      message: 'User declined access',
    });
    expect(failed.status).toBe('error');
    expect(failed.error).toEqual({ code: 'USER_REJECTED', message: 'User declined access' });
    expect(failed.address).toBeNull();
  });

  it('allows retrying from the error state', () => {
    const connecting = walletReducer(initialWalletState, { type: 'CONNECT_REQUESTED' });
    const failed = walletReducer(connecting, {
      type: 'CONNECT_FAILED',
      code: 'CONNECTION_FAILED',
      message: 'boom',
    });
    const retrying = walletReducer(failed, { type: 'CONNECT_REQUESTED' });
    expect(retrying.status).toBe('connecting');
    expect(retrying.error).toBeNull();
  });

  it('ignores CONNECT_SUCCEEDED / CONNECT_FAILED when not connecting', () => {
    const succeeded = walletReducer(initialWalletState, {
      type: 'CONNECT_SUCCEEDED',
      address: ADDRESS,
      network: 'TESTNET',
      networkPassphrase: TESTNET,
    });
    expect(succeeded).toEqual(initialWalletState);

    const failed = walletReducer(initialWalletState, {
      type: 'CONNECT_FAILED',
      code: 'CONNECTION_FAILED',
      message: 'late failure',
    });
    expect(failed).toEqual(initialWalletState);
  });

  it('ignores duplicate CONNECT_REQUESTED while connecting or connected', () => {
    const connecting = walletReducer(initialWalletState, { type: 'CONNECT_REQUESTED' });
    expect(walletReducer(connecting, { type: 'CONNECT_REQUESTED' })).toBe(connecting);

    const connected = connectedState();
    expect(walletReducer(connected, { type: 'CONNECT_REQUESTED' })).toBe(connected);
  });

  it('updates the address on ACCOUNT_CHANGED only while connected', () => {
    const other = 'GXYZ567ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQ';
    const connected = connectedState();
    const switched = walletReducer(connected, { type: 'ACCOUNT_CHANGED', address: other });
    expect(switched.address).toBe(other);
    expect(switched.status).toBe('connected');

    expect(
      walletReducer(initialWalletState, { type: 'ACCOUNT_CHANGED', address: other }),
    ).toEqual(initialWalletState);
  });

  it('updates network details on NETWORK_CHANGED while connected', () => {
    const connected = connectedState();
    const switched = walletReducer(connected, {
      type: 'NETWORK_CHANGED',
      network: 'PUBLIC',
      networkPassphrase: PUBLIC,
    });
    expect(switched.network).toBe('PUBLIC');
    expect(switched.networkPassphrase).toBe(PUBLIC);
    expect(switched.status).toBe('connected');
  });

  it('resets everything except install detection on DISCONNECTED', () => {
    const connected = { ...connectedState(), installed: true };
    const disconnected = walletReducer(connected, { type: 'DISCONNECTED' });
    expect(disconnected.status).toBe('disconnected');
    expect(disconnected.address).toBeNull();
    expect(disconnected.network).toBeNull();
    expect(disconnected.error).toBeNull();
    expect(disconnected.installed).toBe(true);
  });
});

describe('isNetworkMismatch', () => {
  it('is false while disconnected', () => {
    expect(isNetworkMismatch(initialWalletState, TESTNET)).toBe(false);
  });

  it('is false when connected on the expected network', () => {
    expect(isNetworkMismatch(connectedState(), TESTNET)).toBe(false);
  });

  it('is true when connected on a different network', () => {
    expect(isNetworkMismatch(connectedState(), PUBLIC)).toBe(true);
  });
});

describe('truncateAddress', () => {
  it('truncates long addresses to GABC…WXYZ form', () => {
    expect(truncateAddress(ADDRESS)).toBe('GABC…WXYZ');
  });

  it('leaves short strings untouched', () => {
    expect(truncateAddress('GABC')).toBe('GABC');
  });
});
