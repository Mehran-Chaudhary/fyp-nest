import { HttpStatus, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { DataSource } from 'typeorm';
import { AuditAction, AuditStatus } from '../../common/enums/audit-action.enum';
import { ActorType } from '../../common/enums/auth-type.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { AppException } from '../../common/exceptions/app.exception';
import { hasPermission } from '../../common/utils/permission.util';
import { isUuid } from '../../common/utils/uuid.util';
import { REALTIME_CONFIG_KEY, type RealtimeConfig } from '../../config/realtime.config';
import { EventBusService } from '../../shared/events/event-bus.service';
import type { ControlMessage, RealtimeEvent } from '../../shared/events/realtime-event';
import { AuditService } from '../audit/audit.service';
import { RealtimeAuthService, type SocketSession } from './realtime-auth.service';
import { Rooms, roomsFor, toClientEvent } from './realtime-routing';

const MAX_SUBSCRIPTIONS = 50;
/** Client messages per socket per window, before the socket is closed. */
const MESSAGE_BUDGET = { limit: 30, windowMs: 10_000 };

interface SocketState {
  session: SocketSession;
  expiryTimer?: NodeJS.Timeout;
  messages: { count: number; windowStart: number };
  subscriptions: Set<string>;
}

type Ack =
  { ok: true; [key: string]: unknown } | { ok: false; code: string; message: string };

/**
 * The real-time notification engine (proposal module 6.16): pushes workflow,
 * step and tool events to the canvas, and notifications to people.
 *
 * ## Protocol (`docs/contracts/realtime-v1.md`)
 *
 * Socket.IO at `REALTIME_PATH`. The client authenticates in the handshake's
 * `auth` payload (`{ token, organizationId }` or `{ apiKey }`), receives
 * `ready` with its rooms, and may then `subscribe` to runs it is allowed to
 * read. Server events: `event` (run, step, tool and approval events) and
 * `notification`. Every event has a stream id; `subscribe` and `resume` take
 * `lastEventId` and replay what was missed.
 *
 * ## Tenant isolation, twice
 *
 * A socket belongs to exactly one workspace, verified at the handshake, and
 * joins only rooms derived from verified ids. On top of that, every single
 * delivery compares the event's workspace with the socket's — so even a
 * mis-routed event could not cross tenants.
 *
 * ## Access that changes
 *
 * Sockets are re-checked on a timer and immediately on security events, and
 * closed (with the reason) when their credential expires, is revoked, or their
 * membership or permissions no longer allow what they hold. Rooms a socket is
 * no longer entitled to are left on the spot.
 */
@WebSocketGateway()
export class RealtimeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly logger = new Logger(RealtimeGateway.name);
  private readonly config: RealtimeConfig;
  private readonly state = new Map<string, SocketState>();
  private readonly teardown: Array<() => void> = [];
  private revalidateTimer?: NodeJS.Timeout;

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly auth: RealtimeAuthService,
    private readonly events: EventBusService,
    private readonly dataSource: DataSource,
    private readonly auditService: AuditService,
    configService: ConfigService,
  ) {
    this.config = configService.getOrThrow<RealtimeConfig>(REALTIME_CONFIG_KEY);
  }

  afterInit(server: Server): void {
    server.use((socket, next) => {
      this.auth
        .authenticate({
          auth: socket.handshake.auth ?? {},
          headers: socket.handshake.headers,
          query: socket.handshake.query ?? {},
          address: socket.handshake.address,
        })
        .then((session) => {
          (socket.data as { session?: SocketSession }).session = session;
          next();
        })
        .catch((error: unknown) => next(toConnectError(error)));
    });

    this.teardown.push(this.events.onEvent((event) => this.route(event)));
    this.teardown.push(this.events.onControl((message) => this.onControl(message)));
    this.revalidateTimer = setInterval(
      () => void this.revalidateAll(),
      this.config.revalidateIntervalMs,
    );
    this.revalidateTimer.unref();
    this.logger.log(
      `Real-time events at ${this.config.path} (${this.config.transports.join(', ')}).`,
    );
  }

  handleConnection(socket: Socket): void {
    const session = (socket.data as { session?: SocketSession }).session;
    if (!session) {
      socket.disconnect(true);
      return;
    }
    const state: SocketState = {
      session,
      messages: { count: 0, windowStart: Date.now() },
      subscriptions: new Set(),
    };
    this.state.set(socket.id, state);
    this.syncRooms(socket, state);
    this.armExpiry(socket, state);
    socket.emit('ready', {
      organizationId: session.organizationId,
      rooms: [...socket.rooms].filter((room) => room !== socket.id),
      expiresAt: session.expiresAt,
      serverTime: new Date().toISOString(),
    });
  }

  handleDisconnect(socket: Socket): void {
    const state = this.state.get(socket.id);
    if (!state) return;
    clearTimeout(state.expiryTimer);
    this.state.delete(socket.id);
    void this.auth.releaseConnection(state.session);
  }

  onModuleDestroy(): void {
    clearInterval(this.revalidateTimer);
    for (const stop of this.teardown) stop();
    for (const state of this.state.values()) clearTimeout(state.expiryTimer);
  }

  // ── Client messages ───────────────────────────────────────────────────────

  @SubscribeMessage('subscribe')
  async subscribe(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { runId?: unknown; lastEventId?: unknown },
  ): Promise<Ack> {
    const state = this.admit(socket);
    if (!state) return refusal(ErrorCode.RATE_LIMIT_EXCEEDED, 'Too many messages.');
    const { session } = state;
    const runId = typeof body?.runId === 'string' ? body.runId : '';
    if (!isUuid(runId))
      return refusal(ErrorCode.VALIDATION_FAILED, 'runId must be a run id.');
    if (!hasPermission(session.permissions, 'workflow:read')) {
      return refusal(ErrorCode.PERMISSION_DENIED, 'Watching runs requires workflow:read.');
    }
    if (state.subscriptions.size >= MAX_SUBSCRIPTIONS && !state.subscriptions.has(runId)) {
      return refusal(
        ErrorCode.RATE_LIMIT_EXCEEDED,
        `At most ${MAX_SUBSCRIPTIONS} runs per connection.`,
      );
    }

    const [run]: Array<{
      organization_id: string;
      initiator_user_id: string | null;
      initiator_api_key_id: string | null;
    }> = await this.dataSource.query(
      `SELECT organization_id, initiator_user_id, initiator_api_key_id
         FROM workflow_runs WHERE id = $1 AND deleted_at IS NULL`,
      [runId],
    );
    const own =
      !!run &&
      (session.kind === 'user'
        ? run.initiator_user_id === session.userId
        : run.initiator_api_key_id === session.apiKeyId);
    const allowed =
      !!run &&
      run.organization_id === session.organizationId &&
      (own || hasPermission(session.permissions, 'workflow:read_all'));

    if (!allowed) {
      if (run) {
        // It exists — in another workspace, or it is someone else's. Answer
        // exactly as for a missing run, and record the probe.
        await this.auditService.recordSafe({
          action: AuditAction.REALTIME_SUBSCRIPTION_DENIED,
          status: AuditStatus.DENIED,
          organizationId: session.organizationId,
          resourceType: 'workflow_run',
          resourceId: runId,
          actor: {
            type: session.kind === 'user' ? ActorType.USER : ActorType.API_KEY,
            id: session.userId ?? session.apiKeyId ?? null,
            label: session.label,
          },
          context: { ipAddress: session.ip },
          metadata: {
            reason:
              run.organization_id === session.organizationId
                ? 'NOT_OWNER'
                : 'OTHER_WORKSPACE',
          },
        });
      }
      return refusal(ErrorCode.WORKFLOW_RUN_NOT_FOUND, 'The workflow run was not found.');
    }

    await socket.join(Rooms.run(runId));
    state.subscriptions.add(runId);
    const replay = await this.replay(
      socket,
      state,
      body?.lastEventId,
      (event) => event.runId === runId,
    );
    return { ok: true, runId, replayed: replay.length, events: replay };
  }

  @SubscribeMessage('unsubscribe')
  async unsubscribe(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { runId?: unknown },
  ): Promise<Ack> {
    const state = this.admit(socket);
    if (!state) return refusal(ErrorCode.RATE_LIMIT_EXCEEDED, 'Too many messages.');
    const runId = typeof body?.runId === 'string' ? body.runId : '';
    if (state.subscriptions.delete(runId)) await socket.leave(Rooms.run(runId));
    return { ok: true, runId };
  }

  /** Events missed while disconnected, for the rooms this socket is in now. */
  @SubscribeMessage('resume')
  async resume(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { lastEventId?: unknown },
  ): Promise<Ack> {
    const state = this.admit(socket);
    if (!state) return refusal(ErrorCode.RATE_LIMIT_EXCEEDED, 'Too many messages.');
    const events = await this.replay(socket, state, body?.lastEventId, () => true);
    return { ok: true, replayed: events.length, events };
  }

  /** A fresh access token before the current one expires; the socket stays open. */
  @SubscribeMessage('auth:refresh')
  async refresh(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { token?: unknown },
  ): Promise<Ack> {
    const state = this.admit(socket);
    if (!state) return refusal(ErrorCode.RATE_LIMIT_EXCEEDED, 'Too many messages.');
    if (typeof body?.token !== 'string')
      return refusal(ErrorCode.AUTH_TOKEN_MISSING, 'Send { token }.');
    try {
      state.session = await this.auth.refresh(state.session, body.token);
      (socket.data as { session?: SocketSession }).session = state.session;
      this.syncRooms(socket, state);
      this.armExpiry(socket, state);
      return { ok: true, expiresAt: state.session.expiresAt };
    } catch (error) {
      this.close(socket, error);
      return refusal(
        codeOf(error),
        'The token was not accepted; the connection is closing.',
      );
    }
  }

  // ── Delivery ──────────────────────────────────────────────────────────────

  private route(event: RealtimeEvent): void {
    if (!this.server) return;
    const delivered = new Set<string>();
    const payload = toClientEvent(event);
    const channel = event.type === 'notification' ? 'notification' : 'event';

    for (const room of roomsFor(event)) {
      const members = this.server.sockets.adapter.rooms.get(room);
      if (!members) continue;
      for (const socketId of members) {
        if (delivered.has(socketId)) continue;
        const socket = this.server.sockets.sockets.get(socketId);
        const state = this.state.get(socketId);
        // The second, independent tenant check: on every delivery.
        if (!socket || !state || state.session.organizationId !== event.organizationId)
          continue;
        delivered.add(socketId);
        socket.emit(channel, payload);
      }
    }
  }

  private async replay(
    socket: Socket,
    state: SocketState,
    lastEventId: unknown,
    filter: (event: RealtimeEvent) => boolean,
  ): Promise<unknown[]> {
    if (typeof lastEventId !== 'string' || this.config.replayMaxEvents <= 0) return [];
    const events = await this.events.replay(
      state.session.organizationId,
      lastEventId,
      this.config.replayMaxEvents,
    );
    return events
      .filter((event) => event.organizationId === state.session.organizationId)
      .filter(filter)
      .filter((event) => roomsFor(event).some((room) => socket.rooms.has(room)))
      .map(toClientEvent);
  }

  // ── Keeping access current ────────────────────────────────────────────────

  private onControl(message: ControlMessage): void {
    if (message.kind !== 'revalidate' || !this.server) return;
    for (const [socketId, state] of this.state) {
      const { session } = state;
      if (message.organizationId && session.organizationId !== message.organizationId)
        continue;
      if (message.userId && session.userId !== message.userId) continue;
      if (message.apiKeyId && session.apiKeyId !== message.apiKeyId) continue;
      const socket = this.server.sockets.sockets.get(socketId);
      if (socket) void this.revalidate(socket, state);
    }
  }

  private async revalidateAll(): Promise<void> {
    if (!this.server) return;
    for (const [socketId, state] of this.state) {
      const socket = this.server.sockets.sockets.get(socketId);
      if (socket) await this.revalidate(socket, state);
    }
  }

  private async revalidate(socket: Socket, state: SocketState): Promise<void> {
    try {
      state.session = await this.auth.revalidate(state.session);
      (socket.data as { session?: SocketSession }).session = state.session;
      this.syncRooms(socket, state);
    } catch (error) {
      if (isTransient(error)) return; // a database blip is not a revocation
      this.close(socket, error);
    }
  }

  /** Joins the rooms the session is entitled to, and leaves the rest. */
  private syncRooms(socket: Socket, state: SocketState): void {
    const { session } = state;
    const organizationId = session.organizationId;
    const wanted = new Set<string>();
    const canRead = hasPermission(session.permissions, 'workflow:read');
    if (session.kind === 'user' && session.userId)
      wanted.add(Rooms.user(organizationId, session.userId));
    if (session.kind === 'api_key' && session.apiKeyId) {
      wanted.add(Rooms.key(organizationId, session.apiKeyId));
    }
    if (hasPermission(session.permissions, 'workflow:read_all'))
      wanted.add(Rooms.runs(organizationId));
    if (hasPermission(session.permissions, 'workflow:approve'))
      wanted.add(Rooms.approvers(organizationId));

    for (const room of [...socket.rooms]) {
      if (room === socket.id) continue;
      const isRun = room.startsWith('run:');
      if ((isRun && !canRead) || (!isRun && !wanted.has(room))) {
        void socket.leave(room);
        if (isRun) state.subscriptions.delete(room.slice(4));
      }
    }
    for (const room of wanted) void socket.join(room);
  }

  private armExpiry(socket: Socket, state: SocketState): void {
    clearTimeout(state.expiryTimer);
    if (state.session.expiresAt === null) return;
    const inMs = Math.max(0, state.session.expiresAt - Date.now());
    state.expiryTimer = setTimeout(
      () => {
        socket.emit('auth:expired', { code: ErrorCode.AUTH_TOKEN_EXPIRED });
        socket.disconnect(true);
      },
      Math.min(inMs, 2_147_000_000),
    );
    state.expiryTimer.unref();
  }

  private close(socket: Socket, error: unknown): void {
    socket.emit('auth:revoked', { code: codeOf(error) });
    socket.disconnect(true);
  }

  /** A small per-socket message budget: sockets that flood are closed. */
  private admit(socket: Socket): SocketState | null {
    const state = this.state.get(socket.id);
    if (!state) return null;
    const now = Date.now();
    if (now - state.messages.windowStart > MESSAGE_BUDGET.windowMs) {
      state.messages = { count: 0, windowStart: now };
    }
    state.messages.count += 1;
    if (state.messages.count > MESSAGE_BUDGET.limit) {
      socket.emit('error', { code: ErrorCode.RATE_LIMIT_EXCEEDED });
      socket.disconnect(true);
      return null;
    }
    return state;
  }
}

function codeOf(error: unknown): string {
  return error instanceof AppException ? error.code : ErrorCode.AUTH_TOKEN_INVALID;
}

function isTransient(error: unknown): boolean {
  if (!(error instanceof AppException)) return true;
  const status = error.getStatus();
  return status >= 500 && status !== Number(HttpStatus.NOT_IMPLEMENTED);
}

function refusal(code: string, message: string): Ack {
  return { ok: false, code, message };
}

/** A Socket.IO `connect_error` carrying the same code a JSON error would. */
function toConnectError(error: unknown): Error & { data?: unknown } {
  const code = codeOf(error);
  const message =
    error instanceof AppException ? error.displayMessage : 'Authentication failed.';
  const connectError = new Error(message) as Error & { data?: unknown };
  connectError.data = {
    code,
    message,
    ...(error instanceof AppException && error.retryAfterSeconds
      ? { retryAfterSeconds: error.retryAfterSeconds }
      : {}),
  };
  return connectError;
}
