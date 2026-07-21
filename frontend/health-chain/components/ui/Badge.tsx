import React, { forwardRef } from "react";
import { cn } from "@/lib/utils/cn";

export type BadgeVariant =
  | "pending"
  | "active"
  | "critical"
  | "resolved"
  | "info"
  | "default";

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

const variantStyles: Record<BadgeVariant, string> = {
  pending:
    "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  active:
    "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  critical: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  resolved:
    "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  info: "bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300",
  default:
    "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300",
};

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  ({ variant = "default", className, children, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(
        "inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium",
        variantStyles[variant],
        className
      )}
      {...props}
    >
      {children}
    </span>
  )
);

Badge.displayName = "Badge";
