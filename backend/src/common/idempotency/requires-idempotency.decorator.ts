import { SetMetadata } from '@nestjs/common';

export const REQUIRES_IDEMPOTENCY_KEY = 'requiresIdempotency';

/**
 * Mark a route as requiring an Idempotency-Key header.
 * Missing key will throw a 400 BadRequestException.
 *
 * @example
 * @RequiresIdempotency()
 * @Post()
 * create() {}
 */
export const RequiresIdempotency = () =>
  SetMetadata(REQUIRES_IDEMPOTENCY_KEY, true);
