/* Opt-in Phase 5 live verification: tools, workflow definitions and runs, approvals,
 * the Socket.IO real-time channel, audit, analytics, quotas, agent circuit breakers and
 * personal data, against a running backend with its real queues, model endpoint,
 * retrieval, PII engine and outbound HTTP.
 *
 * Creates disposable users and workspaces. Never touches existing users or workspaces.
 * Members join through the public invitation flow: the invitation email is read from the
 * configured Ethereal test inbox over IMAP. No database rows are written directly.
 * Secrets (passwords, tokens, API keys, TOTP secrets, invitation tokens) stay in process
 * memory and are never written to output. Documents and run inputs are synthetic.
 *
 * Needs, on the backend under test:
 *  - TOOL_HTTP_ALLOWED_HOSTS including P5_ECHO_HOST (default postman-echo.com) and
 *    P5_STATUS_HOST (default httpbin.org): HTTP tools are proven with real requests;
 *  - AGENT_CIRCUIT_MAX_TOKENS at or below ~2,500 within AGENT_CIRCUIT_WINDOW, so one
 *    large turn opens an agent's breaker (P5_CIRCUIT_CHARS sizes that turn);
 *  - WORKFLOW_SWEEP_INTERVAL short enough (15s) for the approval-timeout and run-timeout
 *    checks to finish within a few minutes.
 *
 * Model calls are real and metered: about ten, paced by the workspace token rate.
 * Flow-control refusals that a check did not ask for are waited out (Retry-After) and
 * recorded under facts.flowControl, never counted as failures.
 *
 *   node scripts/verify-phase5-live.cjs --run
 */
'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const tls = require('node:tls');
require('dotenv').config({ quiet: true });
const { io } = require('socket.io-client');

if (!process.argv.includes('--run')) throw new Error('Explicit --run required');
const BASE = process.env.P5_BASE_URL || `http://localhost:${process.env.APP_PORT || 3000}`;
const OUT = process.env.P5_RESULTS || 'docs/frontend/PHASE_5_LIVE_RESULTS.json';
const COOKIE = process.env.REFRESH_TOKEN_COOKIE_NAME || 'daiap_rt';
const ECHO_HOST = process.env.P5_ECHO_HOST || 'postman-echo.com';
const STATUS_HOST = process.env.P5_STATUS_HOST || 'httpbin.org';
const CIRCUIT_CHARS = Number(process.env.P5_CIRCUIT_CHARS || 4_400); // ~0.86 tokens per character of hex: ~3,900 tokens
const REALTIME_PATH = process.env.REALTIME_PATH || '/realtime';
const run = `p5-${Date.now()}`;

process.stdout.on('error', () => undefined);

const results = [];
const traces = {};
const samples = {};
const facts = { flowControl: [], transientRetries: [], modelObservations: [], timings: {} };
const actors = {};
const workspaces = [];
const createdBases = [];
const apiKeys = [];
const sockets = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ws = (id, suffix = '') => `/api/v1/organizations/${id}${suffix}`;
const FLOW_CODES = new Set(['TOKEN_RATE_LIMITED', 'LLM_BUSY', 'RATE_LIMIT_EXCEEDED']);
const ACTIVE = new Set(['QUEUED', 'RUNNING', 'WAITING_APPROVAL']);

// ── HTTP ────────────────────────────────────────────────────────────────────

const recent = new Map();
async function pace(key) {
  for (;;) {
    const now = Date.now();
    const list = (recent.get(key) || []).filter((t) => now - t < 60_000);
    if (list.length < 90) {
      list.push(now);
      recent.set(key, list);
      return;
    }
    await sleep(60_000 - (now - list[0]) + 250);
  }
}

function log(row) {
  try {
    console.log(JSON.stringify(row));
  } catch {
    /* best effort */
  }
}

function readCookie(headers) {
  const all = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  const match = all.find((value) => value.startsWith(`${COOKIE}=`));
  return match ? match.split(';')[0].slice(COOKIE.length + 1) : null;
}

async function refresh(actor) {
  const res = await fetch(`${BASE}/api/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `${COOKIE}=${actor.refreshCookie}` },
    body: '{}',
  });
  const json = await res.json();
  if (res.status !== 200) throw new Error(`refresh failed for ${actor.name}: ${res.status}`);
  actor.token = json.data.accessToken ?? json.data.tokens?.accessToken;
  actor.tokenAt = Date.now();
  const cookie = readCookie(res.headers);
  if (cookie) actor.refreshCookie = cookie;
  // Keep the actor's open sockets authorised: the in-place refresh is itself a contract.
  for (const handle of actor.sockets ?? []) {
    if (!handle.socket.connected) continue;
    const ack = await handle.emit('auth:refresh', { token: actor.token });
    handle.refreshes.push({ at: new Date().toISOString(), ok: ack?.ok === true, expiresAt: ack?.expiresAt ?? null });
  }
}

async function freshToken(actor) {
  if (actor && actor.tokenAt && Date.now() - actor.tokenAt > 11 * 60_000) await refresh(actor);
}

function retryAfterSeconds(headers, json) {
  const header = Number(headers?.get?.('retry-after'));
  if (Number.isFinite(header) && header > 0) return header;
  const detail = Number(json?.error?.details?.retryAfterSeconds ?? json?.retryAfterSeconds);
  return Number.isFinite(detail) && detail > 0 ? detail : 5;
}

async function waitFlow(label, code, seconds) {
  const waitS = Math.min(Math.max(1, Math.ceil(seconds)), 90) + 1;
  facts.flowControl.push({ label, code, waitS, at: new Date().toISOString() });
  log({ label, flowControl: code, waitS });
  await sleep(waitS * 1000);
}

/**
 * One request. `expect` is a status or list; `code` the expected error code. `raw`
 * returns the body as text (downloads). Unrequested flow-control refusals are waited out.
 */
async function call(label, method, urlPath, opts = {}) {
  const { body, actor, org, apiKey, expect = 200, code, quiet = false, flow = true, raw = false } = opts;
  const expected = Array.isArray(expect) ? expect : [expect];
  for (let attempt = 0; ; attempt += 1) {
    if (actor && !apiKey && !opts.token) await freshToken(actor);
    await pace(apiKey ? 'api-key' : actor ? actor.name : 'anonymous');
    const headers = { Accept: raw ? '*/*' : 'application/json', ...(opts.headers ?? {}) };
    const bearer = opts.token ?? (actor && !apiKey ? actor.token : undefined);
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    if (apiKey) headers['X-API-Key'] = apiKey;
    if (org) headers['X-Organization-Id'] = org;
    let payload;
    if (opts.form) payload = opts.form();
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const started = Date.now();
    let res;
    try {
      res = await fetch(`${BASE}${urlPath}`, { method, headers, body: payload, signal: AbortSignal.timeout(opts.timeout ?? 330_000) });
    } catch (error) {
      const row = { label, method, path: urlPath, pass: false, transport: error.name };
      results.push(row);
      log(row);
      return { status: 0, headers: new Headers() };
    }
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    const actualCode = json?.error?.code;
    const asked = expected.includes(res.status) && (!code || code === actualCode);
    if (flow && !asked && FLOW_CODES.has(actualCode) && attempt < 10) {
      await waitFlow(label, actualCode, retryAfterSeconds(res.headers, json));
      continue;
    }
    if (res.status === 503 && !expected.includes(503) && !opts.retriedTransient) {
      facts.transientRetries.push({ label, code: actualCode, requestId: json?.meta?.requestId, at: new Date().toISOString() });
      log({ label, transient: actualCode, retrying: true });
      await sleep(3000);
      return call(label, method, urlPath, { ...opts, retriedTransient: true });
    }
    const row = {
      label,
      method,
      path: urlPath,
      actor: apiKey ? 'api-key' : actor?.name ?? (opts.token ? 'token' : 'anonymous'),
      status: res.status,
      expected: expected.length === 1 ? expected[0] : expected,
      code: actualCode,
      pass: asked,
      ms: Date.now() - started,
      requestId: json?.meta?.requestId ?? res.headers.get('x-request-id') ?? undefined,
    };
    if (!quiet || !asked) {
      results.push(row);
      log(row);
    }
    return { status: res.status, json, text: raw ? text : undefined, data: json?.data, meta: json?.meta, error: json?.error, headers: res.headers, requestId: row.requestId };
  }
}

function check(label, pass, detail) {
  const row = { label, pass: !!pass, ...(detail === undefined ? {} : { detail }) };
  results.push(row);
  log(row);
  return !!pass;
}

function observe(label, detail) {
  facts.modelObservations.push({ label, ...detail });
  log({ observe: label, ...detail });
}

function need(response, label) {
  if (!response.data) throw new Error(`Fixture failed: ${label} (${response.status} ${response.error?.code ?? ''} ${JSON.stringify(response.error?.details ?? '').slice(0, 300)})`);
  return response.data;
}

const keys = (object) => Object.keys(object ?? {}).sort();
function sameKeys(label, object, expected, optional = []) {
  const actual = keys(object).filter((key) => !optional.includes(key));
  const wanted = [...expected].sort();
  return check(label, JSON.stringify(actual) === JSON.stringify(wanted), {
    missing: wanted.filter((key) => !actual.includes(key)),
    extra: actual.filter((key) => !wanted.includes(key)),
  });
}
const fieldsOf = (response) => Object.keys(response.error?.details?.fields ?? {}).sort();

// ── Ethereal IMAP ───────────────────────────────────────────────────────────

function imap(commands) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: 'imap.ethereal.email', port: 993, servername: 'imap.ethereal.email' });
    let buffer = '';
    let index = -1;
    let greeted = false;
    const outputs = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('IMAP timeout'));
    }, 45_000);
    const next = () => {
      index += 1;
      if (index >= commands.length) {
        clearTimeout(timer);
        socket.end();
        resolve(outputs);
        return;
      }
      buffer = '';
      socket.write(`a${index} ${commands[index]}\r\n`);
    };
    socket.setEncoding('latin1');
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (!greeted) {
        if (buffer.includes('\r\n')) {
          greeted = true;
          next();
        }
        return;
      }
      const match = buffer.match(new RegExp(`(?:^|\\r\\n)a${index} (OK|NO|BAD)[^\\r\\n]*\\r\\n$`));
      if (!match) return;
      if (match[1] !== 'OK') {
        clearTimeout(timer);
        socket.destroy();
        reject(new Error(`IMAP command ${index} failed`));
        return;
      }
      outputs.push(buffer);
      next();
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

const quote = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const imapLogin = () => `LOGIN ${quote(process.env.SMTP_USERNAME)} ${quote(process.env.SMTP_PASSWORD)}`;

async function mailUids(recipient, subject) {
  const [, , search] = await imap([imapLogin(), 'SELECT INBOX', `UID SEARCH TO ${quote(recipient)} SUBJECT ${quote(subject)}`, 'LOGOUT']);
  const line = search.split('\r\n').find((entry) => entry.startsWith('* SEARCH'));
  return (line || '').replace('* SEARCH', '').trim().split(/\s+/).filter(Boolean).map(Number);
}

async function invitationToken(recipient) {
  return mailToken(recipient, 'invited', /invitations\/accept\?token=([A-Za-z0-9%_.~-]+)/);
}

/** The token in the newest email to `recipient` whose subject contains `subject`. */
async function mailToken(recipient, subject, pattern) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const uids = await mailUids(recipient, subject);
    if (uids.length) {
      const [, , fetched] = await imap([imapLogin(), 'SELECT INBOX', `UID FETCH ${Math.max(...uids)} BODY.PEEK[]`, 'LOGOUT']);
      let text = fetched.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
      let match = text.match(pattern);
      if (!match) {
        text = (fetched.match(/\r\n\r\n([A-Za-z0-9+/=\r\n]{40,})/g) || [])
          .map((block) => Buffer.from(block.replace(/\s+/g, ''), 'base64').toString('utf8'))
          .join('\n');
        match = text.match(pattern);
      }
      if (match) return decodeURIComponent(match[1]);
    }
    await sleep(3000);
  }
  throw new Error(`No "${subject}" email for ${recipient.split('@')[0]}`);
}

async function mailArrived(recipient, subject, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await mailUids(recipient, subject)).length) return true;
    await sleep(3000);
  }
  return false;
}

// ── TOTP (RFC 6238: SHA-1, 6 digits, 30 s) ─────────────────────────────────

function base32Decode(encoded) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of encoded.replace(/[\s=-]/g, '').toUpperCase()) bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
function totp(secret, timeMs = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(timeMs / 30_000)));
  const digest = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0xf;
  const binary = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(binary).padStart(6, '0');
}

// ── Sockets ─────────────────────────────────────────────────────────────────

/**
 * Opens a Socket.IO connection and records everything it receives. Resolves once the
 * server sent `ready` or refused the handshake.
 */
function openSocket(name, auth, options = {}) {
  return new Promise((resolve) => {
    const socket = io(BASE, {
      path: REALTIME_PATH,
      transports: ['websocket'],
      auth,
      reconnection: false,
      timeout: 10_000,
      ...options,
    });
    const handle = {
      name,
      socket,
      ready: null,
      refused: null,
      events: [],
      notifications: [],
      control: [],
      refreshes: [],
      openedAt: Date.now(),
      emit(event, payload, timeoutMs = 10_000) {
        return new Promise((done) => {
          const timer = setTimeout(() => done({ ok: false, code: 'ACK_TIMEOUT' }), timeoutMs);
          socket.emit(event, payload, (ack) => {
            clearTimeout(timer);
            done(ack);
          });
        });
      },
      close() {
        socket.close();
      },
    };
    socket.on('event', (event) => handle.events.push({ ...event, receivedAt: Date.now() }));
    socket.on('notification', (event) => handle.notifications.push({ ...event, receivedAt: Date.now() }));
    for (const control of ['auth:expired', 'auth:revoked', 'error', 'exception']) {
      socket.on(control, (data) => handle.control.push({ event: control, data, at: Date.now() }));
    }
    socket.on('disconnect', (reason) => handle.control.push({ event: 'disconnect', reason, at: Date.now() }));
    let settled = false;
    socket.on('ready', (ready) => {
      handle.ready = ready;
      if (!settled) {
        settled = true;
        resolve(handle);
      }
    });
    socket.on('connect_error', (error) => {
      handle.refused = { message: error.message, code: error.data?.code ?? null, data: error.data ?? null, transport: error.type ?? null };
      if (!settled) {
        settled = true;
        socket.close();
        resolve(handle);
      }
    });
    sockets.push(handle);
  });
}

async function connectActor(actor, org) {
  const handle = await openSocket(actor.name, { token: actor.token, organizationId: org });
  (actor.sockets ||= []).push(handle);
  return handle;
}

const until = async (predicate, timeoutMs, stepMs = 500) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return predicate();
};
const eventsOf = (handle, runId) => handle.events.filter((event) => event.runId === runId);
const typesOf = (events) => events.map((event) => event.type);

// ── Runs ────────────────────────────────────────────────────────────────────

async function waitRun(label, actor, org, runId, predicate = (run) => !ACTIVE.has(run.status), timeoutMs = 240_000, options = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const res = await call(`poll ${label}`, 'GET', ws(org, `/workflow-runs/${runId}`), { actor, org, quiet: true, apiKey: options.apiKey });
    last = res.data;
    if (last && predicate(last)) return last;
    await sleep(2000);
  }
  return last;
}
const stepOf = (run, nodeId, iteration = 0) => (run?.steps ?? []).find((step) => step.nodeId === nodeId && step.iteration === iteration);
const stepSummary = (run) => (run?.steps ?? []).map((step) => `${step.nodeId}#${step.iteration}:${step.status}${step.handles?.length ? `[${step.handles.join(',')}]` : ''}`);

// ── Knowledge fixture ───────────────────────────────────────────────────────

function upload(name, text, fields) {
  return () => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    form.append('file', new Blob([Buffer.from(text, 'utf8')], { type: 'text/markdown' }), name);
    return form;
  };
}

async function waitForDocuments(actor, org, ids, timeoutMs = 300_000) {
  const started = Date.now();
  const pending = new Set(ids);
  while (pending.size && Date.now() - started < timeoutMs) {
    const page = await call('fixture: poll documents', 'GET', ws(org, '/documents?limit=100'), { actor, org, quiet: true });
    for (const document of page.data ?? []) {
      if (pending.has(document.id) && ['READY', 'FAILED'].includes(document.status)) pending.delete(document.id);
    }
    if (pending.size) await sleep(2000);
  }
  return pending.size === 0;
}

// ── Shapes ──────────────────────────────────────────────────────────────────

const SHAPE = {
  tool: ['id', 'kind', 'name', 'displayName', 'description', 'parameters', 'dataPolicy', 'resultIntegrity', 'requiresApproval', 'requiredPermissions', 'timeoutMs', 'version', 'digest', 'enabled', 'available'],
  httpToolExtra: ['http', 'hasSecret', 'createdAt', 'updatedAt'],
  dataPolicy: ['maxClassification', 'minIntegrity', 'piiArguments', 'sideEffects'],
  execution: ['id', 'createdAt', 'completedAt', 'toolName', 'toolId', 'toolVersion', 'status', 'denialReason', 'errorCode', 'agentId', 'conversationId', 'workflowRunId', 'workflowStepId', 'durationMs', 'resultBytes', 'contextClassification', 'contextIntegrity', 'sideEffects', 'argumentsDigest'],
  testOk: ['status', 'executionId', 'durationMs', 'content', 'truncated'],
  testRefused: ['status', 'executionId', 'durationMs', 'code', 'message'],
  nodeType: ['type', 'label', 'description', 'outputs', 'produces', 'multiple', 'fields'],
  report: ['valid', 'errors', 'warnings', 'stepBound'],
  summary: ['id', 'name', 'description', 'status', 'currentVersion', 'publishedVersion', 'createdById', 'publishedAt', 'lastRunAt', 'createdAt', 'updatedAt'],
  version: ['version', 'graph', 'settings', 'digest', 'valid', 'validation', 'changeNote', 'restoredFromVersion', 'createdById', 'createdAt', 'isCurrent', 'isPublished'],
  run: ['id', 'workflowId', 'workflowVersion', 'status', 'trigger', 'initiatorUserId', 'initiatorApiKeyId', 'classification', 'integrity', 'maxSteps', 'stepsScheduled', 'maxTokens', 'tokensUsed', 'toolCalls', 'errorCode', 'errorStepId', 'createdAt', 'startedAt', 'completedAt', 'deadlineAt'],
  step: ['id', 'nodeId', 'nodeType', 'iteration', 'status', 'handles', 'predecessors', 'attempt', 'maxAttempts', 'classification', 'integrity', 'agentId', 'agentVersion', 'toolId', 'toolVersion', 'model', 'promptTokens', 'completionTokens', 'toolCalls', 'errorCode', 'failureClass', 'deadLettered', 'approval', 'inputBytes', 'outputBytes', 'startedAt', 'completedAt', 'durationMs', 'createdAt'],
  approvalItem: ['runId', 'stepId', 'workflowId', 'nodeId', 'requestedAt', 'expiresAt', 'initiatorUserId', 'classification', 'message', 'canDecide'],
  deadLetter: ['runId', 'stepId', 'workflowId', 'workflowVersion', 'nodeId', 'nodeType', 'iteration', 'attempts', 'errorCode', 'failureClass', 'deadLetteredAt', 'runStatus'],
  trace: ['runId', 'complete', 'problems', 'trace'],
  auditLog: ['id', 'sequence', 'action', 'status', 'severity', 'actorType', 'actorId', 'actorLabel', 'resourceType', 'resourceId', 'resourceLabel', 'ipAddress', 'userAgent', 'requestId', 'httpMethod', 'httpPath', 'httpStatus', 'durationMs', 'errorCode', 'errorMessage', 'metadata', 'createdAt'],
  auditStats: ['totalRecords', 'headSequence', 'bySeverity', 'byStatus', 'topActions'],
  overview: ['from', 'to', 'inference', 'activity', 'workflows', 'tools', 'knowledge', 'privacy', 'governance', 'security'],
  wfAnalytics: ['runs', 'completed', 'failed', 'cancelled', 'timedOut', 'active', 'durationP50Ms', 'durationP95Ms', 'tokens', 'deadLetters'],
  toolAnalytics: ['calls', 'succeeded', 'failed', 'timedOut', 'denied', 'denialsByReason'],
  governance: ['throttledCalls', 'budgetExhaustions', 'rateLimitEvents', 'circuitBreaks', 'openCircuits', 'budgetsNearLimit'],
  timeseries: ['metric', 'interval', 'from', 'to', 'points'],
  topEntry: ['key', 'label', 'invocations', 'tokens', 'throttled'],
  securityEvent: ['id', 'at', 'action', 'severity', 'status', 'actorType', 'actorLabel', 'resourceType', 'resourceId', 'errorCode', 'ipAddress', 'requestId'],
  quota: ['id', 'scope', 'subjectId', 'period', 'tokenLimit', 'enforcement', 'alertThreshold', 'managedBy', 'label', 'usage', 'rate'],
  quotaUsage: ['used', 'reserved', 'remaining', 'percent', 'periodStart', 'resetsAt'],
  quotaHistory: ['periodStart', 'tokensUsed', 'requests', 'rejected', 'alertedAt', 'exhaustedAt'],
  ready: ['organizationId', 'rooms', 'expiresAt', 'serverTime'],
  event: ['id', 'type', 'organizationId', 'at', 'data'],
  personalExport: ['format', 'generatedAt', 'notice', 'account', 'memberships', 'devices', 'conversations', 'workflowRuns', 'apiKeys', 'usage', 'activity', 'truncated'],
  erasure: ['erased', 'workspacesDeleted', 'conversationsShredded', 'workflowRunsShredded', 'apiKeysRevoked', 'membershipsEnded'],
};

// ── Graphs ──────────────────────────────────────────────────────────────────

const node = (id, type, data = {}, x = 0) => ({ id, type, position: { x, y: 0 }, data });
const edge = (id, source, target, sourceHandle, data) => ({ id, source, target, ...(sourceHandle ? { sourceHandle } : {}), ...(data ? { data } : {}) });
const graph = (nodes, edges) => ({ schemaVersion: 1, nodes, edges, viewport: { x: 0, y: 0, zoom: 1 } });

const PERSONAS = [
  ['owner', 'Owner'],
  ['admin', 'Admin'],
  ['member', 'Member'],
  ['viewer', 'Viewer'],
  ['outsider', 'Outsider'],
  ['eraser', 'Eraser'],
];

async function main() {
  // ── Readiness ─────────────────────────────────────────────────────────────
  await call('liveness', 'GET', '/health/live');
  await call('readiness', 'GET', '/health/ready');
  const health = await call('P5-OPS health detail (public)', 'GET', '/health');
  const info = health.data?.details ?? health.data?.info ?? {};
  facts.dependencies = Object.fromEntries(Object.entries(info).map(([name, value]) => [name, value.status]));
  samples.healthRealtime = info.realtime;
  samples.healthWorkflowEngine = info.workflow_engine;
  for (const dependency of ['llm', 'ai_service', 'pii_detector', 'realtime', 'workflow_engine']) {
    if (info[dependency]?.status !== 'up') throw new Error(`Dependency not ready: ${dependency}=${info[dependency]?.status}`);
  }
  // A slow Redis ping reports the queue as degraded while its workers run normally.
  if (info.queue?.status === 'down' || info.queue?.workersEnabled !== true) {
    throw new Error(`Queue workers not running: ${JSON.stringify(info.queue)}`);
  }
  check('P5-OPS health reports the real-time and workflow engines', info.realtime?.eventBus === 'subscribed' && info.workflow_engine?.workersEnabled === true, { realtime: info.realtime, workflow_engine: info.workflow_engine });
  const metricsNoToken = await fetch(`${BASE}/metrics`);
  check('P5-OPS /metrics refuses a request without the operator token', metricsNoToken.status === 401, metricsNoToken.status);
  if (process.env.METRICS_TOKEN) {
    const metrics = await fetch(`${BASE}/metrics`, { headers: { Authorization: `Bearer ${process.env.METRICS_TOKEN}` } });
    const text = await metrics.text();
    check('P5-OPS /metrics serves Prometheus text with the operator token', metrics.status === 200 && /# HELP daiap_/.test(text) && (metrics.headers.get('content-type') || '').includes('text/plain'), { status: metrics.status, type: metrics.headers.get('content-type') });
    facts.metricFamilies = [...new Set([...text.matchAll(/^# TYPE (daiap_[a-z_]+)/gm)].map((match) => match[1]))];
  }

  // ── Accounts and workspaces ──────────────────────────────────────────────
  for (const [name, last] of PERSONAS) {
    const email = `${run}-${name}@example.invalid`;
    const password = `V9!${crypto.randomBytes(24).toString('base64url')}q@`;
    const res = await call(`register ${name}`, 'POST', '/api/v1/auth/register', { body: { email, password, firstName: 'PhaseFive', lastName: last }, expect: 201 });
    const data = need(res, `register ${name}`);
    actors[name] = { name, email, password, user: data.user, token: data.tokens.accessToken, tokenAt: Date.now(), refreshCookie: readCookie(res.headers) };
  }
  const { owner, admin, member, viewer, outsider, eraser } = actors;

  const W = need(await call('create workspace', 'POST', '/api/v1/organizations', { actor: owner, body: { name: `Phase 5 verification ${run}`, slug: run }, expect: 201 }), 'workspace');
  workspaces.push({ id: W.id, actor: owner });
  const X = need(await call('create second tenant', 'POST', '/api/v1/organizations', { actor: outsider, body: { name: `Isolation ${run}`, slug: `${run}-x` }, expect: 201 }), 'tenant');
  workspaces.push({ id: X.id, actor: outsider });
  const EW = need(await call('eraser creates a workspace of their own', 'POST', '/api/v1/organizations', { actor: eraser, body: { name: `Eraser ${run}`, slug: `${run}-e` }, expect: 201 }), 'eraser workspace');
  const w = W.id;
  const x = X.id;

  const roles = need(await call('roles', 'GET', ws(w, '/roles'), { actor: owner, org: w }), 'roles');
  const role = (slug) => roles.find((entry) => entry.slug === slug);
  const approverRole = need(await call('create custom Flow Approver role (no clearance)', 'POST', ws(w, '/roles'), {
    actor: owner, org: w, expect: 201,
    body: {
      name: `Flow Approver ${run.slice(-6)}`,
      description: 'Approves and supervises runs without clearance (Phase 5 fixture).',
      priority: 30,
      color: '#F59E0B',
      permissionKeys: ['workspace:read', 'workflow:read', 'workflow:read_all', 'workflow:approve'],
    },
  }), 'approver role');
  const invitations = [[admin, role('admin').id], [member, role('member').id], [viewer, role('viewer').id], [eraser, role('member').id]];
  for (const [actor, roleId] of invitations) {
    need(await call(`invite ${actor.name}`, 'POST', ws(w, '/invitations'), { actor: owner, org: w, expect: 201, body: { email: actor.email, roleId, message: 'Phase 5 verification fixture.' } }), `invite ${actor.name}`);
  }
  for (const [actor] of invitations) {
    const token = await invitationToken(actor.email);
    check(`invitation email delivered to ${actor.name} (Ethereal IMAP)`, !!token);
    need(await call(`accept invitation as ${actor.name}`, 'POST', '/api/v1/invitations/accept', { actor, body: { token } }), `accept ${actor.name}`);
  }
  for (const actor of [owner, admin, member, viewer, eraser]) {
    actor.member = need(await call(`membership ${actor.name}`, 'GET', ws(w, '/members/me'), { actor, org: w }), 'me');
    const me = await call(`contextual permissions ${actor.name}`, 'GET', '/api/v1/auth/me', { actor, org: w });
    actor.permissions = me.data?.permissions ?? [];
  }
  facts.permissionCounts = Object.fromEntries([owner, admin, member, viewer].map((a) => [a.name, a.permissions.length]));
  const phase5Keys = (a) => a.permissions.filter((p) => /^(workflow|tool|audit|security|quota|usage):/.test(p)).sort();
  facts.phase5Permissions = Object.fromEntries([owner, admin, member, viewer].map((a) => [a.name, phase5Keys(a)]));

  // Knowledge for labelled runs (Phase 3 endpoints).
  const kb = need(await call('fixture: create Ops Handbook base', 'POST', ws(w, '/knowledge-bases'), { actor: owner, org: w, expect: 201, body: { name: 'Ops Handbook', description: 'Escalation procedures.' } }), 'kb');
  createdBases.push({ id: kb.id, org: w, actor: owner });
  const doc = need(await call('fixture: upload an INTERNAL escalation document', 'POST', ws(w, `/knowledge-bases/${kb.id}/documents`), {
    actor: owner, org: w, expect: 202,
    form: upload('escalation.md', `# Escalation Procedure\n\nReference ${run}.\n\nSevere outages are escalated to the duty manager, Imran Siddiqui, at imran.siddiqui@acme.test. Escalations must be acknowledged within 15 minutes and resolved within 4 hours.\n`, { classification: 'INTERNAL' }),
  }), 'doc');
  check('fixture: escalation document READY', await waitForDocuments(owner, w, [doc.id]));

  // Agents (Phase 4 endpoints).
  const summarizer = need(await call('fixture: create the Workflow Summarizer agent', 'POST', ws(w, '/agents'), {
    actor: admin, org: w, expect: 201,
    body: { name: 'Workflow Summarizer', persona: { role: 'a concise writing assistant', tone: 'concise' }, parameters: { temperature: 0, maxOutputTokens: 80 }, retrieval: { enabled: false }, memory: { maxMessages: 0 }, grounding: 'BALANCED', citations: false, instructions: 'Answer in at most two short sentences. Never ask questions back.' },
  }), 'summarizer');
  await call('fixture: publish the summarizer', 'POST', ws(w, `/agents/${summarizer.id}/publish`), { actor: admin, org: w });
  const classifier = need(await call('fixture: create the Sentiment Classifier agent', 'POST', ws(w, '/agents'), {
    actor: admin, org: w, expect: 201,
    body: { name: 'Sentiment Classifier', parameters: { temperature: 0, maxOutputTokens: 60 }, retrieval: { enabled: false }, memory: { maxMessages: 0 }, grounding: 'BALANCED', citations: false, instructions: 'Classify the sentiment of the text you are given.' },
  }), 'classifier');
  await call('fixture: publish the classifier', 'POST', ws(w, `/agents/${classifier.id}/publish`), { actor: admin, org: w });
  const probe = need(await call('fixture: create the Circuit Probe agent', 'POST', ws(w, '/agents'), {
    actor: admin, org: w, expect: 201,
    body: { name: 'Circuit Probe', parameters: { temperature: 0, maxOutputTokens: 16 }, retrieval: { enabled: false }, memory: { maxMessages: 0 }, grounding: 'BALANCED', citations: false, instructions: 'Reply with the single word OK.' },
  }), 'probe');
  await call('fixture: publish the circuit probe', 'POST', ws(w, `/agents/${probe.id}/publish`), { actor: admin, org: w });

  // API keys (Phase 2 endpoint).
  const runnerKey = need(await call('fixture: issue a workflow API key', 'POST', ws(w, '/api-keys'), { actor: owner, org: w, expect: 201, body: { name: `Runner ${run.slice(-6)}`, scopes: ['workflow:read', 'workflow:execute', 'tool:execute'] } }), 'runner key');
  const bareKey = need(await call('fixture: issue a key that may run workflows but not tools', 'POST', ws(w, '/api-keys'), { actor: owner, org: w, expect: 201, body: { name: `Bare ${run.slice(-6)}`, scopes: ['workflow:read', 'workflow:execute'] } }), 'bare key');
  apiKeys.push({ id: bareKey.apiKey.id, org: w });
  apiKeys.push({ id: runnerKey.apiKey.id, org: w });
  const runner = runnerKey.plaintextKey;
  const readerKey = need(await call('fixture: issue a key without workflow:read', 'POST', ws(w, '/api-keys'), { actor: owner, org: w, expect: 201, body: { name: `Reader ${run.slice(-6)}`, scopes: ['tool:read', 'usage:read'] } }), 'reader key');
  apiKeys.push({ id: readerKey.apiKey.id, org: w });

  // ── Real-time: handshakes (P5-RT) ────────────────────────────────────────
  const sOwner = await connectActor(owner, w);
  const sAdmin = await connectActor(admin, w);
  const sMember = await connectActor(member, w);
  const sViewer = await connectActor(viewer, w);
  const sOutsider = await connectActor(outsider, x);
  samples.ready = { member: sMember.ready, admin: sAdmin.ready };
  sameKeys('P5-RT ready payload shape', sMember.ready, SHAPE.ready);
  const roomKinds = (handle) => (handle.ready?.rooms ?? []).map((room) => room.replace(/[0-9a-f-]{36}/g, '*')).sort();
  check('P5-RT a Member joins only their own room', JSON.stringify(roomKinds(sMember)) === JSON.stringify(['org:*:user:*']), roomKinds(sMember));
  check('P5-RT an Administrator also joins the runs and approvers rooms', JSON.stringify(roomKinds(sAdmin)) === JSON.stringify(['org:*:approvers', 'org:*:runs', 'org:*:user:*'].sort()), roomKinds(sAdmin));
  check('P5-RT a Viewer joins only their own room', JSON.stringify(roomKinds(sViewer)) === JSON.stringify(['org:*:user:*']), roomKinds(sViewer));
  check('P5-RT ready.expiresAt is the access token expiry (epoch ms)', typeof sMember.ready?.expiresAt === 'number' && sMember.ready.expiresAt > Date.now(), sMember.ready?.expiresAt);
  check('P5-RT ready.organizationId is the resolved workspace id', sMember.ready?.organizationId === w);
  const bySlug = await openSocket('member-by-slug', { token: member.token, organizationId: run });
  check('P5-RT the workspace may be given by slug', bySlug.ready?.organizationId === w, bySlug.refused);
  bySlug.close();
  const refusals = {
    noToken: await openSocket('no-token', { organizationId: w }),
    queryToken: await openSocket('query-token', {}, { query: { token: member.token } }),
    noWorkspace: await openSocket('no-workspace', { token: member.token }),
    foreignWorkspace: await openSocket('foreign-workspace', { token: member.token, organizationId: x }),
    badToken: await openSocket('bad-token', { token: 'not-a-jwt', organizationId: w }),
    badKey: await openSocket('bad-key', { apiKey: 'daiap_not_a_real_key' }),
    badOrigin: await openSocket('bad-origin', { token: member.token, organizationId: w }, { extraHeaders: { Origin: 'https://evil.example' } }),
  };
  samples.socketRefusals = Object.fromEntries(Object.entries(refusals).map(([key, handle]) => [key, handle.refused]));
  check('P5-RT no credential: connect_error AUTH_TOKEN_MISSING', refusals.noToken.refused?.code === 'AUTH_TOKEN_MISSING', refusals.noToken.refused);
  check('P5-RT a token in the URL: connect_error AUTH_SCHEME_NOT_ALLOWED', refusals.queryToken.refused?.code === 'AUTH_SCHEME_NOT_ALLOWED', refusals.queryToken.refused);
  check('P5-RT no workspace: connect_error ORGANIZATION_CONTEXT_REQUIRED', refusals.noWorkspace.refused?.code === 'ORGANIZATION_CONTEXT_REQUIRED', refusals.noWorkspace.refused);
  check('P5-RT a workspace you do not belong to: connect_error ORGANIZATION_NOT_FOUND', refusals.foreignWorkspace.refused?.code === 'ORGANIZATION_NOT_FOUND', refusals.foreignWorkspace.refused);
  check('P5-RT a malformed token: connect_error AUTH_TOKEN_INVALID', refusals.badToken.refused?.code === 'AUTH_TOKEN_INVALID', refusals.badToken.refused);
  check('P5-RT an unknown API key is refused with a code', typeof refusals.badKey.refused?.code === 'string', refusals.badKey.refused);
  check('P5-RT a disallowed browser origin is a bare transport error with no code', refusals.badOrigin.refused !== null && refusals.badOrigin.refused.code === null, refusals.badOrigin.refused);
  const sRunnerKey = await openSocket('runner-key', { apiKey: runner });
  check('P5-RT an API key socket: expiresAt null and its key room', sRunnerKey.ready?.expiresAt === null && (sRunnerKey.ready?.rooms ?? []).some((room) => room.includes(':key:')), sRunnerKey.ready ?? sRunnerKey.refused);
  const sReaderKey = await openSocket('reader-key', { apiKey: readerKey.plaintextKey });

  // ── Tools (P5-API-01–07) ─────────────────────────────────────────────────
  const tools = await call('P5-API-01 list tools as member', 'GET', ws(w, '/tools'), { actor: member, org: w });
  samples.toolList = tools.data;
  const builtins = Object.fromEntries((tools.data ?? []).map((tool) => [tool.name, tool]));
  check('built-in tools: calculator, current_datetime, knowledge_search, send_email', ['calculator', 'current_datetime', 'knowledge_search', 'send_email'].every((name) => builtins[name]?.kind === 'BUILTIN'), Object.keys(builtins));
  sameKeys('built-in tool shape', builtins.calculator, SHAPE.tool);
  check('built-in data policies and required permissions as documented', builtins.send_email?.requiredPermissions?.includes('member:read') && builtins.knowledge_search?.requiredPermissions?.includes('rag:query') && builtins.send_email?.dataPolicy?.sideEffects === true && builtins.calculator?.resultIntegrity === 'TRUSTED', { send_email: builtins.send_email?.dataPolicy, knowledge_search: builtins.knowledge_search?.requiredPermissions });
  await call('P5-API-01 kind=BUILTIN', 'GET', ws(w, '/tools?kind=BUILTIN'), { actor: viewer, org: w });
  const httpOnly = await call('P5-API-01 kind=HTTP before any is defined', 'GET', ws(w, '/tools?kind=HTTP'), { actor: viewer, org: w });
  check('no HTTP tools yet', (httpOnly.data ?? []).length === 0 && httpOnly.meta?.pagination?.totalItems === 0);
  const searchCalc = await call('P5-API-01 search', 'GET', ws(w, '/tools?search=calc'), { actor: viewer, org: w });
  check('search matches the name', (searchCalc.data ?? []).length === 1 && searchCalc.data[0].name === 'calculator');
  await call('P5-API-01 unknown kind', 'GET', ws(w, '/tools?kind=SCRIPT'), { actor: viewer, org: w, expect: 422, code: 'VALIDATION_FAILED' });
  await call('P5-API-01 limit above 100', 'GET', ws(w, '/tools?limit=101'), { actor: viewer, org: w, expect: 422, code: 'VALIDATION_FAILED' });
  await call('P5-API-01 non-member', 'GET', ws(w, '/tools'), { actor: outsider, org: w, expect: 404, code: 'ORGANIZATION_NOT_FOUND' });
  await call('P5-API-01 an API key with tool:read', 'GET', ws(w, '/tools'), { apiKey: readerKey.plaintextKey });

  await call('P5-API-04 read a built-in by id', 'GET', ws(w, `/tools/${builtins.calculator.id}`), { actor: viewer, org: w });
  await call('P5-API-04 unknown tool', 'GET', ws(w, `/tools/${crypto.randomUUID()}`), { actor: viewer, org: w, expect: 404, code: 'TOOL_NOT_FOUND' });
  await call('P5-API-04 malformed id is not found', 'GET', ws(w, '/tools/abc'), { actor: viewer, org: w, expect: 404, code: 'TOOL_NOT_FOUND' });

  // Built-in tests.
  const calcTest = await call('P5-API-07 test calculator', 'POST', ws(w, `/tools/${builtins.calculator.id}/test`), { actor: admin, org: w, body: { arguments: { expression: '(2 + 3) * 7' } } });
  sameKeys('test result shape (ok)', calcTest.data, SHAPE.testOk);
  check('calculator answers 35', calcTest.data?.status === 'ok' && String(calcTest.data?.content).trim() === '35', calcTest.data);
  const calcBad = await call('P5-API-07 test with arguments that break the schema', 'POST', ws(w, `/tools/${builtins.calculator.id}/test`), { actor: admin, org: w, body: { arguments: { wrong: 1 } } });
  sameKeys('test result shape (refused)', calcBad.data, SHAPE.testRefused);
  check('schema violations are a denial, not an HTTP error', calcBad.status === 200 && calcBad.data?.status === 'denied' && calcBad.data?.code === 'TOOL_ARGUMENTS_INVALID', calcBad.data);
  const clock = await call('P5-API-07 test current_datetime', 'POST', ws(w, `/tools/${builtins.current_datetime.id}/test`), { actor: admin, org: w, body: { arguments: { timezone: 'Asia/Karachi' } } });
  check('current_datetime answers', clock.data?.status === 'ok', clock.data);
  const kbSearch = await call('P5-API-07 test knowledge_search', 'POST', ws(w, `/tools/${builtins.knowledge_search.id}/test`), { actor: admin, org: w, body: { arguments: { query: 'How quickly must escalations be acknowledged?' } } });
  check('knowledge_search returns workspace passages to a cleared tester', kbSearch.data?.status === 'ok' && /15 minutes/.test(kbSearch.data?.content ?? ''), { status: kbSearch.data?.status, bytes: (kbSearch.data?.content ?? '').length });
  const unverified = await call('P5-API-07 send_email to a member whose email is not verified', 'POST', ws(w, `/tools/${builtins.send_email.id}/test`), { actor: owner, org: w, body: { arguments: { to: viewer.email, subject: 'x', body: 'y' } } });
  check('send_email only reaches ACTIVE (email-verified) members: an unverified one is denied like a stranger', unverified.data?.status === 'denied' && unverified.data?.code === 'TOOL_INFORMATION_FLOW_BLOCKED', unverified.data);
  const verifyToken = await mailToken(member.email, 'Confirm your email', /verify-email\?token=([A-Za-z0-9%_.~-]+)/);
  await call('fixture: the member verifies their email (Phase 1)', 'POST', '/api/v1/auth/verify-email', { body: { token: verifyToken } });
  const mailTest = await call('P5-API-07 test send_email to a member', 'POST', ws(w, `/tools/${builtins.send_email.id}/test`), { actor: owner, org: w, body: { arguments: { to: member.email, subject: `Phase 5 tool test ${run}`, body: 'This is a synthetic message from the Phase 5 verification.' } } });
  check('send_email delivered', mailTest.data?.status === 'ok', mailTest.data);
  check('the recipient receives a live notification (agent_email), never the subject or body', await until(() => sMember.notifications.some((n) => n.data?.kind === 'agent_email'), 15_000), sMember.notifications.map((n) => n.data));
  samples.emailNotification = sMember.notifications.find((n) => n.data?.kind === 'agent_email');
  check('the email notification carries metadata only', samples.emailNotification && !JSON.stringify(samples.emailNotification).includes('synthetic message') && samples.emailNotification.data.agentId === null && typeof samples.emailNotification.data.subjectLength === 'number');
  check('the email reached the inbox (Ethereal)', await mailArrived(member.email, `Phase 5 tool test ${run}`));
  const mailOutside = await call('P5-API-07 send_email to a non-member', 'POST', ws(w, `/tools/${builtins.send_email.id}/test`), { actor: owner, org: w, body: { arguments: { to: 'stranger@example.invalid', subject: 'x', body: 'y' } } });
  check('emails only go to members (denied, RECIPIENT)', mailOutside.data?.status === 'denied' && mailOutside.data?.code === 'TOOL_INFORMATION_FLOW_BLOCKED', mailOutside.data);
  const unknownTest = await call('P5-API-07 test an unknown tool id', 'POST', ws(w, `/tools/${crypto.randomUUID()}/test`), { actor: admin, org: w, body: { arguments: {} } });
  check('an unknown tool id is a 200 denial TOOL_NOT_GRANTED, not a 404', unknownTest.status === 200 && unknownTest.data?.status === 'denied' && unknownTest.data?.code === 'TOOL_NOT_GRANTED', unknownTest.data);
  await call('P5-API-07 member lacks tool:update', 'POST', ws(w, `/tools/${builtins.calculator.id}/test`), { actor: member, org: w, body: { arguments: { expression: '1+1' } }, expect: 403, code: 'PERMISSION_DENIED' });
  await call('P5-API-07 arguments must be an object', 'POST', ws(w, `/tools/${builtins.calculator.id}/test`), { actor: admin, org: w, body: { arguments: 'x' }, expect: 422, code: 'VALIDATION_FAILED' });

  // HTTP tools.
  const echoParams = { type: 'object', properties: { q: { type: 'string', minLength: 1, maxLength: 200, description: 'Text to echo.' } }, required: ['q'], additionalProperties: false };
  const echoGetBody = {
    name: 'echo_lookup', displayName: 'Echo lookup', description: 'Echoes a query string back from a public test service.',
    parameters: echoParams,
    http: { method: 'GET', url: `https://${ECHO_HOST}/get`, query: { q: '{{q}}' }, auth: { type: 'none' }, responsePath: '/args' },
  };
  const echoGet = need(await call('P5-API-02 create a GET tool', 'POST', ws(w, '/tools'), { actor: admin, org: w, body: echoGetBody, expect: 201 }), 'echo_lookup');
  samples.httpTool = echoGet;
  sameKeys('HTTP tool shape', echoGet, [...SHAPE.tool, ...SHAPE.httpToolExtra]);
  sameKeys('data policy shape', echoGet.dataPolicy, SHAPE.dataPolicy);
  check('a third-party GET tool defaults to PUBLIC, EXTERNAL, deny, no side effects', JSON.stringify(echoGet.dataPolicy) === JSON.stringify({ maxClassification: 'PUBLIC', minIntegrity: 'EXTERNAL', piiArguments: 'deny', sideEffects: false }) || (echoGet.dataPolicy.maxClassification === 'PUBLIC' && echoGet.dataPolicy.minIntegrity === 'EXTERNAL' && echoGet.dataPolicy.piiArguments === 'deny' && echoGet.dataPolicy.sideEffects === false), echoGet.dataPolicy);
  check('new HTTP tool: version 1, EXTERNAL results, available, no secret, default timeout', echoGet.version === 1 && echoGet.resultIntegrity === 'EXTERNAL' && echoGet.available === true && echoGet.hasSecret === false && echoGet.timeoutMs > 0, { version: echoGet.version, timeoutMs: echoGet.timeoutMs });
  const postParams = { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 500 } }, required: ['text'], additionalProperties: false };
  const echoPost = need(await call('P5-API-02 create an approval-gated POST tool with a credential', 'POST', ws(w, '/tools'), {
    actor: admin, org: w, expect: 201,
    body: { name: 'echo_submit', displayName: 'Echo submit', description: 'Submits text to a public test service, which echoes it back.', parameters: postParams, http: { method: 'POST', url: `https://${ECHO_HOST}/post`, body: { text: '{{text}}' }, auth: { type: 'bearer' }, responsePath: '/json' }, requiresApproval: true, secret: 'p5-synthetic-credential-not-a-secret' },
  }), 'echo_submit');
  check('a POST tool defaults to side effects and INTERNAL integrity; secret write-only', echoPost.dataPolicy.sideEffects === true && echoPost.dataPolicy.minIntegrity === 'INTERNAL' && echoPost.hasSecret === true && !JSON.stringify(echoPost).includes('p5-synthetic'), echoPost.dataPolicy);
  const slow = need(await call('P5-API-02 create a tool with a 1 s timeout', 'POST', ws(w, '/tools'), {
    actor: admin, org: w, expect: 201,
    body: { name: 'slow_status', displayName: 'Slow status', description: 'Waits the given number of seconds before answering.', parameters: { type: 'object', properties: { seconds: { type: 'integer', minimum: 1, maximum: 5 } }, required: ['seconds'], additionalProperties: false }, http: { method: 'GET', url: `https://${STATUS_HOST}/delay/{{seconds}}`, auth: { type: 'none' } }, timeoutMs: 1000 },
  }), 'slow');
  const flaky = need(await call('P5-API-02 create a tool that returns a chosen status', 'POST', ws(w, '/tools'), {
    actor: admin, org: w, expect: 201,
    body: { name: 'status_probe', displayName: 'Status probe', description: 'Returns the HTTP status code it is given.', parameters: { type: 'object', properties: { code: { type: 'integer', minimum: 200, maximum: 599 } }, required: ['code'], additionalProperties: false }, http: { method: 'GET', url: `https://${STATUS_HOST}/status/{{code}}`, auth: { type: 'none' } }, timeoutMs: 15000 },
  }), 'flaky');
  await call('P5-API-02 name taken', 'POST', ws(w, '/tools'), { actor: admin, org: w, body: echoGetBody, expect: 409, code: 'TOOL_NAME_TAKEN' });
  await call('P5-API-02 a built-in name', 'POST', ws(w, '/tools'), { actor: admin, org: w, body: { ...echoGetBody, name: 'calculator' }, expect: 409, code: 'TOOL_NAME_TAKEN' });
  const notAllowed = await call('P5-API-02 host outside the egress allowlist', 'POST', ws(w, '/tools'), { actor: admin, org: w, body: { ...echoGetBody, name: 'blocked_host', http: { ...echoGetBody.http, url: 'https://example.com/get' } }, expect: 422, code: 'TOOL_DEFINITION_INVALID' });
  samples.toolDefinitionInvalid = notAllowed.error;
  check('definition issues are listed with a JSON pointer', (notAllowed.error?.details?.issues ?? []).some((issue) => issue.path === '/http/url'), notAllowed.error?.details);
  const undeclared = await call('P5-API-02 template naming an undeclared parameter', 'POST', ws(w, '/tools'), { actor: admin, org: w, body: { ...echoGetBody, name: 'bad_template', http: { ...echoGetBody.http, query: { q: '{{missing}}' } } }, expect: 422, code: 'TOOL_DEFINITION_INVALID' });
  check('undeclared template reported at /http/query/q', (undeclared.error?.details?.issues ?? []).some((issue) => issue.path === '/http/query/q'));
  await call('P5-API-02 forbidden header', 'POST', ws(w, '/tools'), { actor: admin, org: w, body: { ...echoGetBody, name: 'bad_header', http: { ...echoGetBody.http, headers: { Authorization: 'x' } } }, expect: 422, code: 'TOOL_DEFINITION_INVALID' });
  const pattern = await call('P5-API-02 unsupported schema keyword (pattern)', 'POST', ws(w, '/tools'), { actor: admin, org: w, body: { ...echoGetBody, name: 'bad_schema', parameters: { ...echoParams, properties: { q: { type: 'string', pattern: '^a' } } } }, expect: 422, code: 'TOOL_DEFINITION_INVALID' });
  check('schema issues are reported under /parameters', (pattern.error?.details?.issues ?? []).some((issue) => issue.path.startsWith('/parameters')), pattern.error?.details);
  await call('P5-API-02 plain http://', 'POST', ws(w, '/tools'), { actor: admin, org: w, body: { ...echoGetBody, name: 'insecure_url', http: { ...echoGetBody.http, url: `http://${ECHO_HOST}/get` } }, expect: 422, code: 'TOOL_DEFINITION_INVALID' });
  await call('P5-API-02 template in the host', 'POST', ws(w, '/tools'), { actor: admin, org: w, body: { ...echoGetBody, name: 'templated_host', http: { ...echoGetBody.http, url: 'https://{{q}}.example.com/get' } }, expect: 422, code: 'TOOL_DEFINITION_INVALID' });
  await call('P5-API-02 invalid name', 'POST', ws(w, '/tools'), { actor: admin, org: w, body: { ...echoGetBody, name: 'Bad-Name' }, expect: 422, code: 'VALIDATION_FAILED' });
  const missing = await call('P5-API-02 required fields missing (P5-G01 fix)', 'POST', ws(w, '/tools'), { actor: admin, org: w, body: { name: 'only_a_name' }, expect: 422, code: 'VALIDATION_FAILED' });
  check('missing required fields named', JSON.stringify(fieldsOf(missing)) === JSON.stringify(['description', 'displayName', 'http', 'parameters']), fieldsOf(missing));
  const nullField = await call('P5-API-02 null for a required field (P5-G02 fix)', 'POST', ws(w, '/tools'), { actor: admin, org: w, body: { ...echoGetBody, name: 'null_field', timeoutMs: null }, expect: 422, code: 'VALIDATION_FAILED' });
  check('null named', JSON.stringify(fieldsOf(nullField)) === JSON.stringify(['timeoutMs']), fieldsOf(nullField));
  await call('P5-API-02 member lacks tool:create', 'POST', ws(w, '/tools'), { actor: member, org: w, body: { ...echoGetBody, name: 'member_tool' }, expect: 403, code: 'PERMISSION_DENIED' });
  await call('P5-API-02 API keys cannot define tools', 'POST', ws(w, '/tools'), { apiKey: readerKey.plaintextKey, body: { ...echoGetBody, name: 'key_tool' }, expect: 401, code: 'AUTH_SCHEME_NOT_ALLOWED' });

  const echoOk = await call('P5-API-07 test the GET tool', 'POST', ws(w, `/tools/${echoGet.id}/test`), { actor: admin, org: w, body: { arguments: { q: 'hello phase five' } } });
  samples.httpTest = echoOk.data;
  check('real outbound GET: the response at responsePath', echoOk.data?.status === 'ok' && JSON.parse(echoOk.data.content ?? '{}').q === 'hello phase five', echoOk.data);
  const piiTest = await call('P5-API-07 test with personal data in the arguments', 'POST', ws(w, `/tools/${echoGet.id}/test`), { actor: admin, org: w, body: { arguments: { q: 'Contact imran.siddiqui@acme.test about the outage' } } });
  samples.piiDenial = piiTest.data;
  check('outgoing request with personal data refused (TOOL_PII_BLOCKED)', piiTest.data?.status === 'denied' && piiTest.data?.code === 'TOOL_PII_BLOCKED', piiTest.data);
  const slowTest = await call('P5-API-07 test past the tool timeout', 'POST', ws(w, `/tools/${slow.id}/test`), { actor: admin, org: w, body: { arguments: { seconds: 3 } } });
  check('timeout is an error outcome TOOL_TIMEOUT', slowTest.data?.status === 'error' && slowTest.data?.code === 'TOOL_TIMEOUT', slowTest.data);
  const failTest = await call('P5-API-07 test a failing upstream', 'POST', ws(w, `/tools/${flaky.id}/test`), { actor: admin, org: w, body: { arguments: { code: 500 } } });
  check('upstream 500 is an error outcome TOOL_EXECUTION_FAILED', failTest.data?.status === 'error' && failTest.data?.code === 'TOOL_EXECUTION_FAILED', failTest.data);
  const postTest = await call('P5-API-07 test the approval-gated POST tool', 'POST', ws(w, `/tools/${echoPost.id}/test`), { actor: admin, org: w, body: { arguments: { text: 'quarterly report ready' } } });
  check('a test counts as approved: the POST runs, credential not echoed in the result', postTest.data?.status === 'ok' && JSON.parse(postTest.data.content ?? '{}').text === 'quarterly report ready' && !(postTest.data.content ?? '').includes('p5-synthetic'), postTest.data);

  // Updates.
  const echoV2 = need(await call('P5-API-05 change the description (behaviour)', 'PATCH', ws(w, `/tools/${echoGet.id}`), { actor: admin, org: w, body: { expectedVersion: 1, description: 'Echoes a query string back; used by the Phase 5 checks.' } }), 'echo v2');
  check('a behaviour change bumps the version and digest', echoV2.version === 2 && echoV2.digest !== echoGet.digest, { version: echoV2.version });
  const renamed = need(await call('P5-API-05 change only the display name', 'PATCH', ws(w, `/tools/${echoGet.id}`), { actor: admin, org: w, body: { expectedVersion: 2, displayName: 'Echo lookup (verified)' } }), 'renamed');
  check('display name is not behaviour: version unchanged', renamed.version === 2 && renamed.digest === echoV2.digest);
  const stale = await call('P5-API-05 stale expectedVersion', 'PATCH', ws(w, `/tools/${echoGet.id}`), { actor: admin, org: w, body: { expectedVersion: 1, description: 'Another description entirely.' }, expect: 409, code: 'RESOURCE_CONFLICT' });
  check('conflict details', stale.error?.details?.expectedVersion === 1 && stale.error?.details?.currentVersion === 2, stale.error?.details);
  const disabled = need(await call('P5-API-05 disable', 'PATCH', ws(w, `/tools/${echoGet.id}`), { actor: admin, org: w, body: { enabled: false } }), 'disabled');
  check('disabled, version unchanged', disabled.enabled === false && disabled.version === 2);
  const disabledTest = await call('P5-API-07 test a disabled tool', 'POST', ws(w, `/tools/${echoGet.id}/test`), { actor: admin, org: w, body: { arguments: { q: 'x' } } });
  check('a disabled tool is denied (TOOL_DISABLED)', disabledTest.data?.status === 'denied' && disabledTest.data?.code === 'TOOL_DISABLED', disabledTest.data);
  await call('P5-API-05 enable', 'PATCH', ws(w, `/tools/${echoGet.id}`), { actor: admin, org: w, body: { enabled: true } });
  const loosened = need(await call('P5-API-05 loosen the data policy (audited as a weakening)', 'PATCH', ws(w, `/tools/${echoGet.id}`), { actor: admin, org: w, body: { dataPolicy: { maxClassification: 'INTERNAL' } } }), 'loosened');
  check('only the field sent changes; the version moves', loosened.dataPolicy.maxClassification === 'INTERNAL' && loosened.dataPolicy.piiArguments === 'deny' && loosened.version === 3, loosened.dataPolicy);
  const rotated = need(await call('P5-API-05 replace the credential', 'PATCH', ws(w, `/tools/${echoPost.id}`), { actor: admin, org: w, body: { secret: 'p5-synthetic-credential-rotated' } }), 'rotated');
  check('a new credential bumps the version', rotated.hasSecret === true && rotated.version === echoPost.version + 1);
  const removedSecret = need(await call('P5-API-05 remove the credential with null', 'PATCH', ws(w, `/tools/${echoPost.id}`), { actor: admin, org: w, body: { secret: null } }), 'secret removed');
  check('null removes the credential', removedSecret.hasSecret === false);
  const noCredential = await call('P5-API-07 test a credentialed tool whose credential was removed', 'POST', ws(w, `/tools/${echoPost.id}/test`), { actor: admin, org: w, body: { arguments: { text: 'x' } } });
  check('auth without a credential fails every call: error TOOL_EXECUTION_FAILED', noCredential.data?.status === 'error' && noCredential.data?.code === 'TOOL_EXECUTION_FAILED' && /credential/.test(noCredential.data?.message ?? ''), noCredential.data);
  const restored = need(await call('P5-API-05 set the credential again', 'PATCH', ws(w, `/tools/${echoPost.id}`), { actor: admin, org: w, body: { secret: 'p5-synthetic-credential-restored' } }), 'credential restored');
  check('credential set again', restored.hasSecret === true);
  await call('P5-API-05 built-ins cannot be edited', 'PATCH', ws(w, `/tools/${builtins.calculator.id}`), { actor: admin, org: w, body: { description: 'Changed description text.' }, expect: 409, code: 'TOOL_DEFINITION_INVALID' });
  const patchNull = await call('P5-API-05 null for a field that cannot be cleared (P5-G02 fix)', 'PATCH', ws(w, `/tools/${echoGet.id}`), { actor: admin, org: w, body: { timeoutMs: null, expectedVersion: null }, expect: 422, code: 'VALIDATION_FAILED' });
  check('both named', JSON.stringify(fieldsOf(patchNull)) === JSON.stringify(['expectedVersion', 'timeoutMs']), fieldsOf(patchNull));
  await call('P5-API-05 member lacks tool:update', 'PATCH', ws(w, `/tools/${echoGet.id}`), { actor: member, org: w, body: { displayName: 'Nope' }, expect: 403, code: 'PERMISSION_DENIED' });
  await call('P5-API-05 unknown tool', 'PATCH', ws(w, `/tools/${crypto.randomUUID()}`), { actor: admin, org: w, body: { displayName: 'Nope' }, expect: 404, code: 'TOOL_NOT_FOUND' });

  // Delete.
  const temp = need(await call('P5-API-02 create a disposable tool', 'POST', ws(w, '/tools'), { actor: admin, org: w, expect: 201, body: { ...echoGetBody, name: 'temp_tool', secret: 'p5-synthetic-credential' } }), 'temp');
  await call('P5-API-06 member lacks tool:delete', 'DELETE', ws(w, `/tools/${temp.id}`), { actor: member, org: w, expect: 403, code: 'PERMISSION_DENIED' });
  const deleted = await call('P5-API-06 delete', 'DELETE', ws(w, `/tools/${temp.id}`), { actor: admin, org: w });
  check('delete answers {deleted: true}', deleted.data?.deleted === true);
  await call('P5-API-04 a deleted tool is not found', 'GET', ws(w, `/tools/${temp.id}`), { actor: admin, org: w, expect: 404, code: 'TOOL_NOT_FOUND' });
  await call('P5-API-06 delete again', 'DELETE', ws(w, `/tools/${temp.id}`), { actor: admin, org: w, expect: 404, code: 'TOOL_NOT_FOUND' });
  const deletedTest = await call('P5-API-07 test a deleted tool', 'POST', ws(w, `/tools/${temp.id}/test`), { actor: admin, org: w, body: { arguments: { q: 'x' } } });
  check('a deleted tool is denied TOOL_NOT_GRANTED', deletedTest.data?.code === 'TOOL_NOT_GRANTED', deletedTest.data);
  await call('P5-API-02 a deleted tool’s name is free again', 'POST', ws(w, '/tools'), { actor: admin, org: w, expect: 201, body: { ...echoGetBody, name: 'temp_tool' } }).then(async (res) => {
    if (res.data?.id) await call('P5-API-06 delete the replacement', 'DELETE', ws(w, `/tools/${res.data.id}`), { actor: admin, org: w });
  });
  await call('P5-API-06 built-ins cannot be deleted', 'DELETE', ws(w, `/tools/${builtins.calculator.id}`), { actor: admin, org: w, expect: 404, code: 'TOOL_NOT_FOUND' });

  // The ledger.
  const ledger = await call('P5-API-03 ledger as member (tool:read + usage:read)', 'GET', ws(w, '/tools/executions?limit=100'), { actor: member, org: w });
  samples.ledger = (ledger.data ?? []).slice(0, 3);
  sameKeys('ledger entry shape', ledger.data?.[0], SHAPE.execution);
  const statuses = new Set((ledger.data ?? []).map((row) => row.status));
  check('the ledger records every outcome: SUCCEEDED, DENIED, FAILED, TIMED_OUT', ['SUCCEEDED', 'DENIED', 'FAILED', 'TIMED_OUT'].every((status) => statuses.has(status)), [...statuses]);
  const reasons = new Set((ledger.data ?? []).map((row) => row.denialReason).filter(Boolean));
  check('denial reasons: ARGUMENTS, RECIPIENT, NOT_GRANTED, PII, DISABLED', ['ARGUMENTS', 'RECIPIENT', 'NOT_GRANTED', 'PII', 'DISABLED'].every((reason) => reasons.has(reason)), [...reasons]);
  check('the ledger is content-free (no arguments or results)', !JSON.stringify(ledger.data).includes('hello phase five') && !JSON.stringify(ledger.data).includes('imran'), null);
  check('ledger newest first', (ledger.data ?? []).every((row, i, all) => i === 0 || new Date(all[i - 1].createdAt) >= new Date(row.createdAt)));
  const byTool = await call('P5-API-03 filter by tool', 'GET', ws(w, `/tools/executions?toolId=${echoGet.id}`), { actor: member, org: w });
  check('toolId filter', (byTool.data ?? []).length > 0 && byTool.data.every((row) => row.toolId === echoGet.id));
  const byBuiltin = await call('P5-API-03 filter by a built-in id', 'GET', ws(w, `/tools/executions?toolId=${builtins.calculator.id}`), { actor: member, org: w });
  check('built-in ids filter too', (byBuiltin.data ?? []).length > 0 && byBuiltin.data.every((row) => row.toolName === 'calculator'));
  await call('P5-API-03 malformed toolId (P5-G03 fix)', 'GET', ws(w, '/tools/executions?toolId=abc'), { actor: member, org: w, expect: 422, code: 'VALIDATION_FAILED' });
  await call('P5-API-03 viewer lacks usage:read', 'GET', ws(w, '/tools/executions'), { actor: viewer, org: w, expect: 403, code: 'PERMISSION_DENIED' });

  // ── Workflow definitions (P5-API-08–20) ──────────────────────────────────
  const nodeTypes = need(await call('P5-API-09 node catalogue as viewer', 'GET', ws(w, '/workflows/node-types'), { actor: viewer, org: w }), 'node types');
  samples.nodeTypes = nodeTypes;
  check('eight node types', JSON.stringify((nodeTypes.nodeTypes ?? []).map((t) => t.type)) === JSON.stringify(['trigger', 'agent', 'tool', 'retrieval', 'condition', 'supervisor', 'approval', 'output']), (nodeTypes.nodeTypes ?? []).map((t) => t.type));
  sameKeys('node type descriptor shape', nodeTypes.nodeTypes?.[0], SHAPE.nodeType);
  await call('P5-API-09 non-member', 'GET', ws(w, '/workflows/node-types'), { actor: outsider, org: w, expect: 404, code: 'ORGANIZATION_NOT_FOUND' });

  const calc = builtins.calculator.id;
  const deterministic = graph(
    [
      node('start', 'trigger', { inputSchema: { type: 'object', properties: { amount: { type: 'number', minimum: 0 }, note: { type: 'string', maxLength: 500 } }, required: ['amount'], additionalProperties: false } }),
      node('calc', 'tool', { toolId: calc, arguments: { expression: '{{input.amount}} * 2' } }, 200),
      node('route', 'condition', { rules: [{ id: 'large', value: '{{nodes.calc.output}}', operator: 'gt', operand: 100 }] }, 400),
      node('big', 'output', { value: 'Large: {{nodes.calc.output}}' }, 600),
      node('small', 'output', { value: 'Small: {{nodes.calc.output}}' }, 600),
    ],
    [edge('e1', 'start', 'calc'), edge('e2', 'calc', 'route'), edge('e3', 'route', 'big', 'large'), edge('e4', 'route', 'small', 'else')],
  );
  const valid = need(await call('P5-API-10 validate a valid graph', 'POST', ws(w, '/workflows/validate'), { actor: admin, org: w, body: { graph: deterministic } }), 'valid');
  sameKeys('validation report shape', valid, SHAPE.report);
  check('valid with a step bound', valid.valid === true && valid.errors.length === 0 && typeof valid.stepBound === 'number', valid);
  const invalidCases = [
    ['no trigger', graph([node('out', 'output')], []), 'TRIGGER_MISSING'],
    ['two triggers', graph([node('a', 'trigger'), node('b', 'trigger'), node('out', 'output')], [edge('e1', 'a', 'out'), edge('e2', 'b', 'out')]), 'TRIGGER_MULTIPLE'],
    ['no output', graph([node('start', 'trigger'), node('calc', 'tool', { toolId: calc, arguments: { expression: '1+1' } })], [edge('e1', 'start', 'calc')]), 'OUTPUT_MISSING'],
    ['unknown node type', graph([node('start', 'trigger'), node('x', 'script'), node('out', 'output')], [edge('e1', 'start', 'out')]), 'NODE_TYPE_UNKNOWN'],
    ['a cycle that is not a loop', graph([node('start', 'trigger'), node('a', 'tool', { toolId: calc, arguments: { expression: '1+1' } }), node('b', 'tool', { toolId: calc, arguments: { expression: '1+1' } }), node('out', 'output')], [edge('e1', 'start', 'a'), edge('e2', 'a', 'b'), edge('e3', 'b', 'a'), edge('e4', 'b', 'out')]), 'CYCLE'],
    ['dangling edge', graph([node('start', 'trigger'), node('out', 'output')], [edge('e1', 'start', 'out'), edge('e2', 'start', 'ghost')]), 'EDGE_DANGLING'],
    ['handle the source does not have', graph([node('start', 'trigger'), node('out', 'output')], [edge('e1', 'start', 'out', 'approved')]), 'HANDLE_INVALID'],
    ['unreachable node', graph([node('start', 'trigger'), node('out', 'output'), node('lost', 'output')], [edge('e1', 'start', 'out')]), 'UNREACHABLE'],
    ['reference to a node that has not run', graph([node('start', 'trigger'), node('a', 'output', { value: '{{nodes.b.output}}' }), node('b', 'output')], [edge('e1', 'start', 'a'), edge('e2', 'start', 'b')]), 'REFERENCE_NOT_ANCESTOR'],
    ['template that does not parse', graph([node('start', 'trigger'), node('out', 'output', { value: '{{input.' })], [edge('e1', 'start', 'out')]), 'TEMPLATE_INVALID'],
    ['retrieval into a tool', graph([node('start', 'trigger'), node('find', 'retrieval', { query: '{{input.input}}' }), node('calc', 'tool', { toolId: calc, arguments: { expression: '{{nodes.find.output}}' } }), node('out', 'output')], [edge('e1', 'start', 'find'), edge('e2', 'find', 'calc'), edge('e3', 'calc', 'out')]), 'TYPE_MISMATCH'],
    ['unknown agent', graph([node('start', 'trigger'), node('a', 'agent', { agentId: crypto.randomUUID() }), node('out', 'output')], [edge('e1', 'start', 'a'), edge('e2', 'a', 'out')]), 'REFERENCE_UNKNOWN'],
    ['tool argument missing', graph([node('start', 'trigger'), node('calc', 'tool', { toolId: calc, arguments: {} }), node('out', 'output')], [edge('e1', 'start', 'calc'), edge('e2', 'calc', 'out')]), 'TOOL_ARGUMENT_MISSING'],
    ['numeric comparison with a string operand', graph([node('start', 'trigger'), node('route', 'condition', { rules: [{ id: 'big', value: '{{input.input}}', operator: 'gt', operand: '10' }] }), node('out', 'output')], [edge('e1', 'start', 'route'), edge('e2', 'route', 'out', 'else')]), 'NODE_DATA_INVALID'],
    ['unsupported schema version', { ...graph([node('start', 'trigger'), node('out', 'output')], [edge('e1', 'start', 'out')]), schemaVersion: 2 }, 'GRAPH_VERSION'],
  ];
  const issueSamples = {};
  for (const [name, candidate, codeWanted] of invalidCases) {
    const report = await call(`P5-API-10 invalid: ${name}`, 'POST', ws(w, '/workflows/validate'), { actor: admin, org: w, body: { graph: candidate } });
    const codes = (report.data?.errors ?? []).map((issue) => issue.code);
    issueSamples[codeWanted] = report.data?.errors?.find((issue) => issue.code === codeWanted);
    check(`validation reports ${codeWanted}`, report.data?.valid === false && codes.includes(codeWanted), codes);
  }
  samples.validationIssues = issueSamples;
  check('issues locate the node or edge', ['REFERENCE_NOT_ANCESTOR', 'EDGE_DANGLING', 'HANDLE_INVALID'].every((codeName) => issueSamples[codeName]?.nodeId || issueSamples[codeName]?.edgeId), issueSamples);
  const deadEnd = await call('P5-API-10 a warning: dead end', 'POST', ws(w, '/workflows/validate'), { actor: admin, org: w, body: { graph: graph([node('start', 'trigger'), node('calc', 'tool', { toolId: calc, arguments: { expression: '1+1' } }), node('out', 'output')], [edge('e1', 'start', 'calc'), edge('e2', 'start', 'out')]) } });
  check('warnings do not invalidate (DEAD_END)', deadEnd.data?.valid === true && (deadEnd.data?.warnings ?? []).some((issue) => issue.code === 'DEAD_END'), deadEnd.data?.warnings);
  await call('P5-API-10 member lacks workflow:create/update', 'POST', ws(w, '/workflows/validate'), { actor: member, org: w, body: { graph: deterministic }, expect: 403, code: 'PERMISSION_DENIED' });
  await call('P5-API-10 graph must be an object', 'POST', ws(w, '/workflows/validate'), { actor: admin, org: w, body: { graph: 'x' }, expect: 422, code: 'VALIDATION_FAILED' });

  const starter = need(await call('P5-API-11 create with a name only', 'POST', ws(w, '/workflows'), { actor: admin, org: w, body: { name: 'Starter Flow' }, expect: 201 }), 'starter');
  samples.starterWorkflow = starter;
  sameKeys('workflow shape', starter, [...SHAPE.summary, 'definition']);
  sameKeys('version shape', starter.definition, SHAPE.version);
  check('a new workflow: DRAFT v1, valid starter graph trigger → output', starter.status === 'DRAFT' && starter.currentVersion === 1 && starter.publishedVersion === null && starter.definition.valid === true && starter.definition.graph.nodes.length === 2, { status: starter.status });
  const D = need(await call('P5-API-11 create the deterministic routing workflow', 'POST', ws(w, '/workflows'), { actor: admin, org: w, body: { name: 'Deterministic Routing', description: 'Doubles an amount and routes it.', graph: deterministic, settings: { maxSteps: 20 } }, expect: 201 }), 'D');
  check('settings stored (lowered ceilings only)', D.definition.settings.maxSteps === 20, D.definition.settings);
  await call('P5-API-11 name taken, ignoring case', 'POST', ws(w, '/workflows'), { actor: admin, org: w, body: { name: 'deterministic routing' }, expect: 409, code: 'WORKFLOW_NAME_TAKEN' });
  const draftInvalid = need(await call('P5-API-11 an invalid graph is saved as a draft', 'POST', ws(w, '/workflows'), { actor: admin, org: w, body: { name: 'Broken Draft', graph: invalidCases[0][1] }, expect: 201 }), 'broken');
  check('saved with valid: false and its report', draftInvalid.definition.valid === false && draftInvalid.definition.validation.errors.length > 0);
  const nullSettings = await call('P5-API-11 null settings field (P5-G02 fix)', 'POST', ws(w, '/workflows'), { actor: admin, org: w, body: { name: 'Null Settings', settings: { runTimeoutMs: null } }, expect: 422, code: 'VALIDATION_FAILED' });
  check('settings.runTimeoutMs named', JSON.stringify(fieldsOf(nullSettings)) === JSON.stringify(['settings.runTimeoutMs']), fieldsOf(nullSettings));
  await call('P5-API-11 member lacks workflow:create', 'POST', ws(w, '/workflows'), { actor: member, org: w, body: { name: 'Nope' }, expect: 403, code: 'PERMISSION_DENIED' });
  await call('P5-API-11 API keys cannot create workflows', 'POST', ws(w, '/workflows'), { apiKey: runner, body: { name: 'Nope' }, expect: 401, code: 'AUTH_SCHEME_NOT_ALLOWED' });

  const listAll = await call('P5-API-08 list as viewer', 'GET', ws(w, '/workflows'), { actor: viewer, org: w });
  check('list: three workflows, newest-updated first', listAll.meta?.pagination?.totalItems === 3 && listAll.data?.[0]?.id === draftInvalid.id, (listAll.data ?? []).map((item) => item.name));
  sameKeys('summary shape', listAll.data?.[0], SHAPE.summary);
  const drafts = await call('P5-API-08 status filter', 'GET', ws(w, '/workflows?status=DRAFT'), { actor: viewer, org: w });
  check('status filter', (drafts.data ?? []).every((item) => item.status === 'DRAFT'));
  const searched = await call('P5-API-08 search by name', 'GET', ws(w, '/workflows?search=routing'), { actor: viewer, org: w });
  check('search', (searched.data ?? []).length === 1 && searched.data[0].id === D.id);
  await call('P5-API-08 unknown status', 'GET', ws(w, '/workflows?status=LIVE'), { actor: viewer, org: w, expect: 422, code: 'VALIDATION_FAILED' });
  await call('P5-API-08 an API key with workflow:read', 'GET', ws(w, '/workflows'), { apiKey: runner });

  await call('P5-API-12 read as viewer', 'GET', ws(w, `/workflows/${D.id}`), { actor: viewer, org: w });
  await call('P5-API-12 unknown', 'GET', ws(w, `/workflows/${crypto.randomUUID()}`), { actor: viewer, org: w, expect: 404, code: 'WORKFLOW_NOT_FOUND' });
  await call('P5-API-12 malformed id', 'GET', ws(w, '/workflows/abc'), { actor: viewer, org: w, expect: 400, code: 'BAD_REQUEST' });

  const renamedWf = need(await call('P5-API-13 rename', 'PATCH', ws(w, `/workflows/${starter.id}`), { actor: admin, org: w, body: { name: 'Starter Flow (renamed)', description: 'Temporary.' } }), 'renamed wf');
  check('rename keeps the version', renamedWf.currentVersion === 1 && renamedWf.name === 'Starter Flow (renamed)');
  const cleared = need(await call('P5-API-13 description null clears it', 'PATCH', ws(w, `/workflows/${starter.id}`), { actor: admin, org: w, body: { description: null } }), 'cleared');
  check('description cleared', cleared.description === null);
  await call('P5-API-13 empty body is a no-op', 'PATCH', ws(w, `/workflows/${starter.id}`), { actor: admin, org: w, body: {} });
  const nameNull = await call('P5-API-13 name null (P5-G02 fix)', 'PATCH', ws(w, `/workflows/${starter.id}`), { actor: admin, org: w, body: { name: null }, expect: 422, code: 'VALIDATION_FAILED' });
  check('name named', JSON.stringify(fieldsOf(nameNull)) === JSON.stringify(['name']));
  await call('P5-API-13 name taken', 'PATCH', ws(w, `/workflows/${starter.id}`), { actor: admin, org: w, body: { name: 'DETERMINISTIC ROUTING' }, expect: 409, code: 'WORKFLOW_NAME_TAKEN' });
  await call('P5-API-13 member lacks workflow:update', 'PATCH', ws(w, `/workflows/${starter.id}`), { actor: member, org: w, body: { name: 'x' }, expect: 403, code: 'PERMISSION_DENIED' });

  // Versions: save, unchanged, invalid, conflict, unknown properties.
  const same = need(await call('P5-API-14 save the identical graph', 'PUT', ws(w, `/workflows/${D.id}/definition`), { actor: admin, org: w, body: { graph: D.definition.graph, expectedVersion: 1 } }), 'same');
  check('an unchanged definition creates no version', same.currentVersion === 1);
  const moved = JSON.parse(JSON.stringify(D.definition.graph));
  moved.nodes.find((n) => n.id === 'small').data.value = 'Small amount: {{nodes.calc.output}}';
  moved.nodes[0].unknownProperty = 'dropped';
  const D2 = need(await call('P5-API-14 save a change with a note', 'PUT', ws(w, `/workflows/${D.id}/definition`), { actor: admin, org: w, body: { graph: moved, expectedVersion: 1, changeNote: 'Clearer small-amount wording.' } }), 'D2');
  check('a change appends version 2; runs still need a publish', D2.currentVersion === 2 && D2.definition.changeNote === 'Clearer small-amount wording.' && D2.publishedVersion === null);
  check('the server drops properties it does not understand', !JSON.stringify(D2.definition.graph).includes('unknownProperty'));
  const staleSave = await call('P5-API-14 stale expectedVersion', 'PUT', ws(w, `/workflows/${D.id}/definition`), { actor: admin, org: w, body: { graph: deterministic, expectedVersion: 1 }, expect: 409, code: 'WORKFLOW_VERSION_CONFLICT' });
  check('conflict details', staleSave.error?.details?.currentVersion === 2, staleSave.error?.details);
  const D3 = need(await call('P5-API-14 save an invalid graph (draft)', 'PUT', ws(w, `/workflows/${D.id}/definition`), { actor: admin, org: w, body: { graph: invalidCases[5][1], expectedVersion: 2 } }), 'D3');
  check('invalid saves are kept with their report', D3.currentVersion === 3 && D3.definition.valid === false);
  const nullSave = await call('P5-API-14 null fields (P5-G02 fix)', 'PUT', ws(w, `/workflows/${D.id}/definition`), { actor: admin, org: w, body: { graph: deterministic, settings: null, expectedVersion: null }, expect: 422, code: 'VALIDATION_FAILED' });
  check('settings and expectedVersion named', JSON.stringify(fieldsOf(nullSave)) === JSON.stringify(['expectedVersion', 'settings']));
  await call('P5-API-14 member lacks workflow:update', 'PUT', ws(w, `/workflows/${D.id}/definition`), { actor: member, org: w, body: { graph: deterministic }, expect: 403, code: 'PERMISSION_DENIED' });

  const versions = await call('P5-API-15 history', 'GET', ws(w, `/workflows/${D.id}/versions`), { actor: viewer, org: w });
  check('newest first, flags', JSON.stringify((versions.data ?? []).map((v) => v.version)) === JSON.stringify([3, 2, 1]) && versions.data[0].isCurrent && !versions.data[0].valid);
  sameKeys('version entry shape', versions.data?.[0], SHAPE.version);
  await call('P5-API-15 paging', 'GET', ws(w, `/workflows/${D.id}/versions?limit=1&page=2`), { actor: viewer, org: w });
  const v1 = need(await call('P5-API-16 one version', 'GET', ws(w, `/workflows/${D.id}/versions/1`), { actor: viewer, org: w }), 'v1');
  check('version 1 is the original graph', v1.version === 1 && v1.changeNote === 'Created.');
  await call('P5-API-16 unknown version', 'GET', ws(w, `/workflows/${D.id}/versions/99`), { actor: viewer, org: w, expect: 404, code: 'WORKFLOW_VERSION_NOT_FOUND' });
  await call('P5-API-16 non-numeric version', 'GET', ws(w, `/workflows/${D.id}/versions/abc`), { actor: viewer, org: w, expect: 400, code: 'BAD_REQUEST' });

  const publishInvalid = await call('P5-API-18 publish the invalid current version', 'POST', ws(w, `/workflows/${D.id}/publish`), { actor: admin, org: w, body: {}, expect: 422, code: 'WORKFLOW_INVALID' });
  check('publish refusal lists the errors', (publishInvalid.error?.details?.errors ?? []).length > 0);
  await call('P5-API-18 member lacks workflow:publish', 'POST', ws(w, `/workflows/${D.id}/publish`), { actor: member, org: w, body: { version: 2 }, expect: 403, code: 'PERMISSION_DENIED' });
  const D4 = need(await call('P5-API-17 restore version 2', 'POST', ws(w, `/workflows/${D.id}/versions/2/restore`), { actor: admin, org: w, body: { changeNote: 'Back to the working graph.' }, expect: 201 }), 'D4');
  const v4 = need(await call('P5-API-16 the restored copy', 'GET', ws(w, `/workflows/${D.id}/versions/4`), { actor: viewer, org: w }), 'v4');
  check('restore appends a copy with the same digest', D4.currentVersion === 4 && v4.restoredFromVersion === 2 && v4.digest === D2.definition.digest && v4.valid === true);
  await call('P5-API-17 restore the current version', 'POST', ws(w, `/workflows/${D.id}/versions/4/restore`), { actor: admin, org: w, body: {}, expect: 422, code: 'VALIDATION_FAILED' });
  await call('P5-API-17 restore an unknown version', 'POST', ws(w, `/workflows/${D.id}/versions/42/restore`), { actor: admin, org: w, body: {}, expect: 404, code: 'WORKFLOW_VERSION_NOT_FOUND' });
  await call('P5-API-17 member lacks workflow:update', 'POST', ws(w, `/workflows/${D.id}/versions/1/restore`), { actor: member, org: w, body: {}, expect: 403, code: 'PERMISSION_DENIED' });
  const published = need(await call('P5-API-18 publish the current version', 'POST', ws(w, `/workflows/${D.id}/publish`), { actor: admin, org: w, body: {} }), 'published');
  check('ACTIVE, published version 4', published.status === 'ACTIVE' && published.publishedVersion === 4 && published.publishedAt !== null && published.definition.isPublished === true);

  // ── Runs (P5-API-21–32) ──────────────────────────────────────────────────
  const r1 = need(await call('P5-API-21 start a run (member)', 'POST', ws(w, `/workflows/${D.id}/runs`), { actor: member, org: w, body: { input: { amount: 30, note: 'Small order' } }, expect: 202 }), 'r1');
  samples.startedRun = r1;
  sameKeys('run shape', r1, SHAPE.run);
  check('202 RUNNING, MANUAL, pinned to the published version', r1.status === 'RUNNING' && r1.trigger === 'MANUAL' && r1.workflowVersion === 4 && r1.initiatorUserId === member.user.id);
  const sub = await sMember.emit('subscribe', { runId: r1.id, lastEventId: '0-0' });
  samples.subscribeAck = { ...sub, events: (sub.events ?? []).length };
  check('P5-RT subscribe to your own run: ok with replayed events', sub.ok === true && sub.runId === r1.id && typeof sub.replayed === 'number', { ok: sub.ok, replayed: sub.replayed });
  const r1Done = await waitRun('r1', member, w, r1.id);
  traces.deterministicRun = stepSummary(r1Done);
  check('deterministic run COMPLETED; untaken branch SKIPPED', r1Done?.status === 'COMPLETED' && stepOf(r1Done, 'small')?.status === 'SUCCEEDED' && stepOf(r1Done, 'big')?.status === 'SKIPPED' && stepOf(r1Done, 'route')?.handles?.[0] === 'else', stepSummary(r1Done));
  sameKeys('step shape', stepOf(r1Done, 'calc'), SHAPE.step);
  check('steps carry tool id, version and the tool call', stepOf(r1Done, 'calc')?.toolId === calc && stepOf(r1Done, 'calc')?.toolCalls?.length === 1);
  check('predecessors as nodeId#iteration', JSON.stringify(stepOf(r1Done, 'route')?.predecessors) === JSON.stringify(['calc#0']));
  await until(() => eventsOf(sMember, r1.id).some((e) => e.type === 'run.completed'), 15_000);
  const live = [...new Map([...(sub.events ?? []), ...eventsOf(sMember, r1.id)].map((e) => [e.id, e])).values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  traces.deterministicEvents = live.map((e) => ({ id: e.id, type: e.type, nodeId: e.nodeId, data: e.data }));
  sameKeys('P5-RT event shape (step)', live.find((e) => e.type === 'step.completed'), [...SHAPE.event, 'runId', 'workflowId', 'stepId', 'nodeId', 'initiatorUserId'], ['receivedAt']);
  const types = new Set(live.map((e) => e.type));
  check('P5-RT the run produced run.started, step.queued/started/completed/skipped, tool.called, run.completed', ['run.started', 'step.queued', 'step.started', 'step.completed', 'step.skipped', 'tool.called', 'run.completed'].every((t) => types.has(t)), [...types]);
  check('P5-RT run.completed is last and carries status, steps and tokensUsed', live[live.length - 1]?.type === 'run.completed' && live[live.length - 1].data.status === 'COMPLETED' && typeof live[live.length - 1].data.steps === 'number');
  check('P5-RT events are metadata only (no run input or output)', !JSON.stringify(live).includes('Small order') && !JSON.stringify(live).includes('Small amount'));
  check('P5-RT event ids are stream positions, strictly increasing', live.every((e, i) => /^\d+-\d+$/.test(e.id) && (i === 0 || e.id !== live[i - 1].id)));
  facts.queuedBeforeStarted = live.findIndex((e) => e.type === 'step.queued') < live.findIndex((e) => e.type === 'run.started');
  check('P5-RT the Administrator (runs room) got run.* without subscribing, and no step events', eventsOf(sAdmin, r1.id).some((e) => e.type === 'run.completed') && !eventsOf(sAdmin, r1.id).some((e) => e.type.startsWith('step.')), typesOf(eventsOf(sAdmin, r1.id)));
  check('P5-RT the Viewer received nothing for someone else’s run', eventsOf(sViewer, r1.id).length === 0);
  check('P5-RT the other tenant received nothing', sOutsider.events.length === 0);
  const vSub = await sViewer.emit('subscribe', { runId: r1.id });
  check('P5-RT subscribing to someone else’s run without read_all: WORKFLOW_RUN_NOT_FOUND', vSub.ok === false && vSub.code === 'WORKFLOW_RUN_NOT_FOUND', vSub);
  const xSub = await sOutsider.emit('subscribe', { runId: r1.id });
  check('P5-RT another workspace’s run: the same answer', xSub.ok === false && xSub.code === 'WORKFLOW_RUN_NOT_FOUND', xSub);
  check('P5-RT malformed runId: VALIDATION_FAILED', (await sMember.emit('subscribe', { runId: 'abc' })).code === 'VALIDATION_FAILED');
  check('P5-RT unknown run: WORKFLOW_RUN_NOT_FOUND', (await sMember.emit('subscribe', { runId: crypto.randomUUID() })).code === 'WORKFLOW_RUN_NOT_FOUND');
  check('P5-RT a key without workflow:read cannot watch runs: PERMISSION_DENIED', (await sReaderKey.emit('subscribe', { runId: r1.id })).code === 'PERMISSION_DENIED');
  const firstId = live[0]?.id;
  const resumed = await sMember.emit('resume', { lastEventId: firstId });
  check('P5-RT resume replays what came after lastEventId, for the rooms you are in', resumed.ok === true && resumed.replayed >= 1 && resumed.events.every((e) => e.id > firstId), { replayed: resumed.replayed });
  const badResume = await sMember.emit('resume', { lastEventId: 'yesterday' });
  check('P5-RT a malformed lastEventId replays nothing (no error)', badResume.ok === true && badResume.replayed === 0);
  check('P5-RT unsubscribe', (await sMember.emit('unsubscribe', { runId: r1.id })).ok === true);

  const r1Content = need(await call('P5-API-24 own run content', 'GET', ws(w, `/workflow-runs/${r1.id}/content`), { actor: member, org: w }), 'r1 content');
  samples.runContent = r1Content;
  check('own content VISIBLE: input and the output of the branch that ran', r1Content.contentState === 'VISIBLE' && r1Content.input.amount === 30 && JSON.stringify(r1Content.output) === JSON.stringify({ small: 'Small amount: 60' }), r1Content);
  const calcStep = stepOf(r1Done, 'calc');
  const stepContent = need(await call('P5-API-25 a step’s content', 'GET', ws(w, `/workflow-runs/${r1.id}/steps/${calcStep.id}/content`), { actor: member, org: w }), 'step content');
  check('a tool step: its arguments in, the number out', stepContent.output === 60 && JSON.stringify(stepContent.input).includes('30 * 2'), stepContent);
  await call('P5-API-25 unknown step', 'GET', ws(w, `/workflow-runs/${r1.id}/steps/${crypto.randomUUID()}/content`), { actor: member, org: w, expect: 404, code: 'WORKFLOW_STEP_NOT_FOUND' });
  await call('P5-API-25 malformed step id', 'GET', ws(w, `/workflow-runs/${r1.id}/steps/abc/content`), { actor: member, org: w, expect: 400, code: 'BAD_REQUEST' });
  await call('P5-API-24 reveal on your own run needs pii:reveal', 'GET', ws(w, `/workflow-runs/${r1.id}/content?reveal=true`), { actor: member, org: w, expect: 403, code: 'PERMISSION_DENIED' });
  await call('P5-API-23 someone else’s run without read_all', 'GET', ws(w, `/workflow-runs/${r1.id}`), { actor: viewer, org: w, expect: 404, code: 'WORKFLOW_RUN_NOT_FOUND' });
  await call('P5-API-23 supervisor reads it', 'GET', ws(w, `/workflow-runs/${r1.id}`), { actor: admin, org: w });
  await call('P5-API-23 malformed id', 'GET', ws(w, '/workflow-runs/abc'), { actor: member, org: w, expect: 400, code: 'BAD_REQUEST' });

  const r2 = need(await call('P5-API-21 the other branch', 'POST', ws(w, `/workflows/${D.id}/runs`), { actor: member, org: w, body: { input: { amount: 80 } }, expect: 202 }), 'r2');
  const r2Done = await waitRun('r2', member, w, r2.id);
  check('amount 80 routes to "large"', r2Done?.status === 'COMPLETED' && stepOf(r2Done, 'big')?.status === 'SUCCEEDED' && stepOf(r2Done, 'small')?.status === 'SKIPPED');
  const badInput = await call('P5-API-21 input that breaks the trigger schema', 'POST', ws(w, `/workflows/${D.id}/runs`), { actor: member, org: w, body: { input: { amount: 'thirty' } }, expect: 422, code: 'WORKFLOW_INPUT_INVALID' });
  check('input issues listed', (badInput.error?.details?.issues ?? []).length > 0, badInput.error?.details);
  await call('P5-API-21 unknown input field', 'POST', ws(w, `/workflows/${D.id}/runs`), { actor: member, org: w, body: { input: { amount: 1, extra: true } }, expect: 422, code: 'WORKFLOW_INPUT_INVALID' });
  const idemKey = crypto.randomUUID();
  const firstIdem = need(await call('P5-API-21 with an idempotency key', 'POST', ws(w, `/workflows/${D.id}/runs`), { actor: member, org: w, body: { input: { amount: 5 }, idempotencyKey: idemKey }, expect: 202 }), 'idem');
  const repeatIdem = need(await call('P5-API-21 the same key again', 'POST', ws(w, `/workflows/${D.id}/runs`), { actor: member, org: w, body: { input: { amount: 5 }, idempotencyKey: idemKey }, expect: 202 }), 'idem2');
  check('the same key returns the first run, marked duplicate', repeatIdem.id === firstIdem.id && repeatIdem.duplicate === true);
  const crossIdem = await call('P5-API-21 another member reuses the key (P5-G09)', 'POST', ws(w, `/workflows/${D.id}/runs`), { actor: admin, org: w, body: { input: { amount: 5 }, idempotencyKey: idemKey }, expect: 202 });
  check('keys are per workflow, not per person: the first member’s run comes back', crossIdem.data?.id === firstIdem.id && crossIdem.data?.duplicate === true && crossIdem.data?.initiatorUserId === member.user.id, { initiator: crossIdem.data?.initiatorUserId });
  await call('P5-API-21 null version (P5-G02 fix)', 'POST', ws(w, `/workflows/${D.id}/runs`), { actor: member, org: w, body: { input: { amount: 1 }, version: null }, expect: 422, code: 'VALIDATION_FAILED' });
  await call('P5-API-21 a test run of another version needs workflow:update', 'POST', ws(w, `/workflows/${D.id}/runs`), { actor: member, org: w, body: { input: { amount: 1 }, version: 2 }, expect: 403, code: 'PERMISSION_DENIED' });
  const testRun = need(await call('P5-API-21 an editor test-runs version 2', 'POST', ws(w, `/workflows/${D.id}/runs`), { actor: admin, org: w, body: { input: { amount: 1 }, version: 2 }, expect: 202 }), 'test run');
  check('test run pinned to version 2', testRun.workflowVersion === 2);
  await call('P5-API-21 an invalid version cannot run', 'POST', ws(w, `/workflows/${D.id}/runs`), { actor: admin, org: w, body: { input: { amount: 1 }, version: 3 }, expect: 422, code: 'WORKFLOW_INVALID' });
  await call('P5-API-21 a draft cannot run', 'POST', ws(w, `/workflows/${starter.id}/runs`), { actor: member, org: w, body: { input: { input: 'x' } }, expect: 409, code: 'WORKFLOW_NOT_ACTIVE' });
  await call('P5-API-21 viewer lacks workflow:execute', 'POST', ws(w, `/workflows/${D.id}/runs`), { actor: viewer, org: w, body: { input: { amount: 1 } }, expect: 403, code: 'PERMISSION_DENIED' });
  await call('P5-API-21 unknown workflow', 'POST', ws(w, `/workflows/${crypto.randomUUID()}/runs`), { actor: member, org: w, body: { input: { amount: 1 } }, expect: 404, code: 'WORKFLOW_NOT_FOUND' });
  const keyRun = need(await call('P5-API-21 an API key starts a run', 'POST', ws(w, `/workflows/${D.id}/runs`), { apiKey: runner, body: { input: { amount: 7 } }, expect: 202 }), 'key run');
  check('API runs: trigger API, initiated by the key', keyRun.trigger === 'API' && keyRun.initiatorApiKeyId === runnerKey.apiKey.id && keyRun.initiatorUserId === null);
  const keySub = await sRunnerKey.emit('subscribe', { runId: keyRun.id, lastEventId: '0-0' });
  check('P5-RT a key subscribes to its own run', keySub.ok === true, keySub);
  await waitRun('key run', null, w, keyRun.id, undefined, 120_000, { apiKey: runner });
  check('P5-RT the key socket sees its run complete', await until(() => eventsOf(sRunnerKey, keyRun.id).some((e) => e.type === 'run.completed'), 20_000), typesOf(eventsOf(sRunnerKey, keyRun.id)));
  check('P5-RT the key’s run.* events omit initiatorApiKeyId', eventsOf(sRunnerKey, keyRun.id).every((e) => !('initiatorApiKeyId' in e)));
  const bareRun = need(await call('P5-API-21 a key without tool:execute starts a run with a tool step', 'POST', ws(w, `/workflows/${D.id}/runs`), { apiKey: bareKey.plaintextKey, body: { input: { amount: 7 } }, expect: 202 }), 'bare run');
  const bareDone = await waitRun('bare run', null, w, bareRun.id, undefined, 120_000, { apiKey: bareKey.plaintextKey });
  check('a run acts as its initiator: the key lacks tool:execute, so the tool step is denied and the run FAILS', bareDone?.status === 'FAILED' && (stepOf(bareDone, 'calc')?.errorCode === 'PERMISSION_DENIED' || stepOf(bareDone, 'calc')?.toolCalls?.some((c) => c.status === 'denied' && c.reason === 'PERMISSION')), { status: bareDone?.status, calls: stepOf(bareDone, 'calc')?.toolCalls, error: stepOf(bareDone, 'calc')?.errorCode });
  const keyList = await call('P5-API-22 an API key lists its own runs', 'GET', ws(w, '/workflow-runs'), { apiKey: runner });
  check('only the key’s runs', (keyList.data ?? []).length === 1 && keyList.data[0].id === keyRun.id);

  // Archive.
  const archived = need(await call('P5-API-19 archive', 'POST', ws(w, `/workflows/${D.id}/archive`), { actor: admin, org: w }), 'archived');
  check('ARCHIVED', archived.status === 'ARCHIVED');
  await call('P5-API-19 archive again (idempotent)', 'POST', ws(w, `/workflows/${D.id}/archive`), { actor: admin, org: w });
  await call('P5-API-21 an archived workflow cannot run', 'POST', ws(w, `/workflows/${D.id}/runs`), { actor: member, org: w, body: { input: { amount: 1 } }, expect: 409, code: 'WORKFLOW_NOT_ACTIVE' });
  await call('P5-API-21 but an editor can still test-run a version', 'POST', ws(w, `/workflows/${D.id}/runs`), { actor: admin, org: w, body: { input: { amount: 1 }, version: 1 }, expect: 202 });
  await call('P5-API-19 member lacks workflow:publish', 'POST', ws(w, `/workflows/${D.id}/archive`), { actor: member, org: w, expect: 403, code: 'PERMISSION_DENIED' });
  const republished = need(await call('P5-API-18 publishing again un-archives', 'POST', ws(w, `/workflows/${D.id}/publish`), { actor: admin, org: w, body: { version: 2 } }), 'republished');
  check('ACTIVE again, publishing an older version', republished.status === 'ACTIVE' && republished.publishedVersion === 2);

  // Approval workflow.
  const approvalGraph = graph(
    [
      node('start', 'trigger'),
      node('gate', 'approval', { message: 'Approve submitting: {{input.input}}' }, 200),
      node('send', 'tool', { toolId: echoPost.id, arguments: { text: '{{input.input}}' }, retry: { maxAttempts: 1 } }, 400),
      node('done', 'output', { value: '{{nodes.send.output}}' }, 600),
      node('refused', 'output', { value: 'Refused' }, 400),
    ],
    [edge('e1', 'start', 'gate'), edge('e2', 'gate', 'send', 'approved'), edge('e3', 'send', 'done'), edge('e4', 'gate', 'refused', 'rejected')],
  );
  const A = need(await call('P5-API-11 create the approval workflow', 'POST', ws(w, '/workflows'), { actor: admin, org: w, body: { name: 'Approval Gate', graph: approvalGraph }, expect: 201 }), 'A');
  check('an approval-gated tool behind an approval node is valid', A.definition.valid === true, A.definition.validation);
  const ungated = await call('P5-API-10 an approval-gated tool without an approval node', 'POST', ws(w, '/workflows/validate'), { actor: admin, org: w, body: { graph: graph([node('start', 'trigger'), node('send', 'tool', { toolId: echoPost.id, arguments: { text: '{{input.input}}' } }), node('done', 'output')], [edge('e1', 'start', 'send'), edge('e2', 'send', 'done')]) } });
  observe('validation of an approval-gated tool without an approval node', { valid: ungated.data?.valid, errors: ungated.data?.errors, warnings: ungated.data?.warnings });
  await call('P5-API-18 publish the approval workflow', 'POST', ws(w, `/workflows/${A.id}/publish`), { actor: admin, org: w, body: {} });
  const ra = need(await call('P5-API-21 member starts an approval run', 'POST', ws(w, `/workflows/${A.id}/runs`), { actor: member, org: w, body: { input: { input: 'Pay invoice 42 for the Lahore office' } }, expect: 202 }), 'ra');
  const raWaiting = await waitRun('ra waiting', member, w, ra.id, (r) => r.status === 'WAITING_APPROVAL');
  check('the run waits for a person', raWaiting?.status === 'WAITING_APPROVAL' && stepOf(raWaiting, 'gate')?.status === 'WAITING_APPROVAL' && stepOf(raWaiting, 'gate')?.approval?.expiresAt);
  check('P5-RT approvers get approval.requested live', await until(() => eventsOf(sAdmin, ra.id).some((e) => e.type === 'approval.requested'), 15_000), typesOf(eventsOf(sAdmin, ra.id)));
  check('P5-RT the initiator gets run.* but not approval.requested (not an approver)', !eventsOf(sMember, ra.id).some((e) => e.type === 'approval.requested'));
  const queue = need(await call('P5-API-29 the approval queue (admin)', 'GET', ws(w, '/workflow-runs/approvals'), { actor: admin, org: w }), 'queue');
  const item = queue.find((entry) => entry.runId === ra.id);
  samples.approvalItem = item;
  sameKeys('approval item shape', item, SHAPE.approvalItem);
  check('message rendered for a cleared approver; may decide', item?.message === 'Approve submitting: Pay invoice 42 for the Lahore office' && item?.canDecide === true && item?.classification === 'PUBLIC');
  await call('P5-API-29 member lacks workflow:approve', 'GET', ws(w, '/workflow-runs/approvals'), { actor: member, org: w, expect: 403, code: 'PERMISSION_DENIED' });
  await call('P5-API-29 bearer only', 'GET', ws(w, '/workflow-runs/approvals'), { apiKey: runner, expect: 401, code: 'AUTH_SCHEME_NOT_ALLOWED' });
  await call('P5-API-30 member lacks workflow:approve', 'POST', ws(w, `/workflow-runs/${ra.id}/steps/${item?.stepId ?? crypto.randomUUID()}/approval`), { actor: member, org: w, body: { decision: 'approve' }, expect: 403, code: 'PERMISSION_DENIED' });
  await call('P5-API-30 unknown decision', 'POST', ws(w, `/workflow-runs/${ra.id}/steps/${item?.stepId ?? crypto.randomUUID()}/approval`), { actor: admin, org: w, body: { decision: 'maybe' }, expect: 422, code: 'VALIDATION_FAILED' });
  const decided = need(await call('P5-API-30 approve', 'POST', ws(w, `/workflow-runs/${ra.id}/steps/${item?.stepId ?? crypto.randomUUID()}/approval`), { actor: admin, org: w, body: { decision: 'approve', comment: 'Looks right.' } }), 'decided');
  check('the decision answers with the run', decided.id === ra.id);
  const raDone = await waitRun('ra', member, w, ra.id);
  traces.approvalRun = stepSummary(raDone);
  check('approved: the gated POST ran and the run COMPLETED', raDone?.status === 'COMPLETED' && stepOf(raDone, 'send')?.status === 'SUCCEEDED' && stepOf(raDone, 'refused')?.status === 'SKIPPED', stepSummary(raDone));
  check('the step records who decided', stepOf(raDone, 'gate')?.approval?.decision === 'approved' && stepOf(raDone, 'gate')?.approval?.decidedBy === 'person' && stepOf(raDone, 'gate')?.approval?.decidedById === admin.user.id);
  const raOut = need(await call('P5-API-24 the run output', 'GET', ws(w, `/workflow-runs/${ra.id}/content`), { actor: member, org: w }), 'ra out');
  check('output is the echo service’s JSON at responsePath', raOut.output?.done?.text === 'Pay invoice 42 for the Lahore office' || raOut.output?.text === 'Pay invoice 42 for the Lahore office', raOut.output);
  check('P5-RT approval.decided reached the approvers', await until(() => eventsOf(sAdmin, ra.id).some((e) => e.type === 'approval.decided' && e.data.decision === 'approved'), 10_000));
  await call('P5-API-30 decide again', 'POST', ws(w, `/workflow-runs/${ra.id}/steps/${item?.stepId ?? crypto.randomUUID()}/approval`), { actor: admin, org: w, body: { decision: 'reject' }, expect: 409, code: 'WORKFLOW_APPROVAL_NOT_PENDING' });

  const rr = need(await call('P5-API-21 a run to reject', 'POST', ws(w, `/workflows/${A.id}/runs`), { actor: member, org: w, body: { input: { input: 'Buy a yacht' } }, expect: 202 }), 'rr');
  await waitRun('rr waiting', member, w, rr.id, (r) => r.status === 'WAITING_APPROVAL');
  const rrStep = (await call('P5-API-23 find its gate step', 'GET', ws(w, `/workflow-runs/${rr.id}`), { actor: member, org: w })).data;
  await call('P5-API-30 reject with a comment', 'POST', ws(w, `/workflow-runs/${rr.id}/steps/${stepOf(rrStep, 'gate')?.id ?? crypto.randomUUID()}/approval`), { actor: owner, org: w, body: { decision: 'reject', comment: 'Not in budget.' } });
  const rrDone = await waitRun('rr', member, w, rr.id);
  check('rejected: the "rejected" branch ran, the tool did not', rrDone?.status === 'COMPLETED' && stepOf(rrDone, 'refused')?.status === 'SUCCEEDED' && stepOf(rrDone, 'send')?.status === 'SKIPPED', stepSummary(rrDone));

  const selfRun = need(await call('P5-API-21 the admin starts a run', 'POST', ws(w, `/workflows/${A.id}/runs`), { actor: admin, org: w, body: { input: { input: 'Self approval probe' } }, expect: 202 }), 'self');
  await waitRun('self waiting', admin, w, selfRun.id, (r) => r.status === 'WAITING_APPROVAL');
  const selfQueue = need(await call('P5-API-29 the admin sees their own run as not decidable', 'GET', ws(w, '/workflow-runs/approvals'), { actor: admin, org: w }), 'self queue');
  const selfItem = selfQueue.find((entry) => entry.runId === selfRun.id);
  check('canDecide false on your own run', selfItem?.canDecide === false);
  await call('P5-API-30 approving your own run', 'POST', ws(w, `/workflow-runs/${selfRun.id}/steps/${selfItem?.stepId ?? crypto.randomUUID()}/approval`), { actor: admin, org: w, body: { decision: 'approve' }, expect: 403, code: 'WORKFLOW_SELF_APPROVAL_FORBIDDEN' });
  await call('P5-API-27 viewer lacks workflow:execute (checked before the lookup)', 'POST', ws(w, `/workflow-runs/${selfRun.id}/cancel`), { actor: viewer, org: w, expect: 403, code: 'PERMISSION_DENIED' });
  await call('P5-API-27 a member cannot see, so cannot cancel, someone else’s run', 'POST', ws(w, `/workflow-runs/${selfRun.id}/cancel`), { actor: member, org: w, expect: 404, code: 'WORKFLOW_RUN_NOT_FOUND' });
  const cancelled = need(await call('P5-API-27 cancel while waiting', 'POST', ws(w, `/workflow-runs/${selfRun.id}/cancel`), { actor: admin, org: w }), 'cancelled');
  check('CANCELLED at once; the waiting step cancelled too', cancelled.status === 'CANCELLED');
  const cancelledDetail = (await call('P5-API-23 the cancelled run', 'GET', ws(w, `/workflow-runs/${selfRun.id}`), { actor: admin, org: w })).data;
  check('gate step CANCELLED', stepOf(cancelledDetail, 'gate')?.status === 'CANCELLED', stepSummary(cancelledDetail));
  await call('P5-API-27 cancel again', 'POST', ws(w, `/workflow-runs/${selfRun.id}/cancel`), { actor: admin, org: w, expect: 409, code: 'WORKFLOW_RUN_FINISHED' });
  await call('P5-API-28 a cancelled run cannot be resumed', 'POST', ws(w, `/workflow-runs/${selfRun.id}/resume`), { actor: admin, org: w, expect: 409, code: 'WORKFLOW_RUN_NOT_RESUMABLE' });
  await call('P5-API-30 approving a cancelled run', 'POST', ws(w, `/workflow-runs/${selfRun.id}/steps/${selfItem?.stepId ?? crypto.randomUUID()}/approval`), { actor: owner, org: w, body: { decision: 'approve' }, expect: 409, code: 'WORKFLOW_APPROVAL_NOT_PENDING' });
  check('P5-RT run.cancelled published', await until(() => eventsOf(sAdmin, selfRun.id).some((e) => e.type === 'run.cancelled'), 10_000));

  // Personal data in a run: the egress check, supervision masking and reveal.
  const rp = need(await call('P5-API-21 a run whose input holds personal data', 'POST', ws(w, `/workflows/${A.id}/runs`), { actor: member, org: w, body: { input: { input: 'Refund imran.siddiqui@acme.test for invoice 77' } }, expect: 202 }), 'rp');
  await waitRun('rp waiting', member, w, rp.id, (r) => r.status === 'WAITING_APPROVAL');
  const supervisedWaiting = need(await call('P5-API-24 supervisor reads the waiting run', 'GET', ws(w, `/workflow-runs/${rp.id}/content`), { actor: admin, org: w }), 'supervised');
  samples.maskedRunContent = supervisedWaiting;
  check('someone else’s run is MASKED for a supervisor', supervisedWaiting.contentState === 'MASKED' && !JSON.stringify(supervisedWaiting.input).includes('imran.siddiqui') && /\[EMAIL_ADDRESS_\d+\]/.test(JSON.stringify(supervisedWaiting.input)), supervisedWaiting);
  await call('P5-API-24 reveal without pii:reveal', 'GET', ws(w, `/workflow-runs/${rp.id}/content?reveal=true`), { actor: admin, org: w, expect: 403, code: 'PERMISSION_DENIED' });
  const revealed = need(await call('P5-API-24 the owner reveals', 'GET', ws(w, `/workflow-runs/${rp.id}/content?reveal=true`), { actor: owner, org: w }), 'revealed');
  check('revealed: VISIBLE, real values', revealed.contentState === 'VISIBLE' && JSON.stringify(revealed.input).includes('imran.siddiqui@acme.test'));
  const rpQueue = need(await call('P5-API-29 the approval message is masked? (observed)', 'GET', ws(w, '/workflow-runs/approvals'), { actor: admin, org: w }), 'rp queue');
  const rpItem = rpQueue.find((entry) => entry.runId === rp.id);
  samples.piiApprovalMessage = { masked: !String(rpItem?.message).includes('imran.siddiqui'), classification: rpItem?.classification };
  await call('P5-API-30 approve the personal-data run', 'POST', ws(w, `/workflow-runs/${rp.id}/steps/${rpItem?.stepId ?? crypto.randomUUID()}/approval`), { actor: admin, org: w, body: { decision: 'approve' } });
  const rpDone = await waitRun('rp', member, w, rp.id);
  traces.piiRun = stepSummary(rpDone);
  check('the gated POST carrying an email is refused at egress: run FAILED, POLICY, not retried', rpDone?.status === 'FAILED' && stepOf(rpDone, 'send')?.errorCode === 'TOOL_PII_BLOCKED' && stepOf(rpDone, 'send')?.failureClass === 'POLICY' && stepOf(rpDone, 'send')?.attempt === 1, { status: rpDone?.status, step: stepOf(rpDone, 'send') });
  check('dead-lettered metadata', stepOf(rpDone, 'send')?.deadLettered === true && rpDone.errorCode === 'TOOL_PII_BLOCKED' && rpDone.errorStepId === stepOf(rpDone, 'send')?.id);
  check('P5-RT step.failed and run.failed published', await until(() => eventsOf(sMember, rp.id).some((e) => e.type === 'run.failed'), 10_000));

  // Labels: an approval over INTERNAL passages, decided by a role without clearance.
  const labelled = need(await call('P5-API-11 create the labelled approval workflow', 'POST', ws(w, '/workflows'), {
    actor: admin, org: w, expect: 201,
    body: {
      name: 'Escalation Review',
      graph: graph(
        [
          node('start', 'trigger'),
          node('find', 'retrieval', { query: '{{input.input}}', knowledgeBaseIds: [kb.id], topK: 3 }, 200),
          node('review', 'approval', { message: 'Review these passages: {{nodes.find.output}}' }, 400),
          node('out', 'output', { value: '{{nodes.find.output}}' }, 600),
          node('stop', 'output', { value: 'Not reviewed.' }, 600),
        ],
        [edge('e1', 'start', 'find'), edge('e2', 'find', 'review'), edge('e3', 'review', 'out', 'approved'), edge('e4', 'review', 'stop', 'rejected')],
      ),
    },
  }), 'labelled');
  await call('P5-API-18 publish it', 'POST', ws(w, `/workflows/${labelled.id}/publish`), { actor: admin, org: w, body: {} });
  await call('fixture: make the viewer a Flow Approver without clearance (Phase 2 endpoint)', 'PUT', ws(w, `/members/${viewer.member.id}/roles`), { actor: owner, org: w, body: { roleIds: [approverRole.id] } });
  const rl = need(await call('P5-API-21 member starts the labelled run', 'POST', ws(w, `/workflows/${labelled.id}/runs`), { actor: member, org: w, body: { input: { input: 'How fast must severe outages be acknowledged?' } }, expect: 202 }), 'rl');
  const rlWaiting = await waitRun('rl waiting', member, w, rl.id, (r) => r.status === 'WAITING_APPROVAL' || !ACTIVE.has(r.status));
  check('retrieval as the initiator: the run is labelled INTERNAL', rlWaiting?.status === 'WAITING_APPROVAL' && rlWaiting.classification === 'INTERNAL' && stepOf(rlWaiting, 'review')?.classification === 'INTERNAL', { status: rlWaiting?.status, classification: rlWaiting?.classification });
  check('P5-RT rooms follow access: after the role change the viewer is an approver and gets approval.requested', await until(() => eventsOf(sViewer, rl.id).some((e) => e.type === 'approval.requested'), 20_000), typesOf(eventsOf(sViewer, rl.id)));
  const vQueue = need(await call('P5-API-29 the uncleared approver’s queue', 'GET', ws(w, '/workflow-runs/approvals'), { actor: viewer, org: w }), 'v queue');
  const vItem = vQueue.find((entry) => entry.runId === rl.id);
  check('message withheld (null) and canDecide false for an approver without clearance', vItem && vItem.message === null && vItem.canDecide === false && vItem.classification === 'INTERNAL', vItem);
  await call('P5-API-30 an uncleared approver cannot decide', 'POST', ws(w, `/workflow-runs/${rl.id}/steps/${vItem?.stepId ?? crypto.randomUUID()}/approval`), { actor: viewer, org: w, body: { decision: 'approve' }, expect: 403, code: 'FORBIDDEN' });
  const withheld = need(await call('P5-API-24 an uncleared supervisor reads the run', 'GET', ws(w, `/workflow-runs/${rl.id}/content`), { actor: viewer, org: w }), 'withheld');
  check('content WITHHELD for CLEARANCE', withheld.contentState === 'WITHHELD' && withheld.withheldReason === 'CLEARANCE' && withheld.input === null && withheld.classification === 'INTERNAL', withheld);
  const ownLabelled = need(await call('P5-API-25 the initiator reads the retrieval step', 'GET', ws(w, `/workflow-runs/${rl.id}/steps/${stepOf(rlWaiting, 'find').id}/content`), { actor: member, org: w }), 'find content');
  check('retrieval output: passages with title, text, classification, ids, score', Array.isArray(ownLabelled.output) && ownLabelled.output.length > 0 && ['title', 'text', 'classification', 'documentId', 'knowledgeBaseId', 'score'].every((k) => k in ownLabelled.output[0]), ownLabelled.output?.[0] && Object.keys(ownLabelled.output[0]));
  const aQueue = need(await call('P5-API-29 a cleared approver sees the message', 'GET', ws(w, '/workflow-runs/approvals'), { actor: admin, org: w }), 'a queue');
  check('the cleared approver gets the rendered message', /acknowledged within 15 minutes/.test(aQueue.find((entry) => entry.runId === rl.id)?.message ?? ''));
  await call('P5-API-30 the cleared approver approves', 'POST', ws(w, `/workflow-runs/${rl.id}/steps/${vItem?.stepId ?? crypto.randomUUID()}/approval`), { actor: admin, org: w, body: { decision: 'approve' } });
  const rlDone = await waitRun('rl', member, w, rl.id);
  check('labelled run COMPLETED', rlDone?.status === 'COMPLETED');
  await call('fixture: give the viewer their Viewer role back', 'PUT', ws(w, `/members/${viewer.member.id}/roles`), { actor: owner, org: w, body: { roleIds: [role('viewer').id] } });

  // A run's initiator loses workflow:execute while it waits.
  const rv = need(await call('P5-API-21 a run whose initiator will be demoted', 'POST', ws(w, `/workflows/${A.id}/runs`), { actor: member, org: w, body: { input: { input: 'Order printer paper' } }, expect: 202 }), 'rv');
  await waitRun('rv waiting', member, w, rv.id, (r) => r.status === 'WAITING_APPROVAL');
  await call('fixture: demote the member to Viewer (Phase 2 endpoint)', 'PUT', ws(w, `/members/${member.member.id}/roles`), { actor: owner, org: w, body: { roleIds: [role('viewer').id] } });
  const rvGate = stepOf((await call('P5-API-23 read rv', 'GET', ws(w, `/workflow-runs/${rv.id}`), { actor: admin, org: w })).data, 'gate');
  await call('P5-API-30 approve after the demotion', 'POST', ws(w, `/workflow-runs/${rv.id}/steps/${rvGate?.id ?? crypto.randomUUID()}/approval`), { actor: admin, org: w, body: { decision: 'approve' } });
  const rvDone = await waitRun('rv', admin, w, rv.id);
  check('the next step re-checks the initiator: WORKFLOW_PRINCIPAL_REVOKED (POLICY), run FAILED', rvDone?.status === 'FAILED' && rvDone.errorCode === 'WORKFLOW_PRINCIPAL_REVOKED' && stepOf(rvDone, 'send')?.failureClass === 'POLICY', { status: rvDone?.status, error: rvDone?.errorCode, step: stepOf(rvDone, 'send')?.errorCode });
  await call('fixture: restore the member role', 'PUT', ws(w, `/members/${member.member.id}/roles`), { actor: owner, org: w, body: { roleIds: [role('member').id] } });
  await refresh(member);

  // Failure, dead letter, fix, resume; and an error edge.
  const failGraph = graph(
    [node('start', 'trigger', { inputSchema: { type: 'object', properties: { code: { type: 'integer', minimum: 200, maximum: 599 } }, required: ['code'], additionalProperties: false } }), node('call', 'tool', { toolId: flaky.id, arguments: { code: '{{input.code}}' }, retry: { maxAttempts: 1 } }, 200), node('out', 'output', { value: 'Upstream answered.' }, 400)],
    [edge('e1', 'start', 'call'), edge('e2', 'call', 'out')],
  );
  const F = need(await call('P5-API-11 create the failure workflow', 'POST', ws(w, '/workflows'), { actor: admin, org: w, body: { name: 'Upstream Call', graph: failGraph }, expect: 201 }), 'F');
  await call('P5-API-18 publish it', 'POST', ws(w, `/workflows/${F.id}/publish`), { actor: admin, org: w, body: {} });
  const rf = need(await call('P5-API-21 a run whose tool fails', 'POST', ws(w, `/workflows/${F.id}/runs`), { actor: member, org: w, body: { input: { code: 503 } }, expect: 202 }), 'rf');
  const rfFailed = await waitRun('rf', member, w, rf.id);
  check('upstream 503: step FAILED (TRANSIENT, one attempt allowed), run FAILED, dead-lettered', rfFailed?.status === 'FAILED' && stepOf(rfFailed, 'call')?.status === 'FAILED' && stepOf(rfFailed, 'call')?.errorCode === 'TOOL_EXECUTION_FAILED' && stepOf(rfFailed, 'call')?.deadLettered === true, stepOf(rfFailed, 'call'));
  const letters = await call('P5-API-31 dead letters (admin)', 'GET', ws(w, '/workflow-runs/dead-letters'), { actor: admin, org: w });
  samples.deadLetter = letters.data?.find((entry) => entry.runId === rf.id);
  sameKeys('dead letter shape', samples.deadLetter, SHAPE.deadLetter);
  check('dead letters list the PII refusal and the upstream failure, metadata only', (letters.data ?? []).some((entry) => entry.runId === rp.id && entry.errorCode === 'TOOL_PII_BLOCKED') && (letters.data ?? []).some((entry) => entry.runId === rf.id));
  await call('P5-API-31 member lacks workflow:update', 'GET', ws(w, '/workflow-runs/dead-letters'), { actor: member, org: w, expect: 403, code: 'PERMISSION_DENIED' });
  await call('P5-API-05 fix the tool: point it at a working endpoint', 'PATCH', ws(w, `/tools/${flaky.id}`), { actor: admin, org: w, body: { http: { method: 'GET', url: `https://${ECHO_HOST}/get`, query: { code: '{{code}}' }, auth: { type: 'none' } } } });
  await call('P5-API-28 viewer lacks workflow:execute', 'POST', ws(w, `/workflow-runs/${rf.id}/resume`), { actor: viewer, org: w, expect: 403, code: 'PERMISSION_DENIED' });
  const resumedRun = need(await call('P5-API-28 resume the failed run', 'POST', ws(w, `/workflow-runs/${rf.id}/resume`), { actor: member, org: w }), 'resumed');
  check('resume answers RUNNING', resumedRun.status === 'RUNNING');
  const rfDone = await waitRun('rf resumed', member, w, rf.id);
  check('only the failed step re-ran (with the fixed tool): COMPLETED', rfDone?.status === 'COMPLETED' && stepOf(rfDone, 'call')?.status === 'SUCCEEDED' && stepOf(rfDone, 'start')?.attempt === 1, stepSummary(rfDone));
  check('P5-RT run.resumed published with stepsReset', await until(() => eventsOf(sMember, rf.id).some((e) => e.type === 'run.resumed' && e.data.stepsReset === 1), 10_000), typesOf(eventsOf(sMember, rf.id)));
  await call('P5-API-28 a completed run cannot be resumed', 'POST', ws(w, `/workflow-runs/${rf.id}/resume`), { actor: member, org: w, expect: 409, code: 'WORKFLOW_RUN_NOT_RESUMABLE' });
  const errorEdge = need(await call('P5-API-11 create a workflow with an error edge', 'POST', ws(w, '/workflows'), {
    actor: admin, org: w, expect: 201,
    body: { name: 'Fallback Route', graph: graph([node('start', 'trigger'), node('call', 'tool', { toolId: slow.id, arguments: { seconds: 3 }, retry: { maxAttempts: 1 } }, 200), node('out', 'output', { value: 'Fast path.' }, 400), node('fallback', 'output', { value: 'Fell back.' }, 400)], [edge('e1', 'start', 'call'), edge('e2', 'call', 'out'), edge('e3', 'call', 'fallback', 'error')]) },
  }), 'error edge');
  await call('P5-API-18 publish it', 'POST', ws(w, `/workflows/${errorEdge.id}/publish`), { actor: admin, org: w, body: {} });
  const re = need(await call('P5-API-21 a run whose step times out', 'POST', ws(w, `/workflows/${errorEdge.id}/runs`), { actor: member, org: w, body: { input: { input: 'go' } }, expect: 202 }), 're');
  const reDone = await waitRun('re', member, w, re.id);
  check('a failure with an error edge is an outcome: step FAILED [error], fallback ran, run COMPLETED', reDone?.status === 'COMPLETED' && stepOf(reDone, 'call')?.status === 'FAILED' && stepOf(reDone, 'call')?.handles?.[0] === 'error' && stepOf(reDone, 'fallback')?.status === 'SUCCEEDED' && stepOf(reDone, 'out')?.status === 'SKIPPED', stepSummary(reDone));
  observe('timeout failure class on the error-edge step', { errorCode: stepOf(reDone, 'call')?.errorCode, failureClass: stepOf(reDone, 'call')?.failureClass, attempt: stepOf(reDone, 'call')?.attempt });

  // Loops, step ceiling, run deadline.
  const loopGraph = (onExhausted) => graph(
    [node('start', 'trigger', { inputSchema: { type: 'object', properties: { start: { type: 'number' } }, required: ['start'], additionalProperties: false } }), node('inc', 'tool', { toolId: calc, arguments: { expression: '{{input.start}} + 1' } }, 200), node('check', 'condition', { rules: [{ id: 'again', value: '{{nodes.inc.output}}', operator: 'lt', operand: 1000 }] }, 400), node('out', 'output', { value: '{{nodes.inc.output}}' }, 600)],
    [edge('e1', 'start', 'inc'), edge('e2', 'inc', 'check'), edge('loop', 'check', 'inc', 'again', { loop: { maxIterations: 2, onExhausted } }), edge('e3', 'check', 'out', 'else')],
  );
  const L = need(await call('P5-API-11 create a loop (fall_through)', 'POST', ws(w, '/workflows'), { actor: admin, org: w, body: { name: 'Bounded Loop', graph: loopGraph('fall_through') }, expect: 201 }), 'L');
  check('a back edge from a condition rule is a valid loop', L.definition.valid === true, L.definition.validation);
  await call('P5-API-18 publish it', 'POST', ws(w, `/workflows/${L.id}/publish`), { actor: admin, org: w, body: {} });
  const rlp = need(await call('P5-API-21 run the loop', 'POST', ws(w, `/workflows/${L.id}/runs`), { actor: member, org: w, body: { input: { start: 1 } }, expect: 202 }), 'loop run');
  const rlpDone = await waitRun('loop', member, w, rlp.id);
  traces.loopRun = stepSummary(rlpDone);
  check('the body ran maxIterations + 1 times, then fell through to else', rlpDone?.status === 'COMPLETED' && stepOf(rlpDone, 'inc', 2)?.status === 'SUCCEEDED' && !stepOf(rlpDone, 'inc', 3) && stepOf(rlpDone, 'out')?.status === 'SUCCEEDED', stepSummary(rlpDone));
  const L2 = need(await call('P5-API-11 create a loop that fails when exhausted', 'POST', ws(w, '/workflows'), { actor: admin, org: w, body: { name: 'Strict Loop', graph: loopGraph('fail') }, expect: 201 }), 'L2');
  await call('P5-API-18 publish it', 'POST', ws(w, `/workflows/${L2.id}/publish`), { actor: admin, org: w, body: {} });
  const rlp2 = need(await call('P5-API-21 run it', 'POST', ws(w, `/workflows/${L2.id}/runs`), { actor: member, org: w, body: { input: { start: 1 } }, expect: 202 }), 'loop2');
  const rlp2Done = await waitRun('loop2', member, w, rlp2.id);
  check('onExhausted fail: WORKFLOW_LOOP_EXHAUSTED', rlp2Done?.status === 'FAILED' && rlp2Done.errorCode === 'WORKFLOW_LOOP_EXHAUSTED', { status: rlp2Done?.status, error: rlp2Done?.errorCode });
  const cappedValidate = await call('P5-API-10 a step ceiling below the worst case warns', 'POST', ws(w, '/workflows/validate'), { actor: admin, org: w, body: { graph: loopGraph('fall_through') } });
  observe('loop stepBound', { stepBound: cappedValidate.data?.stepBound });
  const S = need(await call('P5-API-11 create with settings.maxSteps 2', 'POST', ws(w, '/workflows'), { actor: admin, org: w, body: { name: 'Tiny Ceiling', graph: deterministic, settings: { maxSteps: 2 } }, expect: 201 }), 'S');
  await call('P5-API-18 publish it', 'POST', ws(w, `/workflows/${S.id}/publish`), { actor: admin, org: w, body: {} });
  const rs = need(await call('P5-API-21 run past the step ceiling', 'POST', ws(w, `/workflows/${S.id}/runs`), { actor: member, org: w, body: { input: { amount: 1 } }, expect: 202 }), 'rs');
  const rsDone = await waitRun('rs', member, w, rs.id);
  check('WORKFLOW_STEP_LIMIT_EXCEEDED', rsDone?.status === 'FAILED' && rsDone.errorCode === 'WORKFLOW_STEP_LIMIT_EXCEEDED' && rsDone.maxSteps === 2, { status: rsDone?.status, error: rsDone?.errorCode });
  const T = need(await call('P5-API-11 create with a 2 s run timeout', 'POST', ws(w, '/workflows'), { actor: admin, org: w, body: { name: 'Short Deadline', graph: approvalGraph, settings: { runTimeoutMs: 2000 } }, expect: 201 }), 'T');
  await call('P5-API-18 publish it', 'POST', ws(w, `/workflows/${T.id}/publish`), { actor: admin, org: w, body: {} });
  const rt = need(await call('P5-API-21 a run that will pass its deadline waiting', 'POST', ws(w, `/workflows/${T.id}/runs`), { actor: member, org: w, body: { input: { input: 'deadline' } }, expect: 202 }), 'rt');
  const rtDone = await waitRun('rt', member, w, rt.id, (r) => r.status === 'TIMED_OUT', 120_000);
  check('the sweep times the run out: TIMED_OUT, WORKFLOW_TIMEOUT', rtDone?.status === 'TIMED_OUT' && rtDone.errorCode === 'WORKFLOW_TIMEOUT', { status: rtDone?.status });
  const rtResumed = need(await call('P5-API-28 resume a timed-out run', 'POST', ws(w, `/workflow-runs/${rt.id}/resume`), { actor: member, org: w }), 'rt resumed');
  check('resumed with a fresh deadline', rtResumed.status === 'RUNNING' && new Date(rtResumed.deadlineAt) > new Date(Date.now() + 60_000));
  await call('P5-API-27 cancel it (owner of the run)', 'POST', ws(w, `/workflow-runs/${rt.id}/cancel`), { actor: member, org: w });

  // Approval timeout (the sweep decides by the node's policy).
  const timeoutWf = need(await call('P5-API-11 create an approval that approves itself on timeout', 'POST', ws(w, '/workflows'), {
    actor: admin, org: w, expect: 201,
    body: { name: 'Auto Approve', graph: graph([node('start', 'trigger'), node('gate', 'approval', { message: 'Auto: {{input.input}}', timeoutMs: 60000, onTimeout: 'approve' }, 200), node('done', 'output', { value: 'Approved by timeout.' }, 400), node('no', 'output', { value: 'Rejected.' }, 400)], [edge('e1', 'start', 'gate'), edge('e2', 'gate', 'done', 'approved'), edge('e3', 'gate', 'no', 'rejected')]) },
  }), 'timeout wf');
  await call('P5-API-18 publish it', 'POST', ws(w, `/workflows/${timeoutWf.id}/publish`), { actor: admin, org: w, body: {} });
  const rto = need(await call('P5-API-21 start it (decided later)', 'POST', ws(w, `/workflows/${timeoutWf.id}/runs`), { actor: member, org: w, body: { input: { input: 'tick' } }, expect: 202 }), 'rto');

  // Agents in runs (real model calls).
  const G = need(await call('P5-API-11 create an agent workflow', 'POST', ws(w, '/workflows'), {
    actor: admin, org: w, expect: 201,
    body: { name: 'Agent Summary', graph: graph([node('start', 'trigger'), node('write', 'agent', { agentId: summarizer.id, prompt: 'In one sentence, summarise: {{input.input}}', useTools: false }, 200), node('out', 'output', { value: '{{nodes.write.output}}' }, 400)], [edge('e1', 'start', 'write'), edge('e2', 'write', 'out')]) },
  }), 'G');
  await call('P5-API-18 publish it', 'POST', ws(w, `/workflows/${G.id}/publish`), { actor: admin, org: w, body: {} });
  const rg = need(await call('P5-API-21 an agent step (real model call)', 'POST', ws(w, `/workflows/${G.id}/runs`), { actor: member, org: w, body: { input: { input: 'The Lahore office moves to a new building on 1 November; all staff should pack their desks by 30 October.' } }, expect: 202 }), 'rg');
  await sMember.emit('subscribe', { runId: rg.id, lastEventId: '0-0' });
  const rgDone = await waitRun('rg', member, w, rg.id, undefined, 300_000);
  const writeStep = stepOf(rgDone, 'write');
  check('agent step: model, agent version, tokens; run tokensUsed', rgDone?.status === 'COMPLETED' && writeStep?.model && writeStep?.agentId === summarizer.id && writeStep?.agentVersion === 1 && writeStep.promptTokens > 0 && rgDone.tokensUsed > 0, { status: rgDone?.status, model: writeStep?.model, tokens: rgDone?.tokensUsed, error: rgDone?.errorCode });
  const rgOut = need(await call('P5-API-24 the agent’s answer', 'GET', ws(w, `/workflow-runs/${rg.id}/content`), { actor: member, org: w }), 'rg out');
  observe('agent step answer', { chars: String(rgOut.output ?? '').length, sample: String(rgOut.output ?? '').slice(0, 160) });
  check('P5-RT step.completed for the agent carries tokens', await until(() => eventsOf(sMember, rg.id).some((e) => e.type === 'step.completed' && e.nodeId === 'write' && e.data.tokens > 0), 15_000), eventsOf(sMember, rg.id).filter((e) => e.nodeId === 'write').map((e) => ({ type: e.type, data: e.data })));
  const J = need(await call('P5-API-11 create a structured-output workflow', 'POST', ws(w, '/workflows'), {
    actor: admin, org: w, expect: 201,
    body: {
      name: 'Sentiment Router',
      graph: graph(
        [
          node('start', 'trigger'),
          node('classify', 'agent', { agentId: classifier.id, prompt: 'Classify the sentiment of: {{input.input}}', useTools: false, output: { format: 'json', schema: { type: 'object', properties: { sentiment: { type: 'string', enum: ['positive', 'negative', 'neutral'] } }, required: ['sentiment'], additionalProperties: false } } }, 200),
          node('route', 'condition', { rules: [{ id: 'happy', value: '{{nodes.classify.output.sentiment}}', operator: 'equals', operand: 'positive' }] }, 400),
          node('praise', 'output', { value: 'Positive: {{nodes.classify.output.sentiment}}' }, 600),
          node('other', 'output', { value: 'Other: {{nodes.classify.output.sentiment}}' }, 600),
        ],
        [edge('e1', 'start', 'classify'), edge('e2', 'classify', 'route'), edge('e3', 'route', 'praise', 'happy'), edge('e4', 'route', 'other', 'else')],
      ),
    },
  }), 'J');
  check('a path into a JSON output schema validates', J.definition.valid === true, J.definition.validation);
  const typo = await call('P5-API-10 a path the output schema rules out', 'POST', ws(w, '/workflows/validate'), { actor: admin, org: w, body: { graph: { ...J.definition.graph, nodes: J.definition.graph.nodes.map((n) => (n.id === 'praise' ? { ...n, data: { value: '{{nodes.classify.output.mood}}' } } : n)) } } });
  check('TYPE_MISMATCH for a field additionalProperties:false forbids', (typo.data?.errors ?? []).some((issue) => issue.code === 'TYPE_MISMATCH'), typo.data?.errors);
  await call('P5-API-18 publish it', 'POST', ws(w, `/workflows/${J.id}/publish`), { actor: admin, org: w, body: {} });
  const rj = need(await call('P5-API-21 structured output (real model call)', 'POST', ws(w, `/workflows/${J.id}/runs`), { actor: member, org: w, body: { input: { input: 'I absolutely love the new office, thank you so much!' } }, expect: 202 }), 'rj');
  const rjDone = await waitRun('rj', member, w, rj.id, undefined, 300_000);
  const rjOut = (await call('P5-API-24 structured run output', 'GET', ws(w, `/workflow-runs/${rj.id}/content`), { actor: member, org: w })).data;
  observe('structured output routing', { status: rjDone?.status, error: rjDone?.errorCode, output: rjOut?.output, steps: stepSummary(rjDone) });
  check('structured output validated and routed (completed through one of the branches)', rjDone?.status === 'COMPLETED' && (stepOf(rjDone, 'praise')?.status === 'SUCCEEDED' || stepOf(rjDone, 'other')?.status === 'SUCCEEDED'), stepSummary(rjDone));
  const sup = need(await call('P5-API-11 create a supervisor team (round robin)', 'POST', ws(w, '/workflows'), {
    actor: admin, org: w, expect: 201,
    body: {
      name: 'Two-Writer Team',
      graph: graph(
        [node('start', 'trigger'), node('lead', 'supervisor', { strategy: 'round_robin', goal: 'Write two different one-sentence slogans for: {{input.input}}', maxRounds: 2 }, 200), node('w1', 'agent', { agentId: summarizer.id, useTools: false }, 400), node('w2', 'agent', { agentId: classifier.id, useTools: false }, 400), node('out', 'output', { value: '{{nodes.lead.output}}' }, 600)],
        [edge('e1', 'start', 'lead'), edge('e2', 'lead', 'w1', 'worker'), edge('e3', 'lead', 'w2', 'worker'), edge('e4', 'lead', 'out', 'done')],
      ),
    },
  }), 'sup');
  check('a supervisor with two workers is valid', sup.definition.valid === true, sup.definition.validation);
  await call('P5-API-18 publish it', 'POST', ws(w, `/workflows/${sup.id}/publish`), { actor: admin, org: w, body: {} });
  const rsu = need(await call('P5-API-21 supervisor run (real model calls)', 'POST', ws(w, `/workflows/${sup.id}/runs`), { actor: member, org: w, body: { input: { input: 'a reusable water bottle' } }, expect: 202 }), 'rsu');
  const rsuDone = await waitRun('rsu', member, w, rsu.id, undefined, 300_000);
  traces.supervisorRun = stepSummary(rsuDone);
  const workerSteps = (rsuDone?.steps ?? []).filter((st) => st.nodeId === 'w1' || st.nodeId === 'w2');
  check('round robin: each worker ran once per round (its iteration is the round), the supervisor finished with "done", run COMPLETED', rsuDone?.status === 'COMPLETED' && workerSteps.length === 2 && workerSteps.every((st) => st.status === 'SUCCEEDED') && (rsuDone.steps ?? []).some((st) => st.nodeId === 'lead' && st.handles?.[0] === 'done'), stepSummary(rsuDone));

  // Approval decided by timeout (started earlier).
  const rtoDone = await waitRun('rto', member, w, rto.id, (r) => !ACTIVE.has(r.status), 180_000);
  check('the timeout policy decided: approved by "timeout", run COMPLETED', rtoDone?.status === 'COMPLETED' && stepOf(rtoDone, 'gate')?.approval?.decidedBy === 'timeout' && stepOf(rtoDone, 'done')?.status === 'SUCCEEDED', { status: rtoDone?.status, approval: stepOf(rtoDone, 'gate')?.approval });
  check('P5-RT approval.decided by timeout reached the approvers', await until(() => eventsOf(sAdmin, rto.id).some((e) => e.type === 'approval.decided' && e.data.decidedBy === 'timeout'), 10_000));

  // Lists, trace, deletion.
  const mine = await call('P5-API-22 my runs (member)', 'GET', ws(w, '/workflow-runs'), { actor: member, org: w });
  check('scope mine: only runs the member started, newest first', (mine.data ?? []).length > 0 && mine.data.every((r) => r.initiatorUserId === member.user.id) && mine.data.every((r, i, all) => i === 0 || new Date(all[i - 1].createdAt) >= new Date(r.createdAt)));
  await call('P5-API-22 scope=all needs workflow:read_all', 'GET', ws(w, '/workflow-runs?scope=all'), { actor: member, org: w, expect: 403, code: 'PERMISSION_DENIED' });
  const everyone = await call('P5-API-22 scope=all (admin)', 'GET', ws(w, '/workflow-runs?scope=all&limit=100'), { actor: admin, org: w });
  check('everyone’s runs', (everyone.data ?? []).some((r) => r.initiatorUserId === member.user.id) && (everyone.data ?? []).some((r) => r.initiatorApiKeyId));
  const failedOnly = await call('P5-API-22 status filter', 'GET', ws(w, '/workflow-runs?status=FAILED'), { actor: member, org: w });
  check('status filter', (failedOnly.data ?? []).length > 0 && failedOnly.data.every((r) => r.status === 'FAILED'));
  const byWf = await call('P5-API-22 workflow filter', 'GET', ws(w, `/workflow-runs?workflowId=${A.id}`), { actor: member, org: w });
  check('workflowId filter', (byWf.data ?? []).length > 0 && byWf.data.every((r) => r.workflowId === A.id));
  await call('P5-API-22 malformed workflowId (P5-G03 fix)', 'GET', ws(w, '/workflow-runs?workflowId=abc'), { actor: member, org: w, expect: 422, code: 'VALIDATION_FAILED' });
  const trace = need(await call('P5-API-26 trace from the audit log', 'GET', ws(w, `/workflow-runs/${ra.id}/trace`), { actor: admin, org: w }), 'trace');
  samples.trace = trace;
  sameKeys('trace shape', trace, SHAPE.trace);
  check('the trace is complete', trace.complete === true && trace.problems.length === 0, trace.problems);
  await call('P5-API-26 member lacks audit:read', 'GET', ws(w, `/workflow-runs/${ra.id}/trace`), { actor: member, org: w, expect: 403, code: 'PERMISSION_DENIED' });
  await call('P5-API-26 unknown run', 'GET', ws(w, `/workflow-runs/${crypto.randomUUID()}/trace`), { actor: admin, org: w, expect: 404, code: 'WORKFLOW_RUN_NOT_FOUND' });
  const activeRun = need(await call('P5-API-21 a run left waiting', 'POST', ws(w, `/workflows/${A.id}/runs`), { actor: member, org: w, body: { input: { input: 'Will be deleted with its workflow' } }, expect: 202 }), 'active');
  await waitRun('active waiting', member, w, activeRun.id, (r) => r.status === 'WAITING_APPROVAL');
  await call('P5-API-32 an active run cannot be deleted', 'DELETE', ws(w, `/workflow-runs/${activeRun.id}`), { actor: member, org: w, expect: 409, code: 'RESOURCE_CONFLICT' });
  await call('P5-API-32 viewer deleting someone else’s run', 'DELETE', ws(w, `/workflow-runs/${r2.id}`), { actor: viewer, org: w, expect: 404, code: 'WORKFLOW_RUN_NOT_FOUND' });
  const delOwn = await call('P5-API-32 delete your own finished run', 'DELETE', ws(w, `/workflow-runs/${r2.id}`), { actor: member, org: w });
  check('deleted', delOwn.data?.deleted === true);
  await call('P5-API-23 a deleted run is gone', 'GET', ws(w, `/workflow-runs/${r2.id}`), { actor: member, org: w, expect: 404, code: 'WORKFLOW_RUN_NOT_FOUND' });
  await call('P5-API-24 its content is gone', 'GET', ws(w, `/workflow-runs/${r2.id}/content`), { actor: admin, org: w, expect: 404, code: 'WORKFLOW_RUN_NOT_FOUND' });
  const deletedTrace = await call('P5-API-26 the audit trail of a deleted run stays', 'GET', ws(w, `/workflow-runs/${r2.id}/trace`), { actor: admin, org: w });
  check('trace still available after deletion', deletedTrace.status === 200 && deletedTrace.data?.runId === r2.id);
  await call('P5-API-32 supervisor with workflow:delete deletes a member’s run', 'DELETE', ws(w, `/workflow-runs/${rr.id}`), { actor: admin, org: w });
  await call('P5-API-20 member lacks workflow:delete', 'DELETE', ws(w, `/workflows/${A.id}`), { actor: member, org: w, expect: 403, code: 'PERMISSION_DENIED' });
  const delWf = await call('P5-API-20 delete a workflow with a run in progress', 'DELETE', ws(w, `/workflows/${A.id}`), { actor: admin, org: w });
  check('deleted', delWf.data?.deleted === true);
  const afterDelete = await waitRun('active after workflow delete', member, w, activeRun.id, (r) => !ACTIVE.has(r.status), 30_000);
  check('its waiting run was cancelled; run history stays readable', afterDelete?.status === 'CANCELLED');
  await call('P5-API-12 a deleted workflow is gone', 'GET', ws(w, `/workflows/${A.id}`), { actor: admin, org: w, expect: 404, code: 'WORKFLOW_NOT_FOUND' });
  await call('P5-API-20 delete again', 'DELETE', ws(w, `/workflows/${A.id}`), { actor: admin, org: w, expect: 404, code: 'WORKFLOW_NOT_FOUND' });
  const byRun = await call('P5-API-03 ledger filtered by run', 'GET', ws(w, `/tools/executions?runId=${ra.id}`), { actor: admin, org: w });
  check('the gated POST in that run is in the ledger', (byRun.data ?? []).some((row) => row.toolName === 'echo_submit' && row.workflowRunId === ra.id && row.status === 'SUCCEEDED'));

  // ── Quotas and circuits (P5-API-43–51) ───────────────────────────────────
  const quotas = await call('P5-API-43 quotas as member (usage:read)', 'GET', ws(w, '/quotas'), { actor: member, org: w });
  samples.quotas = quotas.data;
  const platform = (quotas.data ?? []).filter((q) => q.managedBy === 'PLATFORM');
  check('platform rows: the monthly allowance and the per-minute rate', platform.some((q) => q.period === 'MONTH' && q.usage) && platform.some((q) => q.period === 'MINUTE' && q.rate), platform.map((q) => `${q.period}:${q.tokenLimit}`));
  sameKeys('quota shape', platform[0], SHAPE.quota);
  sameKeys('quota usage shape', platform.find((q) => q.usage)?.usage, SHAPE.quotaUsage);
  await call('P5-API-43 viewer has neither usage:read nor quota:manage', 'GET', ws(w, '/quotas'), { actor: viewer, org: w, expect: 403, code: 'PERMISSION_DENIED' });
  const mineBefore = await call('P5-API-44 quotas that bind the member', 'GET', ws(w, '/quotas/me'), { actor: member, org: w });
  check('before any member quota: only the workspace’s', (mineBefore.data ?? []).every((q) => q.scope === 'ORGANIZATION'));
  const keyQuotas = await call('P5-API-44 an API key with usage:read', 'GET', ws(w, '/quotas/me'), { apiKey: readerKey.plaintextKey });
  check('a key sees the workspace quotas that bind it', Array.isArray(keyQuotas.data) && keyQuotas.data.length >= 1);
  await call('P5-API-44 a key without usage:read, llm:invoke or agent:execute', 'GET', ws(w, '/quotas/me'), { apiKey: runner, expect: 403, code: 'PERMISSION_DENIED' });
  await call('P5-API-44 viewer', 'GET', ws(w, '/quotas/me'), { actor: viewer, org: w, expect: 403, code: 'PERMISSION_DENIED' });
  const soft = need(await call('P5-API-45 a SOFT daily budget on the member', 'POST', ws(w, '/quotas'), { actor: admin, org: w, expect: 201, body: { scope: 'MEMBER', subjectId: member.user.id, period: 'DAY', tokenLimit: 40, enforcement: 'SOFT', alertThreshold: 50, label: 'Member trial budget' } }), 'soft');
  check('created WORKSPACE-managed; a new budget starts from what the member already spent today (the usage ledger)', soft.managedBy === 'WORKSPACE' && soft.label === 'Member trial budget' && soft.usage?.used > 0 && soft.usage.periodStart && soft.usage.resetsAt, soft.usage);
  await call('P5-API-45 the same scope, subject and period again', 'POST', ws(w, '/quotas'), { actor: admin, org: w, body: { scope: 'MEMBER', subjectId: member.user.id, period: 'DAY', tokenLimit: 500 }, expect: 409, code: 'RESOURCE_CONFLICT' });
  await call('P5-API-45 a subject outside the workspace', 'POST', ws(w, '/quotas'), { actor: admin, org: w, body: { scope: 'MEMBER', subjectId: outsider.user.id, period: 'DAY', tokenLimit: 500 }, expect: 422, code: 'VALIDATION_FAILED' });
  await call('P5-API-45 MEMBER scope without a subject', 'POST', ws(w, '/quotas'), { actor: admin, org: w, body: { scope: 'MEMBER', period: 'DAY', tokenLimit: 500 }, expect: 422, code: 'VALIDATION_FAILED' });
  await call('P5-API-45 tokenLimit 0', 'POST', ws(w, '/quotas'), { actor: admin, org: w, body: { scope: 'ORGANIZATION', period: 'DAY', tokenLimit: 0 }, expect: 422, code: 'VALIDATION_FAILED' });
  await call('P5-API-45 member lacks quota:manage', 'POST', ws(w, '/quotas'), { actor: member, org: w, body: { scope: 'ORGANIZATION', period: 'DAY', tokenLimit: 500 }, expect: 403, code: 'PERMISSION_DENIED' });
  const mineAfter = await call('P5-API-44 now includes the member quota', 'GET', ws(w, '/quotas/me'), { actor: member, org: w });
  check('member quota binds the member', (mineAfter.data ?? []).some((q) => q.id === soft.id));
  const chat = await call('member: a small model call against the SOFT budget (real model call)', 'POST', ws(w, '/llm/chat'), { actor: member, org: w, body: { messages: [{ role: 'user', content: 'Reply with the single word OK.' }], parameters: { maxOutputTokens: 8, temperature: 0 } } });
  check('SOFT lets the call through', chat.status === 200);
  check('P5-RT quota.threshold notified to quota managers and the member', await until(() => sAdmin.notifications.some((n) => n.data?.kind === 'quota.threshold') && sMember.notifications.some((n) => n.data?.kind === 'quota.threshold'), 20_000), { admin: sAdmin.notifications.map((n) => n.data?.kind), member: sMember.notifications.map((n) => n.data?.kind) });
  samples.quotaNotification = sAdmin.notifications.find((n) => n.data?.kind === 'quota.threshold');
  const hard = need(await call('P5-API-46 switch to HARD with a lower limit', 'PATCH', ws(w, `/quotas/${soft.id}`), { actor: admin, org: w, body: { enforcement: 'HARD', tokenLimit: 60 } }), 'hard');
  check('updated', hard.enforcement === 'HARD' && hard.tokenLimit === 60 && hard.usage.used > 0, hard.usage);
  const refusedChat = await call('member: a call the HARD budget refuses', 'POST', ws(w, '/llm/chat'), { actor: member, org: w, body: { messages: [{ role: 'user', content: 'Reply OK.' }], parameters: { maxOutputTokens: 50 } }, expect: 429, code: 'QUOTA_EXCEEDED', flow: false });
  samples.quotaExceeded = { error: refusedChat.error, retryAfter: refusedChat.headers?.get('retry-after') };
  check('QUOTA_EXCEEDED carries Retry-After (seconds to the period reset)', Number(refusedChat.headers?.get('retry-after')) > 0, samples.quotaExceeded);
  const history = await call('P5-API-48 the budget’s periods', 'GET', ws(w, `/quotas/${soft.id}/history`), { actor: member, org: w });
  samples.quotaHistory = history.data;
  sameKeys('history entry shape', history.data?.[0], SHAPE.quotaHistory);
  check('this period: tokens used, a refusal, an alert', history.data?.[0]?.tokensUsed > 0 && history.data[0].rejected >= 1 && history.data[0].alertedAt !== null, history.data?.[0]);
  await call('P5-API-48 periods above 36', 'GET', ws(w, `/quotas/${soft.id}/history?periods=37`), { actor: member, org: w, expect: 422, code: 'VALIDATION_FAILED' });
  await call('P5-API-46 null where it cannot clear (P5-G02 fix)', 'PATCH', ws(w, `/quotas/${soft.id}`), { actor: admin, org: w, body: { tokenLimit: null }, expect: 422, code: 'VALIDATION_FAILED' });
  const labelCleared = need(await call('P5-API-46 null clears the label', 'PATCH', ws(w, `/quotas/${soft.id}`), { actor: admin, org: w, body: { label: null, tokenLimit: 1000000 } }), 'label cleared');
  check('label cleared, limit raised', labelCleared.label === null && labelCleared.tokenLimit === 1_000_000);
  await call('P5-API-46 platform rows cannot be changed', 'PATCH', ws(w, `/quotas/${platform[0].id}`), { actor: admin, org: w, body: { tokenLimit: 5 }, expect: 403, code: 'QUOTA_MANAGED_BY_PLATFORM' });
  await call('P5-API-46 unknown quota', 'PATCH', ws(w, `/quotas/${crypto.randomUUID()}`), { actor: admin, org: w, body: { tokenLimit: 5 }, expect: 404, code: 'QUOTA_NOT_FOUND' });
  await call('P5-API-46 malformed id', 'PATCH', ws(w, '/quotas/abc'), { actor: admin, org: w, body: { tokenLimit: 5 }, expect: 400, code: 'BAD_REQUEST' });
  await call('P5-API-47 platform rows cannot be removed', 'DELETE', ws(w, `/quotas/${platform[0].id}`), { actor: admin, org: w, expect: 403, code: 'QUOTA_MANAGED_BY_PLATFORM' });
  const removedQuota = await call('P5-API-47 remove', 'DELETE', ws(w, `/quotas/${soft.id}`), { actor: admin, org: w });
  check('removed', removedQuota.data?.deleted === true);
  await call('P5-API-47 again', 'DELETE', ws(w, `/quotas/${soft.id}`), { actor: admin, org: w, expect: 404, code: 'QUOTA_NOT_FOUND' });
  await call('P5-API-48 history of a removed quota', 'GET', ws(w, `/quotas/${soft.id}/history`), { actor: admin, org: w, expect: 404, code: 'QUOTA_NOT_FOUND' });
  const rate = need(await call('P5-API-45 a tiny per-minute workspace rate', 'POST', ws(w, '/quotas'), { actor: admin, org: w, expect: 201, body: { scope: 'ORGANIZATION', period: 'MINUTE', tokenLimit: 10, label: 'Rate probe' } }), 'rate');
  check('a MINUTE quota reports rate.available', rate.rate && typeof rate.rate.available === 'number' && rate.usage === null, rate.rate);
  const drain = await call('admin: a call larger than the whole rate, on a full bucket (real model call)', 'POST', ws(w, '/llm/chat'), { actor: admin, org: w, body: { messages: [{ role: 'user', content: 'Reply OK.' }], parameters: { maxOutputTokens: 8 } }, flow: false });
  check('a full bucket admits one call even when it is larger than the rate (and is emptied)', drain.status === 200, drain.error);
  const throttled = await call('admin: the next call within the minute is refused', 'POST', ws(w, '/llm/chat'), { actor: admin, org: w, body: { messages: [{ role: 'user', content: 'Reply OK.' }], parameters: { maxOutputTokens: 8 } }, expect: 429, code: 'TOKEN_RATE_LIMITED', flow: false });
  check('TOKEN_RATE_LIMITED names the workspace rate', throttled.error?.details?.quotaId === rate.id && throttled.error?.details?.tokensPerMinute === 10, throttled.error?.details);
  await call('P5-API-47 remove the rate', 'DELETE', ws(w, `/quotas/${rate.id}`), { actor: admin, org: w });

  const noCircuits = await call('P5-API-49 open circuits (none)', 'GET', ws(w, '/circuits'), { actor: member, org: w });
  check('no open circuits', Array.isArray(noCircuits.data) && noCircuits.data.length === 0);
  const closed = need(await call('P5-API-50 one agent’s breaker', 'GET', ws(w, `/circuits/agents/${probe.id}`), { actor: viewer, org: w }), 'closed');
  check('closed', closed.state === 'closed' && closed.agentId === probe.id);
  const conv = need(await call('fixture: member opens a conversation with the Circuit Probe (Phase 4)', 'POST', ws(w, '/conversations'), { actor: member, org: w, body: { agentId: probe.id }, expect: 201 }), 'conv');
  // Random hex tokenizes densely (~2 tokens per group), so the turn clearly exceeds the window's token ceiling.
  const bulk = (crypto.randomBytes(Math.ceil(CIRCUIT_CHARS / 2)).toString('hex').match(/.{1,4}/g) ?? []).join(' ').slice(0, CIRCUIT_CHARS);
  const big = await call('member: one oversized turn (real model call)', 'POST', ws(w, `/conversations/${conv.id}/messages`), { actor: member, org: w, body: { content: `Reference codes:\n${bulk}\n\nReply with the single word OK.`, parameters: { maxOutputTokens: 8 } } });
  facts.circuitTurnTokens = big.data?.usage;
  check('the oversized turn completed', big.status === 200, big.error);
  check('P5-RT agent.circuit_opened notified to agent and quota managers', await until(() => sAdmin.notifications.some((n) => n.data?.kind === 'agent.circuit_opened'), 20_000), sAdmin.notifications.map((n) => n.data));
  samples.circuitNotification = sAdmin.notifications.find((n) => n.data?.kind === 'agent.circuit_opened');
  const refusedTurn = await call('member: the next turn is refused', 'POST', ws(w, `/conversations/${conv.id}/messages`), { actor: member, org: w, body: { content: 'Reply OK.' }, expect: 503, code: 'AGENT_CIRCUIT_OPEN', flow: false });
  samples.circuitOpen = { error: refusedTurn.error, retryAfter: refusedTurn.headers?.get('retry-after') };
  check('AGENT_CIRCUIT_OPEN: reason, openedAt and Retry-After', refusedTurn.error?.details?.reason === 'RUNAWAY_SPEND' && Number(refusedTurn.headers?.get('retry-after')) > 0, samples.circuitOpen);
  const open = await call('P5-API-49 open circuits', 'GET', ws(w, '/circuits'), { actor: member, org: w });
  samples.openCircuits = open.data;
  check('the probe is listed open with reason and retryAt', (open.data ?? []).some((c) => c.agentId === probe.id && c.state === 'open' && c.reason === 'RUNAWAY_SPEND' && c.retryAt));
  await call('P5-API-50 open state', 'GET', ws(w, `/circuits/agents/${probe.id}`), { actor: member, org: w });
  await call('P5-API-51 member cannot reset', 'DELETE', ws(w, `/circuits/agents/${probe.id}`), { actor: member, org: w, expect: 403, code: 'PERMISSION_DENIED' });
  const reset = need(await call('P5-API-51 reset', 'DELETE', ws(w, `/circuits/agents/${probe.id}`), { actor: admin, org: w }), 'reset');
  check('reset: wasOpen true', reset.reset === true && reset.wasOpen === true);
  const resetAgain = need(await call('P5-API-51 reset again', 'DELETE', ws(w, `/circuits/agents/${probe.id}`), { actor: admin, org: w }), 'reset again');
  check('reset again: wasOpen false', resetAgain.wasOpen === false);
  await call('P5-API-50 unknown agent', 'GET', ws(w, `/circuits/agents/${crypto.randomUUID()}`), { actor: member, org: w, expect: 404, code: 'AGENT_NOT_FOUND' });
  await call('P5-API-50 malformed id', 'GET', ws(w, '/circuits/agents/abc'), { actor: member, org: w, expect: 400, code: 'BAD_REQUEST' });
  await call('P5-API-49 non-member', 'GET', ws(w, '/circuits'), { actor: outsider, org: w, expect: 404, code: 'ORGANIZATION_NOT_FOUND' });

  // ── Audit (P5-API-33–38) ─────────────────────────────────────────────────
  const logs = await call('P5-API-33 the audit log (admin)', 'GET', ws(w, '/audit-logs?limit=100'), { actor: admin, org: w });
  sameKeys('audit record shape', logs.data?.[0], SHAPE.auditLog);
  const actions = new Set((logs.data ?? []).map((row) => row.action));
  facts.auditActionsSeen = [...actions].sort();
  const byAction = async (action) => (await call(`P5-API-33 action=${action}`, 'GET', ws(w, `/audit-logs?action=${action}&limit=20`), { actor: admin, org: w })).data ?? [];
  const weakening = (await byAction('tool.updated')).find((row) => row.metadata?.weakened === true);
  check('loosening a tool’s data policy is audited as a weakening', weakening && JSON.stringify(weakening.metadata.weakenings).includes('maxClassification=INTERNAL'), weakening?.metadata);
  check('approvals are audited', (await byAction('workflow.approval.granted')).length >= 2);
  check('reveals are audited CRITICAL', (await byAction('pii.unmasked')).some((row) => row.severity === 'CRITICAL'));
  check('supervised reads are audited', (await byAction('workflow.run.supervised')).length >= 1);
  check('the circuit break and reset are audited', (await byAction('agent.circuit_broken')).length >= 1 && (await byAction('agent.circuit_reset')).length >= 1);
  check('a refused socket subscription is audited', (await byAction('realtime.subscription.denied')).length >= 1);
  const prefix = await call('P5-API-33 actionPrefix=tool.', 'GET', ws(w, '/audit-logs?actionPrefix=tool.&limit=100'), { actor: admin, org: w });
  check('prefix filter', (prefix.data ?? []).length > 0 && prefix.data.every((row) => row.action.startsWith('tool.')));
  const warnings = await call('P5-API-33 severity=WARNING', 'GET', ws(w, '/audit-logs?severity=WARNING'), { actor: admin, org: w });
  check('severity filter', (warnings.data ?? []).every((row) => row.severity === 'WARNING'));
  const byActor = await call('P5-API-33 actorId=member', 'GET', ws(w, `/audit-logs?actorId=${member.user.id}&limit=100`), { actor: admin, org: w });
  check('actor filter', (byActor.data ?? []).length > 0 && byActor.data.every((row) => row.actorId === member.user.id));
  const byResource = await call('P5-API-33 resourceType + resourceId', 'GET', ws(w, `/audit-logs?resourceType=workflow_run&resourceId=${ra.id}`), { actor: admin, org: w });
  check('resource filter', (byResource.data ?? []).length > 0 && byResource.data.every((row) => row.resourceId === ra.id));
  const recorded = await call('fixture: a request that writes an audit record', 'POST', ws(w, `/tools/${calc}/test`), { actor: admin, org: w, body: { arguments: { expression: '6*7' } } });
  const byRequest = await call('P5-API-33 requestId of one request', 'GET', ws(w, `/audit-logs?requestId=${encodeURIComponent(recorded.requestId ?? '')}`), { actor: admin, org: w });
  check('requestId (the x-request-id of a response) pulls that request’s records', (byRequest.data ?? []).length >= 1 && byRequest.data.every((row) => row.requestId === recorded.requestId), { requestId: recorded.requestId, rows: (byRequest.data ?? []).map((row) => row.action) });
  const windowed = await call('P5-API-33 from/to window', 'GET', ws(w, `/audit-logs?from=${encodeURIComponent(new Date(Date.now() - 3_600_000).toISOString())}&to=${encodeURIComponent(new Date().toISOString())}`), { actor: admin, org: w });
  check('window filter', windowed.status === 200);
  await call('P5-API-33 unknown action', 'GET', ws(w, '/audit-logs?action=nope'), { actor: admin, org: w, expect: 422, code: 'VALIDATION_FAILED' });
  await call('P5-API-33 malformed actorId', 'GET', ws(w, '/audit-logs?actorId=abc'), { actor: admin, org: w, expect: 422, code: 'VALIDATION_FAILED' });
  await call('P5-API-33 member lacks audit:read', 'GET', ws(w, '/audit-logs'), { actor: member, org: w, expect: 403, code: 'PERMISSION_DENIED' });
  await call('P5-API-33 bearer only', 'GET', ws(w, '/audit-logs'), { apiKey: runner, expect: 401, code: 'AUTH_SCHEME_NOT_ALLOWED' });
  await call('P5-API-33 non-member', 'GET', ws(w, '/audit-logs'), { actor: outsider, org: w, expect: 404, code: 'ORGANIZATION_NOT_FOUND' });
  const stats = need(await call('P5-API-34 statistics', 'GET', ws(w, '/audit-logs/statistics'), { actor: admin, org: w }), 'stats');
  samples.auditStatistics = stats;
  sameKeys('statistics shape', stats, SHAPE.auditStats);
  check('totals as strings (bigint), ten top actions at most', typeof stats.totalRecords === 'string' && stats.topActions.length <= 10 && stats.topActions.every((a) => typeof a.count === 'number'));
  await call('P5-API-34 member lacks audit:read', 'GET', ws(w, '/audit-logs/statistics'), { actor: member, org: w, expect: 403, code: 'PERMISSION_DENIED' });
  const verify = need(await call('P5-API-35 verify the chain', 'GET', ws(w, '/audit-logs/verify'), { actor: admin, org: w }), 'verify');
  samples.verify = verify;
  check('the chain verifies', verify.valid === true && verify.recordsChecked >= Number(stats.totalRecords) - 5, verify);
  const verify5 = need(await call('P5-API-35 verify the first 5 records', 'GET', ws(w, '/audit-logs/verify?maxRecords=5'), { actor: admin, org: w }), 'verify5');
  check('maxRecords bounds the check', verify5.valid === true && verify5.recordsChecked === 5);
  const verifyBad = need(await call('P5-API-35 a non-numeric maxRecords checks everything (P5-G10)', 'GET', ws(w, '/audit-logs/verify?maxRecords=abc'), { actor: admin, org: w }), 'verify bad');
  check('non-numeric maxRecords is ignored, not refused', verifyBad.recordsChecked > 5);
  await call('P5-API-35 member lacks audit:verify', 'GET', ws(w, '/audit-logs/verify'), { actor: member, org: w, expect: 403, code: 'PERMISSION_DENIED' });
  const exportRes = await call('P5-API-36 export NDJSON', 'GET', ws(w, '/audit-logs/export'), { actor: admin, org: w, raw: true });
  const lines = (exportRes.text ?? '').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  facts.exportHeaders = { contentType: exportRes.headers.get('content-type'), disposition: exportRes.headers.get('content-disposition') };
  check('NDJSON with an attachment disposition', facts.exportHeaders.contentType?.includes('application/x-ndjson') && facts.exportHeaders.disposition?.includes('audit-log.ndjson'), facts.exportHeaders);
  samples.exportLineKeys = keys(lines[0]);
  const linked = lines.every((line, i) => i === 0 || (BigInt(line.sequence) === BigInt(lines[i - 1].sequence) + 1n && line.previousHash === lines[i - 1].hash));
  check('offline check: every exported line links to the previous one (sequence and previousHash)', lines.length > 10 && linked && lines[0].sequence === '1', { lines: lines.length, first: lines[0]?.sequence });
  const windowExport = await call('P5-API-36 a windowed export', 'GET', ws(w, `/audit-logs/export?from=${encodeURIComponent(new Date(Date.now() - 600_000).toISOString())}`), { actor: admin, org: w, raw: true });
  const windowLines = (windowExport.text ?? '').split('\n').filter(Boolean);
  check('the window narrows the export', windowLines.length > 0 && windowLines.length < lines.length);
  const badExport = await call('P5-API-36 an unparseable date (P5-G04 fix)', 'GET', ws(w, '/audit-logs/export?from=garbage'), { actor: admin, org: w, expect: 422, code: 'VALIDATION_FAILED' });
  check('the refusal is a JSON envelope labelled as JSON, with no attachment (P5-G05 fix)', (badExport.headers.get('content-type') || '').includes('application/json') && !badExport.headers.get('content-disposition'), { type: badExport.headers.get('content-type'), disposition: badExport.headers.get('content-disposition') });
  await call('P5-API-36 member lacks audit:export', 'GET', ws(w, '/audit-logs/export'), { actor: member, org: w, expect: 403, code: 'PERMISSION_DENIED' });
  const archives = await call('P5-API-37 retention archives', 'GET', ws(w, '/audit-logs/archives'), { actor: admin, org: w });
  check('no pruning yet: an empty list', Array.isArray(archives.data) && archives.data.length === 0);
  await call('P5-API-37 member lacks audit:read', 'GET', ws(w, '/audit-logs/archives'), { actor: member, org: w, expect: 403, code: 'PERMISSION_DENIED' });
  await call('P5-API-38 an archive that does not exist', 'GET', ws(w, '/audit-logs/archives/999999'), { actor: admin, org: w, expect: 404, code: 'RESOURCE_NOT_FOUND' });
  await call('P5-API-38 a malformed sequence', 'GET', ws(w, '/audit-logs/archives/abc'), { actor: admin, org: w, expect: 404, code: 'RESOURCE_NOT_FOUND' });
  await call('P5-API-38 member lacks audit:export', 'GET', ws(w, '/audit-logs/archives/1'), { actor: member, org: w, expect: 403, code: 'PERMISSION_DENIED' });

  // ── Analytics (P5-API-39–42) ─────────────────────────────────────────────
  const overview = need(await call('P5-API-39 overview (member)', 'GET', ws(w, '/analytics/overview'), { actor: member, org: w }), 'overview');
  samples.overview = overview;
  sameKeys('overview shape', overview, SHAPE.overview);
  sameKeys('workflow analytics shape', overview.workflows, SHAPE.wfAnalytics);
  sameKeys('tool analytics shape', overview.tools, SHAPE.toolAnalytics);
  sameKeys('governance shape', overview.governance, SHAPE.governance);
  check('workflow counts reflect the runs', overview.workflows.runs >= 15 && overview.workflows.completed >= 8 && overview.workflows.failed >= 4 && overview.workflows.deadLetters >= 2, overview.workflows);
  check('tool counts and denials by reason', overview.tools.calls > 10 && overview.tools.denied >= 5 && overview.tools.denialsByReason.PII >= 1, overview.tools);
  check('governance saw the throttles and the circuit', overview.governance.throttledCalls >= 2 && overview.governance.circuitBreaks >= 1, overview.governance);
  await call('P5-API-39 from after to', 'GET', ws(w, `/analytics/overview?from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(new Date(Date.now() - 1000).toISOString())}`), { actor: member, org: w, expect: 422, code: 'VALIDATION_FAILED' });
  await call('P5-API-39 a range over 400 days', 'GET', ws(w, `/analytics/overview?from=2025-01-01T00:00:00Z&to=${encodeURIComponent(new Date().toISOString())}`), { actor: member, org: w, expect: 422, code: 'VALIDATION_FAILED' });
  await call('P5-API-39 viewer lacks usage:read', 'GET', ws(w, '/analytics/overview'), { actor: viewer, org: w, expect: 403, code: 'PERMISSION_DENIED' });
  await call('P5-API-39 an API key without usage:read', 'GET', ws(w, '/analytics/overview'), { apiKey: runner, expect: 403, code: 'PERMISSION_DENIED' });
  await call('P5-API-39 an API key with usage:read', 'GET', ws(w, '/analytics/overview'), { apiKey: readerKey.plaintextKey });
  await call('P5-API-03 an API key with tool:read and usage:read reads the ledger', 'GET', ws(w, '/tools/executions'), { apiKey: readerKey.plaintextKey });
  const series = need(await call('P5-API-40 daily tokens', 'GET', ws(w, '/analytics/timeseries?metric=tokens'), { actor: member, org: w }), 'series');
  samples.timeseries = { ...series, points: series.points.slice(-3) };
  sameKeys('timeseries shape', series, SHAPE.timeseries);
  check('30 days by default, every bucket present', series.points.length >= 30 && series.points.length <= 31 && series.interval === 'day');
  const hourly = need(await call('P5-API-40 hourly workflow runs today', 'GET', ws(w, `/analytics/timeseries?metric=workflow_runs&interval=hour&from=${encodeURIComponent(new Date(Date.now() - 6 * 3_600_000).toISOString())}`), { actor: member, org: w }), 'hourly');
  check('hourly buckets, today’s runs counted', hourly.points.length >= 6 && hourly.points.reduce((sum, p) => sum + (p.value ?? 0), 0) >= 15, hourly.points.map((p) => p.value));
  const p95 = need(await call('P5-API-40 a percentile with gaps', 'GET', ws(w, '/analytics/timeseries?metric=latency_p95'), { actor: member, org: w }), 'p95');
  check('percentiles are null where there is no data', p95.points.some((p) => p.value === null));
  for (const metric of ['invocations', 'throttled', 'failures', 'ttft_p95', 'redaction_p95', 'entities_masked', 'workflow_failures', 'tool_calls', 'tool_denials', 'security_events', 'rag_queries']) {
    await call(`P5-API-40 metric ${metric}`, 'GET', ws(w, `/analytics/timeseries?metric=${metric}`), { actor: member, org: w });
  }
  await call('P5-API-40 unknown metric', 'GET', ws(w, '/analytics/timeseries?metric=happiness'), { actor: member, org: w, expect: 422, code: 'VALIDATION_FAILED' });
  await call('P5-API-40 metric is required', 'GET', ws(w, '/analytics/timeseries'), { actor: member, org: w, expect: 422, code: 'VALIDATION_FAILED' });
  await call('P5-API-40 hourly over 14 days', 'GET', ws(w, `/analytics/timeseries?metric=tokens&interval=hour&from=${encodeURIComponent(new Date(Date.now() - 15 * 86_400_000).toISOString())}`), { actor: member, org: w, expect: 422, code: 'VALIDATION_FAILED' });
  const topAgents = need(await call('P5-API-41 top agents', 'GET', ws(w, '/analytics/top?dimension=agents'), { actor: member, org: w }), 'top agents');
  samples.topAgents = topAgents;
  sameKeys('top entry shape', topAgents[0], SHAPE.topEntry);
  check('agents ranked with labels', topAgents.some((entry) => entry.key === probe.id && entry.label === 'Circuit Probe'));
  const topModels = need(await call('P5-API-41 top models', 'GET', ws(w, '/analytics/top?dimension=models'), { actor: member, org: w }), 'top models');
  check('models keyed by name', topModels.length >= 1 && typeof topModels[0].key === 'string');
  await call('P5-API-41 ranking members needs quota:manage', 'GET', ws(w, '/analytics/top?dimension=members'), { actor: member, org: w, expect: 403, code: 'PERMISSION_DENIED' });
  const topMembers = need(await call('P5-API-41 top members (admin)', 'GET', ws(w, '/analytics/top?dimension=members'), { actor: admin, org: w }), 'top members');
  check('members ranked', topMembers.some((entry) => entry.key === member.user.id));
  await call('P5-API-41 top API keys (admin)', 'GET', ws(w, '/analytics/top?dimension=api_keys'), { actor: admin, org: w });
  await call('P5-API-41 limit above 50', 'GET', ws(w, '/analytics/top?dimension=agents&limit=51'), { actor: member, org: w, expect: 422, code: 'VALIDATION_FAILED' });
  await call('P5-API-41 unknown dimension', 'GET', ws(w, '/analytics/top?dimension=tools'), { actor: member, org: w, expect: 422, code: 'VALIDATION_FAILED' });
  const security = need(await call('P5-API-42 the security feed (admin)', 'GET', ws(w, '/analytics/security-events?limit=20'), { actor: admin, org: w }), 'security');
  samples.securityEvents = security.slice(0, 3);
  sameKeys('security event shape', security[0], SHAPE.securityEvent);
  check('WARNING and CRITICAL only, newest first', security.length > 0 && security.every((e) => ['WARNING', 'CRITICAL'].includes(e.severity)) && security.every((e, i, all) => i === 0 || new Date(all[i - 1].at) >= new Date(e.at)));
  const olderPage = need(await call('P5-API-42 the next page with before', 'GET', ws(w, `/analytics/security-events?limit=20&before=${encodeURIComponent(security[security.length - 1].at)}`), { actor: admin, org: w }), 'older');
  check('before pages strictly older', olderPage.every((e) => new Date(e.at) < new Date(security[security.length - 1].at)));
  await call('P5-API-42 member lacks audit:read and security:read', 'GET', ws(w, '/analytics/security-events'), { actor: member, org: w, expect: 403, code: 'PERMISSION_DENIED' });
  await call('P5-API-42 limit above 200', 'GET', ws(w, '/analytics/security-events?limit=201'), { actor: admin, org: w, expect: 422, code: 'VALIDATION_FAILED' });

  // ── Real-time: limits and revocation ─────────────────────────────────────
  const flood = await openSocket('flood', { token: viewer.token, organizationId: w });
  for (let i = 0; i < 31; i += 1) flood.socket.emit('resume', { lastEventId: 'x' }, () => undefined);
  check('P5-RT more than 30 messages in 10 s: error RATE_LIMIT_EXCEEDED and the socket closes', await until(() => flood.control.some((c) => c.event === 'error' && c.data?.code === 'RATE_LIMIT_EXCEEDED') && flood.control.some((c) => c.event === 'disconnect'), 10_000), flood.control.map((c) => c.event));
  const extra = [];
  let limitHit = null;
  for (let i = 0; i < 11 && !limitHit; i += 1) {
    const handle = await openSocket(`viewer-${i}`, { token: viewer.token, organizationId: w });
    if (handle.refused) limitHit = handle.refused;
    else extra.push(handle);
  }
  check('P5-RT more than 10 sockets per person: REALTIME_CONNECTION_LIMIT', limitHit?.code === 'REALTIME_CONNECTION_LIMIT', { opened: extra.length + 2, refused: limitHit });
  for (const handle of extra) handle.close();
  const refreshed = await sMember.emit('auth:refresh', { token: member.token });
  check('P5-RT auth:refresh with your own fresh token keeps the socket', refreshed.ok === true && typeof refreshed.expiresAt === 'number');
  const hijack = await openSocket('hijack', { token: member.token, organizationId: w });
  const hijackAck = await hijack.emit('auth:refresh', { token: viewer.token }, 5000);
  check('P5-RT auth:refresh with someone else’s token closes the socket (auth:revoked)', await until(() => hijack.control.some((c) => c.event === 'auth:revoked') && hijack.control.some((c) => c.event === 'disconnect'), 10_000), { ack: hijackAck, control: hijack.control.map((c) => c.event) });
  await call('fixture: revoke the runner key while its socket is open (Phase 2 endpoint)', 'DELETE', ws(w, `/api-keys/${runnerKey.apiKey.id}`), { actor: owner, org: w, body: { reason: 'Phase 5 revocation check' } });
  check('P5-RT revoking a key closes its socket at once (auth:revoked)', await until(() => sRunnerKey.control.some((c) => c.event === 'auth:revoked'), 15_000), sRunnerKey.control);
  samples.revokedControl = sRunnerKey.control.find((c) => c.event === 'auth:revoked');

  // ── Personal data (P5-API-52–53) ─────────────────────────────────────────
  const exportOwn = await call('P5-API-52 member exports their data', 'GET', '/api/v1/auth/me/export', { actor: member, raw: true });
  const personal = JSON.parse(exportOwn.text ?? '{}');
  facts.personalExportHeaders = { contentType: exportOwn.headers.get('content-type'), disposition: exportOwn.headers.get('content-disposition'), cacheControl: exportOwn.headers.get('cache-control') };
  sameKeys('personal export shape (a raw file, no envelope)', personal, SHAPE.personalExport);
  check('a JSON attachment, not cached', facts.personalExportHeaders.contentType?.includes('application/json') && /attachment; filename="personal-data-\d{4}-\d{2}-\d{2}\.json"/.test(facts.personalExportHeaders.disposition ?? '') && facts.personalExportHeaders.cacheControl === 'no-store', facts.personalExportHeaders);
  check('the export holds the member’s own runs decrypted and their conversation', personal.workflowRuns?.some((r) => r.id === r1.id && r.input?.amount === 30) && personal.conversations?.some((c) => c.id === conv.id) && personal.memberships?.some((m) => m.organizationId === w));
  check('no other person’s runs', !personal.workflowRuns?.some((r) => r.id === selfRun.id));
  samples.personalExport = { format: personal.format, sections: Object.fromEntries(['memberships', 'devices', 'conversations', 'workflowRuns', 'apiKeys', 'usage', 'activity'].map((k) => [k, personal[k]?.length ?? 0])), truncated: personal.truncated, accountKeys: keys(personal.account) };
  await call('P5-API-52 API keys cannot export personal data', 'GET', '/api/v1/auth/me/export', { apiKey: readerKey.plaintextKey, expect: 401 });
  for (let i = 1; i <= 5; i += 1) await call(`P5-API-52 eraser export ${i}/5 within the hour`, 'GET', '/api/v1/auth/me/export', { actor: eraser, raw: true, quiet: i < 5 });
  const sixth = await call('P5-API-52 a sixth export within the hour', 'GET', '/api/v1/auth/me/export', { actor: eraser, raw: true, expect: 429, code: 'RATE_LIMIT_EXCEEDED', flow: false });
  check('export is rate limited (5 per hour) with Retry-After', Number(sixth.headers?.get('retry-after')) > 0, sixth.headers?.get('retry-after'));

  // Admission control: at most WORKFLOW_MAX_ACTIVE_RUNS_PER_ORG (20) active runs per workspace.
  const ew = EW.id;
  const hold = need(await call('P5-API-11 the eraser creates a waiting workflow in their own workspace', 'POST', ws(ew, '/workflows'), {
    actor: eraser, org: ew, expect: 201,
    body: { name: 'Hold', graph: graph([node('start', 'trigger'), node('gate', 'approval', { message: 'Hold {{input.input}}' }, 200), node('done', 'output', {}, 400), node('no', 'output', {}, 400)], [edge('e1', 'start', 'gate'), edge('e2', 'gate', 'done', 'approved'), edge('e3', 'gate', 'no', 'rejected')]) },
  }), 'hold');
  await call('P5-API-18 publish it', 'POST', ws(ew, `/workflows/${hold.id}/publish`), { actor: eraser, org: ew, body: {} });
  let admitted = 0;
  let ceiling = null;
  for (let i = 0; i < 21 && !ceiling; i += 1) {
    const res = await call(`P5-API-21 active run ${i + 1}`, 'POST', ws(ew, `/workflows/${hold.id}/runs`), { actor: eraser, org: ew, body: { input: { input: String(i) } }, expect: [202, 429], quiet: i < 19, flow: false });
    if (res.status === 202) admitted += 1;
    else ceiling = res;
  }
  samples.concurrencyLimit = ceiling ? { error: ceiling.error, retryAfter: ceiling.headers?.get('retry-after') } : null;
  check('the 21st active run is refused: WORKFLOW_CONCURRENCY_LIMIT 429 with Retry-After 30', admitted === 20 && ceiling?.status === 429 && ceiling?.error?.code === 'WORKFLOW_CONCURRENCY_LIMIT' && ceiling?.error?.details?.limit === 20 && Number(ceiling?.headers?.get('retry-after')) === 30, { admitted, error: ceiling?.error });

  // The eraser: a run and a conversation in the shared workspace, MFA, then erasure.
  const er = need(await call('P5-API-21 the eraser starts a run in the shared workspace', 'POST', ws(w, `/workflows/${D.id}/runs`), { actor: eraser, org: w, body: { input: { amount: 3 } }, expect: 202 }), 'eraser run');
  await waitRun('eraser run', eraser, w, er.id);
  need(await call('fixture: the eraser opens a conversation (Phase 4)', 'POST', ws(w, '/conversations'), { actor: eraser, org: w, body: { agentId: summarizer.id }, expect: 201 }), 'eraser conversation');
  const setup = need(await call('fixture: the eraser begins MFA setup (Phase 1)', 'POST', '/api/v1/auth/mfa/setup', { actor: eraser, body: { password: eraser.password } }), 'mfa setup');
  const enrolledAt = Date.now();
  need(await call('fixture: the eraser enables MFA', 'POST', '/api/v1/auth/mfa/enable', { actor: eraser, body: { code: totp(setup.secret, enrolledAt) } }), 'mfa enable');
  await call('P5-API-53 an owner of a shared workspace cannot erase', 'DELETE', '/api/v1/auth/me', { actor: owner, body: { password: owner.password, confirmation: 'ERASE MY ACCOUNT' }, expect: 409, code: 'ACCOUNT_ERASURE_BLOCKED' }).then((res) => {
    samples.erasureBlocked = res.error;
    check('the blocking workspaces are named with their member counts', (res.error?.details?.workspaces ?? []).some((entry) => entry.id === w && entry.otherMembers >= 4), res.error?.details);
  });
  const wrongPhrase = await call('P5-API-53 wrong confirmation phrase', 'DELETE', '/api/v1/auth/me', { actor: eraser, body: { password: eraser.password, confirmation: 'erase my account' }, expect: 422, code: 'VALIDATION_FAILED' });
  check('confirmation named', fieldsOf(wrongPhrase).includes('confirmation'));
  await call('P5-API-53 wrong password (401, not a session problem)', 'DELETE', '/api/v1/auth/me', { actor: eraser, body: { password: 'Not-The-Password-1!', confirmation: 'ERASE MY ACCOUNT' }, expect: 401, code: 'AUTH_PASSWORD_MISMATCH' });
  await call('P5-API-53 MFA enabled and no code', 'DELETE', '/api/v1/auth/me', { actor: eraser, body: { password: eraser.password, confirmation: 'ERASE MY ACCOUNT' }, expect: 401, code: 'MFA_CODE_INVALID' });
  await call('P5-API-53 a wrong code', 'DELETE', '/api/v1/auth/me', { actor: eraser, body: { password: eraser.password, confirmation: 'ERASE MY ACCOUNT', code: '000000' }, expect: 401, code: 'MFA_CODE_INVALID' });
  await call('P5-API-53 null code (P5-G02 fix)', 'DELETE', '/api/v1/auth/me', { actor: eraser, body: { password: eraser.password, confirmation: 'ERASE MY ACCOUNT', code: null }, expect: 422, code: 'VALIDATION_FAILED' });
  const nextStep = (Math.floor(enrolledAt / 30_000) + 1) * 30_000;
  if (Date.now() < nextStep + 500) await sleep(nextStep + 500 - Date.now());
  const oldToken = eraser.token;
  const erased = need(await call('P5-API-53 erase with password, a current code and the phrase', 'DELETE', '/api/v1/auth/me', { actor: eraser, body: { password: eraser.password, confirmation: 'ERASE MY ACCOUNT', code: totp(setup.secret) } }), 'erased');
  samples.erasure = erased;
  sameKeys('erasure outcome shape', erased, SHAPE.erasure);
  check('their sole workspace deleted; runs and conversations shredded; memberships ended', erased.erased === true && erased.workspacesDeleted.includes(EW.id) && erased.workflowRunsShredded >= 21 && erased.conversationsShredded >= 1 && erased.membershipsEnded >= 1, erased);
  await call('P5-API-53 the old access token is dead', 'GET', '/api/v1/auth/me', { token: oldToken, expect: 401 });
  await call('P5-API-53 sign-in no longer works', 'POST', '/api/v1/auth/login', { body: { email: eraser.email, password: eraser.password }, expect: 401 });
  await call('P5-API-23 the eraser’s run is gone for supervisors too', 'GET', ws(w, `/workflow-runs/${er.id}`), { actor: admin, org: w, expect: 404, code: 'WORKFLOW_RUN_NOT_FOUND' });
  check('the farewell email went to the original address', await mailArrived(eraser.email, 'Your account has been erased'));
  delete actors.eraser;

  // ── Isolation ────────────────────────────────────────────────────────────
  for (const [label, path] of [['tools', '/tools'], ['workflows', '/workflows'], ['runs', '/workflow-runs'], ['quotas', '/quotas'], ['analytics', '/analytics/overview'], ['audit', '/audit-logs']]) {
    await call(`isolation: a non-member reads ${label}`, 'GET', ws(w, path), { actor: outsider, org: w, expect: 404, code: 'ORGANIZATION_NOT_FOUND' });
  }
  await call('isolation: another tenant’s workflow id inside your own workspace', 'GET', ws(x, `/workflows/${D.id}`), { actor: outsider, org: x, expect: 404, code: 'WORKFLOW_NOT_FOUND' });
  await call('isolation: another tenant’s run id', 'GET', ws(x, `/workflow-runs/${r1.id}`), { actor: outsider, org: x, expect: 404, code: 'WORKFLOW_RUN_NOT_FOUND' });
  await call('isolation: another tenant’s tool id', 'GET', ws(x, `/tools/${echoGet.id}`), { actor: outsider, org: x, expect: 404, code: 'TOOL_NOT_FOUND' });
  await call('isolation: another tenant’s agent circuit', 'GET', ws(x, `/circuits/agents/${probe.id}`), { actor: outsider, org: x, expect: 404, code: 'AGENT_NOT_FOUND' });
  check('P5-RT the other tenant’s socket received no event or notification all run', sOutsider.events.length === 0 && sOutsider.notifications.length === 0);
  facts.socketTotals = Object.fromEntries([sOwner, sAdmin, sMember, sViewer, sOutsider].map((h) => [h.name, { events: h.events.length, notifications: h.notifications.length, refreshes: h.refreshes.length, control: h.control.map((c) => c.event) }]));
}

// ── Coverage ────────────────────────────────────────────────────────────────

function coverage() {
  const byOperation = {};
  for (const row of results) {
    const id = /^P5-API-(\d+)/.exec(row.label ?? '')?.[1];
    if (!id || row.status === undefined) continue;
    const entry = (byOperation[`P5-API-${id}`] ||= { requests: 0, passed: 0, outcomes: new Set() });
    entry.requests += 1;
    if (row.pass) entry.passed += 1;
    entry.outcomes.add(`${row.status}${row.code ? ` ${row.code}` : ''}`);
  }
  return Object.fromEntries(
    Object.entries(byOperation)
      .sort(([a], [b]) => Number(a.slice(7)) - Number(b.slice(7)))
      .map(([id, entry]) => [id, { requests: entry.requests, passed: entry.passed, outcomes: [...entry.outcomes].sort() }]),
  );
}

main()
  .catch((error) => {
    console.log(JSON.stringify({ fatal: error.message, stack: error.stack?.split('\n').slice(0, 4) }));
    results.push({ label: 'run completed', pass: false, error: error.message });
  })
  .finally(async () => {
    for (const handle of sockets) {
      try {
        handle.close();
      } catch {
        /* closing */
      }
    }
    const w = workspaces[0]?.id;
    if (w && actors.admin) {
      const active = await call('cleanup list active runs', 'GET', ws(w, '/workflow-runs?scope=all&limit=100'), { actor: actors.admin, org: w, quiet: true });
      for (const runRow of (active.data ?? []).filter((r) => ACTIVE.has(r.status))) {
        await call('cleanup cancel run', 'POST', ws(w, `/workflow-runs/${runRow.id}/cancel`), { actor: actors.admin, org: w, expect: [200, 409], quiet: true });
      }
    }
    for (const base of createdBases) {
      await call('cleanup delete knowledge base', 'DELETE', ws(base.org, `/knowledge-bases/${base.id}`), { actor: base.actor, org: base.org, expect: [200, 404] });
    }
    for (const key of apiKeys) {
      await call('cleanup revoke API key', 'DELETE', ws(key.org, `/api-keys/${key.id}`), { actor: actors.owner, org: key.org, body: {}, expect: [200, 404] });
    }
    for (const workspace of workspaces) {
      await call('cleanup delete disposable workspace', 'DELETE', ws(workspace.id), { actor: workspace.actor, org: workspace.id });
    }
    for (const actor of Object.values(actors)) {
      await call('cleanup logout all fixture sessions', 'POST', '/api/v1/auth/logout-all', { actor, body: {}, expect: [200, 401] });
    }
    const passed = results.filter((row) => row.pass).length;
    const report = {
      run,
      baseUrl: BASE,
      completedAt: new Date().toISOString(),
      summary: { total: results.length, passed, failed: results.length - passed },
      coverage: coverage(),
      facts,
      traces,
      samples,
      results,
      fixtureUsers: Object.values(actors).map((actor) => actor.user?.id),
      fixtureWorkspaces: workspaces.map((workspace) => workspace.id),
      limitations: [
        'Members joined through real invitation emails read from the Ethereal test inbox; no direct database writes.',
        'Model output is non-deterministic: content-dependent behaviour is recorded under facts.modelObservations, not counted as checks.',
        'Fixture accounts retained with sessions revoked (the eraser account was erased); workspaces soft-deleted through the API; the knowledge base deleted (content purged).',
        'No browser/frontend tests.',
      ],
    };
    fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ total: results.length, passed, failed: results.length - passed, operations: Object.keys(report.coverage).length, flowControlWaits: facts.flowControl.length }));
    process.exitCode = results.some((row) => !row.pass) ? 1 : 0;
    setTimeout(() => process.exit(process.exitCode), 2000).unref();
  });
