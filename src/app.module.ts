import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { configurations, validateEnvironment } from './config';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { AuthenticationGuard } from './common/guards/authentication.guard';
import { OrganizationContextGuard } from './common/guards/organization-context.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { RateLimitGuard } from './common/guards/rate-limit.guard';
import { AuditInterceptor } from './common/interceptors/audit.interceptor';
import { ResponseTransformInterceptor } from './common/interceptors/response-transform.interceptor';
import { TimeoutInterceptor } from './common/interceptors/timeout.interceptor';
import { IsStrongPasswordConstraint } from './common/validators/is-strong-password.validator';
import { DatabaseModule } from './database/database.module';
import { RequestContextMiddleware } from './shared/context/request-context.middleware';
import { RequestContextModule } from './shared/context/request-context.module';
import { CryptoModule } from './shared/crypto/crypto.module';
import { LoggerModule } from './shared/logger/logger.module';
import { MailModule } from './shared/mail/mail.module';
import { AiServiceModule } from './shared/ai-service/ai-service.module';
import { EventsModule } from './shared/events/events.module';
import { QueueModule } from './shared/queue/queue.module';
import { RedisModule } from './shared/redis/redis.module';
import { StorageModule } from './shared/storage/storage.module';
import { VectorStoreModule } from './shared/vector-store/vector-store.module';
import { AgentsModule } from './modules/agents/agents.module';
import { ApiKeysModule } from './modules/api-keys/api-keys.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
import { InvitationsModule } from './modules/invitations/invitations.module';
import { KnowledgeModule } from './modules/knowledge/knowledge.module';
import { LlmModule } from './modules/llm/llm.module';
import { MembershipsModule } from './modules/memberships/memberships.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { PrivacyModule } from './modules/privacy/privacy.module';
import { RbacModule } from './modules/rbac/rbac.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { ToolsModule } from './modules/tools/tools.module';
import { UsersModule } from './modules/users/users.module';
import { WorkflowsModule } from './modules/workflows/workflows.module';

/**
 * Application root.
 *
 * ## Guard order is a security property, not a style choice
 *
 * Nest executes global guards in registration order, and the order below is
 * load-bearing:
 *
 *  1. **RateLimitGuard** — before anything expensive. Throttling after
 *     authentication would mean every rejected request still paid for a JWT
 *     verification and a database lookup, which is exactly the amplification a
 *     rate limiter exists to prevent.
 *  2. **AuthenticationGuard** — establishes *who*. Fails closed: a route with no
 *     `@Auth()` or `@Public()` requires a Bearer token.
 *  3. **OrganizationContextGuard** — establishes *which tenant*, and proves
 *     membership. Needs the principal from step 2.
 *  4. **PermissionsGuard** — establishes *may they*. Needs the permission set
 *     from step 3.
 *
 * ## Interceptor order
 *
 * Nest runs interceptors outside-in on the way down and inside-out on the way
 * back. `ResponseTransformInterceptor` is registered first so it wraps last,
 * which means the audit interceptor sees the handler's raw return value rather
 * than an envelope it would have to unwrap to find a resource id.
 */
@Module({
  imports: [
    // ── Configuration ─────────────────────────────────────────────────────
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: configurations,
      validate: validateEnvironment,
      envFilePath: ['.env.local', '.env'],
      expandVariables: true,
    }),

    // ── Cross-cutting infrastructure ──────────────────────────────────────
    LoggerModule,
    RequestContextModule,
    CryptoModule,
    RedisModule,
    MailModule,
    DatabaseModule,
    // Phase 2 cloud dependencies. Each boots without configuration and reports
    // itself unconfigured, so the platform starts before they are provisioned.
    StorageModule,
    VectorStoreModule,
    AiServiceModule,
    QueueModule,
    // Phase 4: the cross-process event bus (Redis streams + pub/sub) behind
    // the real-time layer, and the workflow engine's control channel.
    EventsModule,
    EventEmitterModule.forRoot({
      // Wildcard listeners let a module subscribe to whole event families
      // (`security.*`) without enumerating them.
      wildcard: true,
      delimiter: '.',
      maxListeners: 20,
      verboseMemoryLeak: true,
    }),

    // ── Feature modules ───────────────────────────────────────────────────
    HealthModule,
    AuditModule,
    UsersModule,
    RbacModule,
    ApiKeysModule,
    OrganizationsModule,
    MembershipsModule,
    InvitationsModule,
    AuthModule,
    KnowledgeModule,
    // Phase 3: the PII engine, the LLM gateway, and agents with memory. Each
    // boots without its cloud dependency and answers 503 naming what is missing.
    PrivacyModule,
    LlmModule,
    AgentsModule,
    // Phase 4: the Tool Execution Engine, the multi-agent workflow engine and
    // the canvas's backend, and real-time events over WebSocket. Nothing new
    // to provision: the engine runs on the Redis/BullMQ of phase 2.
    ToolsModule,
    WorkflowsModule,
    RealtimeModule,
  ],
  providers: [
    // ── Global guards, in execution order ─────────────────────────────────
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: AuthenticationGuard },
    { provide: APP_GUARD, useClass: OrganizationContextGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },

    // ── Global interceptors ───────────────────────────────────────────────
    { provide: APP_INTERCEPTOR, useClass: ResponseTransformInterceptor },
    { provide: APP_INTERCEPTOR, useClass: TimeoutInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },

    // ── Global exception filter ───────────────────────────────────────────
    { provide: APP_FILTER, useClass: AllExceptionsFilter },

    // Registered so class-validator can resolve it through Nest's container and
    // read the live password policy from configuration. Requires the
    // `useContainer` call in main.ts.
    IsStrongPasswordConstraint,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Applied to every route, including health probes, so that a correlation id
    // and a source IP exist before any guard runs — which is what makes a
    // rejected sign-in traceable.
    consumer.apply(RequestContextMiddleware).forRoutes('*path');
  }
}
