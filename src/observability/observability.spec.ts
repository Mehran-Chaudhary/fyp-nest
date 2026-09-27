import type { Request } from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { routeTemplate } from './http-metrics.middleware';
import { createMetricsHandler } from './metrics-endpoint';
import { circuitStateValue, MetricsService } from './metrics.service';
import { sanitizeAttributes, scrubText, stripQuery } from './span-sanitizer';

/**
 * Observability (phase 5): what may leave in a trace, what a metric may be
 * labelled with, and who may scrape.
 */
describe('observability (phase 5)', () => {
  describe('span sanitizer', () => {
    it('strips query strings from every URL attribute', () => {
      expect(stripQuery('https://ai.example.com/v1/documents/parse?filename=payroll.pdf')).toBe(
        'https://ai.example.com/v1/documents/parse',
      );
      const clean = sanitizeAttributes({
        'url.full': 'https://api.test/v1/members?search=ayesha#top',
        'http.target': '/api/v1/members?search=ayesha',
        'url.query': 'search=ayesha',
        'http.method': 'GET',
        'http.status_code': 200,
      });
      expect(clean['url.full']).toBe('https://api.test/v1/members');
      expect(clean['http.target']).toBe('/api/v1/members');
      expect(clean).not.toHaveProperty('url.query');
      expect(clean['http.method']).toBe('GET');
      expect(clean['http.status_code']).toBe(200);
    });

    it('scrubs personal values out of error messages and statements', () => {
      const message = scrubText(
        'duplicate key value violates unique constraint: Key (email)=(ayesha@acme.test) ' +
          "already exists; card 4111 1111 1111 1111; name 'Ayesha Raza'",
      );
      expect(message).not.toContain('ayesha@acme.test');
      expect(message).not.toContain('4111');
      expect(message).not.toContain('Ayesha Raza');
      expect(message).toContain('Key (email)=([value])');
    });

    it('bounds free text, so nothing prompt-sized fits in an attribute', () => {
      const clean = sanitizeAttributes({ 'daiap.note': 'x'.repeat(10_000) });
      expect((clean['daiap.note'] as string).length).toBeLessThanOrEqual(512);
    });
  });

  describe('metrics', () => {
    it('labels HTTP metrics by route template, never by concrete path', () => {
      const request = {
        baseUrl: '',
        route: { path: '/api/v1/organizations/:organizationId/agents/:agentId' },
      } as unknown as Request;
      expect(routeTemplate(request)).toBe('/api/v1/organizations/:organizationId/agents/:agentId');
      expect(routeTemplate({ baseUrl: '' } as Request)).toBe('unmatched');
    });

    it('maps circuit states to gauge values', () => {
      expect(circuitStateValue('CLOSED')).toBe(0);
      expect(circuitStateValue('HALF_OPEN')).toBe(1);
      expect(circuitStateValue('OPEN')).toBe(2);
    });

    it('renders the exposition format, refreshing gauges first, surviving a failing hook', async () => {
      const metrics = new MetricsService();
      metrics.onScrape(() => metrics.llmInFlight.set(3));
      metrics.onScrape(() => {
        throw new Error('dependency down');
      });
      metrics.quotaDecisions.inc({ decision: 'rejected', reason: 'budget', scope: 'MEMBER' });
      const body = await metrics.render();
      expect(body).toContain('daiap_llm_inflight{service="daiap-api"} 3');
      expect(body).toMatch(
        /daiap_quota_decisions_total\{decision="rejected",reason="budget",scope="MEMBER",service="daiap-api"\} 1/,
      );
      expect(body).toContain('process_cpu_user_seconds_total');
    });
  });

  describe('the /metrics endpoint', () => {
    let server: Server;
    let base: string;
    const serve = (handler: ReturnType<typeof createMetricsHandler>) =>
      new Promise<void>((resolve) => {
        server = createServer(handler);
        server.listen(0, '127.0.0.1', () => {
          base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/metrics`;
          resolve();
        });
      });
    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('requires the bearer token when one is configured', async () => {
      await serve(
        createMetricsHandler(new MetricsService(), {
          token: 'scrape-token-with-enough-entropy-123',
          isProduction: true,
        }),
      );
      expect((await fetch(base)).status).toBe(401);
      expect(
        (await fetch(base, { headers: { authorization: 'Bearer wrong-token-value-xxxxxxxxxx' } }))
          .status,
      ).toBe(401);
      const ok = await fetch(base, {
        headers: { authorization: 'Bearer scrape-token-with-enough-entropy-123' },
      });
      expect(ok.status).toBe(200);
      expect(ok.headers.get('content-type')).toContain('text/plain');
    });

    it('refuses everyone in production without a token, serves openly in development', async () => {
      await serve(createMetricsHandler(new MetricsService(), { token: '', isProduction: true }));
      expect((await fetch(base)).status).toBe(401);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await serve(createMetricsHandler(new MetricsService(), { token: '', isProduction: false }));
      expect((await fetch(base)).status).toBe(200);
      expect((await fetch(base, { method: 'POST' })).status).toBe(405);
    });
  });
});
