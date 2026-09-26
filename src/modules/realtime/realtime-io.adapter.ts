import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { IncomingMessage } from 'node:http';
import type { Server, ServerOptions } from 'socket.io';
import type { RealtimeConfig } from '../../config/realtime.config';
import type { SecurityConfig } from '../../config/security.config';

/**
 * The Socket.IO server, configured from the environment rather than from
 * decorator constants:
 *
 *  - **Path and transports** from `REALTIME_PATH` / `REALTIME_TRANSPORTS`.
 *    WebSocket only by default, which needs no sticky sessions behind a load
 *    balancer.
 *  - **Origin check at the engine level**, before the Socket.IO handshake:
 *    a browser page from an origin not in `CORS_ORIGINS` cannot open a socket
 *    at all (cross-site WebSocket hijacking). Authentication is by token, not
 *    cookie, so this is defence in depth.
 *  - **Tiny client messages** (`REALTIME_MAX_MESSAGE_SIZE`): clients only ever
 *    send subscriptions and tokens.
 *  - No client library served, no Engine.IO v3 fallback.
 */
export class RealtimeIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly realtime: RealtimeConfig,
    private readonly security: SecurityConfig,
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const allowed = new Set(
      this.security.cors.origins.map((origin) => origin.replace(/\/+$/, '')),
    );
    const anyOrigin = this.security.cors.allowAnyOrigin;
    const originAllowed = (origin: string | undefined) =>
      !origin || anyOrigin || allowed.has(origin.replace(/\/+$/, ''));

    return super.createIOServer(port, {
      ...options,
      path: this.realtime.path,
      transports: this.realtime.transports,
      serveClient: false,
      allowEIO3: false,
      pingInterval: this.realtime.pingIntervalMs,
      pingTimeout: this.realtime.pingTimeoutMs,
      maxHttpBufferSize: this.realtime.maxClientMessageBytes,
      connectTimeout: 10_000,
      cors: {
        origin: anyOrigin ? true : [...allowed],
        // Tokens travel in the handshake payload; cookies are never needed.
        credentials: false,
      },
      allowRequest: (
        request: IncomingMessage,
        callback: (error: string | null | undefined, success: boolean) => void,
      ) => {
        if (!this.realtime.enabled) return callback('real-time events are disabled', false);
        callback(null, originAllowed(request.headers.origin));
      },
    } as ServerOptions);
  }
}
