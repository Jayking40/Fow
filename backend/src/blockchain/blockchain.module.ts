import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CompensationModule } from '../common/compensation/compensation.module';

import { BlockchainController } from './controllers/blockchain.controller';
import { FailedSorobanTxEntity } from './entities/failed-soroban-tx.entity';
import { AdminGuard } from './guards/admin.guard';
import { JobDeduplicationPlugin } from './plugins/job-deduplication.plugin';
import { SorobanDlqProcessor } from './processors/soroban-dlq.processor';
import { SorobanTxProcessor } from './processors/soroban-tx.processor';
import { BlockchainHealthService } from './services/blockchain-health.service';
import { ConfirmationService } from './services/confirmation.service';
import { CursorManager } from './services/cursor-manager.service';
import { FailedSorobanTxService } from './services/failed-soroban-tx.service';
import { IdempotencyService } from './services/idempotency.service';
import { PaginatedQueryService } from './services/paginated-query.service';
import { QueueMetricsService } from './services/queue-metrics.service';
import { SorobanService } from './services/soroban.service';

@Module({
  imports: [
    CompensationModule,
    TypeOrmModule.forFeature([FailedSorobanTxEntity]),
    BullModule.registerQueueAsync(
      {
        name: 'soroban-tx-queue',
        useFactory: (configService: ConfigService) => ({
          connection: {
            host: configService.get<string>('REDIS_HOST'),
            port: configService.get<number>('REDIS_PORT'),
          },
          defaultJobOptions: {
            attempts: 5,
            backoff: {
              type: 'exponential',
              delay: 1000,
            },
            removeOnComplete: true,
            removeOnFail: false,
          },
        }),
        inject: [ConfigService],
      },
      {
        name: 'soroban-dlq',
        useFactory: (configService: ConfigService) => ({
          connection: {
            host: configService.get<string>('REDIS_HOST'),
            port: configService.get<number>('REDIS_PORT'),
          },
        }),
        inject: [ConfigService],
      },
    ),
  ],
  providers: [
    SorobanService,
    ConfirmationService,
    IdempotencyService,
    JobDeduplicationPlugin,
    SorobanTxProcessor,
    SorobanDlqProcessor,
    FailedSorobanTxService,
    BlockchainHealthService,
    QueueMetricsService,
    AdminGuard,
    CursorManager,
    PaginatedQueryService,
  ],
  controllers: [BlockchainController],
  exports: [SorobanService, QueueMetricsService],
})
export class BlockchainModule {}
