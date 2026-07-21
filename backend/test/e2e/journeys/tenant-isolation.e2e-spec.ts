/**
 * Tenant isolation matrix — verifies that data created in tenant A is never
 * readable or writable by tenant B, even when both share the same database.
 *
 * Related: issue #19.
 */

import * as request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { buildApp, closeApp } from '../../helpers/app-builder';
import { truncateAll } from '../../testcontainers/base';
import { makeCreateBloodRequestDto, makeJwtPayload } from '../../helpers/factories';
import * as jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret';

function tok(sub: string, tenantId: string, role = 'HOSPITAL') {
  return jwt.sign(
    { ...makeJwtPayload({ sub, tenantId, role }), iat: Math.floor(Date.now() / 1000) },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

describe('Tenant isolation matrix (e2e)', () => {
  let app: INestApplication;
  let httpServer: unknown;

  const tokenA = tok('user-a', 'tenant-A');
  const tokenB = tok('user-b', 'tenant-B');
  const adminA = tok('admin-a', 'tenant-A', 'admin');

  let requestIdA: string;

  beforeAll(async () => {
    app = await buildApp();
    httpServer = app.getHttpServer();
    await truncateAll();
  });

  afterAll(async () => {
    await closeApp();
  });

  it('tenant A can create a blood request', async () => {
    const res = await request(httpServer)
      .post('/blood-requests')
      .set('Authorization', `Bearer ${tokenA}`)
      .send(makeCreateBloodRequestDto({ hospitalId: 'hosp-A' }))
      .expect(201);

    requestIdA = res.body.id as string;
    expect(requestIdA).toBeDefined();
  });

  it('tenant B cannot read tenant A blood request', async () => {
    await request(httpServer)
      .get(`/blood-requests/${requestIdA}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(404);
  });

  it('tenant B list does not include tenant A records', async () => {
    const res = await request(httpServer)
      .get('/blood-requests')
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(200);

    const ids = (res.body.data ?? res.body).map((r: { id: string }) => r.id);
    expect(ids).not.toContain(requestIdA);
  });

  it('tenant B cannot cancel tenant A blood request', async () => {
    await request(httpServer)
      .patch(`/blood-requests/${requestIdA}/cancel`)
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(404);
  });

  it('admin of tenant A CAN read the request', async () => {
    await request(httpServer)
      .get(`/blood-requests/${requestIdA}`)
      .set('Authorization', `Bearer ${adminA}`)
      .expect(200);
  });

  it('tenant B creates its own request and A cannot see it', async () => {
    const resB = await request(httpServer)
      .post('/blood-requests')
      .set('Authorization', `Bearer ${tokenB}`)
      .send(makeCreateBloodRequestDto({ hospitalId: 'hosp-B' }))
      .expect(201);

    const requestIdB = resB.body.id as string;

    await request(httpServer)
      .get(`/blood-requests/${requestIdB}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(404);
  });
});
