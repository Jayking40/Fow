/**
 * Typed wrapper around @stellar/freighter-api.
 *
 * Every call degrades gracefully when the Freighter extension is not
 * installed (or when running server-side): callers get a WalletError with a
 * stable `code` instead of an opaque throw from the extension bridge.
 */

import {
  isConnected,
  isAllowed,
  requestAccess,
  getAddress,
  getNetwork,
  signTransaction as freighterSignTransaction,
} from '@stellar/freighter-api';

export type WalletErrorCode =
  | 'NOT_INSTALLED'
  | 'USER_REJECTED'
  | 'CONNECTION_FAILED'
  | 'SIGNING_FAILED';

export class WalletError extends Error {
  code: WalletErrorCode;

  constructor(code: WalletErrorCode, message: string) {
    super(message);
    this.name = 'WalletError';
    this.code = code;
  }
}

export interface WalletNetwork {
  network: string;
  networkPassphrase: string;
}

const isBrowser = () => typeof window !== 'undefined';

function isRejection(message: string): boolean {
  return /reject|denied|declined|cancel/i.test(message);
}

/** True when the Freighter extension is detectable in this browser. */
export async function isFreighterInstalled(): Promise<boolean> {
  if (!isBrowser()) return false;
  try {
    const result = await isConnected();
    return !result.error && result.isConnected;
  } catch {
    return false;
  }
}

/** True when the user has already granted this origin access. */
export async function isFreighterAllowed(): Promise<boolean> {
  if (!isBrowser()) return false;
  try {
    const result = await isAllowed();
    return !('error' in result && result.error) && result.isAllowed;
  } catch {
    return false;
  }
}

/**
 * Prompt the user to grant access and return their public key.
 * Throws WalletError(NOT_INSTALLED | USER_REJECTED | CONNECTION_FAILED).
 */
export async function connect(): Promise<string> {
  if (!(await isFreighterInstalled())) {
    throw new WalletError('NOT_INSTALLED', 'Freighter wallet is not installed');
  }
  try {
    const result = await requestAccess();
    if (result.error) {
      const message = String(result.error);
      throw new WalletError(
        isRejection(message) ? 'USER_REJECTED' : 'CONNECTION_FAILED',
        message,
      );
    }
    if (!result.address) {
      throw new WalletError('CONNECTION_FAILED', 'Freighter returned no address');
    }
    return result.address;
  } catch (err) {
    if (err instanceof WalletError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new WalletError(
      isRejection(message) ? 'USER_REJECTED' : 'CONNECTION_FAILED',
      message,
    );
  }
}

/**
 * Public key of the already-authorized account, or null when not connected.
 * Never prompts.
 */
export async function getPublicKey(): Promise<string | null> {
  if (!isBrowser()) return null;
  try {
    const result = await getAddress();
    if (result.error || !result.address) return null;
    return result.address;
  } catch {
    return null;
  }
}

/** Network currently selected inside Freighter. */
export async function getWalletNetwork(): Promise<WalletNetwork | null> {
  if (!isBrowser()) return null;
  try {
    const result = await getNetwork();
    if (result.error) return null;
    return {
      network: result.network,
      networkPassphrase: result.networkPassphrase,
    };
  } catch {
    return null;
  }
}

/**
 * Ask Freighter to sign a transaction envelope XDR.
 * Throws WalletError(NOT_INSTALLED | USER_REJECTED | SIGNING_FAILED).
 */
export async function signTransaction(
  xdr: string,
  opts: { networkPassphrase: string; address?: string },
): Promise<string> {
  if (!(await isFreighterInstalled())) {
    throw new WalletError('NOT_INSTALLED', 'Freighter wallet is not installed');
  }
  try {
    const result = await freighterSignTransaction(xdr, opts);
    if (result.error) {
      const message = String(result.error);
      throw new WalletError(
        isRejection(message) ? 'USER_REJECTED' : 'SIGNING_FAILED',
        message,
      );
    }
    return result.signedTxXdr;
  } catch (err) {
    if (err instanceof WalletError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new WalletError(
      isRejection(message) ? 'USER_REJECTED' : 'SIGNING_FAILED',
      message,
    );
  }
}

/**
 * Freighter offers no programmatic revoke; disconnecting is app-local.
 * Exposed for symmetry so callers never touch the extension API directly.
 */
export async function disconnect(): Promise<void> {
  // Intentionally empty — WalletProvider clears its own persisted state.
}
