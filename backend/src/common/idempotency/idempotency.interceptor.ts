import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  BadRequestException,
  ConflictException,
  UnprocessableEntityException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { Request, Response } from 'express';
import { Observable, of, from } from 'rxjs';
import { switchMap, tap } from 'rxjs/operators';

import { ErrorCode } from '../errors/error-codes.enum';
import { REQUIRES_IDEMPOTENCY_KEY } from './requires-idempotency.decorator';

import { IdempotencyService } from './idempotency.service';

/**
 * Idempotency interceptor for routes marked with @RequiresIdempotency().
 * Ensures duplicate requests return the same result without duplicate writes.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    private readonly idempotencyService: IdempotencyService,
    private readonly reflector: Reflector,
  ) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    const requiresIdempotency = this.reflector.getAllAndOverride<boolean>(
      REQUIRES_IDEMPOTENCY_KEY,
      [context.getHandler(), context.getClass()],
    );

    // If not decorated with @RequiresIdempotency, proceed normally
    if (!requiresIdempotency) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    const idempotencyKey = request.headers['idempotency-key'] as string;

    // Check if key is missing
    if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
      throw new BadRequestException({
        code: ErrorCode.IDEMPOTENCY_KEY_MISSING,
        message: 'Idempotency-Key header is required',
      });
    }

    // Generate body hash
    const bodyHash = this.idempotencyService.generateBodyHash(request.body);

    // Use from to convert promise to observable
    return from(this.idempotencyService.checkAndStart(idempotencyKey, bodyHash)).pipe(
      switchMap((checkResult) => {
        switch (checkResult.type) {
          case 'completed':
            this.logger.debug(
              `Returning completed response for idempotency key: ${idempotencyKey}`,
            );
            response.status(checkResult.statusCode);
            return of(checkResult.body);
          case 'conflict':
            response.setHeader('Retry-After', checkResult.retryAfter.toString());
            throw new ConflictException({
              code: ErrorCode.IDEMPOTENCY_KEY_CONFLICT,
              message: 'Request with this Idempotency-Key is already being processed',
            });
          case 'bodyMismatch':
            throw new UnprocessableEntityException({
              code: ErrorCode.IDEMPOTENCY_BODY_MISMATCH,
              message: 'Request body does not match previous request with the same Idempotency-Key',
            });
          case 'proceed':
            // Proceed with handler execution
            return next.handle().pipe(
              tap((data) => {
                // Store the completed response - we'll use fire-and-forget but log any errors
                const statusCode = response.statusCode || 200;
                this.idempotencyService.storeCompleted(idempotencyKey, statusCode, data).catch((err) => {
                  this.logger.error(`Failed to store idempotency response: ${err instanceof Error ? err.message : String(err)}`);
                });
              }),
            );
        }
      }),
    );
  }
}
