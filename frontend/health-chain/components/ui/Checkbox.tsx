"use client";

import React, { forwardRef } from "react";
import { cn } from "@/lib/utils/cn";

export interface CheckboxProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  ({ label, id, className, ...props }, ref) => {
    const inputId = id ?? label?.toLowerCase().replace(/\s+/g, "-");
    return (
      <label
        htmlFor={inputId}
        className="inline-flex items-center gap-2 cursor-pointer select-none"
      >
        <input
          ref={ref}
          type="checkbox"
          id={inputId}
          className={cn(
            "w-4 h-4 rounded border-border-muted text-[#D32F2F] focus:ring-[#D32F2F] bg-surface",
            className
          )}
          {...props}
        />
        {label && (
          <span className="text-sm text-text-primary">{label}</span>
        )}
      </label>
    );
  }
);

Checkbox.displayName = "Checkbox";
