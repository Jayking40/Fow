"use client";

import React, { forwardRef } from "react";
import { cn } from "@/lib/utils/cn";
import { LoadingSpinner } from "./LoadingSpinner";

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "destructive" | "ghost";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = "primary",
      size = "md",
      loading = false,
      disabled,
      className,
      children,
      ...props
    },
    ref
  ) => {
    const base =
      "inline-flex items-center justify-center gap-2 font-semibold rounded transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:opacity-50 disabled:pointer-events-none";

    const variants = {
      primary:
        "bg-[#D32F2F] text-white hover:bg-[#b71c1c] focus-visible:ring-[#D32F2F] dark:bg-[#ef5350] dark:hover:bg-[#D32F2F]",
      secondary:
        "bg-white text-brand-black border border-gray-300 hover:bg-gray-50 focus-visible:ring-gray-400 dark:bg-surface dark:text-text-primary dark:border-border-muted dark:hover:bg-surface-raised",
      destructive:
        "bg-red-700 text-white hover:bg-red-800 focus-visible:ring-red-600",
      ghost:
        "bg-transparent text-brand-black hover:bg-gray-100 focus-visible:ring-gray-400 dark:text-text-primary dark:hover:bg-surface-raised",
    };

    const sizes = {
      sm: "px-3 py-1.5 text-sm h-8",
      md: "px-4 py-2 text-base h-10",
      lg: "px-6 py-3 text-lg h-12",
    };

    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={cn(base, variants[variant], sizes[size], className)}
        {...props}
      >
        {loading && <LoadingSpinner className="py-0 h-4 w-4" />}
        {children}
      </button>
    );
  }
);

Button.displayName = "Button";
