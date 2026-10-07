import { jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import type { ConfigService } from '@nestjs/config';
import type { RedisService } from '../redis/redis.service';
import {
  EventBusService,
  SUBSCRIBER_HEARTBEAT_MS,
  SUBSCRIBER_HEARTBEAT_TIMEOUT_MS,
} from './event-bus.service';

/** The subscriber connection, as far as the bus uses it. */
class FakeSubscriber extends EventEmitter {
  status = 'ready';
  subscribe = jest.fn(() => Promise.resolve(2));
  ping = jest.fn(() => Promise.resolve('PONG'));
  disconnect = jest.fn();
  quit = jest.fn(() => Promise.resolve('OK'));
}

function makeBus() {
  const subscriber = new FakeSubscriber();
  const redis = { redis: { duplicate: () => subscriber } } as unknown as RedisService;
  const config = {
    getOrThrow: (key: string) =>
      key === 'redis'
        ? { keyPrefix: 'test:' }
        : { streamMaxLength: 1000, streamTtlSeconds: 3600 },
  } as unknown as ConfigService;
  const bus = new EventBusService(redis, config);
  return { bus, subscriber };
}

describe('EventBusService subscriber heartbeat', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  async function started() {
    const made = makeBus();
    made.bus.onEvent(() => undefined);
    made.bus.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(0);
    return made;
  }

  it('reports subscribed once the subscription is confirmed, and pings it periodically', async () => {
    const { bus, subscriber } = await started();
    expect(subscriber.subscribe).toHaveBeenCalledWith(
      'test:events:live',
      'test:events:control',
    );
    expect(bus.isSubscribed).toBe(true);

    await jest.advanceTimersByTimeAsync(SUBSCRIBER_HEARTBEAT_MS);
    expect(subscriber.ping).toHaveBeenCalledTimes(1);
    expect(bus.isSubscribed).toBe(true);
    await bus.onApplicationShutdown();
  });

  it('reconnects a subscriber that stops answering, and stops claiming to be subscribed', async () => {
    // The verification run: the server had dropped the subscription while the
    // client still read "ready", and /health said "subscribed" with no live events.
    const { bus, subscriber } = await started();
    subscriber.ping.mockImplementation(() => new Promise<string>(() => undefined));

    await jest.advanceTimersByTimeAsync(
      SUBSCRIBER_HEARTBEAT_MS + SUBSCRIBER_HEARTBEAT_TIMEOUT_MS,
    );
    expect(subscriber.disconnect).toHaveBeenCalledWith(true);

    await jest.advanceTimersByTimeAsync(SUBSCRIBER_HEARTBEAT_MS * 2);
    expect(subscriber.status).toBe('ready'); // the client still believes it
    expect(bus.isSubscribed).toBe(false); // the bus no longer does
    await bus.onApplicationShutdown();
  });

  it('reconnects when the heartbeat fails outright', async () => {
    const { bus, subscriber } = await started();
    subscriber.ping.mockRejectedValueOnce(new Error('Connection is closed.'));
    await jest.advanceTimersByTimeAsync(SUBSCRIBER_HEARTBEAT_MS);
    expect(subscriber.disconnect).toHaveBeenCalledWith(true);
    await bus.onApplicationShutdown();
  });

  it('is not subscribed before the subscription is confirmed', () => {
    const { bus, subscriber } = makeBus();
    subscriber.subscribe.mockImplementation(() => new Promise<number>(() => undefined));
    bus.onEvent(() => undefined);
    bus.onApplicationBootstrap();
    expect(bus.isSubscribed).toBe(false);
  });

  it('stops the heartbeat on shutdown', async () => {
    const { bus, subscriber } = await started();
    await bus.onApplicationShutdown();
    await jest.advanceTimersByTimeAsync(SUBSCRIBER_HEARTBEAT_MS * 3);
    expect(subscriber.ping).not.toHaveBeenCalled();
    expect(subscriber.quit).toHaveBeenCalled();
  });
});
