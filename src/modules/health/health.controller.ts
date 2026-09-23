import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckService,
  MemoryHealthIndicator,
  TypeOrmHealthIndicator,
  type HealthCheckResult,
} from '@nestjs/terminus';
import { Public, SkipOrganizationContext } from '../../common/decorators/auth.decorators';
import { APP_CONFIG_KEY, type AppConfig } from '../../config/app.config';
import { RedisHealthIndicator } from './indicators/redis.health';

/**
 * Health and readiness probes.
 *
 * Three endpoints, because orchestrators need to distinguish three questions and
 * answering all of them with one check causes real outages:
 *
 *  - `/health/live` — is the process running? Never touches a dependency. If a
 *    liveness probe checked the database, a brief database blip would make
 *    Kubernetes *restart* every API pod, which is precisely the wrong response.
 *  - `/health/ready` — can this instance serve traffic? Requires PostgreSQL;
 *    treats Redis as degraded-but-serving.
 *  - `/health` — a fuller report for humans and dashboards.
 *
 * All are public and excluded from request logging: a probe every few seconds
 * would otherwise drown out everything of interest.
 */
@ApiTags('Health')
@Controller('health')
@Public()
@SkipOrganizationContext()
export class HealthController {
  private readonly appConfig: AppConfig;

  constructor(
    private readonly health: HealthCheckService,
    private readonly database: TypeOrmHealthIndicator,
    private readonly redis: RedisHealthIndicator,
    private readonly memory: MemoryHealthIndicator,
    private readonly configService: ConfigService,
  ) {
    this.appConfig = this.configService.getOrThrow<AppConfig>(APP_CONFIG_KEY);
  }

  @Get()
  @HealthCheck()
  @ApiOperation({ summary: 'Full health report' })
  async check(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.database.pingCheck('database', { timeout: 3_000 }),
      () => this.redis.isHealthy('redis'),
      // A heap ceiling catches a runaway leak before the process is OOM-killed,
      // which gives the orchestrator a chance to cycle the instance gracefully.
      () => this.memory.checkHeap('memory_heap', 512 * 1024 * 1024),
    ]);
  }

  @Get('live')
  @ApiOperation({
    summary: 'Liveness probe',
    description:
      'Returns 200 whenever the process is running. Deliberately checks no ' +
      'dependency: a liveness probe that fails on a database blip causes every ' +
      'instance to be restarted, which fixes nothing and loses all in-flight work.',
  })
  live(): { status: 'ok'; uptime: number; environment: string; timestamp: string } {
    return {
      status: 'ok',
      uptime: Math.floor(process.uptime()),
      environment: this.appConfig.env,
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  @HealthCheck()
  @ApiOperation({
    summary: 'Readiness probe',
    description:
      'PostgreSQL must be reachable. Redis being unreachable reports as degraded ' +
      'rather than failing, because the platform has documented fallbacks for ' +
      'every path that uses it.',
  })
  async ready(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.database.pingCheck('database', { timeout: 3_000 }),
      () => this.redis.isHealthy('redis'),
    ]);
  }
}
