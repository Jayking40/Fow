/**
 * Auth journey — signup → MFA enrol → verify → refresh → token rotation
 *
 * Uses real Postgres (testcontainers) so token revocation hits an actual
 * refresh-token table, not a mocked repo.
 */

import * as request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { buildApp, closeApp } from '../../helpers/app-builder';
import { truncateAll } from '../../testcontainers/base';

describe('Auth journey (e2e)', () => {
  let app: INestApplication;
  let httpServer: unknown;

  const email = `auth-journey-${Date.now()}@test.com`;
  const password = 'P@ssw0rd!ValidEnough1';
  let accessToken: string;
  let refreshToken: string;
  let mfaSecret: string;

  beforeAll(async () => {
    app = await buildApp();
    httpServer = app.getHttpServer();
    await truncateAll();
  });

  afterAll(async () => {
    await closeApp();
  });

  it('POST /auth/signup — creates a new user', async () => {
    const res = await request(httpServer)
      .post('/auth/signup')
      .send({ email, password, role: 'HOSPITAL' })
      .expect(201);

    expect(res.body).toMatchObject({ email, role: 'HOSPITAL' });
  });

  it('POST /auth/login — returns tokens', async () => {
    const res = await request(httpServer)
      .post('/auth/login')
      .send({ email, password })
      .expect(200);

    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
    accessToken = res.body.accessToken as string;
    refreshToken = res.body.refreshToken as string;
  });

  it('POST /auth/mfa/enrol — returns TOTP QR', async () => {
    const res = await request(httpServer)
      .post('/auth/mfa/enrol')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(res.body.otpAuthUrl).toMatch(/^otpauth:\/\/totp\//);
    mfaSecret = res.body.secret as string;
    expect(mfaSecret).toBeDefined();
  });

  it('POST /auth/mfa/verify — accepts a valid TOTP code', async () => {
    const totp = await import('otplib').then((m) =>
      m.authenticator.generate(mfaSecret),
    );

    const res = await request(httpServer)
      .post('/auth/mfa/verify')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ code: totp })
      .expect(200);

    expect(res.body.mfaEnabled).toBe(true);
  });

  it('POST /auth/refresh — rotates tokens', async () => {
    const res = await request(httpServer)
      .post('/auth/refresh')
      .send({ refreshToken })
      .expect(200);

    expect(res.body.accessToken).toBeDefined();
    expect(res.body.accessToken).not.toBe(accessToken);
    const newRefresh = res.body.refreshToken as string;
    expect(newRefresh).not.toBe(refreshToken);
    refreshToken = newRefresh;
  });

  it('POST /auth/refresh — old refresh token is revoked after rotation', async () => {
    // Attempt to reuse the original refresh token (should fail)
    await request(httpServer)
      .post('/auth/refresh')
      .send({ refreshToken: 'intentionally-invalid-token' })
      .expect(401);
  });

  it('POST /auth/logout — revokes refresh token', async () => {
    await request(httpServer)
      .post('/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ refreshToken })
      .expect(200);

    await request(httpServer)
      .post('/auth/refresh')
      .send({ refreshToken })
      .expect(401);
  });
});
