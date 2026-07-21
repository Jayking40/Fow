import {
  Controller,
  Post,
  Body,
  Headers,
  BadRequestException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';

import { DispatchSyncService, SyncActionDto, SyncResult } from './dispatch-sync.service';
import { SyncActionType } from './entities/dispatch-sync-log.entity';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateIdempotencyKey(key: string | undefined): string {
  if (!key || !UUID_REGEX.test(key)) {
    throw new BadRequestException(
      'Idempotency-Key header is required and must be a valid UUID',
    );
  }
  return key;
}

@Controller('dispatch/sync')
export class DispatchSyncController {
  constructor(private readonly syncService: DispatchSyncService) {}

  @Post('accept')
  @HttpCode(HttpStatus.OK)
  async acceptAssignment(
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() body: Omit<SyncActionDto, 'actionType'>,
  ): Promise<SyncResult> {
    const key = validateIdempotencyKey(idempotencyKey);
    return this.syncService.applyAction(
      { ...body, actionType: SyncActionType.ACCEPT_ASSIGNMENT },
      key,
    );
  }

  @Post('pickup')
  @HttpCode(HttpStatus.OK)
  async confirmPickup(
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() body: Omit<SyncActionDto, 'actionType'>,
  ): Promise<SyncResult> {
    const key = validateIdempotencyKey(idempotencyKey);
    return this.syncService.applyAction(
      { ...body, actionType: SyncActionType.CONFIRM_PICKUP },
      key,
    );
  }

  @Post('dropoff')
  @HttpCode(HttpStatus.OK)
  async confirmDropoff(
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() body: Omit<SyncActionDto, 'actionType'>,
  ): Promise<SyncResult> {
    const key = validateIdempotencyKey(idempotencyKey);
    return this.syncService.applyAction(
      { ...body, actionType: SyncActionType.CONFIRM_DROPOFF },
      key,
    );
  }

  @Post('signature')
  @HttpCode(HttpStatus.OK)
  async captureSignature(
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() body: Omit<SyncActionDto, 'actionType'>,
  ): Promise<SyncResult> {
    const key = validateIdempotencyKey(idempotencyKey);
    return this.syncService.applyAction(
      { ...body, actionType: SyncActionType.CAPTURE_SIGNATURE },
      key,
    );
  }

  @Post('photo')
  @HttpCode(HttpStatus.OK)
  async attachPhotoReference(
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() body: Omit<SyncActionDto, 'actionType'>,
  ): Promise<SyncResult> {
    const key = validateIdempotencyKey(idempotencyKey);
    return this.syncService.applyAction(
      { ...body, actionType: SyncActionType.ATTACH_PHOTO_REFERENCE },
      key,
    );
  }
}
