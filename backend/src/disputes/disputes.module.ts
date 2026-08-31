import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BlockchainModule } from '../blockchain/blockchain.module';
import { ContractEventIndexerModule } from '../contract-event-indexer/contract-event-indexer.module';
import { IndexerCursorEntity } from '../contract-event-indexer/entities/indexer-cursor.entity';
import { ReconciliationMismatchEntity } from '../reconciliation/entities/reconciliation-mismatch.entity';

import { DisputesController } from './disputes.controller';
import { DisputesService } from './disputes.service';
import { DisputeNoteEntity } from './entities/dispute-note.entity';
import { DisputeEntity } from './entities/dispute.entity';
import { DisputeEventListener } from './listeners/dispute-event.listener';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      DisputeEntity,
      DisputeNoteEntity,
      ReconciliationMismatchEntity,
      IndexerCursorEntity,
    ]),
    BlockchainModule,
    ContractEventIndexerModule,
  ],
  controllers: [DisputesController],
  providers: [DisputesService, DisputeEventListener],
  exports: [DisputesService],
})
export class DisputesModule {}
