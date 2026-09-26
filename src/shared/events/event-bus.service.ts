import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { CacheKeys, PubSubChannels } from '../../common/constants/cache-keys.constants';
import { REALTIME_CONFIG_KEY, type RealtimeConfig } from '../../config/realtime.config';
import { REDIS_CONFIG_KEY, type RedisConfig } from '../../config/redis.config';
import { RedisService } from '../redis/redis.service';
import {
  sanitizeEventData,
  type ControlMessage,
  type PublishableEvent,
  type RealtimeEvent,
} from './realtime-event';

/**
 * Appends an event to the workspace's capped stream and announces it, in one
 * atomic step, so a subscriber never sees an event that replay would not also
 * return. ARGV carries the channel: channels are not keys, and must not be
 * given the key prefix twice.
 */
const PUBLISH_SCRIPT = `
local id = redis.call('XADD', KEYS[1], 'MAXLEN', '~', ARGV[1], '*', 'e', ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[3])
redis.call('PUBLISH', ARGV[4], id .. '\\n' .. ARGV[2])
return id
`;

type EventHandler = (event: RealtimeEvent) => void;
type ControlHandler = (message: ControlMessage) => void;

/**
 * The platform's event bus: how the process that runs a workflow step tells
 * the processes holding WebSocket connections what happened.
 *
 * The worker and the API are separate deployments, and there may be several
 * of each. Every event goes to Redis once: appended to a capped per-workspace
 * **stream** (so a client that reconnects can replay what it missed) and
 * published on one **channel** that every API instance subscribes to (so it
 * arrives live wherever the client's socket happens to be).
 *
 * Publishing is best effort by design. An event is a notification about state
 * that is durably recorded in PostgreSQL; failing a workflow step because a
 * notification could not be sent would get the priorities backwards.
 */
@Injectable()
export class EventBusService implements OnApplicationShutdown {
  private readonly logger = new Logger(EventBusService.name);
  private readonly config: RealtimeConfig;
  private readonly keyPrefix: string;
  private subscriber: Redis | null = null;
  private readonly eventHandlers = new Set<EventHandler>();
  private readonly controlHandlers = new Set<ControlHandler>();

  constructor(
    private readonly redis: RedisService,
    configService: ConfigService,
  ) {
    this.config = configService.getOrThrow<RealtimeConfig>(REALTIME_CONFIG_KEY);
    this.keyPrefix = configService.getOrThrow<RedisConfig>(REDIS_CONFIG_KEY).keyPrefix;
  }

  private channel(name: string): string {
    return `${this.keyPrefix}${name}`;
  }

  // ── Publishing ────────────────────────────────────────────────────────────

  /** Publishes an event; returns its stream id, or null when Redis was unavailable. */
  async publish(event: PublishableEvent): Promise<string | null> {
    const body = JSON.stringify({
      ...event,
      data: sanitizeEventData(event.data),
      at: new Date().toISOString(),
    });

    try {
      const id = (await this.redis.redis.eval(
        PUBLISH_SCRIPT,
        1,
        CacheKeys.eventStream(event.organizationId),
        String(this.config.streamMaxLength),
        body,
        String(this.config.streamTtlSeconds),
        this.channel(PubSubChannels.events),
      )) as string;
      return id;
    } catch (error) {
      this.logger.debug(
        `Could not publish ${event.type} for ${event.organizationId}: ${(error as Error).message}`,
      );
      return null;
    }
  }

  async publishControl(message: ControlMessage): Promise<void> {
    try {
      await this.redis.redis.publish(
        this.channel(PubSubChannels.control),
        JSON.stringify(message),
      );
    } catch (error) {
      this.logger.debug(`Could not publish control message: ${(error as Error).message}`);
    }
    // The publishing process must act on its own message too, and must not
    // depend on Redis to do so.
    this.dispatchControl(message);
  }

  // ── Subscribing ───────────────────────────────────────────────────────────

  /** Live events from every process. Returns an unsubscribe function. */
  onEvent(handler: EventHandler): () => void {
    this.eventHandlers.add(handler);
    this.ensureSubscriber();
    return () => this.eventHandlers.delete(handler);
  }

  /** Control messages from every process, this one included. */
  onControl(handler: ControlHandler): () => void {
    this.controlHandlers.add(handler);
    this.ensureSubscriber();
    return () => this.controlHandlers.delete(handler);
  }

  /**
   * Events after `afterId` in a workspace's stream, oldest first, at most
   * `limit`. For a reconnecting client. (The exclusive range syntax needs
   * Redis 6.2, so the boundary entry is skipped by hand.)
   */
  async replay(
    organizationId: string,
    afterId: string,
    limit: number,
  ): Promise<RealtimeEvent[]> {
    if (!/^\d+-\d+$/.test(afterId) || limit <= 0) return [];
    try {
      const entries = (await this.redis.redis.xrange(
        CacheKeys.eventStream(organizationId),
        afterId,
        '+',
        'COUNT',
        limit + 1,
      )) as Array<[string, string[]]>;

      return entries
        .filter(([id]) => id !== afterId)
        .slice(0, limit)
        .map(([id, fields]) => parseEntry(id, fields))
        .filter((event): event is RealtimeEvent => event !== null);
    } catch (error) {
      this.logger.debug(`Replay failed for ${organizationId}: ${(error as Error).message}`);
      return [];
    }
  }

  get isSubscribed(): boolean {
    return this.subscriber?.status === 'ready';
  }

  private ensureSubscriber(): void {
    if (this.subscriber) return;

    const subscriber = this.redis.redis.duplicate();
    this.subscriber = subscriber;
    subscriber.on('error', (error: Error) =>
      this.logger.debug(`Event subscriber error: ${error.message}`),
    );
    subscriber.on('message', (channel: string, message: string) => {
      if (channel === this.channel(PubSubChannels.events)) this.dispatchEvent(message);
      else if (channel === this.channel(PubSubChannels.control)) {
        try {
          this.dispatchControl(JSON.parse(message) as ControlMessage, true);
        } catch {
          // A malformed control message is dropped, never acted on.
        }
      }
    });
    subscriber
      .subscribe(this.channel(PubSubChannels.events), this.channel(PubSubChannels.control))
      .catch((error: Error) =>
        this.logger.warn(`Could not subscribe to the event bus: ${error.message}`),
      );
  }

  private dispatchEvent(message: string): void {
    const newline = message.indexOf('\n');
    if (newline === -1) return;
    const event = parseEntry(message.slice(0, newline), ['e', message.slice(newline + 1)]);
    if (!event) return;
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (error) {
        this.logger.warn(`An event handler failed: ${(error as Error).message}`);
      }
    }
  }

  private readonly recentControl = new Set<string>();

  /**
   * Delivers a control message once per process: it arrives both directly
   * (from `publishControl`) and back through Redis.
   */
  private dispatchControl(message: ControlMessage, fromRedis = false): void {
    const key = JSON.stringify(message);
    if (fromRedis && this.recentControl.has(key)) {
      this.recentControl.delete(key);
      return;
    }
    if (!fromRedis) {
      this.recentControl.add(key);
      setTimeout(() => this.recentControl.delete(key), 10_000).unref();
    }
    for (const handler of this.controlHandlers) {
      try {
        handler(message);
      } catch (error) {
        this.logger.warn(`A control handler failed: ${(error as Error).message}`);
      }
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.subscriber) return;
    await this.subscriber.quit().catch(() => this.subscriber?.disconnect());
    this.subscriber = null;
  }
}

function parseEntry(id: string, fields: string[]): RealtimeEvent | null {
  const index = fields.indexOf('e');
  if (index === -1 || index + 1 >= fields.length) return null;
  try {
    const parsed = JSON.parse(fields[index + 1]) as Omit<RealtimeEvent, 'id'>;
    if (typeof parsed.organizationId !== 'string' || typeof parsed.type !== 'string') {
      return null;
    }
    return { ...parsed, id };
  } catch {
    return null;
  }
}
