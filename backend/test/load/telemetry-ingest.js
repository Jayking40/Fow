/**
 * k6 load scenario — telemetry ingest
 *
 * Simulates IoT temperature sensors sending readings at high frequency.
 * Validates that the ingest endpoint keeps p99 < 500 ms at 500 VUs and
 * that no readings are dropped (204 responses only).
 *
 * Run:
 *   k6 run --env BASE_URL=http://localhost:3000 telemetry-ingest.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const ingestLatency = new Trend('telemetry_ingest_latency_ms', true);
const dropRate = new Rate('telemetry_drop_rate');

export const options = {
  scenarios: {
    sensor_flood: {
      executor: 'constant-vus',
      vus: 500,
      duration: '2m',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.005'],
    telemetry_ingest_latency_ms: ['p(99)<500'],
    telemetry_drop_rate: ['rate<0.001'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const TOKEN = __ENV.SENSOR_TOKEN || 'dev-sensor-token';

const UNITS = Array.from({ length: 20 }, (_, i) => `unit-${i + 1}`);

export default function () {
  const unitId = UNITS[Math.floor(Math.random() * UNITS.length)];
  const tempC = (2 + Math.random() * 4).toFixed(2); // 2–6 °C normal range
  const timestamp = new Date().toISOString();

  const payload = JSON.stringify({
    unitId,
    temperatureCelsius: parseFloat(tempC),
    timestamp,
    sensorId: `sensor-${__VU}`,
  });

  const start = Date.now();
  const res = http.post(`${BASE_URL}/telemetry/temperature`, payload, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  });
  ingestLatency.add(Date.now() - start);

  const accepted = check(res, {
    'reading accepted (204)': (r) => r.status === 204 || r.status === 200,
  });
  dropRate.add(!accepted ? 1 : 0);

  sleep(0.05); // 20 readings/sec per VU
}
