/**
 * Example: Using the Soroban Transaction Queue
 *
 * This file demonstrates how to use the transaction queue system
 * in your NestJS controllers and services.
 */

import {
  Body,
  Controller,
  Get,
  Injectable,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';

import { AdminGuard } from '../guards/admin.guard';
import { SorobanService } from '../services/soroban.service';
import { SorobanTxJob } from '../types/soroban-tx.types';

@Injectable()
export class BloodBankService {
  constructor(private sorobanService: SorobanService) {}

  /**
   * Example 1: Register blood donation through queue
   */
  async registerBloodDonation(
    bankId: string,
    bloodType: string,
    quantity: number,
    expirationDate: number,
    donorId?: string,
  ): Promise<string> {
    // Idempotency keys MUST be deterministic per logical operation so that a
    // retried job or a double-submitted request collapses to one on-chain call.
    // Never embed `Date.now()` / random values here — derive the key from the
    // stable business identifiers of the operation instead.
    const idempotencyKey = `blood-reg-${bankId}-${donorId ?? 'anon'}-${bloodType}-${expirationDate}`;

    const job: SorobanTxJob = {
      contractMethod: 'register_blood',
      args: [bankId, bloodType, quantity, expirationDate, donorId],
      idempotencyKey,
      maxRetries: 5,
      metadata: {
        bankId,
        bloodType,
        quantity,
        timestamp: new Date(),
      },
    };

    const jobId = await this.sorobanService.submitTransaction(job);
    return jobId;
  }

  /**
   * Example 2: Check blood availability through queue
   */
  async checkBloodAvailability(
    bloodType: string,
    minQuantity: number,
  ): Promise<string> {
    const idempotencyKey = `blood-check-${bloodType}-${minQuantity}`;

    const job: SorobanTxJob = {
      contractMethod: 'check_availability',
      args: [bloodType, minQuantity],
      idempotencyKey,
      maxRetries: 3, // Query operations can have fewer retries
      metadata: {
        bloodType,
        minQuantity,
      },
    };

    const jobId = await this.sorobanService.submitTransaction(job);
    return jobId;
  }

  /**
   * Example 3: Query blood inventory through queue
   */
  async queryBloodInventory(
    bloodType: string,
    limit: number = 10,
    offset: number = 0,
  ): Promise<string> {
    const idempotencyKey = `blood-query-${bloodType}-${limit}-${offset}`;

    const job: SorobanTxJob = {
      contractMethod: 'query_by_blood_type',
      args: [bloodType, limit, offset],
      idempotencyKey,
      maxRetries: 3,
      metadata: {
        bloodType,
        limit,
        offset,
      },
    };

    const jobId = await this.sorobanService.submitTransaction(job);
    return jobId;
  }

  /**
   * Example 4: Handling concurrent duplicate submissions
   *
   * This demonstrates how the system prevents duplicate submissions
   * even when requests arrive simultaneously.
   */
  async handleConcurrentDuplicates(): Promise<void> {
    const idempotencyKey = 'unique-blood-reg-001';

    const job: SorobanTxJob = {
      contractMethod: 'register_blood',
      args: ['bank-123', 'O+', 100, 1708000000],
      idempotencyKey,
      maxRetries: 5,
    };

    // Simulate concurrent requests with same idempotency key
    const results = await Promise.allSettled([
      this.sorobanService.submitTransaction(job),
      this.sorobanService.submitTransaction(job),
      this.sorobanService.submitTransaction(job),
    ]);

    // Result: 1 success, 2 failures (duplicate rejection)
    console.log('Results:', results);
    // [
    //   { status: 'fulfilled', value: 'job-123' },
    //   { status: 'rejected', reason: Error('Duplicate submission...') },
    //   { status: 'rejected', reason: Error('Duplicate submission...') },
    // ]
  }

  /**
   * Example 5: Monitoring queue status (admin only)
   */
  async getQueueStatus(): Promise<void> {
    const metrics = await this.sorobanService.getQueueMetrics();
    console.log('Queue Metrics:', {
      queueDepth: metrics.queueDepth,
      failedJobs: metrics.failedJobs,
      dlqCount: metrics.dlqCount,
    });
  }

  /**
   * Example 6: Checking job status
   */
  async checkJobStatus(jobId: string): Promise<void> {
    const status = await this.sorobanService.getJobStatus(jobId);
    console.log('Job Status:', status);
    // {
    //   jobId: 'job-123',
    //   transactionHash: 'tx_abc123...',
    //   status: 'completed',
    //   error: null,
    //   retryCount: 0,
    //   createdAt: Date,
    //   completedAt: Date,
    // }
  }
}

/**
 * Example Controller Usage
 */
@Controller('blood-bank')
export class BloodBankController {
  constructor(private bloodBankService: BloodBankService) {}

  @Post('register')
  async registerBlood(
    @Body()
    body: {
      bankId: string;
      bloodType: string;
      quantity: number;
      expirationDate: number;
      donorId?: string;
    },
  ) {
    const jobId = await this.bloodBankService.registerBloodDonation(
      body.bankId,
      body.bloodType,
      body.quantity,
      body.expirationDate,
      body.donorId,
    );

    return {
      message: 'Blood registration queued',
      jobId,
      statusUrl: `/blood-bank/status/${jobId}`,
    };
  }

  @Get('status/:jobId')
  async getStatus(@Param('jobId') jobId: string) {
    return this.bloodBankService.checkJobStatus(jobId);
  }

  @Get('queue/metrics')
  @UseGuards(AdminGuard)
  async getQueueMetrics() {
    return this.bloodBankService.getQueueStatus();
  }
}
