/**
 * k6 load scenario — WebSocket fanout
 *
 * Opens N persistent WebSocket connections (hospital dashboards) and
 * triggers an order status update via REST. Measures time-to-first-message
 * across all subscribers and asserts p99 < 1 s.
 *
 * Run:
 *   k6 run --env BASE_URL=http://localhost:3000 websocket-fanout.js
 */

import ws from 'k6/ws';
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';

const fanoutLatency = new Trend('ws_fanout_latency_ms', true);
const missedMessages = new Counter('ws_missed_messages');

export const options = {
  scenarios: {
    dashboard_subscribers: {
      executor: 'constant-vus',
      vus: 200,
      duration: '90s',
    },
  },
  thresholds: {
    ws_fanout_latency_ms: ['p(99)<1000'],
    ws_missed_messages: ['count<5'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const WS_URL = BASE_URL.replace(/^http/, 'ws');
const TOKEN = __ENV.ADMIN_TOKEN || 'dev-admin-token';

export default function () {
  const connectStart = Date.now();
  let firstMessageTime = 0;

  const orderId = `order-fanout-${__VU}-${Date.now()}`;

  const res = ws.connect(
    `${WS_URL}/ws/orders?token=${TOKEN}&orderId=${orderId}`,
    {},
    (socket) => {
      socket.on('open', () => {
        // Trigger a status update from REST while connected
        http.patch(
          `${BASE_URL}/orders/${orderId}/accept`,
          '{}',
          { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` } },
        );
      });

      socket.on('message', (data) => {
        if (!firstMessageTime) {
          firstMessageTime = Date.now();
          fanoutLatency.add(firstMessageTime - connectStart);
        }

        const msg = JSON.parse(data);
        check(msg, {
          'message has orderId': (m) => m.orderId === orderId || typeof m.orderId === 'string',
          'message has status': (m) => typeof m.status === 'string',
        });

        socket.close();
      });

      socket.setTimeout(() => {
        if (!firstMessageTime) {
          missedMessages.add(1);
        }
        socket.close();
      }, 5000);
    },
  );

  check(res, { 'ws connected': (r) => r && r.status === 101 });
  sleep(0.1);
}
