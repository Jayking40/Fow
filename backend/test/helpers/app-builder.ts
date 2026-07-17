import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { pgConnectionString, redisConnectionOptions } from '../testcontainers/base';

let _app: INestApplication | null = null;
let _module: TestingModule | null = null;

/**
 * Build (or return cached) the NestJS app wired to the testcontainer endpoints.
 * Call closeApp() in afterAll to tear it down.
 */
export async function buildApp(): Promise<INestApplication> {
  if (_app) return _app;

  const redis = redisConnectionOptions();
  const pgUrl = pgConnectionString();

  _module = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideModule(TypeOrmModule)
    .useModule(
      TypeOrmModule.forRoot({
        type: 'postgres',
        url: pgUrl,
        autoLoadEntities: true,
        migrationsRun: false,
        synchronize: false,
        logging: false,
      }),
    )
    .overrideModule(BullModule)
    .useModule(
      BullModule.forRoot({
        connection: { host: redis.host, port: redis.port },
      }),
    )
    .compile();

  _app = _module.createNestApplication();
  _app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await _app.init();
  return _app;
}

export async function closeApp(): Promise<void> {
  await _app?.close();
  _app = null;
  _module = null;
}

export function getDataSourceFromApp(): DataSource {
  if (!_module) throw new Error('App not built — call buildApp() first');
  return _module.get<DataSource>(DataSource);
}
