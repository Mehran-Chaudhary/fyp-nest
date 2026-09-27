import { normalizePem } from '../common/utils/pem.util';

/**
 * Mutual TLS towards an internal service (phase 5): the certificate and key
 * this backend presents, and the CA it trusts for the service's own
 * certificate. `enabled` only when a client certificate is configured; a CA on
 * its own still pins trust to a private CA.
 */
export interface ClientTlsConfig {
  enabled: boolean;
  cert?: string;
  key?: string;
  passphrase?: string;
  ca?: string;
  /** Name verified on the server certificate, when it differs from the URL host. */
  servername?: string;
}

/** Reads `<PREFIX>_CERT`, `_KEY`, `_KEY_PASSPHRASE`, `_CA` and `_SERVERNAME`. */
export function readClientTls(prefix: string): ClientTlsConfig {
  const cert = normalizePem(process.env[`${prefix}_CERT`]);
  const key = normalizePem(process.env[`${prefix}_KEY`]);
  const ca = normalizePem(process.env[`${prefix}_CA`]);
  const passphrase = process.env[`${prefix}_KEY_PASSPHRASE`] || undefined;
  const servername = process.env[`${prefix}_SERVERNAME`] || undefined;

  return {
    enabled: cert.length > 0 && key.length > 0,
    ...(cert ? { cert } : {}),
    ...(key ? { key } : {}),
    ...(passphrase ? { passphrase } : {}),
    ...(ca ? { ca } : {}),
    ...(servername ? { servername } : {}),
  };
}
