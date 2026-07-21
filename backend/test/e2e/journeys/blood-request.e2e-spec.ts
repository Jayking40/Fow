/**
 * Blood-request happy path journey:
 *   create request → auto-match → dispatch rider → deliver → settle payment
 *
 * Each step drives through HTTP endpoints to validate the full vertical slice
 * including DB writes, queue events, and status transitions.
 */

import * as request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { buildApp, closeApp, getDataSourceFromApp } from '../../helpers/app-builder';
import { truncateAll } from '../../testcontainers/base';
import { makeCreateBloodRequestDto, makeJwtPayload } from '../../helpers/factories';
import * as jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret';

function makeToken(overrides: Partial<ReturnType<typeof makeJwtPayload>> = {}) {
  return jwt.sign({ ...makeJwtPayload(overrides), iat: Math.floor(Date.now() / 1000) }, JWT_SECRET, {
    expiresIn: '1h',
  });
}

describe('Blood-request happy path (e2e)', () => {
  let app: INestApplication;
  let httpServer: unknown;
  let requestId: string;
  let matchId: string;
  let orderId: string;

  const hospitalToken = makeToken({ role: 'HOSPITAL', sub: 'hosp-1', tenantId: 'tenant-1' });
  const riderToken = makeToken({ role: 'RIDER', sub: 'rider-1', tenantId: 'tenant-1' });
  const adminToken = makeToken({ role: 'admin', sub: 'admin-1', tenantId: 'tenant-1' });

  beforeAll(async () => {
    app = await buildApp();
    httpServer = app.getHttpServer();
    await truncateAll();
  });

  afterAll(async () => {
    await closeApp();
  });

  it('POST /blood-requests — hospital creates a request', async () => {
    const dto = makeCreateBloodRequestDto({ hospitalId: 'hosp-1' });
    const res = await request(httpServer)
      .post('/blood-requests')
      .set('Authorization', `Bearer ${hospitalToken}`)
      .send(dto)
      .expect(201);

    expect(res.body.id).toBeDefined();
    expect(res.body.status).toBe('PENDING');
    requestId = res.body.id as string;
  });

  it('POST /matching/match — coordinator triggers matching', async () => {
    const res = await request(httpServer)
      .post('/matching/match')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ requestId })
      .expect(201);

    expect(res.body.matchId).toBeDefined();
    matchId = res.body.matchId as string;
  });

  it('POST /orders — matched units become an order', async () => {
    const res = await request(httpServer)
      .post('/orders')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ matchId })
      .expect(201);

    expect(res.body.id).toBeDefined();
    expect(res.body.status).toBe('PENDING');
    orderId = res.body.id as string;
  });

  it('PATCH /orders/:id/accept — rider accepts the order', async () => {
    const res = await request(httpServer)
      .patch(`/orders/${orderId}/accept`)
      .set('Authorization', `Bearer ${riderToken}`)
      .expect(200);

    expect(res.body.status).toBe('ACCEPTED');
    expect(res.body.riderId).toBe('rider-1');
  });

  it('PATCH /orders/:id/pick-up — rider picks up', async () => {
    await request(httpServer)
      .patch(`/orders/${orderId}/pick-up`)
      .set('Authorization', `Bearer ${riderToken}`)
      .expect(200);
  });

  it('PATCH /orders/:id/deliver — rider marks delivered', async () => {
    const res = await request(httpServer)
      .patch(`/orders/${orderId}/deliver`)
      .set('Authorization', `Bearer ${riderToken}`)
      .send({ signatureBase64: 'data:image/png;base64,iVBORw0KGgo=' })
      .expect(200);

    expect(res.body.status).toBe('DELIVERED');
  });

  it('PATCH /orders/:id/settle — hospital confirms, payment settles', async () => {
    const res = await request(httpServer)
      .patch(`/orders/${orderId}/settle`)
      .set('Authorization', `Bearer ${hospitalToken}`)
      .expect(200);

    expect(res.body.status).toBe('SETTLED');
  });

  it('GET /blood-requests/:id — final request status is FULFILLED', async () => {
    const res = await request(httpServer)
      .get(`/blood-requests/${requestId}`)
      .set('Authorization', `Bearer ${hospitalToken}`)
      .expect(200);

    expect(res.body.status).toBe('FULFILLED');
  });
});
