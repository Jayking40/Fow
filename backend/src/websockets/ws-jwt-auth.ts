import { UnauthorizedException } from '@nestjs/common';

import { decode, verify } from 'jsonwebtoken';

import { JwtKeyService } from '../auth/jwt-key.service';

import type { Socket } from 'socket.io';

export interface WsAuthenticatedUser {
  userId: string;
  role: string;
  riderId?: string;
  orgId: string | null;
}

/** Extracts the bearer token from a socket.io handshake (auth or query). */
function extractToken(socket: Socket): string | undefined {
  const authToken = (
    socket.handshake.auth as Record<string, unknown> | undefined
  )?.token as string | undefined;
  if (authToken) return authToken;

  const queryToken = (
    socket.handshake.query as Record<string, unknown> | undefined
  )?.token as string | undefined;
  return queryToken;
}

/**
 * Verifies a socket.io handshake JWT using the same key-rotation logic as
 * JwtStrategy (HTTP), so a single grace-period key rotation covers both
 * transports. Throws UnauthorizedException on any failure.
 */
export function verifyWsHandshake(
  socket: Socket,
  jwtKeyService: JwtKeyService,
): WsAuthenticatedUser {
  const token = extractToken(socket);
  if (!token) {
    throw new UnauthorizedException('Authentication token required');
  }

  const decoded = decode(token, { complete: true });
  const kid =
    (decoded?.header as unknown as Record<string, string>)?.kid ?? 'key-1';
  const secret = jwtKeyService.resolveSecret(kid);
  if (!secret) {
    throw new UnauthorizedException('Unknown signing key');
  }

  let payload: Record<string, unknown>;
  try {
    payload = verify(token, secret) as Record<string, unknown>;
  } catch (error) {
    throw new UnauthorizedException(
      (error as Error).message || 'Invalid or expired token',
    );
  }

  const userId = (payload.sub as string) ?? (payload.userId as string);
  if (!userId) {
    throw new UnauthorizedException('Token missing subject claim');
  }

  return {
    userId,
    role: (payload.role as string) ?? 'user',
    riderId: payload.riderId as string | undefined,
    orgId: (payload.orgId as string) ?? null,
  };
}

/**
 * Socket.IO namespace middleware factory: `server.use(createWsAuthMiddleware(jwtKeyService))`.
 * Verifies the handshake and attaches the resolved user to `socket.data.user`.
 */
export function createWsAuthMiddleware(jwtKeyService: JwtKeyService) {
  return (socket: Socket, next: (err?: Error) => void) => {
    try {
      const user = verifyWsHandshake(socket, jwtKeyService);
      (socket.data as Record<string, unknown>).user = user;
      next();
    } catch (error) {
      next(error as Error);
    }
  };
}
