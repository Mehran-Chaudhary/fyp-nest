import { createPrivateKey, X509Certificate, type KeyObject } from 'node:crypto';

/**
 * PEM material from the environment.
 *
 * A cloud service has no file system to put a key file on, so certificates
 * and keys arrive as the *contents* of environment variables. Hosting
 * platforms disagree on how a multi-line value survives their variable editor,
 * so three spellings are accepted:
 *
 *  - raw PEM with real newlines;
 *  - PEM with literal `\n` escapes (what a single-line editor produces);
 *  - the whole PEM, base64-encoded (what `npm run generate:mtls` prints).
 */
export function normalizePem(raw: string | undefined | null): string {
  const value = (raw ?? '').trim();
  if (value.length === 0) return '';

  if (value.includes('-----BEGIN')) {
    return `${value.replace(/\\r\\n|\\n/g, '\n').replace(/\r\n/g, '\n').trim()}\n`;
  }

  // Not PEM as given: perhaps base64 of a PEM document.
  if (/^[A-Za-z0-9+/=\s_-]+$/.test(value)) {
    const decoded = Buffer.from(value.replace(/\s+/g, ''), 'base64').toString('utf8');
    if (decoded.includes('-----BEGIN')) return `${decoded.replace(/\r\n/g, '\n').trim()}\n`;
  }

  return value;
}

/** Every certificate in a PEM bundle, in order. */
export function splitPemCertificates(pem: string): string[] {
  return (
    normalizePem(pem).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ??
    []
  ).map((block) => `${block}\n`);
}

/** The client side of a TLS connection: what this backend presents and trusts. */
export interface ClientTlsMaterial {
  cert?: string;
  key?: string;
  passphrase?: string;
  ca?: string;
}

export interface CertificateSummary {
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  /** Whole days until expiry; negative once expired. */
  daysRemaining: number;
  fingerprint256: string;
}

export function summarizeCertificate(pem: string, now = Date.now()): CertificateSummary {
  const [first] = splitPemCertificates(pem);
  if (!first) throw new Error('no certificate found');
  const certificate = new X509Certificate(first);
  return {
    subject: certificate.subject.replace(/\n/g, ', '),
    issuer: certificate.issuer.replace(/\n/g, ', '),
    validFrom: new Date(certificate.validFrom).toISOString(),
    validTo: new Date(certificate.validTo).toISOString(),
    daysRemaining: Math.floor((Date.parse(certificate.validTo) - now) / 86_400_000),
    fingerprint256: certificate.fingerprint256,
  };
}

/**
 * Everything wrong with a client TLS configuration, as boot-time messages.
 *
 * Checked when the process starts rather than on the first request, because a
 * key that does not match its certificate otherwise surfaces as an opaque
 * handshake failure minutes later, on some ingestion job, in some log.
 */
export function describeClientTlsProblems(
  material: ClientTlsMaterial,
  prefix: string,
  label: string,
): string[] {
  const problems: string[] = [];
  const cert = normalizePem(material.cert);
  const key = normalizePem(material.key);
  const ca = normalizePem(material.ca);

  if (Boolean(cert) !== Boolean(key)) {
    problems.push(
      `"${prefix}_CERT" and "${prefix}_KEY" must be set together: a client certificate is ` +
        `useless to ${label} without its private key, and the reverse.`,
    );
    return problems;
  }

  let certificate: X509Certificate | null = null;
  if (cert) {
    const blocks = splitPemCertificates(cert);
    if (blocks.length === 0) {
      problems.push(`"${prefix}_CERT" does not contain a PEM certificate.`);
    } else {
      try {
        certificate = new X509Certificate(blocks[0]);
        if (Date.parse(certificate.validTo) < Date.now()) {
          problems.push(
            `"${prefix}_CERT" expired on ${new Date(certificate.validTo).toISOString()}.`,
          );
        }
      } catch {
        problems.push(`"${prefix}_CERT" is not a valid X.509 certificate.`);
      }
    }
  }

  let privateKey: KeyObject | null = null;
  if (key) {
    try {
      privateKey = createPrivateKey({
        key,
        ...(material.passphrase ? { passphrase: material.passphrase } : {}),
      });
    } catch {
      problems.push(
        `"${prefix}_KEY" is not a readable private key` +
          (material.passphrase ? ' (or the passphrase is wrong).' : '.'),
      );
    }
  }

  if (certificate && privateKey && !certificate.checkPrivateKey(privateKey)) {
    problems.push(`"${prefix}_KEY" does not belong to the certificate in "${prefix}_CERT".`);
  }

  if (ca) {
    const blocks = splitPemCertificates(ca);
    if (blocks.length === 0) {
      problems.push(`"${prefix}_CA" does not contain a PEM certificate.`);
    }
    for (const block of blocks) {
      try {
        new X509Certificate(block);
      } catch {
        problems.push(`"${prefix}_CA" contains a certificate that cannot be parsed.`);
        break;
      }
    }
  }

  return problems;
}
