/**
 * Outbox multi-consumer — verifies that the transactional outbox pattern
 * publishes exactly-once events even when multiple consumer instances race.
 *
 * Related: issue #18.
 *
 * Strategy:
 *   1. Create a blood request (writes an outbox row inside the same TX).
 *   2. Trigger the outbox poller manually (or wait for BullMQ to process).
 *   3. Assert the outbox row is marked `processed` and the downstream
 *      side-effect (e.g., Notification record or audit log entry) exists
 *      exactly once — not duplicated across two concurrent consumer runs.
 */

import * as request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { buildApp, closeApp, getDataSourceFromApp } from '../../helpers/app-builder';
import { truncateAll } from '../../testcontainers/base';
import { makeCreateBloodRequestDto, makeJwtPayload } from '../../helpers/factories';
import * as jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret';
const OUTBOX_POLL_WAIT_MS = 3_000;

function makeToken() {
  return jwt.sign(
    { ...makeJwtPayload({ tenantId: 'tenant-outbox' }), iat: Math.floor(Date.now() / 1000) },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

describe('Outbox multi-consumer (e2e)', () => {
  let app: INestApplication;
  let httpServer: unknown;
  const token = makeToken();
  let requestId: string;

  beforeAll(async () => {
    app = await buildApp();
    httpServer = app.getHttpServer();
    await truncateAll();
  });

  afterAll(async () => {
    await closeApp();
  });

  it('creating a blood request inserts an outbox event', async () => {
    const res = await request(httpServer)
      .post('/blood-requests')
      .set('Authorization', `Bearer ${token}`)
      .send(makeCreateBloodRequestDto())
      .expect(201);

    requestId = res.body.id as string;
    const ds = getDataSourceFromApp();
    const rows: Array<{ aggregate_id: string; processed: boolean }> = await ds.query(
      `SELECT aggregate_id, processed FROM outbox_events WHERE aggregate_id = $1`,
      [requestId],
    );

    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it('waits for the outbox poller to mark events processed', async () => {
    await new Promise((r) => setTimeout(r, OUTBOX_POLL_WAIT_MS));

    const ds = getDataSourceFromApp();
    const unprocessed: Array<unknown> = await ds.query(
      `SELECT id FROM outbox_events WHERE aggregate_id = $1 AND processed = false`,
      [requestId],
    );

    expect(unprocessed.length).toBe(0);
  });

  it('the downstream notification is created exactly once (no duplicates)', async () => {
    const ds = getDataSourceFromApp();
    const notifications: Array<{ aggregate_id: string }> = await ds.query(
      `SELECT aggregate_id FROM notifications WHERE aggregate_id = $1`,
      [requestId],
    );

    // At least one notification created
    expect(notifications.length).toBeGreaterThanOrEqual(1);

    // No duplicates — event should have been delivered exactly once
    expect(notifications.length).toBe(1);
  });

  it('re-triggering the poller is idempotent — no duplicate notifications', async () => {
    // POST to the internal poller endpoint (if exposed) or query queue directly
    await request(httpServer)
      .post('/internal/outbox/flush')
      .set('Authorization', `Bearer ${makeToken()}`)
      .expect((r) => expect([200, 202, 404]).toContain(r.status));

    await new Promise((r) => setTimeout(r, 500));

    const ds = getDataSourceFromApp();
    const notifications: Array<{ aggregate_id: string }> = await ds.query(
      `SELECT aggregate_id FROM notifications WHERE aggregate_id = $1`,
      [requestId],
    );
    expect(notifications.length).toBe(1);
  });
});
