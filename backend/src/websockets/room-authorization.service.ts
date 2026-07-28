import { Injectable, Logger } from '@nestjs/common';

import { AuditLogService } from '../common/audit/audit-log.service';

import type { WsAuthenticatedUser } from './ws-jwt-auth';

/** Roles that may join or publish to any room (operations staff). */
const PRIVILEGED_ROLES = new Set(['admin', 'super_admin', 'dispatcher']);

/** Max rooms a single socket connection may join, to bound fan-out abuse. */
export const MAX_ROOMS_PER_CONNECTION = 20;

export interface RoomJoinDecision {
  allowed: boolean;
  reason?: string;
}

@Injectable()
export class RoomAuthorizationService {
  private readonly logger = new Logger(RoomAuthorizationService.name);

  constructor(private readonly auditLogService: AuditLogService) {}

  /**
   * Evaluates whether `user` may join `room` (format `<type>:<id>`, e.g.
   * `delivery:123`, `order:123`, `recipient:456`, `org:789`).
   *
   * - Privileged roles (admin/super_admin/dispatcher) may join anything.
   * - `recipient:<id>` is scoped to the owning user only.
   * - Other room types (delivery/order) are open to any authenticated user,
   *   matching this codebase's existing dashboard-consumer model.
   */
  evaluate(
    user: WsAuthenticatedUser,
    room: string,
    currentRoomCount: number,
  ): RoomJoinDecision {
    if (!room || !room.includes(':')) {
      return { allowed: false, reason: 'Malformed room identifier' };
    }

    if (currentRoomCount >= MAX_ROOMS_PER_CONNECTION) {
      return { allowed: false, reason: 'Max rooms per connection exceeded' };
    }

    if (PRIVILEGED_ROLES.has(user.role)) {
      return { allowed: true };
    }

    const [type, id] = room.split(':', 2);

    if (type === 'recipient') {
      if (id === user.userId) return { allowed: true };
      return {
        allowed: false,
        reason: 'Recipient room does not belong to user',
      };
    }

    if (type === 'org') {
      if (user.orgId && id === user.orgId) return { allowed: true };
      return { allowed: false, reason: 'Org room does not match user org' };
    }

    if (type === 'delivery' || type === 'order') {
      return { allowed: true };
    }

    return { allowed: false, reason: `Unknown room type "${type}"` };
  }

  /**
   * Writes the audit record for a denied join. Kept separate from
   * `evaluate()` so callers with synchronous join semantics can decide
   * synchronously and fire this off without awaiting (`void auditDenied(...)`),
   * while callers that can afford to await get the same guarantee via
   * `assertCanJoin`.
   */
  async auditDenied(
    user: WsAuthenticatedUser,
    room: string,
    socketId: string,
    reason: string | undefined,
  ): Promise<void> {
    this.logger.warn(
      `Denied room join: user=${user.userId} role=${user.role} room=${room} socket=${socketId} reason=${reason}`,
    );

    try {
      await this.auditLogService.insert({
        actorId: user.userId,
        actorRole: user.role,
        action: 'ws.room.join.denied',
        resourceType: 'ws_room',
        resourceId: room,
        metadata: { socketId, reason },
      });
    } catch (error) {
      this.logger.error(
        `Failed to write audit log for denied room join: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Evaluates the join and, when denied, writes an audit record. Returns the
   * decision so callers can reject/emit without duplicating audit logic.
   */
  async assertCanJoin(
    user: WsAuthenticatedUser,
    room: string,
    currentRoomCount: number,
    socketId: string,
  ): Promise<RoomJoinDecision> {
    const decision = this.evaluate(user, room, currentRoomCount);
    if (!decision.allowed) {
      await this.auditDenied(user, room, socketId, decision.reason);
    }
    return decision;
  }
}
