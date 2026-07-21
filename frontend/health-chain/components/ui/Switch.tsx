"use client";

import React, { forwardRef } from "react";
import { cn } from "@/lib/utils/cn";

export interface SwitchProps {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
}

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked = false, onChange, label, disabled, className, id }, ref) => {
    const switchId = id ?? label?.toLowerCase().replace(/\s+/g, "-");
    return (
      <div className="inline-flex items-center gap-2">
        <button
          ref={ref}
          id={switchId}
          role="switch"
          aria-checked={checked}
          aria-label={label}
          disabled={disabled}
          onClick={() => onChange?.(!checked)}
          className={cn(
            "relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#D32F2F] focus-visible:ring-offset-2",
            checked ? "bg-[#D32F2F]" : "bg-gray-300 dark:bg-gray-600",
            "disabled:opacity-50 disabled:cursor-not-allowed",
            className
          )}
        >
          <span
            className={cn(
              "inline-block h-4 w-4 rounded-full bg-white shadow transition-transform",
              checked ? "translate-x-6" : "translate-x-1"
            )}
          />
        </button>
        {label && (
          <label htmlFor={switchId} className="text-sm text-text-primary cursor-pointer">
            {label}
          </label>
        )}
      </div>
    );
  }
);

Switch.displayName = "Switch";
