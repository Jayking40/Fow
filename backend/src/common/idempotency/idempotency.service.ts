import { Injectable, Inject, Logger } from '@nestjs/common';
import { createHash } from 'crypto';

import Redis from 'ioredis';

import { REDIS_CLIENT } from '../../redis/redis.constants';

export enum IdempotencyRecordStatus {
  PROCESSING = 'processing',
  COMPLETED = 'completed',
}

export interface IdempotencyRecord {
  status: IdempotencyRecordStatus;
  bodyHash: string;
  statusCode?: number;
  body?: unknown;
  createdAt: number;
}

export type IdempotencyCheckResult =
  | { type: 'proceed' }
  | { type: 'completed'; statusCode: number; body: unknown }
  | { type: 'conflict'; retryAfter: number }
  | { type: 'bodyMismatch' };

/**
 * Idempotency service for handling duplicate requests.
 * Uses two-phase semantics with atomic Redis operations to prevent race conditions.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);
  private readonly ttlSeconds = 24 * 60 * 60; // 24 hours
  private readonly lockTtlSeconds = 30; // 30 seconds

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Generate a SHA-256 hash of the request body for fingerprinting.
   */
  generateBodyHash(body: unknown): string {
    const bodyString = JSON.stringify(body || {});
    return createHash('sha256').update(bodyString).digest('hex');
  }

  /**
   * Check the status of an idempotency key and attempt to start processing.
   * Uses atomic Redis SET NX to prevent race conditions.
   */
  async checkAndStart(
    idempotencyKey: string,
    bodyHash: string,
  ): Promise<IdempotencyCheckResult> {
    const key = this.getKey(idempotencyKey);

    try {
      // First, check if a record exists
      const existingRecordJson = await this.redis.get(key);
      if (existingRecordJson) {
        const existingRecord: IdempotencyRecord = JSON.parse(existingRecordJson) as IdempotencyRecord;

        // Check if body hash matches
        if (existingRecord.bodyHash !== bodyHash) {
          return { type: 'bodyMismatch' };
        }

        // Check status
        if (existingRecord.status === IdempotencyRecordStatus.COMPLETED) {
          return {
            type: 'completed',
            statusCode: existingRecord.statusCode!,
            body: existingRecord.body,
          };
        }

        // If still processing, check if lock is expired (createdAt > lockTtl)
        const now = Date.now();
        const elapsedSeconds = (now - existingRecord.createdAt) / 1000;
        if (elapsedSeconds > this.lockTtlSeconds) {
          // Lock expired, we can take over
          const newRecord: IdempotencyRecord = {
            status: IdempotencyRecordStatus.PROCESSING,
            bodyHash,
            createdAt: now,
          };
          // Use SET to overwrite (atomic)
          await this.redis.setex(
            key,
            this.ttlSeconds,
            JSON.stringify(newRecord),
          );
          return { type: 'proceed' };
        } else {
          // Still processing, return conflict
          const retryAfter = Math.ceil(this.lockTtlSeconds - elapsedSeconds);
          return { type: 'conflict', retryAfter };
        }
      }

      // No existing record, try to create a new processing record atomically
      const newRecord: IdempotencyRecord = {
        status: IdempotencyRecordStatus.PROCESSING,
        bodyHash,
        createdAt: Date.now(),
      };
      const result = await this.redis.set(
        key,
        JSON.stringify(newRecord),
        'EX',
        this.ttlSeconds,
        'NX',
      );

      if (result === 'OK') {
        return { type: 'proceed' };
      } else {
        // Another request created the record in between, check again
        return this.checkAndStart(idempotencyKey, bodyHash);
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to check and start idempotency: ${errorMessage}`,
      );
      // On error, allow request to proceed (fail open)
      return { type: 'proceed' };
    }
  }

  /**
   * Store the completed response for an idempotency key.
   */
  async storeCompleted(
    idempotencyKey: string,
    statusCode: number,
    body: unknown,
  ): Promise<void> {
    const key = this.getKey(idempotencyKey);
    try {
      // Get existing record to preserve bodyHash
      const existingRecordJson = await this.redis.get(key);
      if (!existingRecordJson) {
        return;
      }
      const existingRecord: IdempotencyRecord = JSON.parse(existingRecordJson) as IdempotencyRecord;

      const completedRecord: IdempotencyRecord = {
        ...existingRecord,
        status: IdempotencyRecordStatus.COMPLETED,
        statusCode,
        body,
      };

      await this.redis.setex(
        key,
        this.ttlSeconds,
        JSON.stringify(completedRecord),
      );
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to store completed idempotency response: ${errorMessage}`,
      );
    }
  }

  private getKey(idempotencyKey: string): string {
    return `idempotency:record:${idempotencyKey}`;
  }
}
