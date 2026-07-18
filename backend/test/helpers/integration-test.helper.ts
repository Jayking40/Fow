
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import * as path from 'path';

let postgresContainer: StartedPostgreSqlContainer;
let redisContainer: StartedRedisContainer;
let dataSource: DataSource;
let redisClient: Redis;

export async function startContainers() {
  // Start PostgreSQL
  postgresContainer = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('test_db')
    .withUsername('test_user')
    .withPassword('test_password')
    .start();

  // Start Redis
  redisContainer = await new RedisContainer('redis:7-alpine').start();
}

export async function stopContainers() {
  if (dataSource) {
    await dataSource.destroy();
  }
  if (redisClient) {
    await redisClient.quit();
  }
  if (postgresContainer) {
    await postgresContainer.stop();
  }
  if (redisContainer) {
    await redisContainer.stop();
  }
}

export function getPostgresConfig() {
  return {
    host: postgresContainer.getHost(),
    port: postgresContainer.getPort(),
    database: postgresContainer.getDatabase(),
    username: postgresContainer.getUsername(),
    password: postgresContainer.getPassword(),
  };
}

export function getRedisConfig() {
  return {
    host: redisContainer.getHost(),
    port: redisContainer.getPort(),
  };
}

export async function createDataSource(migrationsRun = true): Promise<DataSource> {
  const pgConfig = getPostgresConfig();

  dataSource = new DataSource({
    type: 'postgres',
    host: pgConfig.host,
    port: pgConfig.port,
    username: pgConfig.username,
    password: pgConfig.password,
    database: pgConfig.database,
    entities: [path.join(__dirname, '../../src/**/*.entity{.ts,.js}')],
    migrations: [path.join(__dirname, '../../src/migrations/*{.ts,.js}')],
    synchronize: false,
    logging: false,
  });

  await dataSource.initialize();

  if (migrationsRun) {
    await dataSource.runMigrations();
  }

  return dataSource;
}

export async function createRedisClient(): Promise<Redis> {
  const redisConfig = getRedisConfig();
  redisClient = new Redis({
    host: redisConfig.host,
    port: redisConfig.port,
  });
  return redisClient;
}

export function getDataSource(): DataSource {
  return dataSource;
}

export function getRedisClient(): Redis {
  return redisClient;
}

export async function resetDatabase() {
  if (dataSource) {
    await dataSource.synchronize(true);
  }
}

export async function resetRedis() {
  if (redisClient) {
    await redisClient.flushdb();
  }
}
