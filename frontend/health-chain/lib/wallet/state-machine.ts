/**
 * Pure connection state machine for the wallet.
 *
 * disconnected → connecting → connected
 *                     ↘ error → (retry) connecting
 *
 * Kept free of React/Freighter so the transitions are unit-testable.
 */

import type { WalletErrorCode } from './freighter';

export type WalletStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface WalletState {
  status: WalletStatus;
  /** Extension detected in this browser. null = detection not finished yet. */
  installed: boolean | null;
  address: string | null;
  network: string | null;
  networkPassphrase: string | null;
  error: { code: WalletErrorCode; message: string } | null;
}

export type WalletAction =
  | { type: 'DETECTED'; installed: boolean }
  | { type: 'CONNECT_REQUESTED' }
  | {
      type: 'CONNECT_SUCCEEDED';
      address: string;
      network: string;
      networkPassphrase: string;
    }
  | { type: 'CONNECT_FAILED'; code: WalletErrorCode; message: string }
  | { type: 'ACCOUNT_CHANGED'; address: string }
  | { type: 'NETWORK_CHANGED'; network: string; networkPassphrase: string }
  | { type: 'DISCONNECTED' };

export const initialWalletState: WalletState = {
  status: 'disconnected',
  installed: null,
  address: null,
  network: null,
  networkPassphrase: null,
  error: null,
};

export function walletReducer(state: WalletState, action: WalletAction): WalletState {
  switch (action.type) {
    case 'DETECTED':
      return { ...state, installed: action.installed };

    case 'CONNECT_REQUESTED':
      if (state.status === 'connecting' || state.status === 'connected') return state;
      return { ...state, status: 'connecting', error: null };

    case 'CONNECT_SUCCEEDED':
      if (state.status !== 'connecting') return state;
      return {
        ...state,
        status: 'connected',
        installed: true,
        address: action.address,
        network: action.network,
        networkPassphrase: action.networkPassphrase,
        error: null,
      };

    case 'CONNECT_FAILED':
      if (state.status !== 'connecting') return state;
      return {
        ...state,
        status: 'error',
        address: null,
        network: null,
        networkPassphrase: null,
        error: { code: action.code, message: action.message },
      };

    case 'ACCOUNT_CHANGED':
      if (state.status !== 'connected') return state;
      return { ...state, address: action.address };

    case 'NETWORK_CHANGED':
      if (state.status !== 'connected') return state;
      return {
        ...state,
        network: action.network,
        networkPassphrase: action.networkPassphrase,
      };

    case 'DISCONNECTED':
      return {
        ...initialWalletState,
        installed: state.installed,
      };

    default:
      return state;
  }
}

/** True when the wallet network differs from the app's configured network. */
export function isNetworkMismatch(
  state: WalletState,
  expectedPassphrase: string,
): boolean {
  return (
    state.status === 'connected' &&
    state.networkPassphrase !== null &&
    state.networkPassphrase !== expectedPassphrase
  );
}
