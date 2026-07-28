/**
 * Per-event inbound WebSocket rate limits (messages per window).
 *
 * Mirrors the shape of throttle-limits.config.ts but for socket.io message
 * handlers rather than HTTP routes — GPS-spamming a rider socket or hammering
 * a status-update event must not be able to degrade the shared gateway.
 */
export const WS_RATE_LIMIT_WINDOW_MS = 1000;

export interface WsEventRateLimit {
  /** Max messages allowed within WS_RATE_LIMIT_WINDOW_MS. */
  limit: number;
}

export const WS_EVENT_RATE_LIMITS: Record<string, WsEventRateLimit> = {
  'rider.location': { limit: 5 },
  'rider.location.update': { limit: 5 },
  'delivery.status': { limit: 10 },
  'delivery.eta': { limit: 10 },
};

/** Fallback for events without a specific entry. */
export const DEFAULT_WS_EVENT_RATE_LIMIT: WsEventRateLimit = { limit: 20 };
