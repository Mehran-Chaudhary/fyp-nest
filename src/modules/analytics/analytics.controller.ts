import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { SECURITY_SCHEME } from '../../common/constants/app.constants';
import {
  ApiEnvelopedArrayResponse,
  ApiEnvelopedResponse,
  ApiStandardErrors,
} from '../../common/decorators/api-response.decorators';
import {
  Auth,
  RequireAnyPermission,
  RequirePermissions,
} from '../../common/decorators/auth.decorators';
import { AuthType } from '../../common/enums/auth-type.enum';
import { PermissionDeniedError } from '../../common/exceptions/app.exception';
import { hasPermission } from '../../common/utils/permission.util';
import type { AccessPrincipal } from '../knowledge/domain/access';
import { CurrentAccessPrincipal } from '../knowledge/knowledge.decorators';
import { AnalyticsService } from './analytics.service';
import {
  AnalyticsOverviewDto,
  AnalyticsRangeDto,
  SecurityEventDto,
  SecurityEventsQueryDto,
  SeriesInterval,
  TimeseriesDto,
  TimeseriesQueryDto,
  TopDimension,
  TopEntryDto,
  TopQueryDto,
} from './dto/analytics.dto';

/**
 * The Command Centre (phase 5): throughput, latency distributions, token
 * spend, redaction counts, governance and the security event feed for one
 * workspace. Metadata only — nothing here reads a prompt, a document or an
 * answer.
 */
@ApiTags('Command Centre')
@ApiBearerAuth()
@ApiSecurity(SECURITY_SCHEME.API_KEY)
@Controller({ path: 'organizations/:organizationId/analytics', version: '1' })
@ApiParam({ name: 'organizationId', description: 'Workspace UUID or slug.' })
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('overview')
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @RequirePermissions('usage:read')
  @ApiOperation({
    summary: 'The Command Centre overview',
    description:
      'Inference (calls, tokens, latency and redaction-overhead percentiles), activity, ' +
      'workflows, tools, knowledge, privacy, governance and security for a time range ' +
      '(default: the last 30 days; at most 400).',
  })
  @ApiEnvelopedResponse(AnalyticsOverviewDto)
  @ApiStandardErrors()
  overview(
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Query() query: AnalyticsRangeDto,
  ): Promise<AnalyticsOverviewDto> {
    return this.analytics.overview(principal.organizationId, query.from, query.to);
  }

  @Get('timeseries')
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @RequirePermissions('usage:read')
  @ApiOperation({
    summary: 'One metric over time, hourly or daily (UTC buckets)',
    description:
      'Every bucket in the range is present (zero, or null for a percentile with no data), ' +
      'so the series can be charted as is.',
  })
  @ApiEnvelopedResponse(TimeseriesDto)
  @ApiStandardErrors()
  timeseries(
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Query() query: TimeseriesQueryDto,
  ): Promise<TimeseriesDto> {
    return this.analytics.timeseries(
      principal.organizationId,
      query.metric,
      query.interval ?? SeriesInterval.DAY,
      query.from,
      query.to,
    );
  }

  @Get('top')
  @Auth(AuthType.Bearer, AuthType.ApiKey)
  @RequirePermissions('usage:read')
  @ApiOperation({
    summary: 'Top agents, models, members or API keys by token spend',
    description:
      'Ranking members or API keys needs quota:manage as well: it is a view of what ' +
      'people and integrations do, not only of what the platform costs.',
  })
  @ApiEnvelopedArrayResponse(TopEntryDto)
  @ApiStandardErrors()
  top(
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Query() query: TopQueryDto,
  ): Promise<TopEntryDto[]> {
    const personal =
      query.dimension === TopDimension.MEMBERS || query.dimension === TopDimension.API_KEYS;
    if (personal && !hasPermission(principal.permissions, 'quota:manage')) {
      throw new PermissionDeniedError(['quota:manage']);
    }
    return this.analytics.top(
      principal.organizationId,
      query.dimension,
      query.limit ?? 10,
      query.from,
      query.to,
    );
  }

  @Get('security-events')
  @RequireAnyPermission('audit:read', 'security:read')
  @ApiOperation({
    summary: 'The security event feed',
    description:
      'WARNING and CRITICAL audit records, newest first — access denials, egress blocks, ' +
      'quota exhaustion, circuit breaks, rejected jobs. Page with `before`.',
  })
  @ApiEnvelopedArrayResponse(SecurityEventDto)
  @ApiStandardErrors()
  securityEvents(
    @CurrentAccessPrincipal() principal: AccessPrincipal,
    @Query() query: SecurityEventsQueryDto,
  ): Promise<SecurityEventDto[]> {
    return this.analytics.securityEvents(
      principal.organizationId,
      query.limit ?? 50,
      query.before,
      query.from,
    );
  }
}
