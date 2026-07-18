"use client";

/**
 * Navbar wallet control. Renders the right affordance for every wallet state:
 * install CTA (not installed), connect button, connecting spinner, error retry,
 * or the connected address with a network badge and actions dropdown.
 */

import { useEffect, useRef, useState } from "react";
import { useWallet } from "@/components/providers/WalletProvider";
import {
  explorerAccountUrl,
  FREIGHTER_INSTALL_URL,
  networkLabel,
  truncateAddress,
} from "@/lib/wallet/config";

export default function ConnectWalletButton() {
  const wallet = useWallet();
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [menuOpen]);

  const copyAddress = async () => {
    if (!wallet.address) return;
    await navigator.clipboard.writeText(wallet.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Extension not detected: actionable install CTA.
  if (wallet.installed === false) {
    return (
      <a
        href={FREIGHTER_INSTALL_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="flex h-[40px] items-center gap-2 rounded border border-brand-loginBtn px-4 font-roboto text-sm font-semibold text-brand-loginBtn hover:bg-brand-loginBtn hover:text-white transition"
      >
        Install Freighter
      </a>
    );
  }

  if (wallet.status === "connecting") {
    return (
      <button
        disabled
        className="flex h-[40px] items-center gap-2 rounded bg-brand-loginBtn/70 px-4 font-roboto text-sm font-semibold text-white"
      >
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
        Connecting…
      </button>
    );
  }

  if (wallet.status === "connected" && wallet.address) {
    const isMainnet = (wallet.network ?? "").toUpperCase() === "PUBLIC";
    return (
      <div className="relative" ref={menuRef}>
        <button
          onClick={() => setMenuOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          className="flex h-[40px] items-center gap-2 rounded border border-gray-300 px-3 font-roboto text-sm font-semibold text-brand-black hover:border-brand-loginBtn transition"
        >
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ${
              isMainnet ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"
            }`}
          >
            {networkLabel(wallet.network ?? "?")}
          </span>
          <span className="font-mono">{truncateAddress(wallet.address)}</span>
          <svg width="10" height="6" viewBox="0 0 12 8" fill="none" className="stroke-current">
            <path d="M1 1.5L6 6.5L11 1.5" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {menuOpen && (
          <div
            role="menu"
            className="absolute right-0 top-full z-50 mt-2 w-56 rounded-lg border border-gray-100 bg-white py-1 shadow-xl font-poppins text-sm"
          >
            <button
              role="menuitem"
              onClick={copyAddress}
              className="block w-full px-4 py-2 text-left text-brand-black hover:bg-gray-50"
            >
              {copied ? "Copied!" : "Copy address"}
            </button>
            <a
              role="menuitem"
              href={explorerAccountUrl(wallet.address, wallet.network ?? "TESTNET")}
              target="_blank"
              rel="noopener noreferrer"
              className="block w-full px-4 py-2 text-left text-brand-black hover:bg-gray-50"
            >
              View on explorer
            </a>
            <button
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                wallet.disconnect();
              }}
              className="block w-full px-4 py-2 text-left text-red-600 hover:bg-red-50"
            >
              Disconnect
            </button>
          </div>
        )}
      </div>
    );
  }

  // disconnected or error → connect (retry) button, with error hint underneath.
  return (
    <div className="flex flex-col items-end">
      <button
        onClick={() => void wallet.connect()}
        className="flex h-[40px] items-center rounded bg-brand-loginBtn px-4 font-roboto text-sm font-semibold text-white shadow-md hover:opacity-90 transition"
      >
        {wallet.status === "error" ? "Retry connect" : "Connect Wallet"}
      </button>
      {wallet.status === "error" && wallet.error && (
        <span className="mt-1 max-w-[220px] truncate text-xs text-red-600" title={wallet.error.message}>
          {wallet.error.code === "USER_REJECTED"
            ? "Connection request was rejected"
            : wallet.error.message}
        </span>
      )}
    </div>
  );
}
