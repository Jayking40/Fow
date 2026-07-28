/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';

import { JwtKeyService } from '../../auth/jwt-key.service';
import { RedisLocationRepository } from '../../redis/redis-location.repository';
import { RoomAuthorizationService } from '../../websockets/room-authorization.service';
import { RoomEventBusService } from '../../websockets/room-event-bus.service';
import { WsRateLimiterService } from '../../websockets/ws-rate-limiter.service';

import { RiderLocationGateway } from './rider-location.gateway';

const makeSocket = (id = 'socket-1', user?: Record<string, unknown>) => ({
  id,
  emit: jest.fn(),
  join: jest.fn(),
  rooms: new Set([id]),
  data: { user },
});

describe('RiderLocationGateway — authorization & auditing', () => {
  let gateway: RiderLocationGateway;
  let redisRepo: { updateLocation: jest.Mock };
  let roomAuthorizationService: { assertCanJoin: jest.Mock };
  let roomEventBus: { publish: jest.Mock };
  let rateLimiter: { allow: jest.Mock };

  beforeEach(async () => {
    redisRepo = { updateLocation: jest.fn().mockResolvedValue(undefined) };
    roomAuthorizationService = {
      assertCanJoin: jest.fn().mockResolvedValue({ allowed: true }),
    };
    roomEventBus = { publish: jest.fn().mockResolvedValue(undefined) };
    rateLimiter = { allow: jest.fn().mockResolvedValue(true) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RiderLocationGateway,
        { provide: RedisLocationRepository, useValue: redisRepo },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        {
          provide: JwtKeyService,
          useValue: { resolveSecret: jest.fn().mockReturnValue('secret') },
        },
        {
          provide: RoomAuthorizationService,
          useValue: roomAuthorizationService,
        },
        { provide: RoomEventBusService, useValue: roomEventBus },
        { provide: WsRateLimiterService, useValue: rateLimiter },
      ],
    }).compile();

    gateway = module.get(RiderLocationGateway);
    (gateway as any).server = { emit: jest.fn() };
  });

  describe('hospital.subscribe (order:<id> room join)', () => {
    it('rejects an unauthenticated socket (no verified user on handshake)', async () => {
      const socket = makeSocket('socket-1', undefined);
      await gateway.handleJoinOrder(socket as any, { orderId: 'order-1' });

      expect(socket.join).not.toHaveBeenCalled();
      expect(roomAuthorizationService.assertCanJoin).not.toHaveBeenCalled();
    });

    it('joins the order room when authorized', async () => {
      const socket = makeSocket('socket-1', {
        userId: 'user-1',
        role: 'user',
        orgId: null,
      });
      await gateway.handleJoinOrder(socket as any, { orderId: 'order-1' });

      expect(roomAuthorizationService.assertCanJoin).toHaveBeenCalledWith(
        { userId: 'user-1', role: 'user', orgId: null },
        'order:order-1',
        socket.rooms.size,
        'socket-1',
      );
      expect(socket.join).toHaveBeenCalledWith('order:order-1');
    });

    it('rejects and does not join when unauthorized — the denial is audited by RoomAuthorizationService', async () => {
      roomAuthorizationService.assertCanJoin.mockResolvedValue({
        allowed: false,
        reason: 'blocked',
      });
      const socket = makeSocket('socket-1', {
        userId: 'user-1',
        role: 'user',
        orgId: null,
      });

      await gateway.handleJoinOrder(socket as any, { orderId: 'order-1' });

      expect(socket.join).not.toHaveBeenCalled();
      expect(socket.emit).toHaveBeenCalledWith(
        'error',
        expect.objectContaining({ reason: 'blocked' }),
      );
    });
  });

  describe('rider.location.update', () => {
    it('ignores updates from unauthenticated sockets', async () => {
      const socket = makeSocket('socket-1', undefined);
      await gateway.handleLocationUpdate(socket as any, {
        riderId: 'rider-1',
        lat: 6.5,
        lng: 3.4,
        orderId: 'order-1',
      });

      expect(redisRepo.updateLocation).not.toHaveBeenCalled();
      expect(roomEventBus.publish).not.toHaveBeenCalled();
    });

    it('publishes the location update for an authenticated socket', async () => {
      const socket = makeSocket('socket-1', {
        userId: 'user-1',
        role: 'rider',
        orgId: null,
      });
      await gateway.handleLocationUpdate(socket as any, {
        riderId: 'rider-1',
        lat: 6.5244,
        lng: 3.3792,
        orderId: 'order-1',
      });

      expect(redisRepo.updateLocation).toHaveBeenCalledWith(
        'rider-1',
        6.5244,
        3.3792,
      );
      expect(roomEventBus.publish).toHaveBeenCalledWith(
        (gateway as any).server,
        'order:order-1',
        'order.rider.location',
        { lat: 6.5244, lng: 3.3792 },
      );
    });

    it('drops the update when the inbound rate limit is exceeded', async () => {
      rateLimiter.allow.mockResolvedValue(false);
      const socket = makeSocket('socket-1', {
        userId: 'user-1',
        role: 'rider',
        orgId: null,
      });

      await gateway.handleLocationUpdate(socket as any, {
        riderId: 'rider-1',
        lat: 6.5,
        lng: 3.4,
        orderId: 'order-1',
      });

      expect(redisRepo.updateLocation).not.toHaveBeenCalled();
      expect(socket.emit).toHaveBeenCalledWith(
        'error',
        expect.objectContaining({
          reason: expect.stringContaining('Rate limit'),
        }),
      );
    });
  });
});
