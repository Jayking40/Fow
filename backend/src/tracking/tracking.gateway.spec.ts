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

describe('TrackingGateway', () => {
  let gateway: TrackingGateway;
  let jwtService: JwtService;
  let jwtKeyService: { resolveSecret: jest.Mock };
  let roomAuthorizationService: { evaluate: jest.Mock; auditDenied: jest.Mock };
  let roomEventBus: { publish: jest.Mock; replay: jest.Mock };
  let backpressureQueue: { enqueue: jest.Mock; release: jest.Mock };
  let rateLimiter: { allow: jest.Mock };
  let locationCoalescer: { record: jest.Mock };

  beforeEach(async () => {
    jwtKeyService = { resolveSecret: jest.fn().mockReturnValue('test-secret') };
    roomAuthorizationService = {
      evaluate: jest.fn().mockReturnValue({ allowed: true }),
      auditDenied: jest.fn().mockResolvedValue(undefined),
    };
    roomEventBus = {
      publish: jest
        .fn()
        .mockResolvedValue({ seq: 1, ts: new Date().toISOString() }),
      replay: jest
        .fn()
        .mockResolvedValue({ resyncRequired: false, events: [] }),
    };
    backpressureQueue = { enqueue: jest.fn(), release: jest.fn() };
    rateLimiter = { allow: jest.fn().mockResolvedValue(true) };
    locationCoalescer = { record: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TrackingGateway,
        {
          provide: JwtService,
          useValue: {
            verifyAsync: jest.fn(),
          },
        },
        { provide: JwtKeyService, useValue: jwtKeyService },
        {
          provide: RoomAuthorizationService,
          useValue: roomAuthorizationService,
        },
        { provide: RoomEventBusService, useValue: roomEventBus },
        { provide: BackpressureQueueService, useValue: backpressureQueue },
        { provide: WsRateLimiterService, useValue: rateLimiter },
        { provide: LocationCoalescerService, useValue: locationCoalescer },
      ],
    }).compile();

    gateway = module.get<TrackingGateway>(TrackingGateway);
    jwtService = module.get<JwtService>(JwtService);
  });

  it('should be defined', () => {
    expect(gateway).toBeDefined();
  });

  it('should initialize WebSocket server', () => {
    const mockServer = { on: jest.fn() } as any;
    gateway.afterInit(mockServer);
    expect(gateway).toBeDefined();
  });

  describe('Connection Handling', () => {
    let mockSocket: any;

    beforeEach(() => {
      mockSocket = {
        id: 'test-socket-id',
        handshake: {
          auth: { token: 'valid-token' },
        },
        emit: jest.fn(),
        disconnect: jest.fn(),
        join: jest.fn(),
        leave: jest.fn(),
        connected: true,
        on: jest.fn(),
      };
    });

    afterEach(() => {
      // The gateway starts a heartbeat interval on successful connection;
      // clear it via handleDisconnect so Jest doesn't hang on open handles.
      gateway.handleDisconnect(mockSocket);
    });

    it('should reject connection without token', async () => {
      mockSocket.handshake.auth = {};
      mockSocket.handshake.query = {};

      await gateway.handleConnection(mockSocket);

      expect(mockSocket.disconnect).toHaveBeenCalledWith(true);
    });

    it('should accept valid JWT token', async () => {
      const mockPayload = { sub: 'user-123' };
      (jwtService.verifyAsync as jest.Mock).mockResolvedValue(mockPayload);

      await gateway.handleConnection(mockSocket);

      expect(mockSocket.emit).toHaveBeenCalledWith(
        'connected',
        expect.objectContaining({
          userId: 'user-123',
        }),
      );
    });

    it('should reject invalid JWT token', async () => {
      (jwtService.verifyAsync as jest.Mock).mockRejectedValue(
        new Error('Invalid token'),
      );

      await gateway.handleConnection(mockSocket);

      expect(mockSocket.disconnect).toHaveBeenCalledWith(true);
    });

    it('releases the backpressure queue on disconnect', async () => {
      (jwtService.verifyAsync as jest.Mock).mockResolvedValue({
        sub: 'user-123',
      });
      await gateway.handleConnection(mockSocket);

      gateway.handleDisconnect(mockSocket);

      expect(backpressureQueue.release).toHaveBeenCalledWith('test-socket-id');
    });
  });

  describe('Delivery Subscription', () => {
    let mockSocket: any;

    beforeEach(() => {
      mockSocket = {
        id: 'test-socket-id',
        handshake: {
          auth: { token: 'valid-token' },
        },
        emit: jest.fn(),
        disconnect: jest.fn(),
        join: jest.fn(),
        leave: jest.fn(),
        connected: true,
        on: jest.fn(),
      };

      // Mock authenticated client
      (gateway as any).connectedClients.set('test-socket-id', {
        userId: 'user-123',
        role: 'user',
        orgId: null,
        rooms: new Set(),
      });
    });

    it('should subscribe to delivery room', async () => {
      const data = { deliveryId: 'delivery-123' };

      await gateway.handleDeliverySubscribe(mockSocket, data);

      expect(mockSocket.join).toHaveBeenCalledWith('delivery:delivery-123');
      expect(mockSocket.emit).toHaveBeenCalledWith(
        'delivery.subscribed',
        expect.objectContaining({
          deliveryId: 'delivery-123',
        }),
      );
    });

    it('rejects the subscribe when room authorization denies it', async () => {
      roomAuthorizationService.evaluate.mockReturnValue({
        allowed: false,
        reason: 'nope',
      });
      const data = { deliveryId: 'delivery-123' };

      await gateway.handleDeliverySubscribe(mockSocket, data);

      expect(mockSocket.join).not.toHaveBeenCalled();
      expect(roomAuthorizationService.auditDenied).toHaveBeenCalled();
      expect(mockSocket.emit).toHaveBeenCalledWith('error', { reason: 'nope' });
    });

    it('replays missed events when lastSeq is provided', async () => {
      roomEventBus.replay.mockResolvedValue({
        resyncRequired: false,
        events: [
          { seq: 2, ts: 'x', __event: 'location.update', riderId: 'r1' },
        ],
      });

      await gateway.handleDeliverySubscribe(mockSocket, {
        deliveryId: 'delivery-123',
        lastSeq: 1,
      });

      expect(roomEventBus.replay).toHaveBeenCalledWith(
        'delivery:delivery-123',
        1,
      );
      expect(mockSocket.emit).toHaveBeenCalledWith(
        'location.update',
        expect.objectContaining({ seq: 2, riderId: 'r1' }),
      );
    });

    it('emits resync.required when the replay buffer has expired', async () => {
      roomEventBus.replay.mockResolvedValue({ resyncRequired: true });

      await gateway.handleDeliverySubscribe(mockSocket, {
        deliveryId: 'delivery-123',
        lastSeq: 1,
      });

      expect(mockSocket.emit).toHaveBeenCalledWith(
        'resync.required',
        expect.objectContaining({ room: 'delivery:delivery-123' }),
      );
    });

    it('should unsubscribe from delivery room', () => {
      const data = { deliveryId: 'delivery-123' };

      gateway.handleDeliveryUnsubscribe(mockSocket, data);

      expect(mockSocket.leave).toHaveBeenCalledWith('delivery:delivery-123');
      expect(mockSocket.emit).toHaveBeenCalledWith(
        'delivery.unsubscribed',
        expect.objectContaining({
          deliveryId: 'delivery-123',
        }),
      );
    });

    it('should reject subscription without deliveryId', async () => {
      await gateway.handleDeliverySubscribe(mockSocket, {} as any);

      expect(mockSocket.emit).toHaveBeenCalledWith('error', {
        message: 'Missing deliveryId',
      });
      expect(mockSocket.join).not.toHaveBeenCalled();
    });
  });

  describe('Location Updates (coalesced)', () => {
    let mockSocket: any;
    let mockServer: any;

    beforeEach(() => {
      mockSocket = {
        id: 'test-socket-id',
        emit: jest.fn(),
      };

      mockServer = {
        to: jest.fn().mockReturnThis(),
        emit: jest.fn(),
      };

      (gateway as any).server = mockServer;
      (gateway as any).connectedClients.set('test-socket-id', {
        userId: 'user-123',
        role: 'rider',
        riderId: 'rider-123',
        orgId: null,
        rooms: new Set(),
      });
    });

    it('hands the update to the coalescer instead of emitting immediately', async () => {
      const data = {
        riderId: 'rider-123',
        deliveryId: 'delivery-456',
        latitude: 40.7128,
        longitude: -74.006,
        speed: 25.5,
        heading: 90,
      };

      await gateway.handleRiderLocation(mockSocket, data);

      expect(locationCoalescer.record).toHaveBeenCalledWith(
        mockServer,
        'delivery:delivery-456',
        'rider-123',
        expect.objectContaining({
          riderId: 'rider-123',
          latitude: 40.7128,
          longitude: -74.006,
          speed: 25.5,
          heading: 90,
        }),
      );
      expect(mockServer.to).not.toHaveBeenCalled();
    });

    it('ignores location update without required fields', async () => {
      const data = { latitude: 40.7128, longitude: -74.006 } as any;

      await gateway.handleRiderLocation(mockSocket, data);

      expect(locationCoalescer.record).not.toHaveBeenCalled();
    });

    it('drops the update when the rate limiter denies it', async () => {
      rateLimiter.allow.mockResolvedValue(false);
      const data = {
        riderId: 'rider-123',
        deliveryId: 'delivery-456',
        latitude: 1,
        longitude: 1,
      };

      await gateway.handleRiderLocation(mockSocket, data);

      expect(locationCoalescer.record).not.toHaveBeenCalled();
      expect(mockSocket.emit).toHaveBeenCalledWith(
        'error',
        expect.objectContaining({
          reason: expect.stringContaining('Rate limit'),
        }),
      );
    });
  });

  describe('Delivery Status Updates', () => {
    let mockSocket: any;
    let mockServer: any;

    beforeEach(() => {
      mockSocket = {
        id: 'test-socket-id',
        emit: jest.fn(),
      };

      mockServer = {
        to: jest.fn().mockReturnThis(),
        emit: jest.fn(),
      };

      (gateway as any).server = mockServer;
      (gateway as any).connectedClients.set('test-socket-id', {
        userId: 'user-123',
        role: 'rider',
        riderId: 'rider-123',
        orgId: null,
        rooms: new Set(),
      });
    });

    it('should broadcast delivery status update', async () => {
      const data = {
        deliveryId: 'delivery-456',
        status: 'in_transit',
        riderId: 'rider-123',
      };

      await gateway.handleDeliveryStatus(mockSocket, data);

      expect(roomEventBus.publish).toHaveBeenCalledWith(
        mockServer,
        'delivery:delivery-456',
        'delivery.status.updated',
        expect.objectContaining({
          deliveryId: 'delivery-456',
          status: 'in_transit',
          riderId: 'rider-123',
        }),
      );
    });
  });

  describe('ETA Updates', () => {
    let mockSocket: any;
    let mockServer: any;

    beforeEach(() => {
      mockSocket = {
        id: 'test-socket-id',
        emit: jest.fn(),
      };

      mockServer = {
        to: jest.fn().mockReturnThis(),
        emit: jest.fn(),
      };

      (gateway as any).server = mockServer;
      (gateway as any).connectedClients.set('test-socket-id', {
        userId: 'user-123',
        role: 'admin',
        orgId: null,
        rooms: new Set(),
      });
    });

    it('should broadcast ETA update', async () => {
      const data = {
        deliveryId: 'delivery-456',
        estimatedMinutes: 15,
        distanceKm: 2.5,
      };

      await gateway.handleETABroadcast(mockSocket, data);

      expect(roomEventBus.publish).toHaveBeenCalledWith(
        mockServer,
        'delivery:delivery-456',
        'delivery.eta.updated',
        expect.objectContaining({
          deliveryId: 'delivery-456',
          estimatedMinutes: 15,
          distanceKm: 2.5,
        }),
      );
    });
  });

  describe('Public Methods', () => {
    let mockServer: any;

    beforeEach(() => {
      mockServer = {
        to: jest.fn().mockReturnThis(),
        emit: jest.fn(),
      };

      (gateway as any).server = mockServer;
    });

    it('should emit location update via public method', async () => {
      const payload = {
        riderId: 'rider-123',
        deliveryId: 'delivery-456',
        latitude: 40.7128,
        longitude: -74.006,
      };

      await gateway.emitLocationUpdate(payload);

      expect(roomEventBus.publish).toHaveBeenCalledWith(
        mockServer,
        'delivery:delivery-456',
        'location.update',
        expect.objectContaining(payload),
      );
    });

    it('should emit delivery status update via public method', async () => {
      const payload = {
        deliveryId: 'delivery-456',
        status: 'delivered',
      };

      await gateway.emitDeliveryStatusUpdate(payload);

      expect(roomEventBus.publish).toHaveBeenCalledWith(
        mockServer,
        'delivery:delivery-456',
        'delivery.status.updated',
        expect.objectContaining(payload),
      );
    });

    it('should emit ETA update via public method', async () => {
      const payload = {
        deliveryId: 'delivery-456',
        estimatedMinutes: 10,
      };

      await gateway.emitETAUpdate(payload);

      expect(roomEventBus.publish).toHaveBeenCalledWith(
        mockServer,
        'delivery:delivery-456',
        'delivery.eta.updated',
        expect.objectContaining(payload),
      );
    });
  });
});
