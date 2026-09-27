import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { describeClientTlsProblems, normalizePem, summarizeCertificate } from '../../common/utils/pem.util';
import { createTestPki, type TestPki } from '../../testing/test-certificates';
import { createTlsFetch } from './outbound-tls';

/**
 * Mutual TLS to internal services (phase 5), proven with a real handshake:
 * an HTTPS server that requires a client certificate signed by a private CA,
 * and the transport the AI-service client and the LLM gateway use.
 */
describe('mutual TLS', () => {
  let pki: TestPki;
  let server: Server;
  let url: string;

  beforeAll(async () => {
    pki = await createTestPki();
    server = createServer(
      {
        cert: pki.server.cert,
        key: pki.server.key,
        ca: pki.ca.cert,
        requestCert: true,
        rejectUnauthorized: true,
      },
      (request, response) => {
        const peer = (request.socket as TLSSocket).getPeerCertificate();
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ client: peer.subject?.CN ?? null }));
      },
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `https://localhost:${(server.address() as AddressInfo).port}/v1/health`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('presents the client certificate and verifies the server against the private CA', async () => {
    const tlsFetch = createTlsFetch({
      enabled: true,
      cert: pki.client.cert,
      key: pki.client.key,
      ca: pki.ca.cert,
    });
    expect(tlsFetch).not.toBeNull();
    const response = await tlsFetch!(url, { method: 'GET' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ client: 'daiap-backend' });
  });

  it('is refused by the server without a client certificate', async () => {
    const withoutClientCert = createTlsFetch({ enabled: false, ca: pki.ca.cert });
    await expect(withoutClientCert!(url, { method: 'GET' })).rejects.toThrow();
  });

  it('refuses a server whose certificate is not from the pinned CA', async () => {
    const other = await createTestPki();
    const pinnedElsewhere = createTlsFetch({
      enabled: true,
      cert: pki.client.cert,
      key: pki.client.key,
      ca: other.ca.cert,
    });
    await expect(pinnedElsewhere!(url, { method: 'GET' })).rejects.toThrow();
  });

  it('is not used at all when nothing is configured', () => {
    expect(createTlsFetch({ enabled: false })).toBeNull();
  });

  describe('PEM material from the environment', () => {
    it('accepts raw, \\n-escaped and base64-encoded PEM alike', () => {
      const raw = pki.client.cert;
      const escaped = raw.replace(/\n/g, '\\n');
      const encoded = Buffer.from(raw).toString('base64');
      expect(normalizePem(escaped)).toBe(normalizePem(raw));
      expect(normalizePem(encoded)).toBe(normalizePem(raw));
      expect(normalizePem('')).toBe('');
    });

    it('reports nothing for a consistent configuration', () => {
      expect(
        describeClientTlsProblems(
          { cert: pki.client.cert, key: pki.client.key, ca: pki.ca.cert },
          'AI_SERVICE_TLS',
          'the AI service',
        ),
      ).toEqual([]);
    });

    it('refuses a certificate without its key, and the reverse', () => {
      expect(
        describeClientTlsProblems({ cert: pki.client.cert }, 'AI_SERVICE_TLS', 'x')[0],
      ).toMatch(/must be set together/);
      expect(
        describeClientTlsProblems({ key: pki.client.key }, 'AI_SERVICE_TLS', 'x')[0],
      ).toMatch(/must be set together/);
    });

    it('refuses a key that belongs to another certificate', () => {
      const problems = describeClientTlsProblems(
        { cert: pki.client.cert, key: pki.server.key },
        'LLM_TLS',
        'x',
      );
      expect(problems.join()).toMatch(/does not belong/);
    });

    it('refuses an expired certificate and garbage', async () => {
      const expired = await createTestPki({ expired: true });
      expect(
        describeClientTlsProblems(
          { cert: expired.client.cert, key: expired.client.key },
          'LLM_TLS',
          'x',
        ).join(),
      ).toMatch(/expired/);
      expect(
        describeClientTlsProblems({ cert: 'not a pem', key: 'nor this' }, 'LLM_TLS', 'x').length,
      ).toBeGreaterThan(0);
    });

    it('summarises a certificate for the health report', () => {
      const summary = summarizeCertificate(pki.client.cert);
      expect(summary.subject).toContain('daiap-backend');
      expect(summary.daysRemaining).toBeGreaterThanOrEqual(0);
    });
  });
});
