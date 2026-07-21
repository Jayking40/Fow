"use client";

import React, { useEffect, useRef, useState } from "react";
import { Bell, X, CheckCheck } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils/cn";
import { getSocket } from "@/lib/realtime/socket";
import { invalidateForEvent } from "@/lib/realtime/queryInvalidation";
import { useNotificationsStore, type Notification } from "@/lib/stores/notifications.store";
import { useToast } from "@/lib/hooks/useToast";
import { format, isToday, isYesterday } from "date-fns";

function groupByDay(notifications: Notification[]): Record<string, Notification[]> {
  return notifications.reduce<Record<string, Notification[]>>((acc, n) => {
    const date = new Date(n.timestamp);
    const key = isToday(date) ? "Today" : isYesterday(date) ? "Yesterday" : format(date, "MMM d, yyyy");
    (acc[key] ??= []).push(n);
    return acc;
  }, {});
}

const SEVERITY_DOT: Record<string, string> = {
  critical: "bg-red-500",
  warning: "bg-yellow-500",
  info: "bg-blue-500",
};

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { notifications, unreadCount, addNotification, markRead, markAllRead, dismiss } =
    useNotificationsStore();

  useEffect(() => {
    const socket = getSocket();

    const handleNotification = (event: Parameters<typeof addNotification>[0]) => {
      addNotification(event);
      invalidateForEvent(queryClient, event.type);
      if (event.severity === "critical") {
        showToast(`\uD83D\uDEA8 ${event.title}: ${event.message}`, "error");
      }
    };

    socket.on("notification", handleNotification);
    socket.on("cold_chain.breach", handleNotification);
    socket.on("route_deviation.detected", handleNotification);
    socket.on("emergency.order", handleNotification);
    socket.on("quarantine.flag", handleNotification);

    return () => {
      socket.off("notification", handleNotification);
      socket.off("cold_chain.breach", handleNotification);
      socket.off("route_deviation.detected", handleNotification);
      socket.off("emergency.order", handleNotification);
      socket.off("quarantine.flag", handleNotification);
    };
  }, [addNotification, queryClient, showToast]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const grouped = groupByDay(notifications);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={`Notifications${unreadCount > 0 ? `, ${unreadCount} unread` : ""}`}
        aria-expanded={open}
        className="relative p-2 rounded-full hover:bg-surface-raised transition-colors text-text-primary"
      >
        <Bell className="w-5 h-5" />
        {unreadCount > 0 && (
          <span className="absolute top-0.5 right-0.5 min-w-[18px] h-[18px] rounded-full bg-[#D32F2F] text-white text-[10px] font-bold flex items-center justify-center px-1">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 max-h-[480px] flex flex-col rounded-xl border border-border-muted bg-surface shadow-xl z-50">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border-muted">
            <span className="font-semibold text-text-primary text-sm">Notifications</span>
            {unreadCount > 0 && (
              <button
                onClick={markAllRead}
                className="flex items-center gap-1 text-xs text-[#D32F2F] hover:underline"
                aria-label="Mark all as read"
              >
                <CheckCheck className="w-3.5 h-3.5" />
                Mark all read
              </button>
            )}
          </div>

          <div className="overflow-y-auto flex-1">
            {notifications.length === 0 ? (
              <p className="text-center text-text-muted text-sm py-8">No notifications</p>
            ) : (
              Object.entries(grouped).map(([day, items]) => (
                <div key={day}>
                  <p className="px-4 py-2 text-xs font-semibold text-text-muted uppercase tracking-wider bg-surface-raised">
                    {day}
                  </p>
                  {items.map((n) => (
                    <div
                      key={n.id}
                      onClick={() => markRead(n.id)}
                      className={cn(
                        "flex items-start gap-3 px-4 py-3 cursor-pointer hover:bg-surface-raised transition-colors border-b border-border-muted last:border-0",
                        !n.read && "bg-blue-50/40 dark:bg-blue-900/10"
                      )}
                    >
                      <span
                        className={cn(
                          "mt-1.5 w-2 h-2 rounded-full flex-shrink-0",
                          SEVERITY_DOT[n.severity] ?? "bg-gray-400"
                        )}
                      />
                      <div className="flex-1 min-w-0">
                        <p className={cn("text-sm text-text-primary truncate", !n.read && "font-semibold")}>
                          {n.title}
                        </p>
                        <p className="text-xs text-text-muted truncate">{n.message}</p>
                        <p className="text-xs text-text-muted mt-0.5">
                          {format(new Date(n.timestamp), "HH:mm")}
                        </p>
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); dismiss(n.id); }}
                        className="flex-shrink-0 p-0.5 rounded hover:bg-surface-raised text-text-muted"
                        aria-label="Dismiss notification"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
