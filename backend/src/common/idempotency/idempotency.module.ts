import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { RedisModule } from '../../redis/redis.module';

import { IdempotencyInterceptor } from './idempotency.interceptor';
import { IdempotencyService } from './idempotency.service';

@Module({
  imports: [RedisModule],
  providers: [
    IdempotencyService,
    {
      provide: APP_INTERCEPTOR,
      useClass: IdempotencyInterceptor,
    },
  ],
  exports: [IdempotencyService],
})
export class IdempotencyModule {}
