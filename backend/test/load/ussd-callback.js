/**
 * k6 load scenario — USSD callback burst
 *
 * Simulates Africa's Talking gateway sending concurrent USSD session callbacks
 * (mobile blood donors checking availability / registering donations).
 * Validates p99 < 800 ms and no 5xx at 300 VUs.
 *
 * Run:
 *   k6 run --env BASE_URL=http://localhost:3000 ussd-callback.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const cbLatency = new Trend('ussd_callback_latency_ms', true);
const errorRate = new Rate('ussd_error_rate');

export const options = {
  scenarios: {
    ussd_burst: {
      executor: 'ramping-arrival-rate',
      startRate: 10,
      timeUnit: '1s',
      preAllocatedVUs: 100,
      maxVUs: 400,
      stages: [
        { duration: '30s', target: 100 },
        { duration: '1m', target: 300 },
        { duration: '30s', target: 10 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    ussd_callback_latency_ms: ['p(99)<800'],
    ussd_error_rate: ['rate<0.01'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

const MENU_INPUTS = ['1', '2', '3', '*1#', '*2#'];
const SESSION_IDS = Array.from({ length: 500 }, (_, i) => `AT-SID-${i}`);
const PHONE_NUMBERS = Array.from({ length: 500 }, (_, i) => `+2547${String(i).padStart(8, '0')}`);

export default function () {
  const idx = __VU % 500;
  const sessionId = SESSION_IDS[idx];
  const phoneNumber = PHONE_NUMBERS[idx];
  const text = MENU_INPUTS[Math.floor(Math.random() * MENU_INPUTS.length)];

  // Africa's Talking sends form-encoded POST
  const payload =
    `sessionId=${sessionId}&serviceCode=*384*123#` +
    `&phoneNumber=${encodeURIComponent(phoneNumber)}&text=${encodeURIComponent(text)}&networkCode=63902`;

  const start = Date.now();
  const res = http.post(`${BASE_URL}/ussd/callback`, payload, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  cbLatency.add(Date.now() - start);

  const ok = check(res, {
    'callback handled': (r) => r.status === 200,
    'response is CON or END': (r) =>
      typeof r.body === 'string' &&
      (r.body.startsWith('CON ') || r.body.startsWith('END ')),
  });

  errorRate.add(!ok ? 1 : 0);
  sleep(0.05);
}
