import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SorobanModule } from '../soroban/soroban.module';
import { CustodyChainLinkEntity } from './entities/custody-chain-link.entity';
import { ProofCommitmentEntity } from './entities/proof-commitment.entity';
import { ProofCommitmentController } from './proof-commitment.controller';
import { ProofCommitmentService } from './proof-commitment.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([ProofCommitmentEntity, CustodyChainLinkEntity]),
    SorobanModule,
  ],
  controllers: [ProofCommitmentController],
  providers: [ProofCommitmentService],
  exports: [ProofCommitmentService],
})
export class ProofCommitmentModule {}
