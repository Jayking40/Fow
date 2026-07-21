"use client";

import React, { useState } from "react";
import { cn } from "@/lib/utils/cn";

export interface TabItem {
  key: string;
  label: string;
  content: React.ReactNode;
}

export interface TabsProps {
  items: TabItem[];
  defaultKey?: string;
  className?: string;
}

export function Tabs({ items, defaultKey, className }: TabsProps) {
  const [active, setActive] = useState(defaultKey ?? items[0]?.key);

  const handleKeyDown = (e: React.KeyboardEvent, idx: number) => {
    if (e.key === "ArrowRight") {
      const next = items[(idx + 1) % items.length];
      setActive(next.key);
    } else if (e.key === "ArrowLeft") {
      const prev = items[(idx - 1 + items.length) % items.length];
      setActive(prev.key);
    }
  };

  return (
    <div className={cn("w-full", className)}>
      <div role="tablist" className="flex border-b border-border-muted">
        {items.map((item, idx) => (
          <button
            key={item.key}
            role="tab"
            aria-selected={active === item.key}
            aria-controls={`tabpanel-${item.key}`}
            id={`tab-${item.key}`}
            tabIndex={active === item.key ? 0 : -1}
            onClick={() => setActive(item.key)}
            onKeyDown={(e) => handleKeyDown(e, idx)}
            className={cn(
              "px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#D32F2F]",
              active === item.key
                ? "border-[#D32F2F] text-[#D32F2F]"
                : "border-transparent text-text-muted hover:text-text-primary"
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
      {items.map((item) => (
        <div
          key={item.key}
          role="tabpanel"
          id={`tabpanel-${item.key}`}
          aria-labelledby={`tab-${item.key}`}
          hidden={active !== item.key}
          className="pt-4"
        >
          {item.content}
        </div>
      ))}
    </div>
  );
}
