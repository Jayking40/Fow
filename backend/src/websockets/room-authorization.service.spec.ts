import { Test, TestingModule } from '@nestjs/testing';

import { AuditLogService } from '../common/audit/audit-log.service';

import {
  MAX_ROOMS_PER_CONNECTION,
  RoomAuthorizationService,
} from './room-authorization.service';

import type { WsAuthenticatedUser } from './ws-jwt-auth';

describe('RoomAuthorizationService', () => {
  let service: RoomAuthorizationService;
  let auditLogService: { insert: jest.Mock };

  const user = (
    overrides: Partial<WsAuthenticatedUser> = {},
  ): WsAuthenticatedUser => ({
    userId: 'user-1',
    role: 'user',
    orgId: null,
    ...overrides,
  });

  beforeEach(async () => {
    auditLogService = { insert: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RoomAuthorizationService,
        { provide: AuditLogService, useValue: auditLogService },
      ],
    }).compile();

    service = module.get(RoomAuthorizationService);
  });

  it('rejects malformed room identifiers', () => {
    const decision = service.evaluate(user(), 'not-a-room', 0);
    expect(decision.allowed).toBe(false);
  });

  it('rejects joins once max rooms per connection is reached', () => {
    const decision = service.evaluate(
      user(),
      'delivery:1',
      MAX_ROOMS_PER_CONNECTION,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/Max rooms/);
  });

  it('allows privileged roles into any room', () => {
    const admin = user({ role: 'admin' });
    expect(service.evaluate(admin, 'recipient:someone-else', 0).allowed).toBe(
      true,
    );
    expect(service.evaluate(admin, 'org:another-org', 0).allowed).toBe(true);
  });

  it('allows a user to join their own recipient room', () => {
    const decision = service.evaluate(
      user({ userId: 'user-1' }),
      'recipient:user-1',
      0,
    );
    expect(decision.allowed).toBe(true);
  });

  it("rejects a user joining someone else's recipient room (spoofing)", () => {
    const decision = service.evaluate(
      user({ userId: 'user-1' }),
      'recipient:user-2',
      0,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/does not belong/);
  });

  it('rejects an org room join when orgId does not match', () => {
    const decision = service.evaluate(user({ orgId: 'org-a' }), 'org:org-b', 0);
    expect(decision.allowed).toBe(false);
  });

  it('allows an org room join when orgId matches', () => {
    const decision = service.evaluate(user({ orgId: 'org-a' }), 'org:org-a', 0);
    expect(decision.allowed).toBe(true);
  });

  it('allows any authenticated user into delivery/order rooms', () => {
    expect(service.evaluate(user(), 'delivery:123', 0).allowed).toBe(true);
    expect(service.evaluate(user(), 'order:456', 0).allowed).toBe(true);
  });

  it('rejects unknown room types', () => {
    const decision = service.evaluate(user(), 'mystery:1', 0);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/Unknown room type/);
  });

  it('writes an audit record when a join is denied', async () => {
    await service.assertCanJoin(
      user({ userId: 'user-1' }),
      'recipient:user-2',
      0,
      'socket-1',
    );

    expect(auditLogService.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'user-1',
        action: 'ws.room.join.denied',
        resourceType: 'ws_room',
        resourceId: 'recipient:user-2',
      }),
    );
  });

  it('does not write an audit record when a join is allowed', async () => {
    await service.assertCanJoin(user(), 'delivery:123', 0, 'socket-1');
    expect(auditLogService.insert).not.toHaveBeenCalled();
  });

  it('does not throw if the audit log write fails', async () => {
    auditLogService.insert.mockRejectedValue(new Error('db down'));
    await expect(
      service.auditDenied(user(), 'recipient:user-2', 'socket-1', 'test'),
    ).resolves.toBeUndefined();
  });
});
