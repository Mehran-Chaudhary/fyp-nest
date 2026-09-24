import { buildBullConnectionOptions } from '../../shared/queue/bull-connection';
import type { RedisConfig } from '../../config/redis.config';
import { formatByteSize, parseByteSize } from './byte-size.util';
import { CircuitBreaker, CircuitOpenError, CircuitState } from './circuit-breaker';
import { backoffDelay, withRetry } from './retry.util';
import {
  fileExtension,
  sanitizeFilename,
  stripControlCharacters,
  stripExtension,
} from './text.util';
import { isUuid, uuidV5 } from './uuid.util';

describe('byte sizes', () => {
  it('parses binary units', () => {
    expect(parseByteSize('512kb')).toBe(512 * 1024);
    expect(parseByteSize('50MB')).toBe(50 * 1024 ** 2);
    expect(parseByteSize('1.5gb')).toBe(Math.floor(1.5 * 1024 ** 3));
    expect(parseByteSize('100')).toBe(100);
    expect(parseByteSize(0)).toBe(0);
  });

  it('refuses anything else rather than guessing', () => {
    expect(() => parseByteSize('fifty megabytes')).toThrow();
    expect(() => parseByteSize('-1mb')).toThrow();
    expect(() => parseByteSize(Number.NaN)).toThrow();
  });

  it('formats for messages', () => {
    expect(formatByteSize(50 * 1024 ** 2)).toBe('50 MB');
    expect(formatByteSize(1536)).toBe('1.5 KB');
    expect(formatByteSize(10)).toBe('10 B');
  });
});

describe('uuidV5', () => {
  it('matches the RFC reference vector', () => {
    // uuid5(NAMESPACE_DNS, "www.example.com")
    expect(uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(
      '2ed6657d-e927-568b-95e1-2665a8aea6a2',
    );
  });

  it('is deterministic and name-sensitive — the basis of idempotent chunk ids', () => {
    const namespace = '6f1c2b0e-8d4a-5e3b-9c7f-2a1d0e4b8c6d';
    expect(uuidV5('doc:1:0', namespace)).toBe(uuidV5('doc:1:0', namespace));
    expect(uuidV5('doc:1:0', namespace)).not.toBe(uuidV5('doc:2:0', namespace));
    expect(isUuid(uuidV5('anything', namespace))).toBe(true);
  });

  it('rejects a non-UUID namespace', () => {
    expect(() => uuidV5('x', 'not-a-uuid')).toThrow();
  });
});

describe('text sanitisation', () => {
  it('strips control characters', () => {
    expect(stripControlCharacters('a\u0000b\r\nc\u007f')).toBe('a b c');
  });

  it('reduces client filenames to a safe basename', () => {
    expect(sanitizeFilename('C:\\Users\\x\\Desktop\\report.pdf')).toBe('report.pdf');
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('in"voice:<1>.pdf')).toBe('in_voice__1_.pdf');
    expect(sanitizeFilename('.hidden.txt')).toBe('hidden.txt');
    expect(sanitizeFilename(undefined)).toBe('document');
  });

  it('keeps the extension when truncating', () => {
    const long = `${'a'.repeat(300)}.docx`;
    const safe = sanitizeFilename(long, 50);
    expect(safe).toHaveLength(50);
    expect(safe.endsWith('.docx')).toBe(true);
  });

  it('splits extensions', () => {
    expect(fileExtension('Report.PDF')).toBe('pdf');
    expect(fileExtension('noext')).toBe('');
    expect(stripExtension('policy.v2.docx')).toBe('policy.v2');
  });
});

describe('retry with jitter', () => {
  const noSleep = () => Promise.resolve();

  it('caps the backoff ceiling', () => {
    expect(backoffDelay(10, 100, 1_000, () => 0.999)).toBeLessThan(1_000);
    expect(backoffDelay(0, 100, 1_000, () => 0.5)).toBe(50);
  });

  it('retries until success', async () => {
    let attempts = 0;
    const result = await withRetry(
      () => {
        attempts += 1;
        return attempts < 3 ? Promise.reject(new Error('flaky')) : Promise.resolve('ok');
      },
      { retries: 5, baseDelayMs: 1, maxDelayMs: 1, sleep: noSleep },
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('stops at the retry limit', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        () => {
          attempts += 1;
          return Promise.reject(new Error('down'));
        },
        { retries: 2, baseDelayMs: 1, maxDelayMs: 1, sleep: noSleep },
      ),
    ).rejects.toThrow('down');
    expect(attempts).toBe(3);
  });

  it('does not retry what shouldRetry refuses', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        () => {
          attempts += 1;
          return Promise.reject(new Error('permanent'));
        },
        {
          retries: 5,
          baseDelayMs: 1,
          maxDelayMs: 1,
          sleep: noSleep,
          shouldRetry: () => false,
        },
      ),
    ).rejects.toThrow('permanent');
    expect(attempts).toBe(1);
  });

  it('honours a server-mandated delay', async () => {
    const delays: number[] = [];
    await withRetry(
      (attempt) => (attempt === 0 ? Promise.reject(new Error('429')) : Promise.resolve(1)),
      {
        retries: 1,
        baseDelayMs: 1,
        maxDelayMs: 10_000,
        retryAfterMs: () => 7_000,
        sleep: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
      },
    );
    expect(delays).toEqual([7_000]);
  });
});

describe('circuit breaker', () => {
  let now = 0;
  const breaker = () =>
    new CircuitBreaker('test', { failureThreshold: 2, cooldownMs: 1_000, now: () => now });
  const fail = () => Promise.reject(new Error('down'));
  const succeed = () => Promise.resolve('ok');

  beforeEach(() => {
    now = 0;
  });

  it('opens after consecutive failures and then fails fast', async () => {
    const circuit = breaker();
    await expect(circuit.execute(fail)).rejects.toThrow('down');
    await expect(circuit.execute(fail)).rejects.toThrow('down');
    expect(circuit.state).toBe(CircuitState.OPEN);

    let called = false;
    await expect(
      circuit.execute(() => {
        called = true;
        return succeed();
      }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(called).toBe(false);
  });

  it('half-opens after the cooldown and closes on a successful probe', async () => {
    const circuit = breaker();
    await expect(circuit.execute(fail)).rejects.toThrow();
    await expect(circuit.execute(fail)).rejects.toThrow();
    now = 1_000;
    expect(circuit.state).toBe(CircuitState.HALF_OPEN);
    await expect(circuit.execute(succeed)).resolves.toBe('ok');
    expect(circuit.state).toBe(CircuitState.CLOSED);
  });

  it('re-opens immediately if the probe fails', async () => {
    const circuit = breaker();
    await expect(circuit.execute(fail)).rejects.toThrow();
    await expect(circuit.execute(fail)).rejects.toThrow();
    now = 1_000;
    await expect(circuit.execute(fail)).rejects.toThrow('down');
    expect(circuit.state).toBe(CircuitState.OPEN);
  });

  it('ignores failures the caller says are not the dependency’s fault', async () => {
    const circuit = breaker();
    for (let i = 0; i < 5; i += 1) {
      await expect(circuit.execute(fail, () => false)).rejects.toThrow();
    }
    expect(circuit.state).toBe(CircuitState.CLOSED);
  });

  it('resets the failure count on success', async () => {
    const circuit = breaker();
    await expect(circuit.execute(fail)).rejects.toThrow();
    await circuit.execute(succeed);
    await expect(circuit.execute(fail)).rejects.toThrow();
    expect(circuit.state).toBe(CircuitState.CLOSED);
  });
});

describe('BullMQ connection options', () => {
  const base: RedisConfig = {
    host: 'localhost',
    port: 6379,
    db: 0,
    tls: { enabled: false, rejectUnauthorized: true },
    keyPrefix: 'daiap:',
    connectTimeoutMs: 10_000,
    maxRetriesPerRequest: 3,
  };

  it('parses a managed-Redis URL, enabling TLS for rediss://', () => {
    const options = buildBullConnectionOptions(
      { ...base, url: 'rediss://default:p%40ss@redis.example.com:12345/2' },
      'worker',
    );
    expect(options).toMatchObject({
      host: 'redis.example.com',
      port: 12345,
      username: 'default',
      password: 'p@ss',
      db: 2,
    });
    expect(options.tls).toMatchObject({
      servername: 'redis.example.com',
      rejectUnauthorized: true,
    });
  });

  it('never sets an ioredis key prefix, which BullMQ does not support', () => {
    expect(buildBullConnectionOptions(base, 'worker').keyPrefix).toBeUndefined();
  });

  it('gives workers unlimited per-command retries, as BullMQ requires', () => {
    expect(buildBullConnectionOptions(base, 'worker').maxRetriesPerRequest).toBeNull();
  });

  it('makes producers fail fast so an upload never hangs on Redis', () => {
    const producer = buildBullConnectionOptions(base, 'producer');
    expect(producer.enableOfflineQueue).toBe(false);
    expect(producer.maxRetriesPerRequest).toBe(1);
  });

  it('strips brackets from an IPv6 host', () => {
    expect(
      buildBullConnectionOptions({ ...base, url: 'redis://[::1]:6379' }, 'producer').host,
    ).toBe('::1');
  });
});
