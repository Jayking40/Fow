import React, { forwardRef } from "react";
import { cn } from "@/lib/utils/cn";

export const Table = forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement>>(
  ({ className, ...props }, ref) => (
    <div className="w-full overflow-x-auto">
      <table
        ref={ref}
        className={cn("w-full text-sm text-left border-collapse", className)}
        {...props}
      />
    </div>
  )
);
Table.displayName = "Table";

export const TableHead = forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <thead
      ref={ref}
      className={cn("bg-surface-raised text-text-muted uppercase text-xs tracking-wider", className)}
      {...props}
    />
  )
);
TableHead.displayName = "TableHead";

export const TableBody = forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <tbody
      ref={ref}
      className={cn("divide-y divide-border-muted", className)}
      {...props}
    />
  )
);
TableBody.displayName = "TableBody";

export const TableRow = forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => (
    <tr
      ref={ref}
      className={cn("hover:bg-surface-raised transition-colors", className)}
      {...props}
    />
  )
);
TableRow.displayName = "TableRow";

export const TableCell = forwardRef<HTMLTableCellElement, React.TdHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <td
      ref={ref}
      className={cn("px-4 py-3 text-text-primary", className)}
      {...props}
    />
  )
);
TableCell.displayName = "TableCell";

export const TableHeaderCell = forwardRef<HTMLTableCellElement, React.ThHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <th
      ref={ref}
      className={cn("px-4 py-3 font-medium text-text-muted", className)}
      {...props}
    />
  )
);
TableHeaderCell.displayName = "TableHeaderCell";
