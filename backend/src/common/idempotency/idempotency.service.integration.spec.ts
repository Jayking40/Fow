import { Test, TestingModule } from '@nestjs/testing';
import Redis from 'ioredis';
import RedisMock from 'ioredis-mock';

import { REDIS_CLIENT } from '../../redis/redis.constants';
import { IdempotencyRecordStatus, IdempotencyService } from './idempotency.service';

describe('IdempotencyService (Integration)', () => {
  let service: IdempotencyService;
  let redis: Redis;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IdempotencyService,
        {
          provide: REDIS_CLIENT,
          useFactory: () => new RedisMock(),
        },
      ],
    }).compile();

    service = module.get<IdempotencyService>(IdempotencyService);
    redis = module.get<Redis>(REDIS_CLIENT);

    await redis.flushdb();
  });

  afterAll(async () => {
    await redis.flushdb();
    await redis.quit();
  });

  afterEach(async () => {
    await redis.flushdb();
  });

  describe('Concurrency Storm (50 parallel requests)', () => {
    it('should process exactly one request and return the same result to all others', async () => {
      const key = 'test-concurrency-key';
      const body = { test: 'data' };
      const bodyHash = service.generateBodyHash(body);

      let executionCount = 0;
      const testValue = { id: '123', name: 'test' };

      // Simulate 50 parallel requests
      const promises = Array(50)
        .fill(null)
        .map(async () => {
          const result = await service.checkAndStart(key, bodyHash);
          if (result.type === 'proceed') {
            executionCount++;
            // Simulate some work
            await new Promise((resolve) => setTimeout(resolve, 50));
            await service.storeCompleted(key, 201, testValue);
            return { status: 'processed', data: testValue };
          } else if (result.type === 'completed') {
            return { status: 'cached', data: result.body };
          } else if (result.type === 'conflict') {
            return { status: 'conflict' };
          } else {
            return { status: 'error' };
          }
        });

      const results = await Promise.all(promises);

      // Exactly one should have processed
      expect(executionCount).toBe(1);

      // All should either have cached or conflict, but all should end up with the same result
      const processed = results.filter((r) => r.status === 'processed');
      const cached = results.filter((r) => r.status === 'cached');

      expect(processed.length + cached.length).toBeGreaterThan(0);
      [...processed, ...cached].forEach((r) => {
        expect(r.data).toEqual(testValue);
      });
    });
  });

  describe('Crash Mid-Processing (Lease Expiry)', () => {
    it('should allow a new request to take over after lock expires', async () => {
      const key = 'test-lease-key';
      const body = { test: 'lease' };
      const bodyHash = service.generateBodyHash(body);

      // First, create a "stuck" processing record with an old timestamp
      const oldRecord = {
        status: IdempotencyRecordStatus.PROCESSING,
        bodyHash,
        createdAt: Date.now() - 31 * 1000, // 31 seconds ago (older than 30s lock TTL)
      };
      await redis.setex(service['getKey'](key), 86400, JSON.stringify(oldRecord));

      // Now try to process with the same key
      const result = await service.checkAndStart(key, bodyHash);

      expect(result.type).toBe('proceed');
    });
  });

  describe('Body Mismatch', () => {
    it('should throw body mismatch when key is reused with different body', async () => {
      const key = 'test-body-mismatch-key';
      const body1 = { test: 'data1' };
      const body2 = { test: 'data2' };

      // First, process with body1
      const bodyHash1 = service.generateBodyHash(body1);
      const result1 = await service.checkAndStart(key, bodyHash1);
      expect(result1.type).toBe('proceed');
      await service.storeCompleted(key, 201, { result: 'success1' });

      // Now try with body2, same key
      const bodyHash2 = service.generateBodyHash(body2);
      const result2 = await service.checkAndStart(key, bodyHash2);

      expect(result2.type).toBe('bodyMismatch');
    });
  });

  describe('Completed Request', () => {
    it('should return cached response when key is reused', async () => {
      const key = 'test-completed-key';
      const body = { test: 'cached' };
      const bodyHash = service.generateBodyHash(body);
      const testResponse = { id: '456', value: 'cached-response' };

      // First request
      const result1 = await service.checkAndStart(key, bodyHash);
      expect(result1.type).toBe('proceed');
      await service.storeCompleted(key, 200, testResponse);

      // Second request with same key
      const result2 = await service.checkAndStart(key, bodyHash);
      expect(result2.type).toBe('completed');
      expect(result2.statusCode).toBe(200);
      expect(result2.body).toEqual(testResponse);
    });
  });
});
