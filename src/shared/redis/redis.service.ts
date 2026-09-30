import {
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { type RedisOptions } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { REDIS_CONFIG_KEY, type RedisConfig } from '../../config/redis.config';

/**
 * The platform's Redis client.
 *
 * Redis carries three distinct workloads here: short-lived caches (permission
 * sets, workspace lookups), security counters (failed sign-ins, rate limit
 * buckets, token denylists), and — from phase 4 — the BullMQ queues that move
 * work between agents. Wrapping the driver in one service keeps connection
 * handling, key prefixing and failure behaviour consistent across all three.
 *
 * **Failure posture.** Redis is treated as a cache for read paths: if it is
 * unavailable, reads fall through to PostgreSQL and the request still succeeds.
 * It is *not* optional for security counters; the components that own those
 * decide their own fail-open or fail-closed behaviour explicitly rather than
 * inheriting an accidental one from here.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RedisService.name);
  private readonly config: RedisConfig;
  private client!: Redis;
  private connected = false;

  constructor(private readonly configService: ConfigService) {
    this.config = this.configService.getOrThrow<RedisConfig>(REDIS_CONFIG_KEY);
  }

  onModuleInit(): void {
    this.client = this.createClient();

    this.client.on('connect', () => {
      this.connected = true;
      this.logger.log('Connected to Redis.');
    });

    this.client.on('error', (error: Error) => {
      this.connected = false;
      // Logged at warn, not error: ioredis retries automatically and a transient
      // blip should not page anyone. Sustained failure surfaces via /health.
      this.logger.warn(`Redis connection error: ${error.message}`);
    });

    this.client.on('close', () => {
      this.connected = false;
    });
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.client) return;

    try {
      await this.client.quit();
      this.logger.log('Redis connection closed cleanly.');
    } catch {
      this.client.disconnect();
    }
  }

  /** The underlying ioredis instance, for callers needing commands not wrapped here. */
  get redis(): Redis {
    return this.client;
  }

  get isConnected(): boolean {
    return this.connected && this.client?.status === 'ready';
  }

  private createClient(): Redis {
    const options: RedisOptions = {
      keyPrefix: this.config.keyPrefix,
      db: this.config.db,
      connectTimeout: this.config.connectTimeoutMs,
      maxRetriesPerRequest: this.config.maxRetriesPerRequest,
      // Without this, commands issued before the socket is up are queued
      // indefinitely and a Redis outage turns into request pile-up.
      enableOfflineQueue: true,
      lazyConnect: false,
      retryStrategy: (attempt: number) => Math.min(attempt * 200, 5_000),
    };

    if (this.config.tls.enabled) {
      options.tls = {
        rejectUnauthorized: this.config.tls.rejectUnauthorized,
        ...(this.config.tls.ca ? { ca: this.config.tls.ca } : {}),
      };
    }

    if (this.config.url) {
      return new Redis(this.config.url, options);
    }

    return new Redis({
      ...options,
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      password: this.config.password,
    });
  }

  // ── Primitive operations ──────────────────────────────────────────────────

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds && ttlSeconds > 0) {
      await this.client.set(key, value, 'EX', ttlSeconds);
    } else {
      await this.client.set(key, value);
    }
  }

  /**
   * Sets a key only if it does not exist (SET NX EX). True when this call set
   * it — used to let one caller in per window, for example to debounce writes.
   */
  async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    return (await this.client.set(key, value, 'EX', ttlSeconds, 'NX')) === 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return this.client.del(...keys);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.client.exists(key)) === 1;
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    await this.client.expire(key, ttlSeconds);
  }

  async ttl(key: string): Promise<number> {
    return this.client.ttl(key);
  }

  // ── JSON helpers ──────────────────────────────────────────────────────────

  /**
   * Reads and parses a cached JSON value.
   *
   * Returns `null` on a cache miss, a Redis outage *or* a parse failure. All
   * three mean the same thing to a caller — "no usable cached value" — and
   * treating a corrupt entry as a miss keeps a bad write from wedging a code
   * path until the TTL expires.
   */
  async getJson<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.client.get(key);
      return raw === null ? null : (JSON.parse(raw) as T);
    } catch (error) {
      this.logger.debug(`Cache read failed for ${key}: ${(error as Error).message}`);
      return null;
    }
  }

  /** Serialises and caches a value. Failures are swallowed: a cache write is never critical. */
  async setJson(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    try {
      await this.set(key, JSON.stringify(value), ttlSeconds);
    } catch (error) {
      this.logger.debug(`Cache write failed for ${key}: ${(error as Error).message}`);
    }
  }

  // ── Counters ──────────────────────────────────────────────────────────────

  /**
   * Increments a counter, setting its TTL on first write.
   *
   * The TTL is applied inside a MULTI alongside the INCR so a crash between the
   * two cannot leave a permanent counter — which, for a failed-sign-in counter,
   * would lock a user out forever.
   */
  async increment(
    key: string,
    ttlSeconds: number,
  ): Promise<{ value: number; ttl: number }> {
    const results = await this.client
      .multi()
      .incr(key)
      .expire(key, ttlSeconds, 'NX')
      .ttl(key)
      .exec();

    if (!results) {
      throw new Error('Redis transaction returned no result.');
    }

    const value = Number(results[0]?.[1] ?? 0);
    const ttl = Number(results[2]?.[1] ?? ttlSeconds);

    return { value, ttl };
  }

  async decrement(key: string): Promise<number> {
    return this.client.decr(key);
  }

  // ── Pattern deletion ──────────────────────────────────────────────────────

  /**
   * Deletes every key matching a glob pattern.
   *
   * Uses SCAN rather than KEYS: KEYS blocks the Redis event loop for the whole
   * keyspace, which on a shared instance means blocking BullMQ too.
   *
   * ioredis prepends `keyPrefix` to key *arguments* but not to a SCAN MATCH
   * pattern, and returns fully prefixed keys. Both sides are adjusted manually
   * below, otherwise the scan silently matches nothing.
   */
  async deleteByPattern(pattern: string): Promise<number> {
    const prefix = this.config.keyPrefix;
    const fullPattern = `${prefix}${pattern}`;
    let cursor = '0';
    let deleted = 0;

    do {
      const [nextCursor, keys] = await this.client.scan(
        cursor,
        'MATCH',
        fullPattern,
        'COUNT',
        200,
      );
      cursor = nextCursor;

      if (keys.length > 0) {
        // Strip the prefix; UNLINK will re-apply it.
        const unprefixed = keys.map((key) =>
          key.startsWith(prefix) ? key.slice(prefix.length) : key,
        );
        deleted += await this.client.unlink(...unprefixed);
      }
    } while (cursor !== '0');

    return deleted;
  }

  // ── Distributed lock ──────────────────────────────────────────────────────

  /**
   * Acquires a mutex, returning a release function, or `null` if already held.
   *
   * A single-instance lock (not Redlock), which is the correct trade-off for the
   * workloads here: it guards convenience operations, never correctness-critical
   * ones. Anything that must be serialised for correctness — appending to the
   * audit hash chain, for instance — uses a PostgreSQL advisory lock inside the
   * same transaction as the write, so the lock and the data cannot disagree.
   *
   * The release path uses a compare-and-delete script so a lock whose TTL has
   * already expired, and been re-acquired by someone else, is not deleted by its
   * previous owner.
   */
  async acquireLock(
    key: string,
    ttlSeconds = 30,
  ): Promise<{ release: () => Promise<void> } | null> {
    const token = randomUUID();
    const acquired = await this.client.set(key, token, 'EX', ttlSeconds, 'NX');

    if (acquired !== 'OK') return null;

    const release = async (): Promise<void> => {
      const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;
      try {
        await this.client.eval(script, 1, key, token);
      } catch (error) {
        this.logger.debug(`Lock release failed for ${key}: ${(error as Error).message}`);
      }
    };

    return { release };
  }

  /** Round-trip check used by the health endpoint. */
  async ping(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }
}
