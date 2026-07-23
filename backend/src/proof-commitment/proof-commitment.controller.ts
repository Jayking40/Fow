import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { Permission } from '../auth/enums/permission.enum';

import { ProofCommitmentService } from './proof-commitment.service';
import {
  AmendProofCommitmentDto,
  AppendCustodyLinkDto,
  ConfirmProofCommitmentDto,
  SubmitProofCommitmentDto,
  VerifyInclusionDto,
} from './dto/submit-proof-commitment.dto';

@ApiTags('Proof Commitments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('proof-commitments')
export class ProofCommitmentController {
  constructor(private readonly service: ProofCommitmentService) {}

  // ── Dual-attestation endpoints ──────────────────────────────────────────

  /**
   * Step 1 — Courier submits the bundle Merkle root.
   * Builds the Merkle tree off-chain and anchors the root on-chain.
   */
  @Post()
  @RequirePermissions(Permission.TRANSFER_CUSTODY)
  @ApiOperation({ summary: 'Submit a delivery proof bundle commitment (courier)' })
  submit(@Body() dto: SubmitProofCommitmentDto) {
    return this.service.submitCommitment(dto);
  }

  /**
   * Step 2 — Facility confirms the pending commitment.
   * Must be called within the 4-hour window.
   */
  @Post('confirm')
  @RequirePermissions(Permission.TRANSFER_CUSTODY)
  @ApiOperation({ summary: 'Facility confirms a pending proof commitment' })
  confirm(@Body() dto: ConfirmProofCommitmentDto) {
    return this.service.confirmCommitment(dto);
  }

  // ── Merkle inclusion verification ───────────────────────────────────────

  /**
   * Verify that a specific document hash is included in a committed bundle.
   * Read-only and permissionless — any third party may call this endpoint.
   *
   * Returns `{ included: boolean, computedRoot, storedRoot }` so the caller
   * can independently confirm the result without trusting the backend.
   */
  @Post('verify-inclusion')
  @ApiOperation({
    summary: 'Verify a document leaf is included in a committed bundle (permissionless)',
  })
  verifyInclusion(@Body() dto: VerifyInclusionDto) {
    return this.service.verifyInclusion(dto);
  }

  // ── Amendment (supersede-only) ──────────────────────────────────────────

  /**
   * Supersede a confirmed commitment with a corrected bundle.
   * Admin / arbiter auth required.  Both old and new records are retained.
   */
  @Post('supersede')
  @RequirePermissions(Permission.ADMIN_ACCESS)
  @ApiOperation({
    summary: 'Supersede a confirmed commitment with a corrected bundle (arbiter only)',
  })
  supersede(@Body() dto: AmendProofCommitmentDto) {
    return this.service.supersedeCommitment(dto);
  }

  // ── Custody chain ───────────────────────────────────────────────────────

  /**
   * Append one hash-linked custody handoff.
   * Enforces chain continuity — wrong prevLinkHash is rejected.
   */
  @Post('custody-links')
  @RequirePermissions(Permission.TRANSFER_CUSTODY)
  @ApiOperation({ summary: 'Append a hash-linked custody handoff to a workflow chain' })
  appendLink(@Body() dto: AppendCustodyLinkDto) {
    return this.service.appendCustodyLink(dto);
  }

  /**
   * Verify the full custody chain is gap-free and hash-linked.
   * Read-only, permissionless.
   */
  @Get('custody-links/:workflowId/verify')
  @ApiOperation({
    summary: 'Verify the custody chain for a workflow is intact (permissionless)',
  })
  verifyChain(@Param('workflowId') workflowId: string) {
    return this.service.verifyCustodyChain(workflowId);
  }

  /** Return all custody links for a workflow (ordered by index). */
  @Get('custody-links/:workflowId')
  @RequirePermissions(Permission.VIEW_BLOODUNIT_TRAIL)
  @ApiOperation({ summary: 'Get the full custody chain for a workflow' })
  getChain(@Param('workflowId') workflowId: string) {
    return this.service.getCustodyChain(workflowId);
  }

  // ── Read endpoints ──────────────────────────────────────────────────────

  /** Get a single proof commitment by database UUID. */
  @Get(':id')
  @RequirePermissions(Permission.VIEW_BLOODUNIT_TRAIL)
  @ApiOperation({ summary: 'Get a single proof commitment by ID' })
  getOne(@Param('id') id: string) {
    return this.service.getCommitment(id);
  }

  /** Get full proof history for a workflow (all commitments, oldest first). */
  @Get('workflow/:workflowId/history')
  @RequirePermissions(Permission.VIEW_BLOODUNIT_TRAIL)
  @ApiOperation({ summary: 'Get the full amendment history for a workflow' })
  getHistory(@Param('workflowId') workflowId: string) {
    return this.service.getWorkflowHistory(workflowId);
  }
}
