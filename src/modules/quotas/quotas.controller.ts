import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { SECURITY_SCHEME } from '../../common/constants/app.constants';
import {
  ApiEnvelopedArrayResponse,
  ApiEnvelopedResponse,
  ApiErrorResponse,
  ApiStandardErrors,
} from '../../common/decorators/api-response.decorators';
import {
  Auth,
  RequireAnyPermission,
  RequirePermissions,
} from '../../common/decorators/auth.decorators';
import { AuthType } from '../../common/enums/auth-type.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { NotFoundError } from '../../common/exceptions/app.exception';
import { DataSource } from 'typeorm';
import type { AccessPrincipal } from '../knowledge/domain/access';
import { CurrentAccessPrincipal } from '../knowledge/knowledge.decorators';
import { AgentCircuitService } from './agent-circuit.service';
import {
  AgentCircuitDto,
  CreateQuotaDto,
  QuotaDto,
  QuotaHistoryEntryDto,
  QuotaHistoryQueryDto,
  UpdateQuotaDto,
} from './dto/quota.dto';
import { QuotaManagementService } from './quota-management.service';

/**
 * Token quotas and agent circuit breakers (proposal module 6.14).
 *
 * Budgets are read with `usage:read` and managed with `quota:manage`; the
 * platform's own allowance and rate appear in the list, marked `PLATFORM`,
 * and cannot be changed from here.
 */
@ApiTags('Governance')
@ApiBearerAuth()
@ApiSecurity(SECURITY_SCHEME.API_KEY)
@Controller({ path: 'organizations/:organizationId', version: '1' })
@ApiParam({ name: 'organizationId', description: 'Workspace UUID or slug.' })
export class QuotasController {
  constructor(
    private readonly management: QuotaManagementService,
    private readonly circuits: AgentCircuitService,
    private readonly dataSource: DataSource,
  ) {}

  @Get('quotas')
  @RequireAnyPermission('usage:read', 'quota:manage')
  @ApiOperation({
    summary: 'Every quota in the workspace, with this period’s consumption',
    description:
      'Budgets (DAY, MONTH) show tokens used, reserved by calls in flight, and remaining; ' +
      'rates (MINUTE) show the tokens available right now.',
  })
  @ApiEnvelopedArrayResponse(QuotaDto, 'Quotas')
  @ApiStandardErrors()
  list(@CurrentAccessPrincipal() principal: AccessPrincipal): Promise<QuotaDto[]> {
    return this.management.list(principal.organizationId);
  }

  @Get('quotas/me')
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @RequireAnyPermission('usage:read', 'llm:invoke', 'agent:execute')
  @ApiOperation({
    summary: 'The quotas that bind you',
    description: 'The workspace’s own, and any set on you (or on this API key).',
  })
  @ApiEnvelopedArrayResponse(QuotaDto, 'Quotas')
  @ApiStandardErrors()
  mine(@CurrentAccessPrincipal() principal: AccessPrincipal): Promise<QuotaDto[]> {
    return this.management.forPrincipal(principal);
  }

  @Post('quotas')
  @RequirePermissions('quota:manage')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Set a token quota',
    description:
      'A budget per day or month, or a rate per minute, for the workspace, a member, an ' +
      'agent or an API key. Audited as quota.created.',
  })
  @ApiEnvelopedResponse(QuotaDto)
  @ApiErrorResponse(409, [ErrorCode.RESOURCE_CONFLICT])
  @ApiErrorResponse(422, [ErrorCode.VALIDATION_FAILED])
  @ApiStandardErrors()
  create(
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Body() dto: CreateQuotaDto,
  ): Promise<QuotaDto> {
    return this.management.create(principal.organizationId, principal.userId, dto);
  }

  @Patch('quotas/:quotaId')
  @RequirePermissions('quota:manage')
  @ApiOperation({
    summary: 'Change a quota',
    description: 'Audited as quota.updated; raising a limit is marked `weakened: true`.',
  })
  @ApiEnvelopedResponse(QuotaDto)
  @ApiErrorResponse(403, [ErrorCode.QUOTA_MANAGED_BY_PLATFORM])
  @ApiErrorResponse(404, [ErrorCode.QUOTA_NOT_FOUND])
  @ApiStandardErrors()
  update(
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Param('quotaId', new ParseUUIDPipe()) quotaId: string,
    @Body() dto: UpdateQuotaDto,
  ): Promise<QuotaDto> {
    return this.management.update(principal.organizationId, quotaId, principal.userId, dto);
  }

  @Delete('quotas/:quotaId')
  @RequirePermissions('quota:manage')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a quota', description: 'Audited as quota.deleted.' })
  @ApiErrorResponse(403, [ErrorCode.QUOTA_MANAGED_BY_PLATFORM])
  @ApiErrorResponse(404, [ErrorCode.QUOTA_NOT_FOUND])
  @ApiStandardErrors()
  remove(
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Param('quotaId', new ParseUUIDPipe()) quotaId: string,
  ): Promise<{ deleted: true }> {
    return this.management.remove(principal.organizationId, quotaId);
  }

  @Get('quotas/:quotaId/history')
  @RequireAnyPermission('usage:read', 'quota:manage')
  @ApiOperation({ summary: 'A budget’s past periods: used, requests, refusals, alerts' })
  @ApiEnvelopedArrayResponse(QuotaHistoryEntryDto, 'Periods, newest first')
  @ApiErrorResponse(404, [ErrorCode.QUOTA_NOT_FOUND])
  @ApiStandardErrors()
  history(
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Param('quotaId', new ParseUUIDPipe()) quotaId: string,
    @Query() query: QuotaHistoryQueryDto,
  ): Promise<QuotaHistoryEntryDto[]> {
    return this.management.history(principal.organizationId, quotaId, query.periods ?? 12);
  }

  // ── Circuit breakers ──────────────────────────────────────────────────────

  @Get('circuits')
  @RequireAnyPermission('usage:read', 'quota:manage', 'agent:read')
  @ApiOperation({
    summary: 'Agents whose circuit breaker is open',
    description:
      'An agent is paused automatically after runaway token spend or repeated agent-caused ' +
      'failures (audited as agent.circuit_broken). It reopens by itself after the cooldown.',
  })
  @ApiEnvelopedArrayResponse(AgentCircuitDto, 'Open circuits')
  @ApiStandardErrors()
  openCircuits(@CurrentAccessPrincipal() principal: AccessPrincipal): Promise<AgentCircuitDto[]> {
    return this.circuits.listOpen(principal.organizationId);
  }

  @Get('circuits/agents/:agentId')
  @RequireAnyPermission('usage:read', 'quota:manage', 'agent:read')
  @ApiOperation({ summary: 'One agent’s circuit breaker' })
  @ApiEnvelopedResponse(AgentCircuitDto)
  @ApiStandardErrors()
  async agentCircuit(
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Param('agentId', new ParseUUIDPipe()) agentId: string,
  ): Promise<AgentCircuitDto> {
    await this.assertAgent(principal.organizationId, agentId);
    return this.circuits.state(agentId);
  }

  @Delete('circuits/agents/:agentId')
  @RequireAnyPermission('quota:manage', 'agent:update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Close an agent’s circuit breaker now',
    description: 'For when the cause is fixed. Audited as agent.circuit_reset.',
  })
  @ApiStandardErrors()
  async resetCircuit(
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Param('agentId', new ParseUUIDPipe()) agentId: string,
  ): Promise<{ reset: true; wasOpen: boolean }> {
    await this.assertAgent(principal.organizationId, agentId);
    const wasOpen = await this.circuits.reset(principal.organizationId, agentId, principal.userId);
    return { reset: true, wasOpen };
  }

  /** The agent must be this workspace's: another tenant's agent is simply not found. */
  private async assertAgent(organizationId: string, agentId: string): Promise<void> {
    const rows: unknown[] = await this.dataSource.query(
      `SELECT 1 FROM agents WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
      [agentId, organizationId],
    );
    if (rows.length === 0) throw new NotFoundError(ErrorCode.AGENT_NOT_FOUND);
  }
}
