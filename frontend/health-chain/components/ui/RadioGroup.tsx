"use client";

import React from "react";
import { cn } from "@/lib/utils/cn";

export interface RadioOption {
  value: string;
  label: string;
}

export interface RadioGroupProps {
  name: string;
  options: RadioOption[];
  value?: string;
  onChange?: (value: string) => void;
  label?: string;
  className?: string;
}

export function RadioGroup({
  name,
  options,
  value,
  onChange,
  label,
  className,
}: RadioGroupProps) {
  return (
    <fieldset className={cn("flex flex-col gap-2", className)}>
      {label && (
        <legend className="text-sm font-medium text-text-primary mb-1">
          {label}
        </legend>
      )}
      {options.map((opt) => (
        <label
          key={opt.value}
          className="inline-flex items-center gap-2 cursor-pointer select-none"
        >
          <input
            type="radio"
            name={name}
            value={opt.value}
            checked={value === opt.value}
            onChange={() => onChange?.(opt.value)}
            className="w-4 h-4 text-[#D32F2F] border-border-muted focus:ring-[#D32F2F] bg-surface"
          />
          <span className="text-sm text-text-primary">{opt.label}</span>
        </label>
      ))}
    </fieldset>
  );
}
