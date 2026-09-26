import { registerAs } from '@nestjs/config';
import { parseByteSize } from '../common/utils/byte-size.util';
import { parseDuration } from '../common/utils/duration.util';

/**
 * The real-time notification engine (proposal module 6.16): a Socket.IO
 * server that pushes workflow and tool events to the canvas.
 *
 * Events carry metadata only — ids, statuses, timings, counts — never content.
 * A client that wants a step's output fetches it over HTTP, where the reader's
 * clearance is checked against the output's label.
 */
export interface RealtimeConfig {
  enabled: boolean;
  /** HTTP path of the Socket.IO endpoint, e.g. `/realtime`. */
  path: string;
  /**
   * `websocket` alone needs no sticky sessions behind a load balancer, which is
   * why it is the default. Adding `polling` helps clients behind proxies that
   * strip upgrades, but then every instance must be sticky.
   */
  transports: Array<'websocket' | 'polling'>;
  maxConnectionsPerUser: number;
  /** Handshakes per source IP per minute. */
  maxHandshakesPerMinute: number;
  /** How often each socket's token, membership and permissions are re-checked. */
  revalidateIntervalMs: number;
  /** Most events replayed to a client that reconnects with `lastEventId`. */
  replayMaxEvents: number;
  /** Events retained per workspace for replay (approximate, capped stream). */
  streamMaxLength: number;
  streamTtlSeconds: number;
  pingIntervalMs: number;
  pingTimeoutMs: number;
  /** Largest message a client may send. Clients send tiny control messages only. */
  maxClientMessageBytes: number;
}

export const REALTIME_CONFIG_KEY = 'realtime';

export default registerAs(REALTIME_CONFIG_KEY, (): RealtimeConfig => {
  const transports = (process.env.REALTIME_TRANSPORTS ?? 'websocket')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry): entry is 'websocket' | 'polling' =>
      ['websocket', 'polling'].includes(entry),
    );

  return {
    enabled: process.env.REALTIME_ENABLED !== 'false',
    path: `/${(process.env.REALTIME_PATH ?? '/realtime').replace(/^\/+|\/+$/g, '')}`,
    transports: transports.length > 0 ? transports : ['websocket'],
    maxConnectionsPerUser: Number(process.env.REALTIME_MAX_CONNECTIONS_PER_USER),
    maxHandshakesPerMinute: Number(process.env.REALTIME_MAX_HANDSHAKES_PER_MINUTE),
    revalidateIntervalMs: parseDuration(process.env.REALTIME_REVALIDATE_INTERVAL as string),
    replayMaxEvents: Number(process.env.REALTIME_REPLAY_MAX),
    streamMaxLength: Number(process.env.REALTIME_STREAM_MAXLEN),
    streamTtlSeconds: Math.ceil(
      parseDuration(process.env.REALTIME_STREAM_TTL as string) / 1000,
    ),
    pingIntervalMs: parseDuration(process.env.REALTIME_PING_INTERVAL as string),
    pingTimeoutMs: parseDuration(process.env.REALTIME_PING_TIMEOUT as string),
    maxClientMessageBytes: parseByteSize(process.env.REALTIME_MAX_MESSAGE_SIZE as string),
  };
});
