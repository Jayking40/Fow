/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';

import { JwtKeyService } from '../auth/jwt-key.service';
import { BackpressureQueueService } from '../websockets/backpressure-queue.service';
import { RoomAuthorizationService } from '../websockets/room-authorization.service';
import { RoomEventBusService } from '../websockets/room-event-bus.service';
import { WsRateLimiterService } from '../websockets/ws-rate-limiter.service';

import { LocationCoalescerService } from './location-coalescer.service';
import { TrackingGateway } from './tracking.gateway';

const makeSocket = (id = 'socket-1') => ({
  id,
  emit: jest.fn(),
  disconnect: jest.fn(),
  join: jest.fn(),
  leave: jest.fn(),
  connected: true,
  on: jest.fn(),
  handshake: { auth: { token: 'valid-token' }, query: {} },
});

const makeServer = () => ({
  to: jest.fn().mockReturnThis(),
  emit: jest.fn(),
});

describe('TrackingGateway — authorization & schema validation', () => {
  let gateway: TrackingGateway;
  let jwtService: jest.Mocked<Pick<JwtService, 'verifyAsync'>>;
  let roomEventBus: { publish: jest.Mock; replay: jest.Mock };
  let roomAuthorizationService: { evaluate: jest.Mock; auditDenied: jest.Mock };

  beforeEach(async () => {
    jwtService = { verifyAsync: jest.fn() };
    roomEventBus = {
      publish: jest
        .fn()
        .mockResolvedValue({ seq: 1, ts: new Date().toISOString() }),
      replay: jest
        .fn()
        .mockResolvedValue({ resyncRequired: false, events: [] }),
    };
    roomAuthorizationService = {
      evaluate: jest.fn().mockReturnValue({ allowed: true }),
      auditDenied: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TrackingGateway,
        { provide: JwtService, useValue: jwtService },
        {
          provide: JwtKeyService,
          useValue: { resolveSecret: jest.fn().mockReturnValue('secret') },
        },
        {
          provide: RoomAuthorizationService,
          useValue: roomAuthorizationService,
        },
        { provide: RoomEventBusService, useValue: roomEventBus },
        {
          provide: BackpressureQueueService,
          useValue: { enqueue: jest.fn(), release: jest.fn() },
        },
        {
          provide: WsRateLimiterService,
          useValue: { allow: jest.fn().mockResolvedValue(true) },
        },
        { provide: LocationCoalescerService, useValue: { record: jest.fn() } },
      ],
    }).compile();

    gateway = module.get(TrackingGateway);
  });

  // ---------------------------------------------------------------------------
  // Connection auth
  // ---------------------------------------------------------------------------

  it('rejects connection without token', async () => {
    const socket = makeSocket();
    (socket.handshake as any).auth = {};
    (socket.handshake as any).query = {};
    await gateway.handleConnection(socket as any);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('rejects connection with invalid/expired token', async () => {
    jwtService.verifyAsync.mockRejectedValue(new Error('jwt expired'));
    const socket = makeSocket();
    await gateway.handleConnection(socket as any);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
    expect(socket.emit).toHaveBeenCalledWith('error', {
      reason: 'Invalid or expired token',
    });
  });

  it('accepts valid token and stores context', async () => {
    jwtService.verifyAsync.mockResolvedValue({ sub: 'user-1', role: 'user' });
    const socket = makeSocket();
    await gateway.handleConnection(socket as any);
    expect(socket.emit).toHaveBeenCalledWith(
      'connected',
      expect.objectContaining({ userId: 'user-1' }),
    );
    expect((gateway as any).connectedClients.has('socket-1')).toBe(true);
    gateway.handleDisconnect(socket as any);
  });

  // ---------------------------------------------------------------------------
  // Subscribe authorization
  // ---------------------------------------------------------------------------

  const seedClient = (socketId: string, role: string, riderId?: string) => {
    (gateway as any).connectedClients.set(socketId, {
      userId: 'user-1',
      role,
      riderId,
      orgId: null,
      rooms: new Set(),
    });
  };

  it('allows any authenticated user to subscribe to a delivery', async () => {
    const socket = makeSocket();
    seedClient('socket-1', 'user');
    await gateway.handleDeliverySubscribe(socket as any, {
      deliveryId: 'del-1',
    });
    expect(socket.join).toHaveBeenCalledWith('delivery:del-1');
  });

  it('rejects subscribe for unauthenticated socket', async () => {
    const socket = makeSocket();
    // no client context seeded
    await gateway.handleDeliverySubscribe(socket as any, {
      deliveryId: 'del-1',
    });
    expect(socket.join).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith('error', {
      reason: 'Client not authenticated',
    });
  });

  it('rejects subscribe without deliveryId', async () => {
    const socket = makeSocket();
    seedClient('socket-1', 'user');
    await gateway.handleDeliverySubscribe(socket as any, {} as any);
    expect(socket.join).not.toHaveBeenCalled();
  });

  it('rejects subscribe when room-authorization denies the join and audits it', async () => {
    roomAuthorizationService.evaluate.mockReturnValue({
      allowed: false,
      reason: 'blocked',
    });
    const socket = makeSocket();
    seedClient('socket-1', 'user');
    await gateway.handleDeliverySubscribe(socket as any, {
      deliveryId: 'del-1',
    });
    expect(socket.join).not.toHaveBeenCalled();
    expect(roomAuthorizationService.auditDenied).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      'delivery:del-1',
      'socket-1',
      'blocked',
    );
  });

  // ---------------------------------------------------------------------------
  // Publish authorization — rider.location
  // ---------------------------------------------------------------------------

  it('allows assigned rider to publish location', async () => {
    const socket = makeSocket();
    const server = makeServer();
    (gateway as any).server = server;
    seedClient('socket-1', 'rider', 'rider-1');

    await gateway.handleRiderLocation(socket as any, {
      riderId: 'rider-1',
      deliveryId: 'del-1',
      latitude: 6.45,
      longitude: 3.4,
    });

    const locationCoalescer = (gateway as any).locationCoalescer;
    expect(locationCoalescer.record).toHaveBeenCalledWith(
      server,
      'delivery:del-1',
      'rider-1',
      expect.objectContaining({ riderId: 'rider-1' }),
    );
  });

  it("blocks a rider from publishing location for another rider's delivery", async () => {
    const socket = makeSocket();
    const server = makeServer();
    (gateway as any).server = server;
    seedClient('socket-1', 'rider', 'rider-2'); // different rider

    await gateway.handleRiderLocation(socket as any, {
      riderId: 'rider-1',
      deliveryId: 'del-1',
      latitude: 6.45,
      longitude: 3.4,
    });

    const locationCoalescer = (gateway as any).locationCoalescer;
    expect(locationCoalescer.record).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({
        reason: expect.stringContaining('Not authorized'),
      }),
    );
  });

  it('blocks regular user from publishing location', async () => {
    const socket = makeSocket();
    const server = makeServer();
    (gateway as any).server = server;
    seedClient('socket-1', 'user');

    await gateway.handleRiderLocation(socket as any, {
      riderId: 'rider-1',
      deliveryId: 'del-1',
      latitude: 6.45,
      longitude: 3.4,
    });

    const locationCoalescer = (gateway as any).locationCoalescer;
    expect(locationCoalescer.record).not.toHaveBeenCalled();
  });

  it('allows admin to publish location', async () => {
    const socket = makeSocket();
    const server = makeServer();
    (gateway as any).server = server;
    seedClient('socket-1', 'admin');

    await gateway.handleRiderLocation(socket as any, {
      riderId: 'rider-1',
      deliveryId: 'del-1',
      latitude: 6.45,
      longitude: 3.4,
    });

    const locationCoalescer = (gateway as any).locationCoalescer;
    expect(locationCoalescer.record).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Schema / coordinate validation
  // ---------------------------------------------------------------------------

  it('rejects out-of-range latitude', async () => {
    const socket = makeSocket();
    const server = makeServer();
    (gateway as any).server = server;
    seedClient('socket-1', 'rider', 'rider-1');

    await gateway.handleRiderLocation(socket as any, {
      riderId: 'rider-1',
      deliveryId: 'del-1',
      latitude: 999,
      longitude: 3.4,
    });

    expect(server.to).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith('error', {
      reason: 'Invalid coordinates',
    });
  });

  it('rejects invalid delivery status enum', async () => {
    const socket = makeSocket();
    const server = makeServer();
    (gateway as any).server = server;
    seedClient('socket-1', 'rider', 'rider-1');

    await gateway.handleDeliveryStatus(socket as any, {
      deliveryId: 'del-1',
      status: 'HACKED_STATUS',
      riderId: 'rider-1',
    });

    expect(roomEventBus.publish).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({
        reason: expect.stringContaining('Invalid status'),
      }),
    );
  });

  it('rejects negative estimatedMinutes in ETA', async () => {
    const socket = makeSocket();
    const server = makeServer();
    (gateway as any).server = server;
    seedClient('socket-1', 'admin');

    await gateway.handleETABroadcast(socket as any, {
      deliveryId: 'del-1',
      estimatedMinutes: -5,
    });

    expect(roomEventBus.publish).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith('error', {
      reason: 'Invalid estimatedMinutes',
    });
  });

  // ---------------------------------------------------------------------------
  // Cross-delivery subscription scope
  // ---------------------------------------------------------------------------

  it('user cannot publish status for a delivery they do not own', async () => {
    const socket = makeSocket();
    const server = makeServer();
    (gateway as any).server = server;
    seedClient('socket-1', 'user'); // plain user, not a rider

    await gateway.handleDeliveryStatus(socket as any, {
      deliveryId: 'del-99',
      status: 'in_transit',
      riderId: 'rider-99',
    });

    expect(roomEventBus.publish).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({
        reason: expect.stringContaining('Not authorized'),
      }),
    );
  });
});
