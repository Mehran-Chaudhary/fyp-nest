import type { RedisOptions } from 'ioredis';
import type { RedisConfig } from '../../config/redis.config';

/**
 * Derives BullMQ connection options from the platform's Redis configuration.
 *
 * Two differences from the cache client in `RedisService`, both required by
 * BullMQ rather than chosen:
 *
 *  - **No `keyPrefix`.** BullMQ builds its keys inside Lua scripts, where an
 *    ioredis key prefix is not applied consistently; it namespaces keys with its
 *    own `prefix` option instead (`QUEUE_PREFIX`).
 *  - **`maxRetriesPerRequest: null` for workers.** A worker holds a blocking
 *    connection waiting for jobs; a per-command retry cap would make that
 *    connection give up during an ordinary Redis failover.
 *
 * The same `REDIS_URL` / `REDIS_*` variables drive both clients, so there is one
 * place to point the platform at a managed Redis (Redis Cloud, Upstash, …).
 */
export function buildBullConnectionOptions(
  config: RedisConfig,
  role: 'producer' | 'worker',
): RedisOptions {
  let options: RedisOptions;
  let tlsFromUrl = false;

  if (config.url) {
    const url = new URL(config.url);
    tlsFromUrl = url.protocol === 'rediss:';

    const database = url.pathname.length > 1 ? Number(url.pathname.slice(1)) : config.db;

    options = {
      // `new URL()` keeps the brackets around an IPv6 literal; the socket must not.
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port ? Number(url.port) : 6379,
      username: url.username ? decodeURIComponent(url.username) : undefined,
      password: url.password ? decodeURIComponent(url.password) : undefined,
      db: Number.isInteger(database) ? database : config.db,
    };
  } else {
    options = {
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
      db: config.db,
    };
  }

  if (config.tls.enabled || tlsFromUrl) {
    options.tls = {
      rejectUnauthorized: config.tls.rejectUnauthorized,
      servername: options.host,
      ...(config.tls.ca ? { ca: config.tls.ca } : {}),
    };
  }

  options.connectTimeout = config.connectTimeoutMs;
  options.retryStrategy = (attempt: number) => Math.min(attempt * 500, 10_000);

  if (role === 'worker') {
    options.maxRetriesPerRequest = null;
  } else {
    // A producer sits on the request path. If Redis is unreachable, adding a
    // job must fail fast — the upload has already been stored durably, and the
    // maintenance sweep will enqueue it later — rather than hang the request.
    options.maxRetriesPerRequest = 1;
    options.enableOfflineQueue = false;
  }

  return options;
}
