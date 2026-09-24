import type { Response } from 'express';

/**
 * Writes a Server-Sent Events stream onto an Express response.
 *
 * Used for token streaming from the language model. A few details decide
 * whether SSE actually streams through a real cloud deployment:
 *
 *  - `Cache-Control: no-transform` makes the `compression` middleware leave the
 *    stream alone. Without it, gzip buffers the events and the client receives
 *    the whole answer at the end.
 *  - `X-Accel-Buffering: no` stops nginx-style proxies in front of the app
 *    (Render, Railway and most ingress controllers) from buffering it.
 *  - A comment line every `heartbeatMs` keeps idle-connection reapers at the
 *    load balancer from cutting the stream while a cold model loads.
 *
 * Data is always serialised with `JSON.stringify`, which escapes newlines, so
 * every event carries exactly one `data:` line and model output can never
 * inject an event boundary or a forged event of its own.
 */
export class SseWriter {
  private opened = false;
  private ended = false;
  private heartbeat?: NodeJS.Timeout;
  private eventCount = 0;

  constructor(
    private readonly response: Response,
    private readonly heartbeatMs = 15_000,
  ) {
    response.on('close', () => this.stopHeartbeat());
  }

  get isOpen(): boolean {
    return (
      this.opened && !this.ended && !this.response.writableEnded && !this.response.destroyed
    );
  }

  /** True once the client has gone away or the stream was ended. */
  get isClosed(): boolean {
    return this.ended || this.response.destroyed || this.response.writableEnded;
  }

  open(): void {
    if (this.opened) return;
    this.opened = true;

    this.response.status(200);
    this.response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    this.response.setHeader('Cache-Control', 'no-cache, no-store, no-transform');
    this.response.setHeader('Connection', 'keep-alive');
    this.response.setHeader('X-Accel-Buffering', 'no');
    this.response.flushHeaders();

    // Tells EventSource-style clients how long to wait before reconnecting.
    this.write('retry: 5000\n\n');

    if (this.heartbeatMs > 0) {
      this.heartbeat = setInterval(() => this.comment('keep-alive'), this.heartbeatMs);
      this.heartbeat.unref();
    }
  }

  send(event: string, data: unknown): void {
    if (!this.isOpen) return;
    this.eventCount += 1;
    this.write(
      `id: ${this.eventCount}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
    );
  }

  comment(text: string): void {
    if (!this.isOpen) return;
    this.write(`: ${text.replace(/[\r\n]+/g, ' ')}\n\n`);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.stopHeartbeat();
    if (!this.response.writableEnded) this.response.end();
  }

  private write(chunk: string): void {
    this.response.write(chunk);
    // `compression` adds `flush()`; present or not, the write above is not
    // held back because of `no-transform`, but flushing costs nothing.
    (this.response as Response & { flush?: () => void }).flush?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }
}
