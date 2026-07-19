/**
 * Wallet Store - Zustand store with localStorage persistence.
 * Remembers the last-connected wallet so the app can silently reconnect on
 * refresh (addresses are public, so localStorage is acceptable here — unlike
 * auth tokens, which stay in sessionStorage in auth.store.ts).
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface WalletPersistedState {
  lastAddress: string | null;
  lastNetwork: string | null;
  autoConnect: boolean;
}

interface WalletPersistedActions {
  rememberConnection: (address: string, network: string) => void;
  forgetConnection: () => void;
}

type WalletStore = WalletPersistedState & WalletPersistedActions;

const initialState: WalletPersistedState = {
  lastAddress: null,
  lastNetwork: null,
  autoConnect: false,
};

export const useWalletStore = create<WalletStore>()(
  persist(
    (set) => ({
      ...initialState,

      rememberConnection: (address: string, network: string) => {
        set({ lastAddress: address, lastNetwork: network, autoConnect: true });
      },

      forgetConnection: () => {
        set(initialState);
      },
    }),
    {
      name: 'wallet-storage',
      storage: createJSONStorage(() => localStorage),
    }
  )
);
