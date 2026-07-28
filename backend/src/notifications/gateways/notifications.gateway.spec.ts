/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { Test, TestingModule } from '@nestjs/testing';

import { JwtKeyService } from '../../auth/jwt-key.service';
import { RoomAuthorizationService } from '../../websockets/room-authorization.service';
import { RoomEventBusService } from '../../websockets/room-event-bus.service';

import { NotificationsGateway } from './notifications.gateway';

const makeSocket = (
  id = 'socket-1',
  user?: Record<string, unknown>,
  query: Record<string, unknown> = {},
) => ({
  id,
  emit: jest.fn(),
  join: jest.fn(),
  disconnect: jest.fn(),
  data: { user },
  handshake: { query },
});

describe('NotificationsGateway — auth & recipient room scoping', () => {
  let gateway: NotificationsGateway;
  let roomAuthorizationService: { evaluate: jest.Mock; auditDenied: jest.Mock };
  let roomEventBus: { publish: jest.Mock };

  beforeEach(async () => {
    roomAuthorizationService = {
      evaluate: jest.fn().mockReturnValue({ allowed: true }),
      auditDenied: jest.fn().mockResolvedValue(undefined),
    };
    roomEventBus = { publish: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsGateway,
        {
          provide: JwtKeyService,
          useValue: { resolveSecret: jest.fn().mockReturnValue('secret') },
        },
        {
          provide: RoomAuthorizationService,
          useValue: roomAuthorizationService,
        },
        { provide: RoomEventBusService, useValue: roomEventBus },
      ],
    }).compile();

    gateway = module.get(NotificationsGateway);
  });

  it('disconnects a socket with no verified user (handshake middleware safety net)', () => {
    const socket = makeSocket('socket-1', undefined);
    gateway.handleConnection(socket as any);

    expect(socket.disconnect).toHaveBeenCalledWith(true);
    expect(socket.join).not.toHaveBeenCalled();
  });

  it('joins the recipient room matching the authenticated user by default', () => {
    const socket = makeSocket('socket-1', {
      userId: 'user-1',
      role: 'user',
      orgId: null,
    });
    gateway.handleConnection(socket as any);

    expect(socket.join).toHaveBeenCalledWith('recipient:user-1');
  });

  it("rejects joining someone else's recipient room (spoofing attempt) and audits it", () => {
    roomAuthorizationService.evaluate.mockReturnValue({
      allowed: false,
      reason: 'Recipient room does not belong to user',
    });
    const socket = makeSocket(
      'socket-1',
      { userId: 'user-1', role: 'user', orgId: null },
      { recipientId: 'someone-else' },
    );

    gateway.handleConnection(socket as any);

    expect(socket.join).not.toHaveBeenCalled();
    expect(socket.disconnect).toHaveBeenCalledWith(true);
    expect(roomAuthorizationService.auditDenied).toHaveBeenCalled();
  });

  it('emitToRecipient publishes via the room event bus to the recipient room', async () => {
    (gateway as any).server = {
      to: jest.fn().mockReturnThis(),
      emit: jest.fn(),
    };

    await gateway.emitToRecipient('user-1', { hello: 'world' });

    expect(roomEventBus.publish).toHaveBeenCalledWith(
      (gateway as any).server,
      'recipient:user-1',
      'notification.new',
      { hello: 'world' },
    );
  });
});
