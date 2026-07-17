"use client";

/**
 * Warns when the connected wallet's network differs from the network the app
 * is configured for. Rendered globally (below the Navbar) so the warning is
 * visible on every page before any transaction is attempted.
 */

import { useWallet } from "@/components/providers/WalletProvider";
import { networkLabel } from "@/lib/wallet/config";

export default function NetworkMismatchBanner() {
  const wallet = useWallet();

  if (!wallet.networkMismatch) return null;

  return (
    <div
      role="alert"
      className="fixed bottom-0 left-0 z-[90] w-full bg-amber-500 px-4 py-3 text-center font-poppins text-sm font-semibold text-white shadow-lg"
    >
      Your wallet is on {networkLabel(wallet.network ?? "an unknown network")}, but
      this app uses {networkLabel(wallet.expectedNetwork)}. Switch networks in
      Freighter before signing — transactions will be blocked until then.
    </div>
  );
}
