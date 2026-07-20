import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "../api/queryKeys";

type InvalidationMap = Record<string, readonly unknown[][]>;

const EVENT_INVALIDATION_MAP: InvalidationMap = {
  "cold_chain.breach": [queryKeys.dashboard.stats],
  "route_deviation.detected": [queryKeys.orders.all],
  "emergency.order": [queryKeys.orders.all, queryKeys.dashboard.stats],
  "quarantine.flag": [queryKeys.quarantine.all, queryKeys.anomalies.all],
  notification: [],
};

export function invalidateForEvent(queryClient: QueryClient, eventType: string) {
  const keys = EVENT_INVALIDATION_MAP[eventType] ?? [];
  keys.forEach((key) => {
    queryClient.invalidateQueries({ queryKey: key });
  });
}
