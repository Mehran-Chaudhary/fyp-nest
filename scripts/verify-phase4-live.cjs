/* Opt-in Phase 4 live verification: agents and versions, prompt preview, the model
 * catalogue and workspace model policy, direct chat, conversations, streamed and
 * non-streamed agent turns, information-flow labels, supervision and usage, against a
 * running backend with its real model endpoint, retrieval and PII engine.
 *
 * Creates disposable users and workspaces. Never touches existing users or workspaces.
 * Members join through the public invitation flow: the invitation email is read from the
 * configured Ethereal test inbox over IMAP. No database rows are written directly.
 * Secrets (passwords, tokens, API keys, invitation tokens) stay in process memory and are
 * never written to output. Documents contain synthetic data only.
 *
 * Model calls are real and metered. The run makes about 25 of them, paced by the
 * workspace token rate (QUOTA_TOKENS_PER_MINUTE): a TOKEN_RATE_LIMITED or LLM_BUSY answer
 * that a check did not ask for is waited out (Retry-After) and recorded under
 * facts.flowControl, never counted as a failure.
 *
 *   node scripts/verify-phase4-live.cjs --run                      # main run
 *   node scripts/verify-phase4-live.cjs --run --inject-ai-outage   # also stops and restarts
 *                                                                  # the local AI service
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const tls = require('node:tls');
const { spawn, execFileSync } = require('node:child_process');
const inheritedEnv = { ...process.env };
require('dotenv').config({ quiet: true });

if (!process.argv.includes('--run')) throw new Error('Explicit --run required');
const INJECT_OUTAGE = process.argv.includes('--inject-ai-outage');
const BASE = process.env.P4_BASE_URL || `http://localhost:${process.env.APP_PORT || 3000}`;
const OUT = process.env.P4_RESULTS || 'docs/frontend/PHASE_4_LIVE_RESULTS.json';
const AI_DIR = process.env.P4_AI_SERVICE_DIR || path.resolve('ai-service');
const COOKIE = process.env.REFRESH_TOKEN_COOKIE_NAME || 'daiap_rt';
const AI_LOG_DIR = process.env.P4_AI_LOG_DIR || require('node:os').tmpdir();
const run = `p4-${Date.now()}`;

// A full disk or a closed pipe must not end the run before cleanup.
process.stdout.on('error', () => undefined);

const results = [];
const traces = {};
const samples = {};
const facts = { flowControl: [], transientRetries: [], turns: [], modelObservations: [] };
const actors = {};
const workspaces = [];
const createdBases = [];
const apiKeys = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ws = (id, suffix = '') => `/api/v1/organizations/${id}${suffix}`;

/** Flow-control refusals: wait them out unless a check asked for them. */
const FLOW_CODES = new Set(['TOKEN_RATE_LIMITED', 'LLM_BUSY', 'RATE_LIMIT_EXCEEDED']);
const PLACEHOLDER = /\[[A-Z][A-Z_]+_\d+\]/;

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
    /* logging is best effort; results are written at the end */
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
}

async function freshToken(actor) {
  if (actor && actor.tokenAt && Date.now() - actor.tokenAt > 12 * 60_000) await refresh(actor);
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
 * One JSON request. `expect` is a status or list of statuses; `code` the expected error
 * code. Unrequested flow-control refusals are waited out and retried.
 */
async function call(label, method, urlPath, opts = {}) {
  const { body, actor, org, apiKey, expect = 200, code, quiet = false, flow = true } = opts;
  const expected = Array.isArray(expect) ? expect : [expect];
  for (let attempt = 0; ; attempt += 1) {
    if (actor && !apiKey) await freshToken(actor);
    await pace(apiKey ? 'api-key' : actor ? actor.name : 'anonymous');
    const headers = { Accept: 'application/json' };
    if (actor && !apiKey) headers.Authorization = `Bearer ${actor.token}`;
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
      res = await fetch(`${BASE}${urlPath}`, {
        method,
        headers,
        body: payload,
        signal: AbortSignal.timeout(opts.timeout ?? 330_000),
      });
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
    // A cloud dependency can fail transiently. Retry an unexpected 503 once, and record it.
    if (res.status === 503 && !expected.includes(503) && !opts.retriedTransient) {
      facts.transientRetries.push({ label, code: actualCode, requestId: json?.meta?.requestId, at: new Date().toISOString() });
      log({ label, transient: actualCode, retrying: true });
      await sleep(3000);
      return call(label, method, urlPath, { ...opts, retriedTransient: true });
    }
    const pass = asked;
    const row = {
      label,
      method,
      path: urlPath,
      actor: apiKey ? 'api-key' : actor?.name ?? 'anonymous',
      status: res.status,
      expected: expected.length === 1 ? expected[0] : expected,
      code: actualCode,
      pass,
      ms: Date.now() - started,
      requestId: json?.meta?.requestId ?? res.headers.get('x-request-id') ?? undefined,
    };
    if (!quiet || !pass) {
      results.push(row);
      log(row);
    }
    return { status: res.status, json, data: json?.data, meta: json?.meta, error: json?.error, headers: res.headers };
  }
}

// ── Server-Sent Events over POST ───────────────────────────────────────────

/** The SSE line protocol (WHATWG), as Appendix A of the handoff implements it. */
function createSseParser(onEvent) {
  let buffer = '';
  let name = '';
  let data = [];
  let id;
  return {
    push(text) {
      buffer += text;
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) return;
        let line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') {
          if (data.length > 0) onEvent({ event: name || 'message', data: data.join('\n'), id });
          name = '';
          data = [];
          continue;
        }
        if (line.startsWith(':')) continue; // heartbeat comment
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') name = value;
        else if (field === 'data') data.push(value);
        else if (field === 'id') id = value;
      }
    },
  };
}

/**
 * A streamed POST. `terminal` is the event the check expects to end the stream ('done' or
 * 'error'); `code` the expected error code (error event or JSON). `abortWhen(event)`
 * disconnects the client, like a user pressing Stop.
 */
async function stream(label, urlPath, opts = {}) {
  const { actor, org, body, expect = 200, code, terminal = 'done', abortWhen, flow = true } = opts;
  for (let attempt = 0; ; attempt += 1) {
    await freshToken(actor);
    await pace(actor.name);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeout ?? 330_000);
    const started = Date.now();
    let res;
    try {
      res = await fetch(`${BASE}${urlPath}`, {
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${actor.token}`,
          'X-Organization-Id': org,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      const row = { label, method: 'POST', path: urlPath, pass: false, transport: error.name };
      results.push(row);
      log(row);
      return { status: 0, events: [] };
    }
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream')) {
      const text = await res.text();
      clearTimeout(timer);
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      const actualCode = json?.error?.code;
      const asked = res.status === expect && (!code || code === actualCode);
      if (flow && !asked && FLOW_CODES.has(actualCode) && attempt < 10) {
        await waitFlow(label, actualCode, retryAfterSeconds(res.headers, json));
        continue;
      }
      const row = { label, method: 'POST', path: urlPath, actor: actor.name, status: res.status, expected: expect, code: actualCode, sse: false, contentType, pass: asked, ms: Date.now() - started, requestId: json?.meta?.requestId };
      results.push(row);
      log(row);
      return { status: res.status, sse: false, json, error: json?.error, headers: res.headers, events: [] };
    }

    const events = [];
    let raw = '';
    let aborted = false;
    const parser = createSseParser((event) => {
      let parsed;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        parsed = event.data;
      }
      const entry = { event: event.event, id: event.id, data: parsed, atMs: Date.now() - started };
      events.push(entry);
      if (abortWhen && !aborted && abortWhen(entry, events)) {
        aborted = true;
        controller.abort();
      }
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        raw += text;
        parser.push(text);
        if (aborted) break;
      }
    } catch (error) {
      if (!aborted) {
        clearTimeout(timer);
        const row = { label, method: 'POST', path: urlPath, pass: false, transport: error.name, events: events.length };
        results.push(row);
        log(row);
        return { status: res.status, sse: true, events, raw, aborted, headers: res.headers };
      }
    } finally {
      clearTimeout(timer);
      if (aborted) reader.cancel().catch(() => undefined);
    }

    const errorEvent = events.find((entry) => entry.event === 'error');
    if (flow && errorEvent && FLOW_CODES.has(errorEvent.data?.code) && terminal !== 'error' && !aborted && attempt < 10) {
      await waitFlow(label, errorEvent.data.code, errorEvent.data.retryAfterSeconds ?? 5);
      continue;
    }
    const end = events.find((entry) => entry.event === 'done' || entry.event === 'error');
    const pass =
      res.status === expect &&
      (aborted ? true : end?.event === terminal && (!code || end?.data?.code === code));
    const row = {
      label,
      method: 'POST',
      path: urlPath,
      actor: actor.name,
      status: res.status,
      expected: expect,
      sse: true,
      terminal: aborted ? 'client-abort' : end?.event ?? 'none',
      code: errorEvent?.data?.code,
      events: events.length,
      pass,
      ms: Date.now() - started,
      requestId: res.headers.get('x-request-id') ?? undefined,
    };
    results.push(row);
    log(row);
    return {
      status: res.status,
      sse: true,
      events,
      raw,
      aborted,
      headers: res.headers,
      meta: events.find((entry) => entry.event === 'meta')?.data,
      done: events.find((entry) => entry.event === 'done')?.data,
      error: errorEvent?.data,
    };
  }
}

function check(label, pass, detail) {
  const row = { label, pass: !!pass, ...(detail === undefined ? {} : { detail }) };
  results.push(row);
  log(row);
  return !!pass;
}

/** Model-dependent behaviour: recorded, never a failure. */
function observe(label, detail) {
  facts.modelObservations.push({ label, ...detail });
  log({ observe: label, ...detail });
}

function need(response, label) {
  if (!response.data) throw new Error(`Fixture failed: ${label} (${response.status} ${response.error?.code ?? ''})`);
  return response.data;
}

const keys = (object) => Object.keys(object ?? {}).sort();
function sameKeys(label, object, expected) {
  const actual = keys(object);
  const wanted = [...expected].sort();
  return check(label, JSON.stringify(actual) === JSON.stringify(wanted), {
    missing: wanted.filter((key) => !actual.includes(key)),
    extra: actual.filter((key) => !wanted.includes(key)),
  });
}

/** A compact event trace: name, timing and the small fields of each event. */
function traceOf(events) {
  return events.map((entry) => {
    const d = entry.data ?? {};
    const brief =
      entry.event === 'delta'
        ? { chars: String(d.text ?? '').length }
        : entry.event === 'done'
          ? { keys: keys(d) }
          : d;
    return { id: entry.id, event: entry.event, atMs: entry.atMs, ...brief };
  });
}

function eventNames(events) {
  const names = [];
  for (const entry of events) {
    const name = entry.event === 'status' ? `status:${entry.data.stage}` : entry.event;
    if (names[names.length - 1] !== name || name !== 'delta') names.push(name);
  }
  return names;
}

// ── Ethereal IMAP: read invitation links ────────────────────────────────────

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

async function invitationToken(recipient) {
  const login = `LOGIN ${quote(process.env.SMTP_USERNAME)} ${quote(process.env.SMTP_PASSWORD)}`;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const [, , search] = await imap([login, 'SELECT INBOX', `UID SEARCH TO ${quote(recipient)} SUBJECT "invited"`, 'LOGOUT']);
    const line = search.split('\r\n').find((entry) => entry.startsWith('* SEARCH'));
    const uids = (line || '').replace('* SEARCH', '').trim().split(/\s+/).filter(Boolean).map(Number);
    if (uids.length) {
      const [, , fetched] = await imap([login, 'SELECT INBOX', `UID FETCH ${Math.max(...uids)} BODY.PEEK[]`, 'LOGOUT']);
      let text = fetched.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
      let match = text.match(/invitations\/accept\?token=([A-Za-z0-9%_.~-]+)/);
      if (!match) {
        const decoded = (fetched.match(/\r\n\r\n([A-Za-z0-9+/=\r\n]{40,})/g) || [])
          .map((block) => Buffer.from(block.replace(/\s+/g, ''), 'base64').toString('utf8'))
          .join('\n');
        text = decoded;
        match = text.match(/invitations\/accept\?token=([A-Za-z0-9%_.~-]+)/);
      }
      if (match) return decodeURIComponent(match[1]);
    }
    await sleep(3000);
  }
  throw new Error(`No invitation email for ${recipient.split('@')[0]}`);
}

// ── Knowledge fixtures ──────────────────────────────────────────────────────

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

const docs = {
  leave: {
    name: 'leave-policy.md',
    classification: 'PUBLIC',
    text: `# Leave Policy 2026\n\nReference ${run}.\n\nEvery full-time employee receives 24 days of paid annual leave per calendar year. Up to 5 unused days carry over to the next year. Sick leave is 12 days per year. Submit leave requests in the HR portal at least 10 working days in advance.\n`,
  },
  contacts: {
    name: 'hr-contacts.md',
    classification: 'INTERNAL',
    text: `# HR Contacts\n\nReference ${run}.\n\nThe HR business partner for all leave questions is Imran Siddiqui. Contact him at imran.siddiqui@acme.test or +92 321 7654321. Office hours are 10:00 to 16:00 on weekdays.\n`,
  },
  travel: {
    name: 'travel-faq.md',
    classification: 'INTERNAL',
    text: `# Travel FAQ\n\nReference ${run}.\n\nThe daily meal allowance for domestic business travel is PKR 4,500. Hotel bookings always go through the travel desk, never through personal accounts.\n`,
  },
  salary: {
    name: 'salary-bands.md',
    classification: 'CONFIDENTIAL',
    text: `# Salary Bands: Band Zeta\n\nReference ${run}.\n\nBand Zeta covers principal engineers, paid from PKR 1,200,000 to PKR 1,650,000 per month. Annual leave for Band Zeta follows the standard leave policy.\n`,
  },
  relocation: {
    name: 'relocation-casework.md',
    classification: 'INTERNAL',
    text: `# Relocation Casework\n\nReference ${run}.\n\nThe 2026 relocation stipend for employees moving between offices is PKR 275,000, paid in two instalments.\n`,
  },
};

// ── AI service process control (opt-in outage injection) ────────────────────

function aiServicePid() {
  const output = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
  const line = output.split(/\r?\n/).find((entry) => /(127\.0\.0\.1|0\.0\.0\.0):8000\s+\S+\s+LISTENING/.test(entry));
  return line ? Number(line.trim().split(/\s+/).pop()) : null;
}

function stopAiService() {
  const pid = aiServicePid();
  if (!pid) return false;
  execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  return true;
}

function startAiService() {
  const python = path.join(AI_DIR, '.venv', 'Scripts', 'python.exe');
  const logFile = fs.openSync(path.join(AI_LOG_DIR, `daiap-ai-service-${run}.log`), 'a');
  const env = { ...inheritedEnv };
  delete env.LOG_LEVEL; // the backend's lower-case LOG_LEVEL is rejected by the AI service
  const child = spawn(python, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000'], {
    cwd: AI_DIR,
    env,
    detached: true,
    stdio: ['ignore', logFile, logFile],
    windowsHide: true,
  });
  child.unref();
}

let lastHealth = null;
async function waitForHealth(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(30_000) });
      const json = await res.json();
      const info = json.data?.details ?? json.data?.info ?? json.error?.details ?? json.details ?? {};
      lastHealth = { httpStatus: res.status, ai_service: info.ai_service, pii_detector: info.pii_detector, llm: info.llm };
      if (predicate(info)) return info;
    } catch {
      /* keep waiting */
    }
    await sleep(3000);
  }
  return null;
}

// ── Shapes ──────────────────────────────────────────────────────────────────

const SHAPE = {
  model: ['name', 'family', 'parameterSize', 'quantization', 'contextLength', 'sizeBytes', 'allowed', 'isDefault'],
  policy: ['source', 'version', 'allowedModels', 'defaultModel', 'maxOutputTokens', 'maxContextTokens', 'effective'],
  effective: ['defaultModel', 'maxOutputTokens', 'maxContextTokens', 'platformAllowlist', 'maxClassification'],
  completion: ['invocationId', 'model', 'content', 'finishReason', 'usage', 'redaction', 'timings'],
  usage: ['promptTokens', 'completionTokens', 'estimated'],
  completionRedaction: ['enabled', 'degraded', 'entitiesMasked', 'byType', 'placeholdersResolved', 'placeholdersUnresolved'],
  completionTimings: ['redactionMs', 'queueMs', 'timeToFirstTokenMs', 'generationMs', 'totalMs'],
  summary: ['id', 'name', 'description', 'visibility', 'accessMode', 'currentVersion', 'model', 'role', 'greeting', 'knowledgeBaseCount', 'createdById', 'publishedAt', 'lastUsedAt', 'createdAt', 'updatedAt', 'canEdit'],
  config: ['persona', 'model', 'parameters', 'contextWindow', 'retrieval', 'memory', 'grounding', 'citations', 'tools'],
  persona: ['role', 'tone', 'language', 'greeting'],
  retrieval: ['enabled', 'knowledgeBaseIds', 'hiddenKnowledgeBases', 'topK', 'mode', 'rerank', 'maxContextTokens', 'minScore', 'maxClassification'],
  version: ['version', 'config', 'instructions', 'configDigest', 'changeNote', 'restoredFromVersion', 'createdById', 'createdAt', 'isCurrent'],
  preview: ['model', 'agentVersion', 'promptTemplateVersion', 'messages', 'context', 'redaction', 'retrieval'],
  accounting: ['contextWindow', 'promptBudget', 'reservedForAnswer', 'systemTokens', 'passageTokens', 'historyTokens', 'userTokens', 'passagesIncluded', 'passagesDropped', 'historyIncluded', 'historyExcluded'],
  previewRedaction: ['enabled', 'degraded', 'entities', 'occurrences', 'byType', 'bySource', 'detectors', 'timings', 'egressFindings'],
  previewRetrieval: ['retrievalId', 'passagesRetrieved', 'passagesIncluded', 'effectiveClearance', 'knowledgeBasesSearched'],
  conversation: ['id', 'agentId', 'agentName', 'title', 'status', 'messageCount', 'lastMessageAt', 'classification', 'isOwner', 'ownerKind', 'ownerUserId', 'createdAt'],
  message: ['id', 'sequence', 'role', 'status', 'content', 'contentState', 'classification', 'citations', 'agentVersion', 'model', 'redaction', 'errorCode', 'toolCalls', 'createdAt'],
  citation: ['tag', 'documentId', 'documentTitle', 'knowledgeBaseId', 'chunkId', 'rank', 'score', 'cited'],
  messageRedaction: ['enabled', 'degraded', 'entities', 'byType'],
  page: ['messages', 'nextBefore', 'masked', 'revealed'],
  turn: ['conversationId', 'userMessage', 'assistantMessage', 'usage', 'timings', 'retrieval', 'context'],
  turnTimings: ['retrievalMs', 'redactionMs', 'queueMs', 'timeToFirstTokenMs', 'generationMs', 'totalMs'],
  turnRetrieval: ['retrievalId', 'passagesProvided', 'passagesCited', 'effectiveClearance'],
  turnMeta: ['conversationId', 'agentId', 'agentVersion', 'model', 'userMessageId', 'assistantMessageId'],
  chatMeta: ['invocationId', 'model'],
  usageSummary: ['from', 'to', 'totals', 'latencyMs', 'redactionOverhead', 'byModel', 'byAgent'],
  usageTotals: ['invocations', 'completed', 'failed', 'cancelled', 'refused', 'blocked', 'throttled', 'promptTokens', 'completionTokens', 'entitiesMasked', 'degradedRedactions', 'estimatedTokenCounts'],
};

// ── Scenario ────────────────────────────────────────────────────────────────

const PERSONAS = [
  ['owner', 'Owner'],
  ['admin', 'Admin'],
  ['member', 'Member'],
  ['viewer', 'Viewer'],
  ['author', 'Author'],
  ['outsider', 'Outsider'],
];

async function main() {
  await call('liveness', 'GET', '/health/live');
  const ready = await call('readiness', 'GET', '/health/ready');
  const health = await call('health detail', 'GET', '/health');
  const info = health.data?.details ?? {};
  facts.dependencies = Object.fromEntries(Object.entries(info).map(([name, value]) => [name, value.status]));
  facts.llmHealth = info.llm;
  facts.readiness = ready.status;
  if (info.llm?.status !== 'up' || info.ai_service?.status !== 'up') {
    throw new Error(`Dependencies not ready: llm=${info.llm?.status} ai_service=${info.ai_service?.status}`);
  }

  for (const [name, last] of PERSONAS) {
    const email = `${run}-${name}@example.invalid`;
    const password = `V9!${crypto.randomBytes(24).toString('base64url')}q@`;
    const res = await call(`register ${name}`, 'POST', '/api/v1/auth/register', {
      body: { email, password, firstName: 'PhaseFour', lastName: last },
      expect: 201,
    });
    const data = need(res, `register ${name}`);
    actors[name] = { name, email, user: data.user, token: data.tokens.accessToken, tokenAt: Date.now(), refreshCookie: readCookie(res.headers) };
  }
  const { owner, admin, member, viewer, author, outsider } = actors;

  const W = need(await call('create workspace', 'POST', '/api/v1/organizations', {
    actor: owner, body: { name: `Phase 4 verification ${run}`, slug: run }, expect: 201,
  }), 'workspace');
  workspaces.push({ id: W.id, actor: owner });
  const X = need(await call('create second tenant', 'POST', '/api/v1/organizations', {
    actor: outsider, body: { name: `Isolation ${run}`, slug: `${run}-x` }, expect: 201,
  }), 'second tenant');
  workspaces.push({ id: X.id, actor: outsider });
  const w = W.id;
  const x = X.id;

  const roles = need(await call('roles', 'GET', ws(w, '/roles'), { actor: owner, org: w }), 'roles');
  const role = (slug) => roles.find((entry) => entry.slug === slug);
  const authorRole = need(await call('create custom Agent Author role', 'POST', ws(w, '/roles'), {
    actor: owner, org: w, expect: 201,
    body: {
      name: `Agent Author ${run.slice(-6)}`,
      description: 'Creates agents but cannot edit or publish them (Phase 4 fixture).',
      priority: 40,
      color: '#0EA5E9',
      permissionKeys: [
        'workspace:read', 'knowledgebase:read', 'document:read', 'rag:query', 'clearance:internal',
        'agent:read', 'agent:create', 'agent:execute', 'conversation:read', 'conversation:delete',
      ],
    },
  }), 'author role');
  const invitations = [
    [admin, role('admin').id],
    [member, role('member').id],
    [viewer, role('viewer').id],
    [author, authorRole.id],
  ];
  for (const [actor, roleId] of invitations) {
    need(await call(`invite ${actor.name}`, 'POST', ws(w, '/invitations'), {
      actor: owner, org: w, expect: 201, body: { email: actor.email, roleId, message: 'Phase 4 verification fixture.' },
    }), `invite ${actor.name}`);
  }
  for (const [actor] of invitations) {
    const token = await invitationToken(actor.email);
    check(`invitation email delivered to ${actor.name} (Ethereal IMAP)`, !!token);
    need(await call(`accept invitation as ${actor.name}`, 'POST', '/api/v1/invitations/accept', { actor, body: { token } }), `accept ${actor.name}`);
  }
  for (const actor of [owner, admin, member, viewer, author]) {
    actor.member = need(await call(`membership ${actor.name}`, 'GET', ws(w, '/members/me'), { actor, org: w }), 'me');
    const me = await call(`contextual permissions ${actor.name}`, 'GET', '/api/v1/auth/me', { actor, org: w });
    actor.permissions = me.data?.permissions ?? [];
  }
  facts.permissionCounts = Object.fromEntries([owner, admin, member, viewer, author].map((a) => [a.name, a.permissions.length]));
  const phase4Keys = (a) => a.permissions.filter((p) => /^(agent|conversation|llm|usage|tool):/.test(p)).sort();
  facts.phase4Permissions = Object.fromEntries([owner, admin, member, viewer, author].map((a) => [a.name, phase4Keys(a)]));

  // ── Knowledge fixtures (Phase 3 endpoints) ──────────────────────────────
  const handbook = need(await call('fixture: create Company Handbook base', 'POST', ws(w, '/knowledge-bases'), {
    actor: owner, org: w, expect: 201, body: { name: 'Company Handbook', description: 'Policies for everyone.' },
  }), 'handbook');
  createdBases.push({ id: handbook.id, org: w, actor: owner });
  const hrBase = need(await call('fixture: create RESTRICTED HR Casework base', 'POST', ws(w, '/knowledge-bases'), {
    actor: owner, org: w, expect: 201, body: { name: 'HR Casework', accessMode: 'RESTRICTED', description: 'Casework for HR partners.' },
  }), 'hr base');
  createdBases.push({ id: hrBase.id, org: w, actor: owner });
  await call('fixture: grant author READ on HR Casework', 'PUT', ws(w, `/knowledge-bases/${hrBase.id}/grants`), {
    actor: owner, org: w, body: { subjectType: 'MEMBER', subjectId: author.member.id, accessLevel: 'READ' },
  });
  const uploaded = {};
  for (const [key, doc] of Object.entries(docs)) {
    const base = key === 'relocation' ? hrBase : handbook;
    uploaded[key] = need(await call(`fixture: upload ${doc.name}`, 'POST', ws(w, `/knowledge-bases/${base.id}/documents`), {
      actor: owner, org: w, expect: 202, form: upload(doc.name, doc.text, { classification: doc.classification }),
    }), doc.name);
  }
  const allReady = await waitForDocuments(owner, w, Object.values(uploaded).map((d) => d.id));
  check('fixture: every document READY', allReady);
  const ownerSalary = await call('fixture: owner retrieves the CONFIDENTIAL salary document directly', 'POST', ws(w, '/rag/query'), {
    actor: owner, org: w, body: { query: 'Band Zeta principal engineer salary', rerank: false },
  });
  check('fixture: CONFIDENTIAL document is retrievable by the owner outside agents', (ownerSalary.data?.results ?? []).some((hit) => hit.documentId === uploaded.salary.id));

  const tools = await call('fixture: tool catalogue (Phase 5 endpoint)', 'GET', ws(w, '/tools?limit=100'), { actor: owner, org: w });
  const calculator = (tools.data ?? []).find((tool) => tool.name === 'calculator');
  facts.calculatorToolId = calculator?.id ?? null;

  // ── Models and policy (P4-API-22–24) ────────────────────────────────────
  const models = need(await call('P4-API-22 models as owner', 'GET', ws(w, '/llm/models'), { actor: owner, org: w }), 'models');
  samples.models = models;
  sameKeys('models response shape', models, ['models', 'verified']);
  sameKeys('model entry shape', models.models[0], SHAPE.model);
  const modelName = models.models.find((entry) => entry.isDefault)?.name ?? models.models[0]?.name;
  facts.model = modelName;
  check('model list verified against the endpoint, default marked and allowed', models.verified === true && models.models.some((m) => m.isDefault && m.allowed));
  await call('P4-API-22 models as member', 'GET', ws(w, '/llm/models'), { actor: member, org: w });
  await call('P4-API-22 models as viewer (agent:read suffices)', 'GET', ws(w, '/llm/models'), { actor: viewer, org: w });
  await call('P4-API-22 models from a non-member', 'GET', ws(w, '/llm/models'), { actor: outsider, org: w, expect: 404, code: 'ORGANIZATION_NOT_FOUND' });

  const policy0 = need(await call('P4-API-23 default policy as member', 'GET', ws(w, '/llm/policy'), { actor: member, org: w }), 'policy');
  samples.defaultPolicy = policy0;
  sameKeys('policy shape', policy0, SHAPE.policy);
  sameKeys('effective limits shape', policy0.effective, SHAPE.effective);
  check('default policy: source default, version 0, nothing chosen', policy0.source === 'default' && policy0.version === 0 && policy0.allowedModels.length === 0 && policy0.defaultModel === null);
  facts.effectiveDefaults = policy0.effective;
  await call('P4-API-23 policy as viewer', 'GET', ws(w, '/llm/policy'), { actor: viewer, org: w });

  await call('P4-API-24 member cannot change the policy', 'PUT', ws(w, '/llm/policy'), { actor: member, org: w, body: { maxOutputTokens: 300 }, expect: 403, code: 'PERMISSION_DENIED' });
  const notAllowed = await call('P4-API-24 model outside the platform allowlist', 'PUT', ws(w, '/llm/policy'), { actor: admin, org: w, body: { allowedModels: ['gpt-4o'] }, expect: 422, code: 'LLM_MODEL_NOT_ALLOWED' });
  samples.policyModelNotAllowed = notAllowed.json?.error;
  await call('P4-API-24 maxOutputTokens below 16', 'PUT', ws(w, '/llm/policy'), { actor: admin, org: w, body: { maxOutputTokens: 8 }, expect: 422, code: 'VALIDATION_FAILED' });
  await call('P4-API-24 unknown field', 'PUT', ws(w, '/llm/policy'), { actor: admin, org: w, body: { temperature: 1 }, expect: 422, code: 'VALIDATION_FAILED' });
  const policy1 = need(await call('P4-API-24 first save', 'PUT', ws(w, '/llm/policy'), {
    actor: admin, org: w, body: { expectedVersion: 0, allowedModels: [modelName], defaultModel: modelName, maxOutputTokens: 600 },
  }), 'policy save');
  samples.savedPolicy = policy1;
  check('first save: source workspace, version 1, effective output ceiling lowered', policy1.source === 'workspace' && policy1.version === 1 && policy1.effective.maxOutputTokens === 600);
  const stale = await call('P4-API-24 stale expectedVersion', 'PUT', ws(w, '/llm/policy'), { actor: admin, org: w, body: { expectedVersion: 0, maxOutputTokens: 500 }, expect: 409, code: 'RESOURCE_CONFLICT' });
  check('policy conflict details carry both versions', stale.error?.details?.expectedVersion === 0 && stale.error?.details?.currentVersion === 1, stale.error?.details);
  await call('P4-API-24 default model outside the platform allowlist', 'PUT', ws(w, '/llm/policy'), { actor: admin, org: w, body: { allowedModels: [modelName], defaultModel: 'other/model' }, expect: 422, code: 'LLM_MODEL_NOT_ALLOWED' });
  const policy2 = need(await call('P4-API-24 null returns a ceiling to the platform value', 'PUT', ws(w, '/llm/policy'), {
    actor: admin, org: w, body: { expectedVersion: 1, maxOutputTokens: null },
  }), 'policy reset');
  check('reset: version 2, allowed models kept, effective ceiling back to platform', policy2.version === 2 && policy2.allowedModels.length === 1 && policy2.maxOutputTokens === null && policy2.effective.maxOutputTokens === policy0.effective.maxOutputTokens);
  const modelsAfter = need(await call('P4-API-22 models after the policy names one', 'GET', ws(w, '/llm/models'), { actor: member, org: w }), 'models after');
  check('policy choice reflected in the model list', modelsAfter.models.every((m) => m.allowed === (m.name === modelName)));

  // ── Direct chat (P4-API-20–21) ──────────────────────────────────────────
  const pong = await call('P4-API-20 direct chat', 'POST', ws(w, '/llm/chat'), {
    actor: owner, org: w, body: { messages: [{ role: 'user', content: 'Reply with exactly one word: pong' }], parameters: { temperature: 0, maxOutputTokens: 40 } },
  });
  if (pong.data) {
    samples.directChat = pong.data;
    sameKeys('direct chat shape', pong.data, SHAPE.completion);
    sameKeys('direct chat usage shape', pong.data.usage, SHAPE.usage);
    sameKeys('direct chat redaction shape', pong.data.redaction, SHAPE.completionRedaction);
    sameKeys('direct chat timings shape', pong.data.timings, SHAPE.completionTimings);
    observe('direct chat followed the instruction', { content: pong.data.content, pong: /pong/i.test(pong.data.content) });
  }
  const pii = await call('P4-API-20 direct chat with personal data', 'POST', ws(w, '/llm/chat'), {
    actor: member, org: w,
    body: {
      messages: [
        { role: 'system', content: 'You are terse.' },
        { role: 'user', content: 'My colleague is Imran Siddiqui (imran.siddiqui@acme.test). In one sentence, tell me who to email and at which address.' },
      ],
      parameters: { temperature: 0, maxOutputTokens: 80 },
    },
  });
  if (pii.data) {
    samples.directChatMasked = { redaction: pii.data.redaction, finishReason: pii.data.finishReason };
    check('direct chat masked the name and email before the model saw them', pii.data.redaction.enabled && pii.data.redaction.entitiesMasked >= 2 && pii.data.redaction.byType.EMAIL_ADDRESS >= 1, pii.data.redaction);
    check('direct chat answer has no leftover placeholder', !PLACEHOLDER.test(pii.data.content), pii.data.content);
    observe('direct chat restored the real values', { content: pii.data.content, resolved: pii.data.redaction.placeholdersResolved });
  }
  await call('P4-API-20 viewer lacks llm:invoke', 'POST', ws(w, '/llm/chat'), { actor: viewer, org: w, body: { messages: [{ role: 'user', content: 'hi' }] }, expect: 403, code: 'PERMISSION_DENIED' });
  const blocked = await call('P4-API-20 model not allowed for the workspace', 'POST', ws(w, '/llm/chat'), { actor: owner, org: w, body: { model: 'llama3.1:8b', messages: [{ role: 'user', content: 'hi' }] }, expect: 422, code: 'LLM_MODEL_NOT_ALLOWED' });
  check('model refusal names the models that are allowed', Array.isArray(blocked.error?.details?.allowedModels) && blocked.error.details.allowedModels.includes(modelName), blocked.error?.details);
  await call('P4-API-20 empty messages', 'POST', ws(w, '/llm/chat'), { actor: owner, org: w, body: { messages: [] }, expect: 422, code: 'VALIDATION_FAILED' });
  await call('P4-API-20 unknown role', 'POST', ws(w, '/llm/chat'), { actor: owner, org: w, body: { messages: [{ role: 'tool', content: 'x' }] }, expect: 422, code: 'VALIDATION_FAILED' });
  await call('P4-API-20 message over 32,000 characters', 'POST', ws(w, '/llm/chat'), { actor: owner, org: w, body: { messages: [{ role: 'user', content: 'a'.repeat(32_001) }] }, expect: 422, code: 'VALIDATION_FAILED' });
  await call('P4-API-20 more than 50 messages', 'POST', ws(w, '/llm/chat'), { actor: owner, org: w, body: { messages: Array.from({ length: 51 }, () => ({ role: 'user', content: 'x' })) }, expect: 422, code: 'VALIDATION_FAILED' });
  await call('P4-API-20 temperature above 2', 'POST', ws(w, '/llm/chat'), { actor: owner, org: w, body: { messages: [{ role: 'user', content: 'x' }], parameters: { temperature: 3 } }, expect: 422, code: 'VALIDATION_FAILED' });

  const direct = await stream('P4-API-21 direct chat stream', ws(w, '/llm/chat/stream'), {
    actor: owner, org: w,
    body: { messages: [{ role: 'user', content: 'My name is Imran Siddiqui. Greet me by name in five words or fewer.' }], parameters: { temperature: 0, maxOutputTokens: 60 } },
  });
  traces.directStream = traceOf(direct.events);
  facts.directStreamRaw = direct.raw;
  facts.streamHeaders = Object.fromEntries(['content-type', 'cache-control', 'x-accel-buffering', 'connection', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'x-request-id'].map((h) => [h, direct.headers?.get?.(h) ?? null]));
  check('direct stream: SSE headers that defeat proxy buffering', /text\/event-stream/.test(facts.streamHeaders['content-type']) && /no-transform/.test(facts.streamHeaders['cache-control']) && facts.streamHeaders['x-accel-buffering'] === 'no', facts.streamHeaders);
  check('direct stream: starts with retry and numbered events', direct.raw?.startsWith('retry: 5000') && direct.events.every((entry, index) => entry.id === String(index + 1)));
  const directNames = eventNames(direct.events);
  facts.directStreamOrder = directNames;
  check('direct stream order: meta, redacting, queued, generating, deltas, done', JSON.stringify(directNames.filter((n) => n !== 'status:thinking')) === JSON.stringify(['meta', 'status:redacting', 'status:queued', 'status:generating', 'delta', 'done']), directNames);
  if (direct.meta) sameKeys('direct stream meta shape', direct.meta, SHAPE.chatMeta);
  if (direct.done) {
    sameKeys('direct stream done equals the non-streaming body', direct.done, SHAPE.completion);
    const deltas = direct.events.filter((entry) => entry.event === 'delta').map((entry) => entry.data.text).join('');
    check('direct stream: deltas concatenate to done.content', deltas === direct.done.content, { deltas, content: direct.done.content });
    check('direct stream: meta and done share the invocation id', direct.meta?.invocationId === direct.done.invocationId);
    const generating = direct.events.find((entry) => entry.event === 'status' && entry.data.stage === 'generating');
    check('direct stream: generating status reports redaction counts', generating?.data?.redaction?.entitiesMasked >= 1, generating?.data);
    const queued = direct.events.find((entry) => entry.event === 'status' && entry.data.stage === 'queued');
    check('direct stream: queued status reports gateway load', ['inUse', 'waiting', 'capacity'].every((k) => typeof queued?.data?.[k] === 'number'), queued?.data);
  }
  const preStream = await stream('P4-API-21 refusal before the stream opens is plain JSON', ws(w, '/llm/chat/stream'), {
    actor: owner, org: w, body: { model: 'llama3.1:8b', messages: [{ role: 'user', content: 'hi' }] }, expect: 422, code: 'LLM_MODEL_NOT_ALLOWED',
  });
  check('pre-stream failure has a JSON envelope, not an event stream', preStream.sse === false && preStream.json?.success === false);
  await stream('P4-API-21 viewer refused before the stream opens', ws(w, '/llm/chat/stream'), { actor: viewer, org: w, body: { messages: [{ role: 'user', content: 'hi' }] }, expect: 403, code: 'PERMISSION_DENIED' });
  const directAbort = await stream('P4-API-21 client disconnects mid-answer', ws(w, '/llm/chat/stream'), {
    actor: owner, org: w,
    body: { messages: [{ role: 'user', content: 'Write the numbers from one to three hundred in English words, separated by commas.' }], parameters: { temperature: 0, maxOutputTokens: 1000 } },
    abortWhen: (entry) => entry.event === 'delta',
  });
  facts.directAbort = { aborted: directAbort.aborted, eventsBeforeAbort: directAbort.events.length };

  // Context overflow: a tiny workspace context ceiling refuses before the model is called.
  const tight = need(await call('P4-API-24 shrink the context ceiling to 512', 'PUT', ws(w, '/llm/policy'), { actor: admin, org: w, body: { expectedVersion: 2, maxContextTokens: 512 } }), 'tight policy');
  const overflow = await call('P4-API-20 prompt larger than the context window', 'POST', ws(w, '/llm/chat'), {
    actor: owner, org: w, body: { messages: [{ role: 'user', content: `Summarise this: ${'The quarterly report covers revenue, costs and hiring plans. '.repeat(60)}` }] }, expect: 422, code: 'LLM_CONTEXT_OVERFLOW',
  });
  samples.contextOverflow = overflow.error;
  check('overflow details give the estimate and the window', typeof overflow.error?.details?.contextWindow === 'number' && typeof overflow.error?.details?.estimatedPromptTokens === 'number', overflow.error?.details);
  await call('P4-API-24 restore the context ceiling', 'PUT', ws(w, '/llm/policy'), { actor: admin, org: w, body: { expectedVersion: tight.version, maxContextTokens: null } });

  // Token rate: concurrent calls reserve their worst case (prompt + maximum output) at once.
  const burst = await Promise.all(
    Array.from({ length: 9 }, (_, index) =>
      call(`P4-API-20 burst call ${index + 1} against the workspace token rate`, 'POST', ws(w, '/llm/chat'), {
        actor: owner, org: w, flow: false, expect: [200, 429, 503],
        body: { messages: [{ role: 'user', content: 'Say ok.' }], parameters: { maxOutputTokens: 1000, temperature: 0 } },
      }),
    ),
  );
  const limited = burst.filter((response) => response.error?.code === 'TOKEN_RATE_LIMITED');
  facts.tokenRateBurst = burst.map((response) => response.error?.code ?? response.status);
  check('token rate: concurrent calls past the per-minute budget get 429 TOKEN_RATE_LIMITED', limited.length >= 1, facts.tokenRateBurst);
  if (limited[0]) {
    samples.tokenRateLimited = limited[0].error;
    check('TOKEN_RATE_LIMITED carries Retry-After and the budget', Number(limited[0].headers.get('retry-after')) >= 1 && typeof limited[0].error.details?.tokensPerMinute === 'number' && typeof limited[0].error.details?.requested === 'number', { retryAfter: limited[0].headers.get('retry-after'), details: limited[0].error.details });
  }

  // ── Agents (P4-API-01–11) ───────────────────────────────────────────────
  await call('P4-API-02 member lacks agent:create', 'POST', ws(w, '/agents'), { actor: member, org: w, body: { name: 'Nope' }, expect: 403, code: 'PERMISSION_DENIED' });
  const hiddenKb = await call('P4-API-02 attaching a base the editor cannot read', 'POST', ws(w, '/agents'), { actor: admin, org: w, body: { name: 'Probe Agent', retrieval: { knowledgeBaseIds: [hrBase.id] } }, expect: 404, code: 'KNOWLEDGE_BASE_NOT_FOUND' });
  check('hidden-base refusal names the base id', hiddenKb.error?.details?.knowledgeBaseId === hrBase.id);
  const unknownRole = crypto.randomUUID();
  const roleMissing = await call('P4-API-02 unknown allowed role', 'POST', ws(w, '/agents'), { actor: admin, org: w, body: { name: 'Probe Agent', accessMode: 'RESTRICTED', allowedRoleIds: [unknownRole] }, expect: 404, code: 'ROLE_NOT_FOUND' });
  check('role refusal lists the missing role ids', JSON.stringify(roleMissing.error?.details?.roleIds) === JSON.stringify([unknownRole]));
  await call('P4-API-02 model outside the workspace policy', 'POST', ws(w, '/agents'), { actor: admin, org: w, body: { name: 'Probe Agent', model: 'llama3.1:8b' }, expect: 422, code: 'LLM_MODEL_NOT_ALLOWED' });
  await call('P4-API-02 granting tools needs tool:read', 'POST', ws(w, '/agents'), { actor: author, org: w, body: { name: 'Probe Agent', tools: { toolIds: [crypto.randomUUID()] } }, expect: 403, code: 'PERMISSION_DENIED' });
  await call('P4-API-02 tool iterations above TOOL_MAX_ITERATIONS', 'POST', ws(w, '/agents'), { actor: admin, org: w, body: { name: 'Probe Agent', tools: { maxIterations: 32 } }, expect: 422, code: 'VALIDATION_FAILED' });
  const nested = await call('P4-API-02 retrieval.topK above 20', 'POST', ws(w, '/agents'), { actor: admin, org: w, body: { name: 'Probe Agent', retrieval: { topK: 21 } }, expect: 422, code: 'VALIDATION_FAILED' });
  facts.nestedValidationFields = keys(nested.error?.details?.fields);
  await call('P4-API-02 instructions over 12,000 characters', 'POST', ws(w, '/agents'), { actor: admin, org: w, body: { name: 'Probe Agent', instructions: 'x'.repeat(12_001) }, expect: 422, code: 'VALIDATION_FAILED' });
  await call('P4-API-02 context window below 512', 'POST', ws(w, '/agents'), { actor: admin, org: w, body: { name: 'Probe Agent', contextWindow: 100 }, expect: 422, code: 'VALIDATION_FAILED' });
  await call('P4-API-02 unknown field', 'POST', ws(w, '/agents'), { actor: admin, org: w, body: { name: 'Probe Agent', visibility: 'WORKSPACE' }, expect: 422, code: 'VALIDATION_FAILED' });
  await call('P4-API-02 blank name', 'POST', ws(w, '/agents'), { actor: admin, org: w, body: { name: '   ' }, expect: 422, code: 'VALIDATION_FAILED' });

  const scratch = need(await call('P4-API-02 create with only a name', 'POST', ws(w, '/agents'), { actor: admin, org: w, body: { name: 'Scratch Agent' }, expect: 201 }), 'scratch');
  samples.agentDefaults = scratch;
  sameKeys('agent shape', scratch, [...SHAPE.summary, 'config', 'instructions', 'allowedRoleIds']);
  sameKeys('agent config shape', scratch.config, SHAPE.config);
  sameKeys('agent persona shape', scratch.config.persona, SHAPE.persona);
  sameKeys('agent retrieval view shape', scratch.config.retrieval, SHAPE.retrieval);
  check('new agent: private draft, version 1, editable by its manager', scratch.visibility === 'PRIVATE' && scratch.currentVersion === 1 && scratch.publishedAt === null && scratch.canEdit === true && scratch.accessMode === 'WORKSPACE');
  facts.agentDefaults = scratch.config;
  check('defaults: STRICT grounding, citations, hybrid retrieval with no bases, empty instructions', scratch.config.grounding === 'STRICT' && scratch.config.citations === true && scratch.config.retrieval.enabled === true && scratch.config.retrieval.knowledgeBaseIds.length === 0 && scratch.config.retrieval.mode === 'hybrid' && scratch.instructions === '' && scratch.config.model === null, scratch.config);

  const instructions = 'Help employees understand company policy. Quote figures exactly as the reference material states them. If a question is not about company policy, say that you can only help with policy questions.';
  const hrAgent = need(await call('P4-API-02 create a grounded agent', 'POST', ws(w, '/agents'), {
    actor: admin, org: w, expect: 201,
    body: {
      name: 'HR Policy Assistant',
      description: 'Answers leave and HR questions from the Company Handbook.',
      persona: { role: 'the HR policy assistant', tone: 'friendly', greeting: 'Hi! Ask me about leave, contacts or travel.' },
      model: modelName,
      parameters: { temperature: 0.2, maxOutputTokens: 300 },
      retrieval: { knowledgeBaseIds: [handbook.id], topK: 6, rerank: true },
      memory: { maxMessages: 10, maxHistoryTokens: 1500 },
      grounding: 'STRICT',
      citations: true,
      instructions,
    },
  }), 'hr agent');
  check('grounded agent stored as configured', hrAgent.config.retrieval.knowledgeBaseIds[0] === handbook.id && hrAgent.config.parameters.maxOutputTokens === 300 && hrAgent.instructions === instructions && hrAgent.greeting === hrAgent.config.persona.greeting);
  await call('P4-API-02 names are unique case-insensitively', 'POST', ws(w, '/agents'), { actor: admin, org: w, body: { name: 'hr policy assistant' }, expect: 409, code: 'AGENT_NAME_TAKEN' });

  const casework = need(await call('P4-API-02 author creates a RESTRICTED agent with a compartment', 'POST', ws(w, '/agents'), {
    actor: author, org: w, expect: 201,
    body: {
      name: 'HR Casework Assistant',
      retrieval: { knowledgeBaseIds: [hrBase.id, handbook.id], topK: 6 },
      parameters: { temperature: 0.2, maxOutputTokens: 200 },
      accessMode: 'RESTRICTED',
      allowedRoleIds: [authorRole.id],
      instructions: 'Answer HR casework questions briefly.',
    },
  }), 'casework');
  check('author: own draft, not editable (no agent:update)', casework.visibility === 'PRIVATE' && casework.canEdit === false && casework.config.retrieval.knowledgeBaseIds.length === 2);
  const draftChat = await call('P4-API-13 the creator can talk to their own draft', 'POST', ws(w, '/conversations'), { actor: author, org: w, body: { agentId: casework.id }, expect: 201 });
  if (draftChat.data) await call('P4-API-16 the creator deletes their own conversation', 'DELETE', ws(w, `/conversations/${draftChat.data.id}`), { actor: author, org: w });
  await call('P4-API-13 a member cannot start a conversation with someone else\'s draft', 'POST', ws(w, '/conversations'), { actor: member, org: w, body: { agentId: hrAgent.id }, expect: 404, code: 'AGENT_NOT_FOUND' });

  const calcAgent = calculator
    ? need(await call('P4-API-02 create an agent granted a built-in tool', 'POST', ws(w, '/agents'), {
        actor: admin, org: w, expect: 201,
        body: {
          name: 'Calculator Agent',
          retrieval: { enabled: false },
          grounding: 'BALANCED',
          parameters: { temperature: 0, maxOutputTokens: 200 },
          tools: { toolIds: [calculator.id], maxIterations: 2 },
          instructions: 'You must use the calculator tool for every arithmetic question, then state the result in one sentence.',
        },
      }), 'calculator agent')
    : null;
  const writer = need(await call('P4-API-02 create a general-knowledge agent', 'POST', ws(w, '/agents'), {
    actor: admin, org: w, expect: 201,
    body: { name: 'Writer Agent', retrieval: { enabled: false }, grounding: 'BALANCED', citations: false, parameters: { temperature: 0, maxOutputTokens: 900 } },
  }), 'writer');

  const adminList = need(await call('P4-API-01 list as an agent manager', 'GET', ws(w, '/agents'), { actor: admin, org: w }), 'admin list');
  sameKeys('agent summary shape', adminList[0], SHAPE.summary);
  const names = adminList.map((agent) => agent.name);
  check('managers see every agent, drafts and other people\'s included, sorted by name', JSON.stringify(names) === JSON.stringify([...names].sort((a, b) => a.localeCompare(b))) && names.includes('HR Casework Assistant'), names);
  const memberList0 = await call('P4-API-01 list as a member before publishing', 'GET', ws(w, '/agents'), { actor: member, org: w });
  check('members see no drafts', memberList0.data?.length === 0 && memberList0.meta?.pagination?.totalItems === 0);
  const authorList = await call('P4-API-01 list as the author', 'GET', ws(w, '/agents'), { actor: author, org: w });
  check('a creator without agent:update sees only their own draft', JSON.stringify(authorList.data?.map((a) => a.name)) === JSON.stringify(['HR Casework Assistant']));
  const searched = await call('P4-API-01 search by name', 'GET', ws(w, '/agents?search=assistant'), { actor: admin, org: w });
  check('search matches names', searched.data?.length === 2);
  const privateOnly = await call('P4-API-01 filter by visibility', 'GET', ws(w, '/agents?visibility=WORKSPACE'), { actor: admin, org: w });
  check('visibility filter: nothing published yet', privateOnly.data?.length === 0);
  const paged = await call('P4-API-01 pagination', 'GET', ws(w, '/agents?limit=2&page=2'), { actor: admin, org: w });
  check('pagination metadata', paged.meta?.pagination?.page === 2 && paged.meta?.pagination?.limit === 2 && paged.data?.length === 2, paged.meta?.pagination);
  await call('P4-API-01 limit above 100', 'GET', ws(w, '/agents?limit=101'), { actor: admin, org: w, expect: 422, code: 'VALIDATION_FAILED' });
  await call('P4-API-01 unknown visibility', 'GET', ws(w, '/agents?visibility=PUBLIC'), { actor: admin, org: w, expect: 422, code: 'VALIDATION_FAILED' });

  const adminView = need(await call('P4-API-03 manager reads an agent with a compartment they cannot see', 'GET', ws(w, `/agents/${casework.id}`), { actor: admin, org: w }), 'admin view');
  check('hidden bases are counted, not named', adminView.config.retrieval.knowledgeBaseIds.length === 1 && adminView.config.retrieval.hiddenKnowledgeBases === 1 && adminView.knowledgeBaseCount === 2, adminView.config.retrieval);
  const authorView = need(await call('P4-API-03 author reads the same agent', 'GET', ws(w, `/agents/${casework.id}`), { actor: author, org: w }), 'author view');
  check('the author sees both bases', authorView.config.retrieval.knowledgeBaseIds.length === 2 && authorView.config.retrieval.hiddenKnowledgeBases === 0);
  await call('P4-API-03 member cannot see a draft', 'GET', ws(w, `/agents/${hrAgent.id}`), { actor: member, org: w, expect: 404, code: 'AGENT_NOT_FOUND' });
  await call('P4-API-03 malformed id', 'GET', ws(w, '/agents/not-a-uuid'), { actor: admin, org: w, expect: 400, code: 'BAD_REQUEST' });
  await call('P4-API-03 unknown id', 'GET', ws(w, `/agents/${crypto.randomUUID()}`), { actor: admin, org: w, expect: 404, code: 'AGENT_NOT_FOUND' });
  await call('P4-API-03 another tenant\'s workspace header', 'GET', ws(x, `/agents/${hrAgent.id}`), { actor: outsider, org: x, expect: 404, code: 'AGENT_NOT_FOUND' });

  await call('P4-API-06 member lacks agent:publish', 'POST', ws(w, `/agents/${hrAgent.id}/publish`), { actor: member, org: w, expect: 403, code: 'PERMISSION_DENIED' });
  await call('P4-API-06 author lacks agent:publish', 'POST', ws(w, `/agents/${casework.id}/publish`), { actor: author, org: w, expect: 403, code: 'PERMISSION_DENIED' });
  const published = need(await call('P4-API-06 publish', 'POST', ws(w, `/agents/${hrAgent.id}/publish`), { actor: admin, org: w }), 'published');
  check('published: WORKSPACE visibility, publishedAt set, version unchanged', published.visibility === 'WORKSPACE' && !!published.publishedAt && published.currentVersion === hrAgent.currentVersion);
  const republished = need(await call('P4-API-06 publish again is a no-op', 'POST', ws(w, `/agents/${hrAgent.id}/publish`), { actor: admin, org: w }), 'republish');
  check('publishing twice keeps the first publishedAt', republished.publishedAt === published.publishedAt);
  for (const agent of [casework, writer, scratch, ...(calcAgent ? [calcAgent] : [])]) {
    await call(`P4-API-06 publish ${agent.name}`, 'POST', ws(w, `/agents/${agent.id}/publish`), { actor: admin, org: w });
  }
  const memberList = need(await call('P4-API-01 member list after publishing', 'GET', ws(w, '/agents'), { actor: member, org: w }), 'member list');
  check('members see published WORKSPACE agents, not the RESTRICTED one', memberList.some((a) => a.id === hrAgent.id) && !memberList.some((a) => a.id === casework.id) && memberList.every((a) => a.canEdit === false), memberList.map((a) => a.name));
  await call('P4-API-03 member reads a published agent', 'GET', ws(w, `/agents/${hrAgent.id}`), { actor: member, org: w });
  await call('P4-API-03 RESTRICTED agent is invisible to other roles', 'GET', ws(w, `/agents/${casework.id}`), { actor: member, org: w, expect: 404, code: 'AGENT_NOT_FOUND' });
  const viewerList = need(await call('P4-API-01 viewer list', 'GET', ws(w, '/agents'), { actor: viewer, org: w }), 'viewer list');
  check('viewers can browse published agents', viewerList.some((a) => a.id === hrAgent.id));

  // Updates and versions.
  const described = need(await call('P4-API-04 identity-only change', 'PATCH', ws(w, `/agents/${hrAgent.id}`), { actor: admin, org: w, body: { description: 'Leave, HR contacts and travel, from the handbook.' } }), 'described');
  check('identity edits create no version', described.currentVersion === 1);
  const toned = need(await call('P4-API-04 behaviour change with a change note', 'PATCH', ws(w, `/agents/${hrAgent.id}`), { actor: admin, org: w, body: { expectedVersion: 1, persona: { tone: 'formal' }, changeNote: 'Formal tone for policy answers.' } }), 'toned');
  check('behaviour edit creates version 2; persona merged one level deep', toned.currentVersion === 2 && toned.config.persona.tone === 'formal' && toned.config.persona.role === 'the HR policy assistant');
  const same = need(await call('P4-API-04 unchanged configuration', 'PATCH', ws(w, `/agents/${hrAgent.id}`), { actor: admin, org: w, body: { persona: { tone: 'formal' }, instructions } }), 'same');
  check('saving an unchanged configuration creates no version', same.currentVersion === 2);
  const conflict = await call('P4-API-04 stale expectedVersion', 'PATCH', ws(w, `/agents/${hrAgent.id}`), { actor: admin, org: w, body: { expectedVersion: 1, citations: false }, expect: 409, code: 'AGENT_VERSION_CONFLICT' });
  check('version conflict details', conflict.error?.details?.expectedVersion === 1 && conflict.error?.details?.currentVersion === 2, conflict.error?.details);
  await call('P4-API-04 rename onto another agent', 'PATCH', ws(w, `/agents/${hrAgent.id}`), { actor: admin, org: w, body: { name: 'Scratch Agent' }, expect: 409, code: 'AGENT_NAME_TAKEN' });
  const replaced = need(await call('P4-API-04 parameters are replaced, not merged', 'PATCH', ws(w, `/agents/${hrAgent.id}`), { actor: admin, org: w, body: { parameters: { temperature: 0.1 } } }), 'replaced');
  check('omitting maxOutputTokens from parameters removes the override', replaced.currentVersion === 3 && replaced.config.parameters.maxOutputTokens === undefined && replaced.config.parameters.temperature === 0.1, replaced.config.parameters);
  const restoredParams = need(await call('P4-API-04 set parameters again', 'PATCH', ws(w, `/agents/${hrAgent.id}`), { actor: admin, org: w, body: { parameters: { temperature: 0.2, maxOutputTokens: 300 } } }), 'params back');
  check('version 4 after the second parameter change', restoredParams.currentVersion === 4);
  await call('P4-API-04 member lacks agent:update', 'PATCH', ws(w, `/agents/${hrAgent.id}`), { actor: member, org: w, body: { description: 'x' }, expect: 403, code: 'PERMISSION_DENIED' });
  await call('P4-API-04 the author cannot edit their own agent', 'PATCH', ws(w, `/agents/${casework.id}`), { actor: author, org: w, body: { description: 'x' }, expect: 403, code: 'PERMISSION_DENIED' });
  await call('P4-API-04 naming a hidden base is refused', 'PATCH', ws(w, `/agents/${casework.id}`), { actor: admin, org: w, body: { retrieval: { knowledgeBaseIds: [handbook.id, hrBase.id] } }, expect: 404, code: 'KNOWLEDGE_BASE_NOT_FOUND' });
  const adminEdit = need(await call('P4-API-04 manager edits what they can see', 'PATCH', ws(w, `/agents/${casework.id}`), { actor: admin, org: w, body: { persona: { tone: 'concise' }, retrieval: { knowledgeBaseIds: [handbook.id] } } }), 'admin edit');
  check('manager edit creates a version and still reports the hidden base', adminEdit.currentVersion === 2 && adminEdit.config.retrieval.hiddenKnowledgeBases === 1);
  const preserved = need(await call('P4-API-03 author re-reads after the manager\'s edit', 'GET', ws(w, `/agents/${casework.id}`), { actor: author, org: w }), 'preserved');
  check('the hidden compartment stayed attached', preserved.config.retrieval.knowledgeBaseIds.includes(hrBase.id) && preserved.config.persona.tone === 'concise');
  const access = need(await call('P4-API-04 access edits are in place', 'PATCH', ws(w, `/agents/${writer.id}`), { actor: admin, org: w, body: { accessMode: 'RESTRICTED', allowedRoleIds: [role('member').id] } }), 'access');
  check('changing access creates no version', access.currentVersion === 1 && access.accessMode === 'RESTRICTED' && access.allowedRoleIds.length === 1);
  await call('P4-API-04 return the writer agent to WORKSPACE access', 'PATCH', ws(w, `/agents/${writer.id}`), { actor: admin, org: w, body: { accessMode: 'WORKSPACE', allowedRoleIds: [] } });
  await call('P4-API-04 model outside the policy', 'PATCH', ws(w, `/agents/${scratch.id}`), { actor: admin, org: w, body: { model: 'llama3.1:8b' }, expect: 422, code: 'LLM_MODEL_NOT_ALLOWED' });

  const versions = await call('P4-API-08 version history', 'GET', ws(w, `/agents/${hrAgent.id}/versions`), { actor: member, org: w });
  sameKeys('version shape', versions.data?.[0], SHAPE.version);
  check('history newest first, only the newest current', JSON.stringify(versions.data?.map((v) => v.version)) === JSON.stringify([4, 3, 2, 1]) && versions.data?.filter((v) => v.isCurrent).length === 1 && versions.data?.[0].isCurrent);
  check('change notes recorded', versions.data?.[3]?.changeNote === 'Created.' && versions.data?.[2]?.changeNote === 'Formal tone for policy answers.');
  const capped = await call('P4-API-08 page size capped at 50', 'GET', ws(w, `/agents/${hrAgent.id}/versions?limit=100`), { actor: admin, org: w });
  check('versions limit=100 is answered with limit 50', capped.meta?.pagination?.limit === 50, capped.meta?.pagination);
  const v1 = need(await call('P4-API-09 one version', 'GET', ws(w, `/agents/${hrAgent.id}/versions/1`), { actor: admin, org: w }), 'v1');
  samples.agentVersion = { ...v1, instructions: `${v1.instructions.slice(0, 40)}…` };
  check('version 1: friendly tone, not current', v1.config.persona.tone === 'friendly' && v1.isCurrent === false && /^[0-9a-f]{64}$/.test(v1.configDigest));
  const viewerVersion = await call('P4-API-09 viewer reads a published agent\'s version', 'GET', ws(w, `/agents/${hrAgent.id}/versions/1`), { actor: viewer, org: w });
  check('agent:read holders can read the system prompt of agents they can see', viewerVersion.data?.instructions === instructions);
  await call('P4-API-09 version that does not exist', 'GET', ws(w, `/agents/${hrAgent.id}/versions/99`), { actor: admin, org: w, expect: 404, code: 'AGENT_VERSION_NOT_FOUND' });
  await call('P4-API-09 non-numeric version', 'GET', ws(w, `/agents/${hrAgent.id}/versions/abc`), { actor: admin, org: w, expect: 400, code: 'BAD_REQUEST' });
  await call('P4-API-10 member lacks agent:update', 'POST', ws(w, `/agents/${hrAgent.id}/versions/1/restore`), { actor: member, org: w, body: {}, expect: 403, code: 'PERMISSION_DENIED' });
  await call('P4-API-10 restoring the current version', 'POST', ws(w, `/agents/${hrAgent.id}/versions/4/restore`), { actor: admin, org: w, body: {}, expect: 422, code: 'VALIDATION_FAILED' });
  await call('P4-API-10 stale expectedVersion', 'POST', ws(w, `/agents/${hrAgent.id}/versions/1/restore`), { actor: admin, org: w, body: { expectedVersion: 3 }, expect: 409, code: 'AGENT_VERSION_CONFLICT' });
  await call('P4-API-10 version that does not exist', 'POST', ws(w, `/agents/${hrAgent.id}/versions/99/restore`), { actor: admin, org: w, body: {}, expect: 404, code: 'AGENT_VERSION_NOT_FOUND' });
  const restored = need(await call('P4-API-10 restore version 2', 'POST', ws(w, `/agents/${hrAgent.id}/versions/2/restore`), { actor: admin, org: w, body: { expectedVersion: 4 } }), 'restored');
  const v5 = need(await call('P4-API-09 the restored version', 'GET', ws(w, `/agents/${hrAgent.id}/versions/5`), { actor: admin, org: w }), 'v5');
  const v2 = need(await call('P4-API-09 version 2 for comparison', 'GET', ws(w, `/agents/${hrAgent.id}/versions/2`), { actor: admin, org: w }), 'v2');
  check('restore appends version 5, a copy of version 2 with the same digest', restored.currentVersion === 5 && v5.restoredFromVersion === 2 && v5.configDigest === v2.configDigest && v5.changeNote === 'Restored version 2.' && v5.isCurrent);
  check('the restored copy brought back version 2\'s parameters', JSON.stringify(restored.config.parameters) === JSON.stringify(v2.config.parameters), restored.config.parameters);

  // Prompt preview (no model call).
  const question = 'How many days of annual leave do I get, and what is the email address of the HR business partner?';
  const preview = await call('P4-API-11 prompt preview as owner', 'POST', ws(w, `/agents/${hrAgent.id}/prompt-preview`), { actor: owner, org: w, body: { content: question } });
  if (preview.data) {
    const p = preview.data;
    sameKeys('prompt preview shape', p, SHAPE.preview);
    sameKeys('context accounting shape', p.context, SHAPE.accounting);
    sameKeys('preview redaction shape', p.redaction, SHAPE.previewRedaction);
    sameKeys('preview retrieval shape', p.retrieval, SHAPE.previewRetrieval);
    const text = p.messages.map((m) => m.content).join('\n');
    check('preview: system message first, the question with context last', p.messages[0].role === 'system' && p.messages[p.messages.length - 1].role === 'user' && /<context>/.test(p.messages[p.messages.length - 1].content));
    check('preview: personal data from the documents is masked', !/imran\.siddiqui@acme\.test|Imran Siddiqui|7654321/.test(text) && /\[EMAIL_ADDRESS_1\]/.test(text), p.redaction.byType);
    check('preview: the gateway egress check finds nothing', Array.isArray(p.redaction.egressFindings) && p.redaction.egressFindings.length === 0);
    check('preview: the endpoint ceiling keeps CONFIDENTIAL text out even for the owner', p.retrieval.effectiveClearance === 'INTERNAL' && !/Band Zeta/.test(text), p.retrieval);
    check('preview: sources tagged S1… for citations', /<source tag="S1"/.test(text));
    samples.promptPreview = { ...p, messages: p.messages.map((m) => ({ role: m.role, content: m.content.length > 600 ? `${m.content.slice(0, 600)}…` : m.content })) };
    facts.previewAccounting = p.context;
  }
  const adminPreview = await call('P4-API-11 manager previews the compartment agent', 'POST', ws(w, `/agents/${casework.id}/prompt-preview`), { actor: admin, org: w, body: { content: 'What is the relocation stipend?' } });
  const authorPreview = await call('P4-API-11 author previews the compartment agent', 'POST', ws(w, `/agents/${casework.id}/prompt-preview`), { actor: author, org: w, body: { content: 'What is the relocation stipend?' } });
  check('an agent never widens access: the manager searches 1 base, the author 2', adminPreview.data?.retrieval?.knowledgeBasesSearched === 1 && authorPreview.data?.retrieval?.knowledgeBasesSearched === 2, { admin: adminPreview.data?.retrieval, author: authorPreview.data?.retrieval });
  // The amount itself is masked ([SALARY_1]); the unmasked wording of the HR-only passage marks it.
  check('the HR-only passage reaches only the author\'s prompt', !/two instalments/.test(JSON.stringify(adminPreview.data?.messages ?? [])) && /two instalments/.test(JSON.stringify(authorPreview.data?.messages ?? [])));
  check('the stipend amount is masked in the author\'s prompt', !/275,000/.test(JSON.stringify(authorPreview.data?.messages ?? [])) && /\[SALARY_\d+\]/.test(JSON.stringify(authorPreview.data?.messages ?? [])));
  await call('P4-API-11 viewer lacks agent:execute', 'POST', ws(w, `/agents/${hrAgent.id}/prompt-preview`), { actor: viewer, org: w, body: { content: question }, expect: 403, code: 'PERMISSION_DENIED' });
  await call('P4-API-11 member cannot preview a RESTRICTED agent', 'POST', ws(w, `/agents/${casework.id}/prompt-preview`), { actor: member, org: w, body: { content: 'x' }, expect: 404, code: 'AGENT_NOT_FOUND' });
  await call('P4-API-11 message over AGENT_MAX_MESSAGE_LENGTH', 'POST', ws(w, `/agents/${hrAgent.id}/prompt-preview`), { actor: owner, org: w, body: { content: 'a'.repeat(16_001) }, expect: 422, code: 'VALIDATION_FAILED' });

  // ── Conversations (P4-API-12–19) ────────────────────────────────────────
  await call('P4-API-13 viewer lacks agent:execute', 'POST', ws(w, '/conversations'), { actor: viewer, org: w, body: { agentId: hrAgent.id }, expect: 403, code: 'PERMISSION_DENIED' });
  await call('P4-API-13 RESTRICTED agent is invisible', 'POST', ws(w, '/conversations'), { actor: member, org: w, body: { agentId: casework.id }, expect: 404, code: 'AGENT_NOT_FOUND' });
  await call('P4-API-13 unknown field', 'POST', ws(w, '/conversations'), { actor: member, org: w, body: { agentId: hrAgent.id, model: 'x' }, expect: 422, code: 'VALIDATION_FAILED' });
  const c1 = need(await call('P4-API-13 start a conversation', 'POST', ws(w, '/conversations'), { actor: member, org: w, body: { agentId: hrAgent.id }, expect: 201 }), 'c1');
  samples.newConversation = c1;
  sameKeys('conversation shape', c1, SHAPE.conversation);
  check('new conversation: untitled, empty, PUBLIC, owned by the member', c1.title === null && c1.messageCount === 0 && c1.classification === 'PUBLIC' && c1.isOwner && c1.ownerKind === 'user' && c1.ownerUserId === member.user.id && c1.agentName === 'HR Policy Assistant');

  const t1 = await call('P4-API-18 send a message', 'POST', ws(w, `/conversations/${c1.id}/messages`), {
    actor: member, org: w, body: { content: question, clientMessageId: crypto.randomUUID() },
  });
  if (t1.data) {
    const turn = t1.data;
    facts.turns.push({ label: 'first grounded turn', timings: turn.timings, usage: turn.usage, retrieval: turn.retrieval });
    samples.turnResult = turn;
    sameKeys('turn result shape', turn, SHAPE.turn);
    sameKeys('message shape (user)', turn.userMessage, SHAPE.message);
    sameKeys('message shape (assistant)', turn.assistantMessage, SHAPE.message);
    sameKeys('turn timings shape', turn.timings, SHAPE.turnTimings);
    sameKeys('turn retrieval shape', turn.retrieval, SHAPE.turnRetrieval);
    sameKeys('turn context shape', turn.context, SHAPE.accounting);
    if (turn.assistantMessage.citations[0]) sameKeys('citation shape', turn.assistantMessage.citations[0], SHAPE.citation);
    sameKeys('assistant redaction shape', turn.assistantMessage.redaction, SHAPE.messageRedaction);
    check('user message 1 and answer 2, both COMPLETE and VISIBLE', turn.userMessage.sequence === 1 && turn.assistantMessage.sequence === 2 && turn.assistantMessage.status === 'COMPLETE' && turn.assistantMessage.contentState === 'VISIBLE' && turn.userMessage.redaction === null);
    check('the answer records agent version and model', turn.assistantMessage.agentVersion === 5 && turn.assistantMessage.model === modelName);
    check('retrieval ran as the member, capped at INTERNAL', turn.retrieval.passagesProvided > 0 && turn.retrieval.effectiveClearance === 'INTERNAL' && !!turn.retrieval.retrievalId);
    const answer = turn.assistantMessage.content;
    check('citations: `cited` is true exactly when the answer contains its tag', turn.assistantMessage.citations.every((c) => c.cited === answer.includes(`[${c.tag}]`)) && turn.retrieval.passagesCited === turn.assistantMessage.citations.filter((c) => c.cited).length);
    check('citations carry live document titles', turn.assistantMessage.citations.every((c) => typeof c.documentTitle === 'string'));
    check('the CONFIDENTIAL document is never cited', turn.assistantMessage.citations.every((c) => c.documentId !== uploaded.salary.id));
    check('the answer has no leftover placeholder', !PLACEHOLDER.test(answer), answer);
    check('masking happened for the turn', turn.assistantMessage.redaction.enabled && turn.assistantMessage.redaction.entities >= 1, turn.assistantMessage.redaction);
    observe('grounded answer content', { answer, mentions24: /\b24\b|twenty[- ]four/i.test(answer), mentionsEmail: /imran\.siddiqui@acme\.test/.test(answer), cited: turn.retrieval.passagesCited });
  }
  const dupKey = crypto.randomUUID();
  const t2 = await call('P4-API-18 send with retrieval switched off', 'POST', ws(w, `/conversations/${c1.id}/messages`), {
    actor: member, org: w, body: { content: 'Thanks. Reply with one short sentence.', clientMessageId: dupKey, retrieval: { enabled: false }, parameters: { maxOutputTokens: 60 } },
  });
  if (t2.data) {
    check('retrieval override: no passages, no retrieval id', t2.data.retrieval.passagesProvided === 0 && t2.data.retrieval.retrievalId === null && t2.data.assistantMessage.citations.length === 0);
    check('history from the first turn was included', t2.data.context.historyIncluded >= 2, t2.data.context);
  }
  const dup = await call('P4-API-18 resend with the same clientMessageId', 'POST', ws(w, `/conversations/${c1.id}/messages`), { actor: member, org: w, body: { content: 'Thanks. Reply with one short sentence.', clientMessageId: dupKey }, expect: 409, code: 'MESSAGE_DUPLICATE' });
  check('duplicate refusal points at the stored message', dup.error?.details?.messageId === t2.data?.userMessage?.id, dup.error?.details);
  const narrowed = await call('P4-API-18 narrow retrieval to a base the agent does not use', 'POST', ws(w, `/conversations/${c1.id}/messages`), {
    actor: member, org: w, body: { content: 'Which office hours apply? One sentence.', retrieval: { knowledgeBaseIds: [hrBase.id] }, parameters: { maxOutputTokens: 80 } },
  });
  check('narrowing intersects with the agent\'s bases (none left: no retrieval)', narrowed.data?.retrieval?.passagesProvided === 0);
  await call('P4-API-18 message over AGENT_MAX_MESSAGE_LENGTH', 'POST', ws(w, `/conversations/${c1.id}/messages`), { actor: member, org: w, body: { content: 'a'.repeat(16_001) }, expect: 422, code: 'VALIDATION_FAILED' });
  await call('P4-API-18 viewer lacks agent:execute', 'POST', ws(w, `/conversations/${c1.id}/messages`), { actor: viewer, org: w, body: { content: 'hi' }, expect: 403, code: 'PERMISSION_DENIED' });
  await call('P4-API-18 someone else\'s conversation', 'POST', ws(w, `/conversations/${c1.id}/messages`), { actor: admin, org: w, body: { content: 'hi' }, expect: 404, code: 'CONVERSATION_NOT_FOUND' });
  await call('P4-API-18 unknown parameter override', 'POST', ws(w, `/conversations/${c1.id}/messages`), { actor: member, org: w, body: { content: 'hi', parameters: { topP: 0.5 } }, expect: 422, code: 'VALIDATION_FAILED' });

  // One turn at a time.
  const [busyA, busyB] = await Promise.all([
    call('P4-API-18 concurrent send A', 'POST', ws(w, `/conversations/${c1.id}/messages`), { actor: member, org: w, body: { content: 'Where do I submit leave requests? One sentence.', parameters: { maxOutputTokens: 80 } }, expect: [200, 409] }),
    (async () => {
      await sleep(400);
      return call('P4-API-18 concurrent send B', 'POST', ws(w, `/conversations/${c1.id}/messages`), { actor: member, org: w, body: { content: 'And how many sick days? One sentence.', parameters: { maxOutputTokens: 80 } }, expect: [200, 409] });
    })(),
  ]);
  check('a second send while a turn runs gets 409 CONVERSATION_BUSY', [busyA, busyB].filter((r) => r.error?.code === 'CONVERSATION_BUSY').length === 1 && [busyA, busyB].filter((r) => r.status === 200).length === 1, [busyA.status, busyB.status]);

  // Streaming a turn.
  const s1 = await stream('P4-API-19 stream a turn', ws(w, `/conversations/${c1.id}/messages/stream`), {
    actor: member, org: w, body: { content: 'Who is the HR business partner, and how many leave days carry over?', clientMessageId: crypto.randomUUID() },
  });
  traces.turnStream = traceOf(s1.events);
  facts.turnStreamRaw = s1.raw;
  const turnNames = eventNames(s1.events);
  facts.turnStreamOrder = turnNames;
  check('turn stream order: meta, retrieving, redacting, queued, generating, deltas, done', JSON.stringify(turnNames.filter((n) => n !== 'status:thinking')) === JSON.stringify(['meta', 'status:retrieving', 'status:redacting', 'status:queued', 'status:generating', 'delta', 'done']), turnNames);
  if (s1.meta && s1.done) {
    sameKeys('turn stream meta shape', s1.meta, SHAPE.turnMeta);
    sameKeys('turn stream done equals the non-streaming body', s1.done, SHAPE.turn);
    check('meta announces the ids done confirms', s1.meta.userMessageId === s1.done.userMessage.id && s1.meta.assistantMessageId === s1.done.assistantMessage.id && s1.meta.agentVersion === s1.done.assistantMessage.agentVersion);
    const deltas = s1.events.filter((entry) => entry.event === 'delta').map((entry) => entry.data.text).join('');
    check('turn deltas concatenate to the stored answer', deltas === s1.done.assistantMessage.content, { deltas: deltas.length, content: s1.done.assistantMessage.content.length });
    check('streamed deltas never end inside a placeholder', s1.events.filter((e) => e.event === 'delta').every((e) => !/\[[A-Z_]*\d*$/.test(e.data.text)));
    facts.turns.push({ label: 'streamed turn', timings: s1.done.timings, usage: s1.done.usage, firstDeltaAtMs: s1.events.find((e) => e.event === 'delta')?.atMs, doneAtMs: s1.events.find((e) => e.event === 'done')?.atMs });
    observe('streamed answer content', { answer: s1.done.assistantMessage.content });
  }
  await stream('P4-API-19 viewer refused before the stream opens', ws(w, `/conversations/${c1.id}/messages/stream`), { actor: viewer, org: w, body: { content: 'hi' }, expect: 403, code: 'PERMISSION_DENIED' });
  await stream('P4-API-19 too long, refused before the stream opens', ws(w, `/conversations/${c1.id}/messages/stream`), { actor: member, org: w, body: { content: 'a'.repeat(16_001) }, expect: 422, code: 'VALIDATION_FAILED' });

  // Messages and paging.
  const page = need(await call('P4-API-17 read messages', 'GET', ws(w, `/conversations/${c1.id}/messages`), { actor: member, org: w }), 'page');
  samples.messagePage = { ...page, messages: page.messages.slice(0, 2) };
  sameKeys('message page shape', page, SHAPE.page);
  check('messages chronological, all VISIBLE to their owner', page.messages.every((m, i) => i === 0 || m.sequence > page.messages[i - 1].sequence) && page.messages.every((m) => m.contentState === 'VISIBLE') && page.masked === false && page.revealed === false);
  const total = page.messages.length;
  const older = need(await call('P4-API-17 newest page of two', 'GET', ws(w, `/conversations/${c1.id}/messages?limit=2`), { actor: member, org: w }), 'limit 2');
  check('limit returns the newest messages and a cursor', older.messages.length === 2 && older.messages[1].sequence === page.messages[total - 1].sequence && older.nextBefore === older.messages[0].sequence);
  const previous = need(await call('P4-API-17 previous page with before', 'GET', ws(w, `/conversations/${c1.id}/messages?limit=2&before=${older.nextBefore}`), { actor: member, org: w }), 'before');
  check('before pages backwards', previous.messages.every((m) => m.sequence < older.nextBefore) && previous.messages.length === 2);
  const firstPage = need(await call('P4-API-17 oldest page', 'GET', ws(w, `/conversations/${c1.id}/messages?limit=100&before=3`), { actor: member, org: w }), 'oldest');
  check('a short page ends paging (nextBefore null)', firstPage.nextBefore === null && firstPage.messages.length === 2);
  await call('P4-API-17 limit above 100', 'GET', ws(w, `/conversations/${c1.id}/messages?limit=101`), { actor: member, org: w, expect: 422, code: 'VALIDATION_FAILED' });
  const ownReveal = need(await call('P4-API-17 reveal on your own conversation is ignored', 'GET', ws(w, `/conversations/${c1.id}/messages?reveal=true`), { actor: member, org: w }), 'own reveal');
  check('owners never need reveal', ownReveal.revealed === false);
  await call('P4-API-17 another member\'s conversation', 'GET', ws(w, `/conversations/${c1.id}/messages`), { actor: author, org: w, expect: 404, code: 'CONVERSATION_NOT_FOUND' });

  // A titled conversation whose title holds a name, for supervision.
  const c2 = need(await call('P4-API-13 conversation titled by its first message', 'POST', ws(w, '/conversations'), { actor: member, org: w, body: { agentId: hrAgent.id }, expect: 201 }), 'c2');
  await call('P4-API-18 first message carries a name', 'POST', ws(w, `/conversations/${c2.id}/messages`), { actor: member, org: w, body: { content: 'Is Imran Siddiqui still the HR contact for leave? One sentence.', parameters: { maxOutputTokens: 80 } } });
  const c2read = need(await call('P4-API-14 owner reads the derived title', 'GET', ws(w, `/conversations/${c2.id}`), { actor: member, org: w }), 'c2 read');
  check('title derived from the first message', c2read.title === 'Is Imran Siddiqui still the HR contact for leave? One sentence.' && c2read.messageCount === 2 && c2read.classification === 'INTERNAL', c2read);

  // Supervision.
  const supervised = need(await call('P4-API-14 supervisor reads the conversation', 'GET', ws(w, `/conversations/${c2.id}`), { actor: admin, org: w }), 'supervised');
  check('supervisor sees the title masked and isOwner false', supervised.isOwner === false && !!supervised.title && !supervised.title.includes('Imran Siddiqui') && /\[PERSON_1\]/.test(supervised.title), supervised.title);
  const allList = need(await call('P4-API-12 list everyone\'s conversations', 'GET', ws(w, '/conversations?scope=all'), { actor: admin, org: w }), 'all list');
  check('scope=all lists other members\' conversations, titles masked', allList.some((c) => c.id === c2.id && !c.isOwner && !String(c.title).includes('Imran Siddiqui')));
  await call('P4-API-12 scope=all needs conversation:read_all', 'GET', ws(w, '/conversations?scope=all'), { actor: member, org: w, expect: 403, code: 'PERMISSION_DENIED' });
  const maskedPage = need(await call('P4-API-17 supervisor reads messages (masked)', 'GET', ws(w, `/conversations/${c2.id}/messages`), { actor: admin, org: w }), 'masked');
  samples.supervisedPage = maskedPage;
  check('supervised messages are MASKED and personal data replaced', maskedPage.masked === true && maskedPage.messages.every((m) => m.contentState === 'MASKED') && !JSON.stringify(maskedPage.messages).includes('Imran Siddiqui'));
  await call('P4-API-17 reveal without pii:reveal', 'GET', ws(w, `/conversations/${c2.id}/messages?reveal=true`), { actor: admin, org: w, expect: 403, code: 'PERMISSION_DENIED' });
  const revealed = need(await call('P4-API-17 owner of the workspace reveals', 'GET', ws(w, `/conversations/${c2.id}/messages?reveal=true`), { actor: owner, org: w }), 'revealed');
  check('reveal shows VISIBLE content and says so', revealed.revealed === true && revealed.masked === false && revealed.messages.every((m) => m.contentState === 'VISIBLE'));
  await call('P4-API-14 another member cannot read it', 'GET', ws(w, `/conversations/${c2.id}`), { actor: author, org: w, expect: 404, code: 'CONVERSATION_NOT_FOUND' });
  await call('P4-API-14 unknown conversation', 'GET', ws(w, `/conversations/${crypto.randomUUID()}`), { actor: member, org: w, expect: 404, code: 'CONVERSATION_NOT_FOUND' });
  await call('P4-API-14 malformed id', 'GET', ws(w, '/conversations/42'), { actor: member, org: w, expect: 400, code: 'BAD_REQUEST' });

  // Compartment labels: the author's answer drew on HR Casework.
  const c3 = need(await call('P4-API-13 author talks to their RESTRICTED agent', 'POST', ws(w, '/conversations'), { actor: author, org: w, body: { agentId: casework.id }, expect: 201 }), 'c3');
  const t3 = await call('P4-API-18 author asks a compartment question', 'POST', ws(w, `/conversations/${c3.id}/messages`), { actor: author, org: w, body: { content: 'What is the 2026 relocation stipend? One sentence.' } });
  if (t3.data) {
    check('the answer is labelled with the compartment it drew on', t3.data.retrieval.passagesProvided > 0 && t3.data.assistantMessage.citations.some((c) => c.knowledgeBaseId === hrBase.id));
    observe('compartment answer', { answer: t3.data.assistantMessage.content });
  }
  const compartment = need(await call('P4-API-17 supervisor without the compartment', 'GET', ws(w, `/conversations/${c3.id}/messages`), { actor: admin, org: w }), 'compartment');
  const withheld = compartment.messages.find((m) => m.role === 'ASSISTANT');
  samples.withheldCompartment = withheld;
  check('compartment answer WITHHELD for the supervisor: no content, citations or tool calls', withheld?.contentState === 'WITHHELD' && withheld.withheldReason === 'COMPARTMENT' && withheld.content === null && withheld.citations.length === 0, withheld);
  const ownerSees = need(await call('P4-API-17 owner (bypasses compartments) reads it', 'GET', ws(w, `/conversations/${c3.id}/messages`), { actor: owner, org: w }), 'owner sees');
  check('the owner sees it masked, not withheld', ownerSees.messages.every((m) => m.contentState === 'MASKED'));

  // Source deleted: an answer that cited a deleted document is withdrawn.
  const c4 = need(await call('P4-API-13 travel conversation', 'POST', ws(w, '/conversations'), { actor: member, org: w, body: { agentId: hrAgent.id, title: 'Travel allowance' }, expect: 201 }), 'c4');
  check('an explicit title is kept', c4.title === 'Travel allowance');
  const t4 = await call('P4-API-18 travel question', 'POST', ws(w, `/conversations/${c4.id}/messages`), { actor: member, org: w, body: { content: 'What is the daily meal allowance for domestic travel? One sentence.' } });
  const travelCited = t4.data?.assistantMessage?.citations?.some((c) => c.documentId === uploaded.travel.id);
  check('the travel answer drew on the travel FAQ', travelCited, t4.data?.assistantMessage?.citations?.map((c) => c.documentTitle));
  await call('fixture: owner deletes the travel FAQ document', 'DELETE', ws(w, `/documents/${uploaded.travel.id}`), { actor: owner, org: w });
  const afterDelete = need(await call('P4-API-17 owner of the conversation after the source was deleted', 'GET', ws(w, `/conversations/${c4.id}/messages`), { actor: member, org: w }), 'after delete');
  const gone = afterDelete.messages.find((m) => m.role === 'ASSISTANT');
  const own = afterDelete.messages.find((m) => m.role === 'USER');
  check('answer WITHHELD with SOURCE_DELETED; the member\'s own question stays VISIBLE', gone?.contentState === 'WITHHELD' && gone.withheldReason === 'SOURCE_DELETED' && own?.contentState === 'VISIBLE', { assistant: gone?.contentState, reason: gone?.withheldReason, user: own?.contentState });
  const t4b = await call('P4-API-18 next turn leaves the withdrawn answer out of history', 'POST', ws(w, `/conversations/${c4.id}/messages`), { actor: member, org: w, body: { content: 'Thanks. One short sentence please.', retrieval: { enabled: false }, parameters: { maxOutputTokens: 60 } } });
  check('history excludes the withdrawn answer', t4b.data?.context?.historyExcluded >= 1, t4b.data?.context);

  // Clearance labels: an auditor role with no clearance reads INTERNAL answers.
  const auditorRole = need(await call('fixture: create a Conversation Auditor role (no clearance)', 'POST', ws(w, '/roles'), {
    actor: owner, org: w, expect: 201,
    body: { name: `Conversation Auditor ${run.slice(-6)}`, priority: 30, color: '#64748B', permissionKeys: ['workspace:read', 'agent:read', 'conversation:read', 'conversation:read_all'] },
  }), 'auditor role');
  await call('fixture: make the viewer an auditor', 'PUT', ws(w, `/members/${viewer.member.id}/roles`), { actor: owner, org: w, body: { roleIds: [auditorRole.id] } });
  const clearance = need(await call('P4-API-17 auditor without clearance', 'GET', ws(w, `/conversations/${c2.id}/messages`), { actor: viewer, org: w }), 'clearance');
  check('INTERNAL answers WITHHELD with CLEARANCE; the PUBLIC first question shown masked', clearance.messages.some((m) => m.withheldReason === 'CLEARANCE') && clearance.messages[0].contentState === 'MASKED', clearance.messages.map((m) => `${m.role}:${m.classification}:${m.contentState}:${m.withheldReason ?? ''}`));

  // Rename, archive.
  const renamed = need(await call('P4-API-15 rename', 'PATCH', ws(w, `/conversations/${c1.id}`), { actor: member, org: w, body: { title: 'Leave questions' } }), 'renamed');
  check('renamed', renamed.title === 'Leave questions');
  const archived = need(await call('P4-API-15 archive', 'PATCH', ws(w, `/conversations/${c1.id}`), { actor: member, org: w, body: { status: 'ARCHIVED' } }), 'archived');
  check('archived', archived.status === 'ARCHIVED');
  await call('P4-API-18 sending to an archived conversation', 'POST', ws(w, `/conversations/${c1.id}/messages`), { actor: member, org: w, body: { content: 'hi' }, expect: 409, code: 'CONVERSATION_ARCHIVED' });
  await stream('P4-API-19 archived, refused before the stream opens', ws(w, `/conversations/${c1.id}/messages/stream`), { actor: member, org: w, body: { content: 'hi' }, expect: 409, code: 'CONVERSATION_ARCHIVED' });
  const archivedList = need(await call('P4-API-12 filter by status', 'GET', ws(w, '/conversations?status=ARCHIVED'), { actor: member, org: w }), 'archived list');
  check('status filter', archivedList.length === 1 && archivedList[0].id === c1.id);
  await call('P4-API-15 unarchive', 'PATCH', ws(w, `/conversations/${c1.id}`), { actor: member, org: w, body: { status: 'ACTIVE' } });
  await call('P4-API-15 supervisor cannot rename', 'PATCH', ws(w, `/conversations/${c1.id}`), { actor: admin, org: w, body: { title: 'x' }, expect: 404, code: 'CONVERSATION_NOT_FOUND' });
  await call('P4-API-15 empty title', 'PATCH', ws(w, `/conversations/${c1.id}`), { actor: member, org: w, body: { title: '' }, expect: 422, code: 'VALIDATION_FAILED' });
  await call('P4-API-15 unknown status', 'PATCH', ws(w, `/conversations/${c1.id}`), { actor: member, org: w, body: { status: 'DELETED' }, expect: 422, code: 'VALIDATION_FAILED' });
  const mine = need(await call('P4-API-12 list my conversations', 'GET', ws(w, '/conversations'), { actor: member, org: w }), 'mine');
  check('mine: newest activity first', mine.every((c) => c.isOwner) && mine.every((c, i) => i === 0 || new Date(c.lastMessageAt ?? 0) <= new Date(mine[i - 1].lastMessageAt ?? 0)), mine.map((c) => c.lastMessageAt));
  const byAgent = need(await call('P4-API-12 filter by agent', 'GET', ws(w, `/conversations?agentId=${casework.id}`), { actor: author, org: w }), 'by agent');
  check('agent filter', byAgent.length === 1 && byAgent[0].id === c3.id);

  // Cancellation: the client stops a streamed answer.
  const c5 = need(await call('P4-API-13 owner talks to the writer agent', 'POST', ws(w, '/conversations'), { actor: owner, org: w, body: { agentId: writer.id }, expect: 201 }), 'c5');
  const aborted = await stream('P4-API-19 client disconnects mid-answer', ws(w, `/conversations/${c5.id}/messages/stream`), {
    actor: owner, org: w,
    body: { content: 'Write the numbers from one to three hundred in English words, separated by commas.' },
    abortWhen: (entry) => entry.event === 'delta',
  });
  traces.abortedTurn = traceOf(aborted.events);
  let stored = null;
  for (let attempt = 0; attempt < 10 && !stored; attempt += 1) {
    await sleep(1500);
    const read = await call('P4-API-17 read after the disconnect', 'GET', ws(w, `/conversations/${c5.id}/messages`), { actor: owner, org: w, quiet: true });
    stored = read.data?.messages?.find((m) => m.id === aborted.meta?.assistantMessageId) ?? null;
  }
  facts.cancelledMessage = stored && { status: stored.status, errorCode: stored.errorCode, contentChars: stored.content?.length ?? 0 };
  check('the partial answer is kept as a CANCELLED message (REQUEST_TIMEOUT)', stored?.status === 'CANCELLED' && stored.errorCode === 'REQUEST_TIMEOUT', facts.cancelledMessage);
  const afterAbort = await call('P4-API-18 the turn lease was released', 'POST', ws(w, `/conversations/${c5.id}/messages`), { actor: owner, org: w, body: { content: 'Reply with one word: ready', parameters: { maxOutputTokens: 30 } } });
  check('history skips the cancelled answer', afterAbort.data?.context?.historyIncluded === 1 || afterAbort.data?.context?.historyIncluded === 0, afterAbort.data?.context);

  // A tool call, streamed.
  if (calcAgent) {
    await sleep(20_000); // leave room in the token rate for a two-call answer
    const c6 = need(await call('P4-API-13 owner talks to the calculator agent', 'POST', ws(w, '/conversations'), { actor: owner, org: w, body: { agentId: calcAgent.id }, expect: 201 }), 'c6');
    const toolTurn = await stream('P4-API-19 a turn that calls a tool', ws(w, `/conversations/${c6.id}/messages/stream`), { actor: owner, org: w, body: { content: 'What is 48293 multiplied by 7719?' } });
    traces.toolTurn = traceOf(toolTurn.events);
    const toolEvent = toolTurn.events.find((entry) => entry.event === 'tool');
    const toolStatus = toolTurn.events.find((entry) => entry.event === 'status' && entry.data.stage === 'tool');
    observe('model called the tool', { called: !!toolEvent, answer: toolTurn.done?.assistantMessage?.content });
    if (toolEvent) {
      check('tool status names the tool and iteration', toolStatus?.data?.tool === 'calculator' && toolStatus?.data?.iteration === 1, toolStatus?.data);
      check('tool event: executionId, tool, status, durationMs; no arguments or result', ['durationMs', 'executionId', 'status', 'tool'].every((k) => k in toolEvent.data) && !('arguments' in toolEvent.data) && !('result' in toolEvent.data), toolEvent.data);
      check('the stored answer lists the tool call', toolTurn.done?.assistantMessage?.toolCalls?.[0]?.executionId === toolEvent.data.executionId);
      observe('calculator result in the answer', { correct: /372,?773,?667/.test(toolTurn.done?.assistantMessage?.content ?? '') });
    }
  }

  // Agent lifecycle: unpublish and delete with existing conversations.
  await call('P4-API-07 member lacks agent:publish', 'POST', ws(w, `/agents/${hrAgent.id}/unpublish`), { actor: member, org: w, expect: 403, code: 'PERMISSION_DENIED' });
  const unpublished = need(await call('P4-API-07 unpublish', 'POST', ws(w, `/agents/${hrAgent.id}/unpublish`), { actor: admin, org: w }), 'unpublished');
  check('unpublished: PRIVATE, publishedAt cleared', unpublished.visibility === 'PRIVATE' && unpublished.publishedAt === null);
  await call('P4-API-07 unpublish again is a no-op', 'POST', ws(w, `/agents/${hrAgent.id}/unpublish`), { actor: admin, org: w });
  await call('P4-API-03 member loses the unpublished agent', 'GET', ws(w, `/agents/${hrAgent.id}`), { actor: member, org: w, expect: 404, code: 'AGENT_NOT_FOUND' });
  await call('P4-API-14 the conversation stays readable', 'GET', ws(w, `/conversations/${c1.id}`), { actor: member, org: w });
  await call('P4-API-17 its messages stay readable', 'GET', ws(w, `/conversations/${c1.id}/messages`), { actor: member, org: w });
  await call('P4-API-18 but no new turn runs', 'POST', ws(w, `/conversations/${c1.id}/messages`), { actor: member, org: w, body: { content: 'hi' }, expect: 404, code: 'AGENT_NOT_FOUND' });
  await call('P4-API-06 republish', 'POST', ws(w, `/agents/${hrAgent.id}/publish`), { actor: admin, org: w });

  const c7 = need(await call('P4-API-13 conversation with the scratch agent', 'POST', ws(w, '/conversations'), { actor: member, org: w, body: { agentId: scratch.id }, expect: 201 }), 'c7');
  await call('P4-API-05 member lacks agent:delete', 'DELETE', ws(w, `/agents/${scratch.id}`), { actor: member, org: w, expect: 403, code: 'PERMISSION_DENIED' });
  const deleted = await call('P4-API-05 delete', 'DELETE', ws(w, `/agents/${scratch.id}`), { actor: admin, org: w });
  check('delete answers {deleted: true}', deleted.data?.deleted === true);
  await call('P4-API-03 a deleted agent is gone', 'GET', ws(w, `/agents/${scratch.id}`), { actor: admin, org: w, expect: 404, code: 'AGENT_NOT_FOUND' });
  await call('P4-API-08 its versions are gone', 'GET', ws(w, `/agents/${scratch.id}/versions`), { actor: admin, org: w, expect: 404, code: 'AGENT_NOT_FOUND' });
  await call('P4-API-05 deleting again', 'DELETE', ws(w, `/agents/${scratch.id}`), { actor: admin, org: w, expect: 404, code: 'AGENT_NOT_FOUND' });
  const orphan = need(await call('P4-API-14 its conversation stays readable', 'GET', ws(w, `/conversations/${c7.id}`), { actor: member, org: w }), 'orphan');
  check('the conversation keeps the deleted agent\'s name', orphan.agentName === 'Scratch Agent');
  await call('P4-API-18 sending to it', 'POST', ws(w, `/conversations/${c7.id}/messages`), { actor: member, org: w, body: { content: 'hi' }, expect: 409, code: 'AGENT_UNAVAILABLE' });
  await stream('P4-API-19 streaming to it, refused before the stream opens', ws(w, `/conversations/${c7.id}/messages/stream`), { actor: member, org: w, body: { content: 'hi' }, expect: 409, code: 'AGENT_UNAVAILABLE' });
  await call('P4-API-13 starting a conversation with a deleted agent', 'POST', ws(w, '/conversations'), { actor: member, org: w, body: { agentId: scratch.id }, expect: 409, code: 'AGENT_UNAVAILABLE' });
  const reused = await call('P4-API-02 a deleted agent\'s name is free again', 'POST', ws(w, '/agents'), { actor: admin, org: w, body: { name: 'Scratch Agent' }, expect: 201 });
  if (reused.data) await call('P4-API-05 delete the replacement', 'DELETE', ws(w, `/agents/${reused.data.id}`), { actor: admin, org: w });

  // Deleting conversations.
  await call('P4-API-16 viewer (now auditor) lacks conversation:delete', 'DELETE', ws(w, `/conversations/${c2.id}`), { actor: viewer, org: w, expect: 403, code: 'PERMISSION_DENIED' });
  await call('P4-API-16 another member cannot delete it', 'DELETE', ws(w, `/conversations/${c2.id}`), { actor: author, org: w, expect: 404, code: 'CONVERSATION_NOT_FOUND' });
  const removed = await call('P4-API-16 owner deletes their conversation', 'DELETE', ws(w, `/conversations/${c7.id}`), { actor: member, org: w });
  check('conversation delete answers {deleted: true}', removed.data?.deleted === true);
  await call('P4-API-14 a deleted conversation is gone', 'GET', ws(w, `/conversations/${c7.id}`), { actor: member, org: w, expect: 404, code: 'CONVERSATION_NOT_FOUND' });
  await call('P4-API-16 deleting again', 'DELETE', ws(w, `/conversations/${c7.id}`), { actor: member, org: w, expect: 404, code: 'CONVERSATION_NOT_FOUND' });
  await call('P4-API-16 a supervisor with conversation:delete deletes someone else\'s', 'DELETE', ws(w, `/conversations/${c3.id}`), { actor: admin, org: w });
  await call('P4-API-14 gone for its owner too', 'GET', ws(w, `/conversations/${c3.id}`), { actor: author, org: w, expect: 404, code: 'CONVERSATION_NOT_FOUND' });

  // API keys: a machine principal can talk to agents; the browser never sends one.
  const key = await call('fixture: issue an API key (Phase 2 endpoint)', 'POST', ws(w, '/api-keys'), {
    actor: owner, org: w, expect: 201, body: { name: `Phase 4 key ${run.slice(-6)}`, scopes: ['agent:read', 'agent:execute', 'conversation:read', 'llm:invoke'] },
  });
  if (key.data?.plaintextKey) {
    apiKeys.push({ id: key.data.apiKey.id, org: w });
    const k = key.data.plaintextKey;
    const keyAgents = await call('P4-API-01 list with an API key', 'GET', ws(w, '/agents'), { apiKey: k, org: w });
    check('an API key cannot see a RESTRICTED agent', (keyAgents.data ?? []).every((a) => a.id !== casework.id) && (keyAgents.data ?? []).some((a) => a.id === hrAgent.id));
    const keyConversation = await call('P4-API-13 API key starts a conversation', 'POST', ws(w, '/conversations'), { apiKey: k, org: w, body: { agentId: hrAgent.id }, expect: 201 });
    check('API-key conversations are owned by the key', keyConversation.data?.ownerKind === 'api_key' && keyConversation.data?.ownerUserId === null);
    const supervisedKeys = need(await call('P4-API-12 supervisor sees the key\'s conversation', 'GET', ws(w, '/conversations?scope=all'), { actor: admin, org: w }), 'with key');
    check('ownerKind api_key in the supervisor list', supervisedKeys.some((c) => c.id === keyConversation.data?.id && c.ownerKind === 'api_key' && !c.isOwner));
    await call('P4-API-04 bearer-only routes refuse API keys', 'PATCH', ws(w, `/agents/${hrAgent.id}`), { apiKey: k, org: w, body: { description: 'x' }, expect: 401, code: 'AUTH_SCHEME_NOT_ALLOWED' });
    await call('P4-API-24 policy changes refuse API keys', 'PUT', ws(w, '/llm/policy'), { apiKey: k, org: w, body: { maxOutputTokens: 100 }, expect: 401, code: 'AUTH_SCHEME_NOT_ALLOWED' });
  }

  // Tenant isolation.
  await call('P4-API-01 a non-member', 'GET', ws(w, '/agents'), { actor: outsider, org: w, expect: 404, code: 'ORGANIZATION_NOT_FOUND' });
  await call('P4-API-14 another tenant\'s conversation id', 'GET', ws(x, `/conversations/${c2.id}`), { actor: outsider, org: x, expect: 404, code: 'CONVERSATION_NOT_FOUND' });
  await call('P4-API-11 another tenant\'s agent id', 'POST', ws(x, `/agents/${hrAgent.id}/prompt-preview`), { actor: outsider, org: x, body: { content: 'x' }, expect: 404, code: 'AGENT_NOT_FOUND' });
  const xPolicy = need(await call('P4-API-23 the other tenant keeps the default policy', 'GET', ws(x, '/llm/policy'), { actor: outsider, org: x }), 'x policy');
  check('model policy is per workspace', xPolicy.source === 'default');

  if (INJECT_OUTAGE) await outage({ owner, admin, member, w, hrAgent, writer, c2, modelName });

  // ── Usage (P4-API-25) ───────────────────────────────────────────────────
  const usage = need(await call('P4-API-25 usage as member', 'GET', ws(w, '/llm/usage'), { actor: member, org: w }), 'usage');
  samples.usage = usage;
  sameKeys('usage shape', usage, SHAPE.usageSummary);
  sameKeys('usage totals shape', usage.totals, SHAPE.usageTotals);
  check('ledger counted completed, cancelled and throttled calls', usage.totals.completed >= 10 && usage.totals.cancelled >= 1 && usage.totals.throttled >= 1, usage.totals);
  check('usage by agent names the agents, null for direct chat', usage.byAgent.some((row) => row.agentId === hrAgent.id) && usage.byAgent.some((row) => row.agentId === null));
  check('usage by model', usage.byModel.some((row) => row.model === modelName));
  check('redaction overhead reported as percentiles and a share', usage.redactionOverhead.p50Ms !== null && usage.redactionOverhead.shareOfTotal > 0 && usage.redactionOverhead.shareOfTotal < 1, usage.redactionOverhead);
  const windowed = need(await call('P4-API-25 explicit window', 'GET', ws(w, `/llm/usage?from=${encodeURIComponent(new Date(Date.now() - 3_600_000).toISOString())}&to=${encodeURIComponent(new Date().toISOString())}`), { actor: owner, org: w }), 'window');
  check('explicit window echoed', !!windowed.from && !!windowed.to && windowed.totals.invocations === usage.totals.invocations, { windowed: windowed.totals.invocations, all: usage.totals.invocations });
  const empty = need(await call('P4-API-25 a window before the workspace existed', 'GET', ws(w, '/llm/usage?from=2020-01-01&to=2020-01-02'), { actor: owner, org: w }), 'empty');
  check('empty window: zeros and null percentiles', empty.totals.invocations === 0 && empty.latencyMs.totalP50 === null && empty.byModel.length === 0);
  await call('P4-API-25 unparseable date', 'GET', ws(w, '/llm/usage?from=yesterday'), { actor: owner, org: w, expect: 422, code: 'VALIDATION_FAILED' });
  await call('P4-API-25 a viewer-turned-auditor lacks usage:read', 'GET', ws(w, '/llm/usage'), { actor: viewer, org: w, expect: 403, code: 'PERMISSION_DENIED' });
}

async function outage({ owner, admin, member, w, hrAgent, writer, c2, modelName }) {
  // Detection results are cached for PII_DETECTION_CACHE_TTL (by fingerprint, never text), so text
  // already analysed can still be masked during an outage. Supervision of *new* text must fail
  // closed: prepare a conversation whose title and answer have never been analysed.
  const fresh = need(await call('P4-API-13 conversation with never-analysed content, before the outage', 'POST', ws(w, '/conversations'), {
    actor: member, org: w, expect: 201, body: { agentId: writer.id, title: `Outage check ${crypto.randomUUID()}` },
  }), 'fresh');
  await call('P4-API-18 a fresh answer, before the outage', 'POST', ws(w, `/conversations/${fresh.id}/messages`), {
    actor: member, org: w, body: { content: `Name one famous building in Lahore, in one sentence. (${crypto.randomUUID()})`, parameters: { maxOutputTokens: 60 } },
  });
  check('AI service stopped for outage test', stopAiService());
  await waitForHealth((info) => info.ai_service?.status !== 'up', 45_000);
  facts.outageHealth = lastHealth;
  const c8 = need(await call('P4-API-13 conversation for the outage', 'POST', ws(w, '/conversations'), { actor: member, org: w, body: { agentId: hrAgent.id }, expect: 201 }), 'c8');
  const down = await stream('P4-API-19 retrieval fails after the stream opened', ws(w, `/conversations/${c8.id}/messages/stream`), {
    actor: member, org: w, body: { content: 'How many days of annual leave do I get?' }, terminal: 'error', code: 'AI_SERVICE_UNAVAILABLE',
  });
  traces.outageStream = traceOf(down.events);
  check('outage error event carries status 503', down.error?.status === 503, down.error);
  const afterDown = need(await call('P4-API-14 nothing was stored for the failed turn', 'GET', ws(w, `/conversations/${c8.id}`), { actor: member, org: w }), 'after down');
  check('a turn refused before the model ran leaves no message', afterDown.messageCount === 0);
  const refused = await call('P4-API-18 masking unavailable, policy REFUSE', 'POST', ws(w, `/conversations/${c8.id}/messages`), { actor: member, org: w, body: { content: 'Imran Siddiqui asked about leave. Reply briefly.', retrieval: { enabled: false } }, expect: 503, code: 'PII_DETECTION_UNAVAILABLE' });
  samples.piiUnavailable = refused.error;
  const directDown = await stream('P4-API-21 direct stream while masking is unavailable', ws(w, '/llm/chat/stream'), { actor: member, org: w, body: { messages: [{ role: 'user', content: 'Imran Siddiqui says hi.' }] }, terminal: 'error', code: 'PII_DETECTION_UNAVAILABLE' });
  traces.directOutage = traceOf(directDown.events);
  await call('P4-API-20 direct chat while masking is unavailable', 'POST', ws(w, '/llm/chat'), { actor: member, org: w, body: { messages: [{ role: 'user', content: 'Imran Siddiqui says hi.' }] }, expect: 503, code: 'PII_DETECTION_UNAVAILABLE' });
  await call('P4-API-11 preview while the AI service is down', 'POST', ws(w, `/agents/${hrAgent.id}/prompt-preview`), { actor: member, org: w, body: { content: 'annual leave' }, expect: 503 });
  const unmaskable = need(await call('P4-API-17 supervision of new text while masking is unavailable', 'GET', ws(w, `/conversations/${fresh.id}/messages`), { actor: admin, org: w }), 'unmaskable');
  samples.redactionUnavailablePage = unmaskable;
  check('new supervised content WITHHELD with REDACTION_UNAVAILABLE rather than shown unmasked', unmaskable.messages.length > 0 && unmaskable.messages.every((m) => m.contentState === 'WITHHELD' && m.content === null) && unmaskable.messages.some((m) => m.withheldReason === 'REDACTION_UNAVAILABLE'), unmaskable.messages.map((m) => `${m.role}:${m.contentState}:${m.withheldReason ?? ''}`));
  const cached = need(await call('P4-API-17 supervision of already-analysed text during the outage', 'GET', ws(w, `/conversations/${c2.id}/messages`), { actor: admin, org: w }), 'cached');
  check('already-analysed text is still masked from the detection cache, never shown unmasked', cached.messages.every((m) => m.contentState !== 'VISIBLE') && cached.messages.some((m) => m.contentState === 'MASKED'), cached.messages.map((m) => `${m.role}:${m.contentState}:${m.withheldReason ?? ''}`));
  const titles = need(await call('P4-API-12 supervisor list while masking is unavailable', 'GET', ws(w, '/conversations?scope=all'), { actor: admin, org: w }), 'titles');
  check('foreign titles are null when one of them cannot be masked', titles.filter((c) => !c.isOwner).every((c) => c.title === null), titles.filter((c) => !c.isOwner).map((c) => c.title));
  await call('switch privacy policy to DEGRADE_TO_PATTERNS (Phase 3 endpoint)', 'PUT', ws(w, '/pii/policy'), { actor: admin, org: w, body: { onDetectorFailure: 'DEGRADE_TO_PATTERNS' } });
  const degraded = await call('P4-API-18 degraded masking lets the turn run', 'POST', ws(w, `/conversations/${c8.id}/messages`), { actor: member, org: w, body: { content: 'Email imran.siddiqui@acme.test about leave. Reply in one short sentence.', retrieval: { enabled: false }, parameters: { maxOutputTokens: 60 } } });
  check('the stored answer says masking was degraded', degraded.data?.assistantMessage?.redaction?.degraded === true, degraded.data?.assistantMessage?.redaction);
  await call('restore REFUSE (Phase 3 endpoint)', 'PUT', ws(w, '/pii/policy'), { actor: admin, org: w, body: { onDetectorFailure: 'REFUSE' } });
  startAiService();
  const up = await waitForHealth((info) => info.ai_service?.status === 'up' && info.pii_detector?.status === 'up', 180_000);
  check('AI service recovered', !!up);
  const recovered = await call('P4-API-18 grounded turn after recovery', 'POST', ws(w, `/conversations/${c8.id}/messages`), { actor: member, org: w, body: { content: 'How many days of annual leave do I get? One sentence.' } });
  check('retrieval works again after recovery', recovered.data?.retrieval?.passagesProvided > 0);
  void owner;
  void modelName;
}

// ── Coverage ────────────────────────────────────────────────────────────────

function coverage() {
  const byOperation = {};
  for (const row of results) {
    const id = /^P4-API-(\d+)/.exec(row.label ?? '')?.[1];
    if (!id || row.status === undefined) continue;
    const entry = (byOperation[`P4-API-${id}`] ||= { requests: 0, passed: 0, outcomes: new Set() });
    entry.requests += 1;
    if (row.pass) entry.passed += 1;
    const how = row.terminal === 'client-abort' ? ' (client abort)' : row.terminal === 'error' ? ' (error event)' : row.sse ? ' (stream)' : '';
    entry.outcomes.add(`${row.status}${row.code ? ` ${row.code}` : ''}${how}`);
  }
  return Object.fromEntries(
    Object.entries(byOperation)
      .sort(([a], [b]) => Number(a.slice(7)) - Number(b.slice(7)))
      .map(([id, entry]) => [id, { requests: entry.requests, passed: entry.passed, outcomes: [...entry.outcomes].sort() }]),
  );
}

main()
  .catch((error) => {
    console.log(JSON.stringify({ fatal: error.message, stack: error.stack?.split('\n').slice(0, 3) }));
    results.push({ label: 'run completed', pass: false, error: error.message });
  })
  .finally(async () => {
    for (const base of createdBases) {
      await call('cleanup delete knowledge base', 'DELETE', ws(base.org, `/knowledge-bases/${base.id}`), { actor: base.actor, org: base.org, expect: [200, 404] });
    }
    for (const key of apiKeys) {
      await call('cleanup revoke API key', 'DELETE', ws(key.org, `/api-keys/${key.id}`), { actor: actors.owner, org: key.org, expect: [200, 404] });
    }
    for (const workspace of workspaces) {
      await call('cleanup delete disposable workspace', 'DELETE', ws(workspace.id), { actor: workspace.actor, org: workspace.id });
    }
    for (const actor of Object.values(actors)) {
      await call('cleanup logout all fixture sessions', 'POST', '/api/v1/auth/logout-all', { actor, body: {} });
    }
    const passed = results.filter((row) => row.pass).length;
    const report = {
      run,
      baseUrl: BASE,
      completedAt: new Date().toISOString(),
      outageInjected: INJECT_OUTAGE,
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
        'Fixture accounts retained with sessions revoked; workspaces soft-deleted through the API; knowledge bases deleted (content purged).',
        'No browser/frontend tests.',
      ],
    };
    fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ total: results.length, passed, failed: results.length - passed, operations: Object.keys(report.coverage).length, flowControlWaits: facts.flowControl.length }));
    process.exitCode = results.some((row) => !row.pass) ? 1 : 0;
  });
