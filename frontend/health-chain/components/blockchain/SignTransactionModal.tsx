"use client";

/**
 * Pre-signing preview modal. Shows a human-readable summary of what the
 * transaction does before the request is forwarded to Freighter.
 */

import { useEffect } from "react";
import { networkLabel, truncateAddress } from "@/lib/wallet/config";
import type { OperationSummary } from "@/components/providers/WalletProvider";

interface SignTransactionModalProps {
  summary: OperationSummary;
  xdr: string;
  network: string;
  address: string;
  onApprove: () => void;
  onReject: () => void;
}

export default function SignTransactionModal({
  summary,
  xdr,
  network,
  address,
  onApprove,
  onReject,
}: SignTransactionModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onReject();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onReject]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sign-tx-title"
    >
      <div className="w-full max-w-md rounded-lg bg-white shadow-xl font-poppins">
        <div className="border-b border-gray-100 px-6 py-4">
          <h2 id="sign-tx-title" className="text-lg font-semibold text-brand-black">
            Review transaction
          </h2>
          <p className="mt-1 text-sm text-gray-500">{summary.title}</p>
        </div>

        <div className="px-6 py-4 space-y-3">
          {summary.operations.map((op) => (
            <div key={op.label} className="flex justify-between gap-4 text-sm">
              <span className="text-gray-500">{op.label}</span>
              <span className="text-right font-medium text-brand-black break-all">
                {op.value}
              </span>
            </div>
          ))}

          <div className="flex justify-between gap-4 text-sm">
            <span className="text-gray-500">Signing as</span>
            <span className="font-mono text-brand-black">{truncateAddress(address)}</span>
          </div>
          <div className="flex justify-between gap-4 text-sm">
            <span className="text-gray-500">Network</span>
            <span className="font-medium text-brand-black">{networkLabel(network)}</span>
          </div>

          <details className="text-xs text-gray-400">
            <summary className="cursor-pointer select-none">Raw transaction (XDR)</summary>
            <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded bg-gray-50 p-2">
              {xdr}
            </pre>
          </details>
        </div>

        <div className="flex gap-3 border-t border-gray-100 px-6 py-4">
          <button
            onClick={onReject}
            className="flex-1 rounded border border-gray-300 py-2 text-sm font-semibold text-gray-600 hover:bg-gray-50 transition"
          >
            Reject
          </button>
          <button
            onClick={onApprove}
            className="flex-1 rounded bg-brand-loginBtn py-2 text-sm font-semibold text-white shadow-md hover:opacity-90 transition"
          >
            Approve &amp; sign
          </button>
        </div>
      </div>
    </div>
  );
}
