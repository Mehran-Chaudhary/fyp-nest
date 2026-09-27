import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { isUuid } from '../../common/utils/uuid.util';
import { DATABASE_CONFIG_KEY, type DatabaseConfig } from '../../config/database.config';
import { RequestContextService } from '../../shared/context/request-context.service';

/** The PostgreSQL setting the policies read (see the phase 5 migration). */
export const TENANT_SETTING = 'daiap.tenant';

/** Policies the phase 5 migration installs: 27 tenant tables and `organizations`. */
export const EXPECTED_POLICIES = 28;

/** The slice of a node-postgres pool client this service uses. */
interface PoolClient {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

type Release = (error?: unknown) => void;
type Obtain = () => Promise<[PoolClient, Release]>;

/** What this backend has told one pooled connection. */
interface ConnectionState {
  /** '' when unbound. */
  tenant: string;
  roleApplied: boolean;
}

export interface RowLevelSecurityStatus {
  /** Whether connections are bound to the tenant of the work using them. */
  binding: boolean;
  /** Policies found on the tenant tables. */
  policies: number;
  /** Whether the role the application runs as is subject to those policies. */
  enforced: boolean;
  role: string | null;
  /** Why RLS is not fully in force, when it is not. */
  problem?: string;
}

/**
 * PostgreSQL row-level security as a third tenancy layer (phase 5).
 *
 * The first two layers are the organization guard (a caller reaches only a
 * workspace they belong to) and the repository filters (every query says
 * `WHERE organization_id = …`). Both are application code, and the failure
 * they cannot catch is their own bug: one query that forgets its filter
 * returns every tenant's rows. Row-level security moves that guarantee into
 * the database, beneath the code that could forget.
 *
 * ## How a connection learns its tenant
 *
 * Every unit of work carries its workspace in the ambient request context
 * (`tenantId`): the organization guard sets it for a request, a job sets it
 * once it has verified which workspace it works for. Each time a connection
 * is checked out of the pool, it is told that workspace in the setting the
 * policies read (`daiap.tenant`) — before any statement of the caller runs,
 * and in the caller's own async context, so a checkout can never pick up
 * another request's tenant. The value is cached per connection, so a
 * connection that keeps serving one workspace pays nothing extra.
 *
 * A connection with no tenant bound is a trusted system context — sign-in,
 * migrations, cross-tenant maintenance sweeps — and the policies let it see
 * everything; a bound connection sees and writes only its workspace's rows.
 *
 * ## What it needs
 *
 *  - **A session-mode connection.** The setting lives on the database
 *    session. A transaction-mode pooler (PgBouncer, Supavisor on 6543, Neon's
 *    `-pooler` host) hands consecutive statements to different sessions, so a
 *    binding would land on the wrong one. The application keeps its own pool;
 *    connect it directly. A transaction pooler is detected at boot, and
 *    binding is then switched off rather than left to misbehave.
 *  - **A role the policies apply to.** Policies are FORCEd, so they bind the
 *    table owner too — but never a superuser or a role with BYPASSRLS. For
 *    such login roles, `DB_RLS_ROLE` names a role (the migration creates
 *    `daiap_rls`) that every connection assumes with `SET ROLE`.
 *
 * Both conditions are reported by the health endpoint and at boot.
 */
@Injectable()
export class RowLevelSecurityService implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(RowLevelSecurityService.name);
  private readonly config: DatabaseConfig['rowLevelSecurity'];
  private readonly states = new WeakMap<PoolClient, ConnectionState>();
  private bindingActive = false;
  private status: RowLevelSecurityStatus | null = null;

  constructor(
    private readonly dataSource: DataSource,
    private readonly requestContext: RequestContextService,
    configService: ConfigService,
  ) {
    this.config = configService.getOrThrow<DatabaseConfig>(DATABASE_CONFIG_KEY).rowLevelSecurity;
  }

  onModuleInit(): void {
    if (!this.config.enabled && !this.config.role) return;
    this.install();
  }

  /** After boot: probe the pooler and the role, and say plainly what is in force. */
  async onApplicationBootstrap(): Promise<void> {
    if (this.config.enabled && (await this.transactionPoolerDetected())) {
      this.bindingActive = false;
      this.logger.error(
        'A transaction-mode connection pooler was detected (consecutive statements ran on ' +
          'different backends). Tenant binding for row-level security is OFF, because a ' +
          'session setting would reach the wrong session. Point DB_HOST at a direct ' +
          '(session-mode) connection to enable it.',
      );
    }
    const status = await this.describe();
    if (status.problem) this.logger.warn(`Row-level security: ${status.problem}`);
    else
      this.logger.log(
        `Row-level security in force: ${status.policies} policies, role ${status.role}.`,
      );
  }

  /** The tenant a checkout made now would be bound to. */
  currentTenant(): string {
    if (!this.bindingActive) return '';
    const tenant = this.requestContext.tenantId;
    // Anything but a UUID would make the policies' cast fail every statement.
    return tenant && isUuid(tenant) ? tenant : '';
  }

  /** Whether connections are being bound (enabled and not switched off at boot). */
  get isBinding(): boolean {
    return this.bindingActive;
  }

  async describe(): Promise<RowLevelSecurityStatus> {
    try {
      const [row]: Array<{
        role: string;
        superuser: boolean;
        bypass: boolean;
        policies: string;
      }> = await this.dataSource.query(
        `SELECT current_user AS role,
                r.rolsuper AS superuser,
                r.rolbypassrls AS bypass,
                (SELECT count(*) FROM pg_policies
                  WHERE policyname = 'tenant_isolation' AND schemaname = current_schema()) AS policies
           FROM pg_roles r WHERE r.rolname = current_user`,
      );
      const policies = Number(row?.policies ?? 0);
      const bypasses = Boolean(row?.superuser || row?.bypass);
      const status: RowLevelSecurityStatus = {
        binding: this.bindingActive,
        policies,
        enforced: !bypasses && policies >= EXPECTED_POLICIES,
        role: row?.role ?? null,
      };
      if (!this.config.enabled) {
        status.problem = 'tenant binding is disabled (DB_ROW_LEVEL_SECURITY=false).';
      } else if (!this.bindingActive) {
        status.problem = 'tenant binding is off: a transaction-mode pooler was detected.';
      } else if (policies < EXPECTED_POLICIES) {
        status.problem =
          `only ${policies} of ${EXPECTED_POLICIES} tenant policies are installed; ` +
          'run `npm run migration:run`.';
      } else if (bypasses) {
        status.problem =
          `the database role "${row?.role}" ${row?.superuser ? 'is a superuser' : 'has BYPASSRLS'} ` +
          'and is not subject to the policies. Connect as a non-superuser owner, or set ' +
          'DB_RLS_ROLE=daiap_rls (see docs/ENVIRONMENT.md).';
      }
      this.status = status;
      return status;
    } catch (error) {
      return {
        binding: this.bindingActive,
        policies: 0,
        enforced: false,
        role: null,
        problem: `could not inspect row-level security: ${(error as Error).message}`,
      };
    }
  }

  /** The last status computed, without a round trip (for metrics). */
  get lastStatus(): RowLevelSecurityStatus | null {
    return this.status;
  }

  // ── The checkout hook ─────────────────────────────────────────────────────

  private install(): void {
    const driver = this.dataSource.driver as unknown as {
      obtainMasterConnection?: Obtain;
      obtainSlaveConnection?: Obtain;
    };
    if (typeof driver.obtainMasterConnection !== 'function') {
      this.logger.warn('The database driver does not expose connection checkout; RLS binding is off.');
      return;
    }

    const wrap = (original: Obtain): Obtain => {
      const bound = original.bind(driver);
      return async () => {
        // Read before the first await: this is the caller's context, and a
        // pool that makes the caller wait must not lend it another's tenant.
        const tenant = this.currentTenant();
        const connection = await bound();
        const [client, release] = connection;
        try {
          await this.prepare(client, tenant);
        } catch (error) {
          // A connection in an unknown state is destroyed, never reused.
          release(error instanceof Error ? error : new Error(String(error)));
          throw error;
        }
        return connection;
      };
    };

    driver.obtainMasterConnection = wrap(driver.obtainMasterConnection);
    if (typeof driver.obtainSlaveConnection === 'function') {
      driver.obtainSlaveConnection = wrap(driver.obtainSlaveConnection);
    }
    this.bindingActive = this.config.enabled;
  }

  private async prepare(client: PoolClient, tenant: string): Promise<void> {
    let state = this.states.get(client);
    if (!state) {
      // A new physical connection: nothing has been set on it yet.
      state = { tenant: '', roleApplied: false };
      this.states.set(client, state);
    }
    if (this.config.role && !state.roleApplied) {
      // The role name is validated at boot (a plain identifier), and quoted.
      await client.query(`SET ROLE "${this.config.role}"`);
      state.roleApplied = true;
    }
    if (state.tenant !== tenant) {
      await client.query(`SELECT set_config('${TENANT_SETTING}', $1, false)`, [tenant]);
      state.tenant = tenant;
    }
  }

  /**
   * Whether statements on one client run on different backends — the mark
   * of a transaction-mode pooler. Three probes in a row on one checked-out
   * client; a direct connection always answers with one backend.
   */
  private async transactionPoolerDetected(): Promise<boolean> {
    const runner = this.dataSource.createQueryRunner();
    try {
      const pids = new Set<number>();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const [row]: Array<{ pid: number }> = await runner.query(
          'SELECT pg_backend_pid() AS pid',
        );
        pids.add(Number(row?.pid));
      }
      return pids.size > 1;
    } catch {
      return false;
    } finally {
      await runner.release();
    }
  }
}
