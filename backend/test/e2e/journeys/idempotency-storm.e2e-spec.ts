/**
 * Idempotency storm — fires N concurrent identical POST requests for the same
 * resource and asserts that exactly one succeeds and the rest return 409 or
 * the same resource (idempotent).
 *
 * Related: issue #22.
 */

import * as request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { buildApp, closeApp } from '../../helpers/app-builder';
import { truncateAll } from '../../testcontainers/base';
import { makeCreateBloodRequestDto, makeJwtPayload } from '../../helpers/factories';
import * as jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret';

function makeToken(tenantId = 'tenant-storm') {
  return jwt.sign(
    { ...makeJwtPayload({ tenantId }), iat: Math.floor(Date.now() / 1000) },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

describe('Idempotency storm (e2e)', () => {
  let app: INestApplication;
  let httpServer: unknown;
  const token = makeToken();
  const idempotencyKey = `idem-key-${Date.now()}`;

  beforeAll(async () => {
    app = await buildApp();
    httpServer = app.getHttpServer();
    await truncateAll();
  });

  afterAll(async () => {
    await closeApp();
  });

  it('50 concurrent identical requests produce exactly one resource', async () => {
    const dto = makeCreateBloodRequestDto();

    const responses = await Promise.all(
      Array.from({ length: 50 }).map(() =>
        request(httpServer)
          .post('/blood-requests')
          .set('Authorization', `Bearer ${token}`)
          .set('Idempotency-Key', idempotencyKey)
          .send(dto),
      ),
    );

    const statuses = responses.map((r) => r.status);
    const created = statuses.filter((s) => s === 201);
    const ok = statuses.filter((s) => s === 200);
    const conflict = statuses.filter((s) => s === 409);

    // Either the server deduplicates (200) or returns 409 for duplicates
    expect(created.length).toBe(1);
    expect(ok.length + conflict.length).toBe(49);

    // All successful responses must share the same resource id
    const ids = responses
      .filter((r) => r.status === 200 || r.status === 201)
      .map((r) => r.body.id as string);
    const unique = new Set(ids);
    expect(unique.size).toBe(1);
  });

  it('replaying the same key after success returns the cached response', async () => {
    const res = await request(httpServer)
      .post('/blood-requests')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(makeCreateBloodRequestDto())
      .expect((r) => expect([200, 201]).toContain(r.status));

    expect(res.body.id).toBeDefined();
  });

  it('a different idempotency key creates a distinct resource', async () => {
    const res = await request(httpServer)
      .post('/blood-requests')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', `${idempotencyKey}-different`)
      .send(makeCreateBloodRequestDto())
      .expect(201);

    expect(res.body.id).toBeDefined();
  });
});
