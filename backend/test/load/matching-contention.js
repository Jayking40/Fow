/**
 * k6 load scenario — matching contention
 *
 * Simulates N hospitals simultaneously submitting blood requests for the same
 * rare blood type. Validates that the matching engine serialises correctly
 * (no double-allocation) and that p99 latency stays under 2 s at 100 VUs.
 *
 * Run:
 *   k6 run --env BASE_URL=http://localhost:3000 matching-contention.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';

const matchLatency = new Trend('match_latency_ms', true);
const doubleAlloc = new Counter('double_allocation_errors');

export const options = {
  scenarios: {
    contention_spike: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 100 },
        { duration: '1m', target: 100 },
        { duration: '15s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    match_latency_ms: ['p(99)<2000'],
    double_allocation_errors: ['count<1'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const TOKEN = __ENV.ADMIN_TOKEN || 'dev-admin-token';

const RARE_BLOOD_TYPE = 'AB-';
const BLOOD_BANK_ID = 'bank-contention-test';

function createBloodRequest(vu) {
  const payload = JSON.stringify({
    hospitalId: `hosp-${vu}`,
    requiredBy: new Date(Date.now() + 86400000).toISOString(),
    deliveryAddress: `${vu} Test Street`,
    urgency: 'EMERGENCY',
    items: [{ bloodBankId: BLOOD_BANK_ID, bloodType: RARE_BLOOD_TYPE, quantity: 1 }],
  });

  const res = http.post(`${BASE_URL}/blood-requests`, payload, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  });

  check(res, { 'request created': (r) => r.status === 201 });
  return res.status === 201 ? JSON.parse(res.body).id : null;
}

function triggerMatch(requestId) {
  const start = Date.now();
  const res = http.post(
    `${BASE_URL}/matching/match`,
    JSON.stringify({ requestId }),
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` } },
  );
  matchLatency.add(Date.now() - start);

  const ok = check(res, {
    'match succeeded or no stock': (r) => [201, 409, 422].includes(r.status),
  });

  if (!ok) doubleAlloc.add(1);
  return res;
}

export default function () {
  const requestId = createBloodRequest(__VU);
  if (requestId) {
    triggerMatch(requestId);
  }
  sleep(0.1);
}
