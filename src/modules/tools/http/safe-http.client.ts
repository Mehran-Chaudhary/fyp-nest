import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { performance } from 'node:perf_hooks';
import {
  assertUrlAllowed,
  classifyAddress,
  EgressBlockedError,
  type AllowlistEntry,
} from '../domain/egress-guard';

export interface SafeHttpRequest {
  url: URL;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxResponseBytes: number;
  signal?: AbortSignal;
}

export interface SafeHttpResponse {
  status: number;
  contentType: string | null;
  body: Buffer;
  truncated: boolean;
  /** The address actually connected to, for the audit record. */
  remoteAddress: string | null;
  durationMs: number;
  /** For a 3xx: where it pointed. Redirects are never followed. */
  location: string | null;
}

export interface SafeHttpOptions {
  allowlist: readonly AllowlistEntry[];
  allowPrivateNetworks: boolean;
  allowInsecure: boolean;
  userAgent: string;
  /** Injected for tests. */
  resolve?: (hostname: string) => Promise<LookupAddress[]>;
}

export class HttpToolError extends Error {
  constructor(
    readonly kind: 'TIMEOUT' | 'NETWORK' | 'TOO_LARGE' | 'ABORTED',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'HttpToolError';
  }
}

/**
 * An HTTP client that can only reach what the egress policy allows.
 *
 *  - The URL is checked before anything happens (scheme, credentials,
 *    allowlist, literal addresses).
 *  - DNS resolution goes through a custom `lookup` that rejects the request if
 *    *any* resolved address is non-public, then hands the connection exactly
 *    the address it validated. There is no second resolution for an attacker's
 *    DNS server to answer differently.
 *  - Redirects are not followed. A 3xx is returned as a 3xx, so an allowlisted
 *    host cannot bounce the request to the metadata service.
 *  - The response body is read up to a byte ceiling, and a total deadline
 *    covers connect, headers and body.
 *
 * Built on `node:http`/`node:https` rather than `fetch` because `fetch` offers
 * no hook between resolving a name and connecting to it, and that hook is the
 * whole point.
 */
export class SafeHttpClient {
  constructor(private readonly options: SafeHttpOptions) {}

  async send(request: SafeHttpRequest): Promise<SafeHttpResponse> {
    assertUrlAllowed(request.url, this.options);

    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(
          new HttpToolError(
            'TIMEOUT',
            `No complete response within ${request.timeoutMs}ms.`,
          ),
        ),
      request.timeoutMs,
    );
    const signal = request.signal
      ? AbortSignal.any([controller.signal, request.signal])
      : controller.signal;

    try {
      return await new Promise<SafeHttpResponse>((resolve, reject) => {
        const secure = request.url.protocol === 'https:';
        const send = secure ? httpsRequest : httpRequest;
        const body =
          request.body !== undefined ? Buffer.from(request.body, 'utf8') : undefined;

        const outgoing = send(
          {
            protocol: request.url.protocol,
            hostname: request.url.hostname.replace(/^\[|\]$/g, ''),
            port: request.url.port || (secure ? 443 : 80),
            path: `${request.url.pathname}${request.url.search}`,
            method: request.method,
            headers: {
              'user-agent': this.options.userAgent,
              accept: 'application/json, text/plain;q=0.9, */*;q=0.1',
              ...request.headers,
              ...(body ? { 'content-length': String(body.length) } : {}),
            },
            lookup: this.pinnedLookup(),
            signal,
            // Never reuse a socket across requests: each one is re-checked.
            agent: false,
          },
          (response) => {
            this.readBody(response, request.maxResponseBytes, signal)
              .then(({ buffer, truncated }) =>
                resolve({
                  status: response.statusCode ?? 0,
                  contentType: headerValue(response.headers['content-type']),
                  body: buffer,
                  truncated,
                  remoteAddress: response.socket?.remoteAddress ?? null,
                  durationMs: Math.round(performance.now() - started),
                  location:
                    (response.statusCode ?? 0) >= 300 && (response.statusCode ?? 0) < 400
                      ? headerValue(response.headers.location)
                      : null,
                }),
              )
              .catch(reject);
          },
        );

        outgoing.on('error', (error) => reject(this.translate(error, signal)));
        if (body) outgoing.write(body);
        outgoing.end();
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private pinnedLookup(): LookupFunction {
    const allowPrivate = this.options.allowPrivateNetworks;
    const resolveAll =
      this.options.resolve ??
      ((hostname: string) =>
        new Promise<LookupAddress[]>((resolve, reject) =>
          dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) =>
            error ? reject(error) : resolve(addresses),
          ),
        ));

    return (hostname, options, callback) => {
      resolveAll(hostname)
        .then((addresses) => {
          if (addresses.length === 0) {
            throw new EgressBlockedError('DNS_FAILURE', `${hostname} did not resolve.`);
          }
          if (!allowPrivate) {
            for (const { address } of addresses) {
              const reason = classifyAddress(address);
              if (reason) {
                throw new EgressBlockedError(
                  'ADDRESS_NOT_PUBLIC',
                  `${hostname} resolves to ${address}, which is ${reason}.`,
                );
              }
            }
          }
          const chosen = addresses[0];
          if ((options as { all?: boolean }).all) {
            (callback as (error: null, addresses: LookupAddress[]) => void)(null, [chosen]);
          } else {
            (callback as (error: null, address: string, family: number) => void)(
              null,
              chosen.address,
              chosen.family,
            );
          }
        })
        .catch((error: Error) =>
          (callback as (error: Error, address: string, family: number) => void)(
            error,
            '',
            0,
          ),
        );
    };
  }

  private async readBody(
    response: IncomingMessage,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<{ buffer: Buffer; truncated: boolean }> {
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    try {
      for await (const chunk of response) {
        if (signal.aborted) throw signal.reason;
        const data = chunk as Buffer;
        if (size + data.length > maxBytes) {
          chunks.push(data.subarray(0, Math.max(maxBytes - size, 0)));
          size = maxBytes;
          truncated = true;
          response.destroy();
          break;
        }
        chunks.push(data);
        size += data.length;
      }
    } catch (error) {
      if (!truncated) throw this.translate(error as Error, signal);
    }
    return { buffer: Buffer.concat(chunks, size), truncated };
  }

  private translate(error: Error, signal: AbortSignal): Error {
    if (error instanceof EgressBlockedError || error instanceof HttpToolError) return error;
    if (signal.aborted) {
      const reason: unknown = signal.reason;
      if (reason instanceof HttpToolError) return reason;
      return new HttpToolError('ABORTED', 'The request was cancelled.', { cause: error });
    }
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof EgressBlockedError) return cause;
    return new HttpToolError('NETWORK', `The request failed: ${error.message}`, {
      cause: error,
    });
  }
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}
