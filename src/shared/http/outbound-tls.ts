import { Agent, fetch as undiciFetch } from 'undici';
import type { ClientTlsConfig } from '../../config/client-tls';

/** The shape of `fetch` the platform's HTTP clients take. */
export type TlsFetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * A `fetch` that presents a client certificate — mutual TLS to an internal
 * service (phase 5) — or `null` when none is configured, so callers keep the
 * global `fetch`.
 *
 * Built on undici's `fetch` with its own dispatcher (connection pool), so the
 * certificate applies to this service's connections only, never to anything
 * else the process calls. TLS 1.2 is the floor, the server certificate is
 * always verified, and — when a private CA is given — verified against that
 * CA alone: the one service this client talks to is not trusted merely for
 * holding a publicly-issued certificate.
 */
export function createTlsFetch(tls: ClientTlsConfig): TlsFetch | null {
  if (!tls.enabled && !tls.ca) return null;

  const dispatcher = new Agent({
    connect: {
      ...(tls.cert ? { cert: tls.cert } : {}),
      ...(tls.key ? { key: tls.key } : {}),
      ...(tls.passphrase ? { passphrase: tls.passphrase } : {}),
      ...(tls.ca ? { ca: tls.ca } : {}),
      ...(tls.servername ? { servername: tls.servername } : {}),
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    },
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 120_000,
  });

  return (input, init) =>
    undiciFetch(input, {
      ...(init as Record<string, unknown>),
      dispatcher,
    } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
}
