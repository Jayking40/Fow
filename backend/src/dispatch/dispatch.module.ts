import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MapsModule } from '../maps/maps.module';
import { PolicyCenterModule } from '../policy-center/policy-center.module';
import { RidersModule } from '../riders/riders.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { BloodUnit } from '../blood-units/entities/blood-unit.entity';
import { OrderEntity } from '../orders/entities/order.entity';
import { DeliveryProofEntity } from '../delivery-proof/entities/delivery-proof.entity';
import { RedisModule } from '../redis/redis.module';

import { DispatchController } from './dispatch.controller';
import { DispatchService } from './dispatch.service';
import { DispatchSyncController } from './dispatch-sync.controller';
import { DispatchSyncService } from './dispatch-sync.service';
import { RiderAssignmentService } from './rider-assignment.service';
import { DispatchRecord, DispatchStatusHistory } from './entities/dispatch-record.entity';
import { DispatchSyncLogEntity } from './entities/dispatch-sync-log.entity';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([BloodUnit, OrderEntity, DispatchRecord, DispatchStatusHistory, DispatchSyncLogEntity, DeliveryProofEntity]),
    RidersModule,
    MapsModule,
    PolicyCenterModule,
    NotificationsModule,
    RedisModule,
  ],
  controllers: [DispatchController, DispatchSyncController],
  providers: [DispatchService, RiderAssignmentService, DispatchSyncService],
  exports: [DispatchService, RiderAssignmentService, DispatchSyncService],
})
export class DispatchModule {}
