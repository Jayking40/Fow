import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PolicyCenterModule } from '../policy-center/policy-center.module';
import { RedisLocationRepository } from '../redis/redis-location.repository';
import { RedisModule } from '../redis/redis.module';
import { WebsocketsModule } from '../websockets/websockets.module';

import { NotificationPreferenceController } from './controllers/notification-preference.controller';
import { NotificationDeliveryLog } from './entities/notification-delivery-log.entity';
import { NotificationPreference } from './entities/notification-preference.entity';
import { NotificationTemplateEntity } from './entities/notification-template.entity';
import { NotificationEntity } from './entities/notification.entity';
import { NotificationsGateway } from './gateways/notifications.gateway';
import { RiderLocationGateway } from './gateways/rider-location.gateway';
import { EscalationNotificationListener } from './listeners/escalation-notification.listener';
import { OrderNotificationListener } from './listeners/order-notification.listener';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationProcessor } from './processors/notification.processor';
import { EmailProvider } from './providers/email.provider';
import { InAppProvider } from './providers/in-app.provider';
import { PushProvider } from './providers/push.provider';
import { SmsProvider } from './providers/sms.provider';
import { NotificationPreferenceService } from './services/notification-preference.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      NotificationEntity,
      NotificationTemplateEntity,
      NotificationPreference,
      NotificationDeliveryLog,
    ]),
    BullModule.registerQueue({
      name: 'notifications',
    }),
    PolicyCenterModule,
    RedisModule,
    WebsocketsModule,
  ],
  controllers: [NotificationsController, NotificationPreferenceController],
  providers: [
    // Providers
    SmsProvider,
    PushProvider,
    EmailProvider,
    InAppProvider,

    // Gateways
    NotificationsGateway,
    RiderLocationGateway,
    RedisLocationRepository,

    // Processors
    NotificationProcessor,

    // Listeners
    OrderNotificationListener,
    EscalationNotificationListener,

    // Services
    NotificationsService,
    NotificationPreferenceService,
  ],
  exports: [NotificationsService, NotificationPreferenceService, EmailProvider],
})
export class NotificationsModule {}
