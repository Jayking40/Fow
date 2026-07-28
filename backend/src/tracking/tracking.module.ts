import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';

import { WebsocketsModule } from '../websockets/websockets.module';

import { LocationCoalescerService } from './location-coalescer.service';
import { TrackingGateway } from './tracking.gateway';

@Module({
  imports: [
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: '1d' },
      }),
    }),
    WebsocketsModule,
  ],
  providers: [TrackingGateway, LocationCoalescerService],
  exports: [TrackingGateway],
})
export class TrackingModule {}
