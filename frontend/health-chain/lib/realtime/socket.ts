import { io, Socket } from "socket.io-client";

export type NotificationSeverity = "info" | "warning" | "critical";

export interface ServerNotificationEvent {
  id: string;
  type: string;
  severity: NotificationSeverity;
  title: string;
  message: string;
  timestamp: string;
  meta?: Record<string, unknown>;
}

export interface ServerToClientEvents {
  notification: (event: ServerNotificationEvent) => void;
  "cold_chain.breach": (event: ServerNotificationEvent) => void;
  "route_deviation.detected": (event: ServerNotificationEvent) => void;
  "emergency.order": (event: ServerNotificationEvent) => void;
  "quarantine.flag": (event: ServerNotificationEvent) => void;
}

export type ConnectionStatus = "connected" | "reconnecting" | "offline";

let socket: Socket<ServerToClientEvents> | null = null;

export function getSocket(): Socket<ServerToClientEvents> {
  if (socket) return socket;

  const token =
    typeof window !== "undefined"
      ? (() => {
          try {
            const stored = sessionStorage.getItem("auth-storage");
            return stored ? JSON.parse(stored)?.state?.accessToken : null;
          } catch {
            return null;
          }
        })()
      : null;

  socket = io(process.env.NEXT_PUBLIC_WS_URL ?? "http://localhost:3001", {
    auth: { token },
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 30000,
    transports: ["websocket"],
    autoConnect: true,
  }) as Socket<ServerToClientEvents>;

  return socket;
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}
