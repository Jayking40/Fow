"use client";

import React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils/cn";

export interface PaginationProps {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  className?: string;
}

export function Pagination({ page, totalPages, onPageChange, className }: PaginationProps) {
  if (totalPages <= 1) return null;

  return (
    <nav
      aria-label="Pagination"
      className={cn("flex items-center gap-1", className)}
    >
      <button
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 1}
        aria-label="Previous page"
        className="p-1.5 rounded hover:bg-surface-raised disabled:opacity-40 disabled:cursor-not-allowed text-text-primary"
      >
        <ChevronLeft className="w-4 h-4" />
      </button>

      {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
        <button
          key={p}
          onClick={() => onPageChange(p)}
          aria-current={p === page ? "page" : undefined}
          className={cn(
            "w-8 h-8 rounded text-sm font-medium transition-colors",
            p === page
              ? "bg-[#D32F2F] text-white"
              : "text-text-primary hover:bg-surface-raised"
          )}
        >
          {p}
        </button>
      ))}

      <button
        onClick={() => onPageChange(page + 1)}
        disabled={page >= totalPages}
        aria-label="Next page"
        className="p-1.5 rounded hover:bg-surface-raised disabled:opacity-40 disabled:cursor-not-allowed text-text-primary"
      >
        <ChevronRight className="w-4 h-4" />
      </button>
    </nav>
  );
}
