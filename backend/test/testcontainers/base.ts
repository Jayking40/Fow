/**
 * Testcontainers base — starts real Postgres, Redis, and LocalStack S3
 * containers that are shared across all integration/e2e suites.
 *
 * Why real containers instead of pg-mem / ioredis-mock:
 *   - pg-mem diverges on FOR UPDATE SKIP LOCKED, partial indexes, partitions
 *   - ioredis-mock diverges on Redis Streams, Lua/CAS, XAUTOCLAIM
 *   These are exactly the primitives the concurrency-sensitive features rely on.
 *
 * Usage:
 *   import { startContainers, stopContainers, getDataSource, getRedis, getS3 }
 *     from '../testcontainers/base';
 *
 * Add to jest config (jest-integration.json):
 *   "globalSetup": "<rootDir>/test/testcontainers/global-setup.ts"
 *   "globalTeardown": "<rootDir>/test/testcontainers/global-teardown.ts"
 */

import {
  GenericContainer,
  StartedTestContainer,
  Wait,
} from 'testcontainers';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import { S3Client } from '@aws-sdk/client-s3';

// ── Shared state (set by startContainers, cleared by stopContainers) ──────────

let pgContainer: StartedTestContainer | null = null;
let redisContainer: StartedTestContainer | null = null;
let s3Container: StartedTestContainer | null = null;

let _dataSource: DataSource | null = null;
let _redis: Redis | null = null;
let _s3: S3Client | null = null;

// ── Lifecycle ─────────────────────────────────────────────────────────────────

export async function startContainers(): Promise<void> {
  [pgContainer, redisContainer, s3Container] = await Promise.all([
    startPostgres(),
    startRedis(),
    startLocalStack(),
  ]);

  _dataSource = await buildDataSource();
  await runMigrations(_dataSource);

  _redis = new Redis({
    host: redisContainer.getHost(),
    port: redisContainer.getMappedPort(6379),
    lazyConnect: false,
  });

  _s3 = new S3Client({
    region: 'us-east-1',
    endpoint: `http://${s3Container.getHost()}:${s3Container.getMappedPort(4566)}`,
    forcePathStyle: true,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
}

export async function stopContainers(): Promise<void> {
  await _redis?.quit().catch(() => {});
  await _dataSource?.destroy().catch(() => {});
  await Promise.all([
    pgContainer?.stop(),
    redisContainer?.stop(),
    s3Container?.stop(),
  ]);
  _dataSource = null;
  _redis = null;
  _s3 = null;
  pgContainer = null;
  redisContainer = null;
  s3Container = null;
}

// ── Accessors ─────────────────────────────────────────────────────────────────

export function getDataSource(): DataSource {
  if (!_dataSource) throw new Error('Containers not started — call startContainers() first');
  return _dataSource;
}

export function getRedis(): Redis {
  if (!_redis) throw new Error('Containers not started — call startContainers() first');
  return _redis;
}

export function getS3(): S3Client {
  if (!_s3) throw new Error('Containers not started — call startContainers() first');
  return _s3;
}

/** Reset all tables between test suites without tearing down containers. */
export async function truncateAll(): Promise<void> {
  const ds = getDataSource();
  const tables = ds.entityMetadatas.map((e) => `"${e.tableName}"`).join(', ');
  if (tables) {
    await ds.query(`TRUNCATE TABLE ${tables} CASCADE`);
  }
  await getRedis().flushall();
}

/** Connection string for use in NestJS module overrides. */
export function pgConnectionString(): string {
  if (!pgContainer) throw new Error('Containers not started');
  return `postgresql://test:test@${pgContainer.getHost()}:${pgContainer.getMappedPort(5432)}/testdb`;
}

export function redisConnectionOptions(): { host: string; port: number } {
  if (!redisContainer) throw new Error('Containers not started');
  return {
    host: redisContainer.getHost(),
    port: redisContainer.getMappedPort(6379),
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function startPostgres(): Promise<StartedTestContainer> {
  return new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_DB: 'testdb',
      POSTGRES_USER: 'test',
      POSTGRES_PASSWORD: 'test',
    })
    .withExposedPorts(5432)
    .withWaitStrategy(
      Wait.forLogMessage('database system is ready to accept connections', 2),
    )
    .start();
}

async function startRedis(): Promise<StartedTestContainer> {
  return new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .start();
}

async function startLocalStack(): Promise<StartedTestContainer> {
  return new GenericContainer('localstack/localstack:3')
    .withEnvironment({ SERVICES: 's3', DEBUG: '0' })
    .withExposedPorts(4566)
    .withWaitStrategy(Wait.forLogMessage('Ready.'))
    .start();
}

async function buildDataSource(): Promise<DataSource> {
  // Dynamically import all entity classes from the TypeORM metadata
  // rather than hard-coding them, so new entities are picked up automatically.
  const { AppModule } = await import('../../src/app.module');
  const { NestFactory } = await import('@nestjs/core');
  const { getDataSourceToken } = await import('@nestjs/typeorm');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });
  const ds: DataSource = app.get(getDataSourceToken());
  await app.close();

  const ds2 = new DataSource({
    ...ds.options,
    url: `postgresql://test:test@${pgContainer!.getHost()}:${pgContainer!.getMappedPort(5432)}/testdb`,
    migrationsRun: false,
    synchronize: false,
  });
  await ds2.initialize();
  return ds2;
}

async function runMigrations(ds: DataSource): Promise<void> {
  await ds.runMigrations({ transaction: 'each' });
}
