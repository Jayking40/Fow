"use client";

import React, { useEffect, useState } from "react";
import { cn } from "@/lib/utils/cn";
import { getSocket, type ConnectionStatus } from "@/lib/realtime/socket";

export function ConnectionStatusPill() {
  const [status, setStatus] = useState<ConnectionStatus>("offline");

  useEffect(() => {
    const socket = getSocket();

    const onConnect = () => setStatus("connected");
    const onDisconnect = () => setStatus("offline");
    const onReconnecting = () => setStatus("reconnecting");

    if (socket.connected) setStatus("connected");

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("reconnect_attempt", onReconnecting);
    socket.on("reconnect", onConnect);

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("reconnect_attempt", onReconnecting);
      socket.off("reconnect", onConnect);
    };
  }, []);

  if (status === "connected") return null;

  const styles: Record<Exclude<ConnectionStatus, "connected">, string> = {
    reconnecting: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
    offline: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  };

  const labels: Record<Exclude<ConnectionStatus, "connected">, string> = {
    reconnecting: "Reconnecting…",
    offline: "Offline",
  };

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium",
        styles[status]
      )}
      role="status"
      aria-live="polite"
    >
      <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
      {labels[status]}
    </span>
  );
}
