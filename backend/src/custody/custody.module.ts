import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BlockchainEvent } from '../soroban/entities/blockchain-event.entity';
import { SorobanModule } from '../soroban/soroban.module';

import { CustodyController } from './custody.controller';
import { CustodyService } from './custody.service';
import { CustodyHandoffEntity } from './entities/custody-handoff.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([CustodyHandoffEntity, BlockchainEvent]),
    SorobanModule,
  ],
  controllers: [CustodyController],
  providers: [CustodyService],
  exports: [CustodyService],
})
export class CustodyModule {}
