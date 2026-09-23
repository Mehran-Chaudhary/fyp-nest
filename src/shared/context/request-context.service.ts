import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  AuthenticatedApiKey,
  AuthenticatedUser,
  RequestMembership,
  RequestOrganization,
} from '../../common/interfaces/authenticated-request.interface';
import type { ActorType } from '../../common/enums/auth-type.enum';

/**
 * Everything that travels with a request without being passed as an argument.
 */
export interface RequestContext {
  requestId: string;
  startTime: number;
  ip: string;
  userAgent?: string;
  method?: string;
  path?: string;
  actorType?: ActorType;
  actorId?: string;
  actorLabel?: string;
  user?: AuthenticatedUser;
  apiKey?: AuthenticatedApiKey;
  organization?: RequestOrganization;
  membership?: RequestMembership;
  permissions?: string[];
}

/**
 * Ambient per-request state, backed by `AsyncLocalStorage`.
 *
 * The audit logger needs to record *who* did something, *from where*, and under
 * *which* correlation id. Without ambient context, every service method from the
 * controller down would have to accept and forward an actor parameter it does
 * not otherwise care about — and any method that forgot would silently write an
 * unattributed audit row, which is worse than no row at all for compliance.
 *
 * `AsyncLocalStorage` is the right primitive rather than Nest's request-scoped
 * providers: request scope forces the whole injection subtree to be instantiated
 * per request, which is a real throughput cost, and it does not reach code
 * running outside the HTTP lifecycle (queue consumers in phase 4).
 *
 * The context is populated in two stages: the middleware seeds transport-level
 * facts before any guard runs, and the auth and organization guards enrich it
 * once the principal and workspace are known.
 */
@Injectable()
export class RequestContextService {
  private readonly storage = new AsyncLocalStorage<RequestContext>();

  /** Runs `callback` with `context` bound for the entire async call tree. */
  run<T>(context: RequestContext, callback: () => T): T {
    return this.storage.run(context, callback);
  }

  /**
   * The active context, or `undefined` outside a request.
   *
   * Callers must tolerate `undefined`: background jobs, scheduled tasks and the
   * bootstrap path all run without one.
   */
  get(): RequestContext | undefined {
    return this.storage.getStore();
  }

  /** Merges fields into the active context. A no-op when there is none. */
  patch(partial: Partial<RequestContext>): void {
    const current = this.storage.getStore();
    if (!current) return;
    Object.assign(current, partial);
  }

  get requestId(): string | undefined {
    return this.storage.getStore()?.requestId;
  }

  get userId(): string | undefined {
    return this.storage.getStore()?.user?.id;
  }

  get organizationId(): string | undefined {
    return this.storage.getStore()?.organization?.id;
  }

  get ip(): string | undefined {
    return this.storage.getStore()?.ip;
  }

  /** Elapsed milliseconds since the request entered the process. */
  get elapsedMs(): number | undefined {
    const store = this.storage.getStore();
    return store ? Date.now() - store.startTime : undefined;
  }

  /**
   * Runs `callback` with a synthetic context.
   *
   * Used by seeders, migrations and queue consumers so that work performed
   * outside an HTTP request still produces attributable audit records rather
   * than rows with a null actor.
   */
  runAsSystem<T>(label: string, callback: () => T): T {
    return this.run(
      {
        requestId: `system-${Date.now().toString(36)}`,
        startTime: Date.now(),
        ip: 'internal',
        actorLabel: label,
      },
      callback,
    );
  }
}
