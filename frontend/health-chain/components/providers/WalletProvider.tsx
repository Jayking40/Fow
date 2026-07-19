"use client";

/**
 * WalletProvider — owns the wallet connection state machine and the
 * transaction-signing flow. Every signature request goes through a
 * human-readable preview modal before Freighter is ever asked to sign.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import * as freighter from "@/lib/wallet/freighter";
import { WalletError } from "@/lib/wallet/freighter";
import {
  initialWalletState,
  isNetworkMismatch,
  walletReducer,
  type WalletState,
} from "@/lib/wallet/state-machine";
import {
  getExpectedNetwork,
  getExpectedNetworkPassphrase,
  networkLabel,
} from "@/lib/wallet/config";
import { useWalletStore } from "@/lib/stores/wallet.store";
import SignTransactionModal from "@/components/blockchain/SignTransactionModal";

/** Human-readable description of what a transaction does, shown pre-signing. */
export interface OperationSummary {
  title: string;
  operations: Array<{ label: string; value: string }>;
}

export interface SignRequest {
  xdr: string;
  summary: OperationSummary;
}

interface PendingSignRequest extends SignRequest {
  resolve: (signedXdr: string) => void;
  reject: (err: WalletError) => void;
}

export interface WalletContextValue extends WalletState {
  expectedNetwork: string;
  networkMismatch: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  /** Opens the preview modal, then signs via Freighter once approved. */
  signTransaction: (request: SignRequest) => Promise<string>;
}

const WalletContext = createContext<WalletContextValue | null>(null);

const POLL_INTERVAL_MS = 3_000;

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(walletReducer, initialWalletState);
  const [pendingSign, setPendingSign] = useState<PendingSignRequest | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const rememberConnection = useWalletStore((s) => s.rememberConnection);
  const forgetConnection = useWalletStore((s) => s.forgetConnection);

  const expectedNetwork = getExpectedNetwork();
  const expectedPassphrase = getExpectedNetworkPassphrase();

  const connect = useCallback(async () => {
    dispatch({ type: "CONNECT_REQUESTED" });
    try {
      const address = await freighter.connect();
      const network = await freighter.getWalletNetwork();
      dispatch({
        type: "CONNECT_SUCCEEDED",
        address,
        network: network?.network ?? "UNKNOWN",
        networkPassphrase: network?.networkPassphrase ?? "",
      });
      rememberConnection(address, network?.network ?? "UNKNOWN");
    } catch (err) {
      const walletErr =
        err instanceof WalletError
          ? err
          : new WalletError("CONNECTION_FAILED", String(err));
      dispatch({
        type: "CONNECT_FAILED",
        code: walletErr.code,
        message: walletErr.message,
      });
    }
  }, [rememberConnection]);

  const disconnect = useCallback(() => {
    void freighter.disconnect();
    forgetConnection();
    dispatch({ type: "DISCONNECTED" });
  }, [forgetConnection]);

  // Detect the extension, then silently reconnect if the user connected before.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const installed = await freighter.isFreighterInstalled();
      if (cancelled) return;
      dispatch({ type: "DETECTED", installed });

      const { lastAddress, autoConnect } = useWalletStore.getState();
      if (!installed || !autoConnect || !lastAddress) return;
      if (!(await freighter.isFreighterAllowed())) return;

      const address = await freighter.getPublicKey();
      if (cancelled || !address) return;
      const network = await freighter.getWalletNetwork();
      if (cancelled) return;
      dispatch({ type: "CONNECT_REQUESTED" });
      dispatch({
        type: "CONNECT_SUCCEEDED",
        address,
        network: network?.network ?? "UNKNOWN",
        networkPassphrase: network?.networkPassphrase ?? "",
      });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll for account/network changes made inside the extension.
  useEffect(() => {
    if (state.status !== "connected") return;
    const timer = setInterval(async () => {
      const current = stateRef.current;
      if (current.status !== "connected") return;

      const address = await freighter.getPublicKey();
      if (!address) {
        disconnect();
        return;
      }
      if (address !== current.address) {
        dispatch({ type: "ACCOUNT_CHANGED", address });
        rememberConnection(address, current.network ?? "UNKNOWN");
      }

      const network = await freighter.getWalletNetwork();
      if (network && network.networkPassphrase !== current.networkPassphrase) {
        dispatch({
          type: "NETWORK_CHANGED",
          network: network.network,
          networkPassphrase: network.networkPassphrase,
        });
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [state.status, disconnect, rememberConnection]);

  const signTransaction = useCallback(
    (request: SignRequest): Promise<string> => {
      return new Promise<string>((resolve, reject) => {
        const current = stateRef.current;
        if (current.status !== "connected" || !current.address) {
          reject(new WalletError("CONNECTION_FAILED", "Wallet is not connected"));
          return;
        }
        if (isNetworkMismatch(current, expectedPassphrase)) {
          reject(
            new WalletError(
              "SIGNING_FAILED",
              `Wallet is on ${networkLabel(current.network ?? "?")} but the app expects ${networkLabel(expectedNetwork)}`,
            ),
          );
          return;
        }
        setPendingSign({ ...request, resolve, reject });
      });
    },
    [expectedNetwork, expectedPassphrase],
  );

  const approvePendingSign = useCallback(async () => {
    if (!pendingSign) return;
    const { xdr, resolve, reject } = pendingSign;
    setPendingSign(null);
    try {
      const signed = await freighter.signTransaction(xdr, {
        networkPassphrase: expectedPassphrase,
        address: stateRef.current.address ?? undefined,
      });
      resolve(signed);
    } catch (err) {
      reject(
        err instanceof WalletError
          ? err
          : new WalletError("SIGNING_FAILED", String(err)),
      );
    }
  }, [pendingSign, expectedPassphrase]);

  const rejectPendingSign = useCallback(() => {
    if (!pendingSign) return;
    pendingSign.reject(
      new WalletError("USER_REJECTED", "Transaction rejected in preview"),
    );
    setPendingSign(null);
  }, [pendingSign]);

  const value: WalletContextValue = {
    ...state,
    expectedNetwork,
    networkMismatch: isNetworkMismatch(state, expectedPassphrase),
    connect,
    disconnect,
    signTransaction,
  };

  return (
    <WalletContext.Provider value={value}>
      {children}
      {pendingSign && (
        <SignTransactionModal
          summary={pendingSign.summary}
          xdr={pendingSign.xdr}
          network={state.network ?? expectedNetwork}
          address={state.address ?? ""}
          onApprove={approvePendingSign}
          onReject={rejectPendingSign}
        />
      )}
    </WalletContext.Provider>
  );
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) {
    throw new Error("useWallet must be used within a WalletProvider");
  }
  return ctx;
}
