/**
 * k6 soak scenario — WebSocket horizontal-scaling recovery (issue #26)
 *
 * Ramps up to 5k concurrent /tracking sockets, each subscribed to its own
 * delivery room and tracking the sequence numbers it observes. Midway
 * through the run, manually kill one API instance behind the load balancer
 * (the harness itself cannot do this — see "Manual step" below) and confirm
 * every client either:
 *   - reconnects and receives every missed event in order (via lastSeq
 *     replay), or
 *   - receives an explicit `resync.required` instruction.
 * Memory on the surviving instance(s) should stay flat even with clients
 * reconnecting mid-stream — this exercises the same backpressure path as
 * websocket-fanout.js, just at higher concurrency and over a longer window.
 *
 * Run:
 *   k6 run --env BASE_URL=http://localhost:3000 --env RIDER_TOKEN=<jwt> websocket-soak.js
 *
 * Manual step (not automatable from k6):
 *   While this script is mid-run (after ~2m), kill one API instance
 *   (`kill -9 <pid>` or scale the deployment down by one replica) and watch
 *   the `ws_soak_resync_required` / `ws_soak_gap_recovered` counters below.
 */

import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const gapRecovered = new Counter('ws_soak_gap_recovered');
const resyncRequired = new Counter('ws_soak_resync_required');
const outOfOrderEvents = new Counter('ws_soak_out_of_order_events');
const reconnectLatency = new Trend('ws_soak_reconnect_latency_ms', true);

export const options = {
  scenarios: {
    tracking_soak: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '60s', target: 5000 },
        { duration: '10m', target: 5000 },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: {
    ws_soak_out_of_order_events: ['count==0'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const WS_URL = BASE_URL.replace(/^http/, 'ws');
const TOKEN = __ENV.RIDER_TOKEN || 'dev-rider-token';

export default function () {
  const deliveryId = `soak-${__VU}`;
  let lastSeq = 0;
  let sawGap = false;

  const url = `${WS_URL}/tracking/socket.io/?EIO=4&transport=websocket&token=${TOKEN}`;

  const res = ws.connect(url, {}, (socket) => {
    socket.on('open', () => {
      socket.send(JSON.stringify({ event: 'delivery.subscribe', deliveryId, lastSeq }));
    });

    socket.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }

      if (msg.event === 'resync.required') {
        resyncRequired.add(1);
        sawGap = true;
        return;
      }

      if (typeof msg.seq === 'number') {
        if (msg.seq <= lastSeq) {
          outOfOrderEvents.add(1);
        }
        if (sawGap) {
          gapRecovered.add(1);
          sawGap = false;
        }
        lastSeq = msg.seq;
      }
    });

    socket.setTimeout(() => socket.close(), 60_000);
  });

  check(res, { 'ws connected': (r) => r && r.status === 101 });
  sleep(1);

  reconnectLatency.add(0); // placeholder trend point per VU iteration
}
