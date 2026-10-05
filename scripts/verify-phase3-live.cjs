/* Opt-in Phase 3 live verification: knowledge bases, grants, documents, ingestion,
 * retrieval and PII, against a running backend and its real dependencies.
 *
 * Creates disposable users and workspaces. Never touches existing users or workspaces.
 * Members join through the public invitation flow: the invitation email is read from the
 * configured Ethereal test inbox over IMAP. No database rows are written directly.
 * Secrets (passwords, tokens, API keys, invitation tokens) stay in process memory and are
 * never written to output. Response samples keep synthetic text only; revealed PII values
 * are replaced before they are stored.
 *
 *   node scripts/verify-phase3-live.cjs --run                      # main run
 *   node scripts/verify-phase3-live.cjs --run --inject-ai-outage   # also stops and restarts
 *                                                                  # the local AI service
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const tls = require('node:tls');
const zlib = require('node:zlib');
const { spawn, execFileSync } = require('node:child_process');
const inheritedEnv = { ...process.env };
require('dotenv').config({ quiet: true });

if (!process.argv.includes('--run')) throw new Error('Explicit --run required');
const INJECT_OUTAGE = process.argv.includes('--inject-ai-outage');
const BASE = process.env.P3_BASE_URL || `http://localhost:${process.env.APP_PORT || 3000}`;
const OUT = process.env.P3_RESULTS || 'docs/frontend/PHASE_3_LIVE_RESULTS.json';
const AI_DIR = process.env.P3_AI_SERVICE_DIR || path.resolve('ai-service');
const COOKIE = process.env.REFRESH_TOKEN_COOKIE_NAME || 'daiap_rt';
const MAX_UPLOAD = 50 * 1024 * 1024; // UPLOAD_MAX_FILE_SIZE default; read from server errors otherwise
const run = `p3-${Date.now()}`;

const results = [];
const timelines = {};
const samples = {};
const facts = {};
const actors = {};
const workspaces = [];
const createdBases = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const ws = (id, suffix = '') => `/api/v1/organizations/${id}${suffix}`;

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
  console.log(JSON.stringify(row));
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

function readCookie(headers) {
  const all = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  const match = all.find((value) => value.startsWith(`${COOKIE}=`));
  return match ? match.split(';')[0].slice(COOKIE.length + 1) : null;
}

/**
 * One request. `expect` is a status or list of statuses; `code` the expected error code.
 * `quiet` requests (status polling) are not recorded as checks.
 */
async function call(label, method, urlPath, opts = {}) {
  const { body, form, actor, org, apiKey, expect = 200, code, raw = false, quiet = false } = opts;
  const expected = Array.isArray(expect) ? expect : [expect];
  if (actor && !apiKey && actor.tokenAt && Date.now() - actor.tokenAt > 12 * 60_000) {
    await refresh(actor);
  }
  await pace(apiKey ? 'api-key' : actor ? actor.name : 'anonymous');
  const headers = { Accept: 'application/json' };
  if (actor && !apiKey) headers.Authorization = `Bearer ${actor.token}`;
  if (apiKey) headers['X-API-Key'] = apiKey;
  if (org) headers['X-Organization-Id'] = org;
  let payload;
  if (form) payload = form();
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
      signal: AbortSignal.timeout(opts.timeout ?? 180_000),
    });
  } catch (error) {
    const row = { label, method, path: urlPath, pass: false, transport: error.name };
    if (!quiet) results.push(row);
    log(row);
    return { status: 0, headers: new Headers() };
  }
  const contentType = res.headers.get('content-type') || '';
  let json;
  let buf;
  if (raw && !contentType.includes('application/json')) {
    buf = Buffer.from(await res.arrayBuffer());
  } else {
    const text = await res.text();
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }
  const actualCode = json?.error?.code;
  // A cloud dependency can fail transiently. Retry an unexpected 503 once, and record it.
  if (res.status === 503 && !expected.includes(503) && !opts.retriedTransient) {
    (facts.transientRetries ||= []).push({ label, code: actualCode, requestId: json?.meta?.requestId, at: new Date().toISOString() });
    log({ label, transient: actualCode, retrying: true });
    await sleep(3000);
    return call(label, method, urlPath, { ...opts, retriedTransient: true });
  }
  const pass = expected.includes(res.status) && (!code || actualCode === code);
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
  return {
    status: res.status,
    json,
    data: json?.data,
    meta: json?.meta,
    error: json?.error,
    headers: res.headers,
    buf,
  };
}

function check(label, pass, detail) {
  const row = { label, pass: !!pass, ...(detail === undefined ? {} : { detail }) };
  results.push(row);
  log(row);
  return !!pass;
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

// ── Multipart ───────────────────────────────────────────────────────────────

function upload(file, fields = {}, field = 'file') {
  return () => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    if (file) {
      const list = Array.isArray(file) ? file : [file];
      for (const item of list) {
        form.append(field, new Blob([item.data], { type: item.type || 'application/octet-stream' }), item.name);
      }
    }
    return form;
  };
}

// ── Test files ──────────────────────────────────────────────────────────────

function pdfEscape(text) {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** A real, text-based PDF: one Helvetica text block per page. */
function makePdf(pages, comment = '') {
  const objects = [];
  const pageIds = pages.map((_, index) => 4 + index * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach((lines, index) => {
    const pageId = pageIds[index];
    const contentId = pageId + 1;
    const stream = lines.length
      ? `BT /F1 12 Tf 15 TL 72 740 Td ${lines.map((line) => `(${pdfEscape(line)}) Tj T*`).join(' ')} ET`
      : '';
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  });
  let out = `%PDF-1.4\n%${comment}\n`;
  const offsets = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.byteLength(out);
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** A ZIP archive (deflate), enough for DOCX packages. */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const compressed = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function xmlEscape(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function makeDocx(paragraphs, extra = []) {
  const body = paragraphs
    .map(([style, text]) =>
      `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`,
    )
    .join('');
  return makeZip([
    {
      name: '[Content_Types].xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    },
    {
      name: '_rels/.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    },
    {
      name: 'word/document.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`,
    },
    ...extra,
  ]);
}

const files = {
  leavePdf: {
    name: 'Leave Policy 2026.pdf',
    data: makePdf(
      [
        [
          'Leave Policy 2026',
          `Reference ${run}.`,
          'Annual leave: every full-time employee receives 24 days of paid annual leave per calendar year.',
          'Annual leave accrues at two days per month, and up to 5 unused days carry over to the next year.',
          'Leave requests must be submitted in the HR portal at least 10 working days in advance.',
        ],
        [
          'Sick leave',
          'Employees receive 12 days of paid sick leave per year.',
          'A medical certificate is required for absences longer than 3 consecutive days.',
          'Parental leave is 16 weeks for the primary caregiver and 4 weeks for the secondary caregiver.',
        ],
      ],
      run,
    ),
    type: 'application/pdf',
  },
  handbookMd: {
    name: 'remote-work.md',
    data: Buffer.from(
      `# Remote Work Guidelines\n\nReference ${run}.\n\n## Working hours\n\nCore collaboration hours are 11:00 to 15:00 Pakistan Standard Time. Outside core hours, schedule your work freely.\n\n## Equipment\n\nThe company provides a laptop and a monthly internet allowance of PKR 5,000 for remote staff.\n\n## Security\n\nAlways lock your screen when you step away. Report a lost or stolen device to security@acme.test within 24 hours.\n`,
    ),
    type: 'text/markdown',
  },
  salaryTxt: {
    name: 'compensation-review.txt',
    data: Buffer.from(
      `Compensation review notes (${run}).\nAyesha Raza (ayesha.raza@acme.test, +92 300 1234567, CNIC 35202-1234567-1) earns PKR 950,000 per year.\nBilal Khan leads Project Falcon with Acme Corporation; his corporate card is 4111 1111 1111 1111.\nThe payroll account IBAN is PK36SCBL0000001123456702.\n`,
    ),
    type: 'text/plain',
  },
  payrollDocx: {
    name: 'Payroll Register.docx',
    data: makeDocx([
      ['Heading1', 'Payroll Register 2026'],
      [null, `Reference ${run}.`],
      [null, 'Executive payroll is processed on the 25th of each month.'],
      [null, "The chief executive's annual salary is PKR 18,500,000 before tax."],
      [null, 'Payroll queries go to payroll@acme.test.'],
    ]),
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  financeMd: {
    name: 'q3-finance.md',
    data: Buffer.from(
      `# Q3 Finance Summary\n\nReference ${run}.\n\nRevenue grew 18 percent quarter on quarter to PKR 240 million. Operating margin was 22 percent, and the board approved a capital budget of PKR 35 million for data-centre upgrades.\n`,
    ),
    type: 'text/markdown',
  },
  memberFinanceTxt: {
    name: 'travel-claims.txt',
    data: Buffer.from(`Travel reimbursement claims are settled within 7 working days of approval (${run}).\n`),
    type: 'text/plain',
  },
  corruptPdf: {
    name: 'corrupt.pdf',
    data: Buffer.from(`%PDF-1.7\n${'this is not really a pdf body '.repeat(40)}${run}\n`),
    type: 'application/pdf',
  },
  blankPdf: { name: 'blank-scan.pdf', data: makePdf([[]], `${run}-blank`), type: 'application/pdf' },
  empty: { name: 'empty.txt', data: Buffer.alloc(0), type: 'text/plain' },
  exe: { name: 'setup.exe', data: Buffer.from('MZ\x90\x00\x03\x00\x00\x00', 'latin1'), type: 'application/octet-stream' },
  noExtension: { name: 'README', data: Buffer.from('plain text without an extension'), type: 'text/plain' },
  disguisedPdf: { name: 'invoice.pdf', data: Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00', 'latin1'), type: 'application/pdf' },
  zipAsDocx: { name: 'archive.docx', data: makeZip([{ name: 'notes.txt', data: 'not a word document' }]), type: 'application/octet-stream' },
  macroDocx: {
    name: 'macro.docx',
    data: makeDocx([[null, 'Has macros']], [{ name: 'word/vbaProject.bin', data: Buffer.from('vba') }]),
    type: 'application/octet-stream',
  },
  binaryTxt: { name: 'binary.txt', data: Buffer.from([0x68, 0x00, 0x69, 0x00, 0x01, 0x02]), type: 'text/plain' },
  png: { name: 'diagram.png', data: Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), type: 'image/png' },
  longMd: {
    name: 'employee-handbook.md',
    data: Buffer.from(
      [
        `# Employee Handbook\n\nReference ${run}. This handbook collects the policies every employee must know.`,
        ...[
          ['Expenses', 'Submit expense claims within 30 days with itemised receipts. Claims above PKR 50,000 need director approval. Alcohol and personal entertainment are never reimbursed. Mileage is paid at PKR 60 per kilometre for approved business travel.'],
          ['Travel', 'Book flights through the travel desk at least 14 days before departure. Economy class applies to flights under six hours. Hotels must be within the published city rate. Daily allowances cover meals and local transport.'],
          ['Information security', 'Use the company password manager and enable two-factor authentication everywhere. Never share credentials over chat or email. Report phishing to the security team immediately. Laptops must use full-disk encryption.'],
          ['Data protection', 'Personal data may only be processed for a documented purpose. Customer records stay in approved systems and are never exported to personal devices. Retention schedules decide when records are deleted.'],
          ['Code of conduct', 'Treat colleagues, customers and partners with respect. Harassment and discrimination are not tolerated. Conflicts of interest must be declared to your manager in writing. Gifts above PKR 10,000 must be declined.'],
          ['Overtime', 'Overtime must be approved in advance by your line manager. Approved hours are paid at one and a half times the hourly rate, or taken as time off in lieu within three months.'],
          ['Public holidays', 'The company observes all gazetted public holidays. Staff required to work on a public holiday receive a replacement day off. Religious holidays may be exchanged with notice.'],
          ['Training budget', 'Every employee has an annual training budget of PKR 120,000 for courses, certifications and conferences. Unused budget does not carry over. Certifications must be relevant to the role.'],
          ['Onboarding', 'New joiners complete security training in their first week and meet their onboarding buddy daily for the first month. Probation lasts three months and ends with a written review.'],
          ['Performance reviews', 'Reviews take place twice a year, in June and December. Objectives are agreed at the start of each cycle. Ratings are calibrated across teams before they are shared.'],
          ['Whistleblowing', 'Concerns about fraud, safety or misconduct can be raised anonymously through the ethics hotline. Retaliation against a whistleblower is a disciplinary offence.'],
          ['Remote equipment', 'Remote staff may claim one ergonomic chair and one external monitor every three years. Equipment remains company property and must be returned when employment ends.'],
        ].map(([title, body], index) => `## ${index + 1}. ${title}\n\n${body} ${body}`),
      ].join('\n\n'),
    ),
    type: 'text/markdown',
  },
  urdu: {
    name: 'سالانہ رخصت پالیسی.txt',
    data: Buffer.from(`ملازمین کو ہر سال 24 دن کی سالانہ چھٹی ملتی ہے۔ (${run})\n`),
    type: 'text/plain',
  },
  pathName: { name: 'C:\\fakepath\\quarterly "draft".txt', data: Buffer.from(`Draft notes ${run}\n`), type: 'text/plain' },
};

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

// ── Documents ───────────────────────────────────────────────────────────────

const TERMINAL = ['READY', 'FAILED'];

/** Polls the document list as `actor` until every id reaches a terminal state. */
async function waitForDocuments(actor, org, ids, timeoutMs = 240_000) {
  const started = Date.now();
  const pending = new Set(ids);
  const last = {};
  while (pending.size && Date.now() - started < timeoutMs) {
    const page = await call('poll documents', 'GET', ws(org, '/documents?limit=100'), { actor, org, quiet: true });
    for (const document of page.data ?? []) {
      if (!ids.includes(document.id)) continue;
      const state = `${document.status}|v${document.indexVersion}|a${document.activeIndexVersion}|${document.isSearchable}|${document.statusMessage ?? ''}`;
      if (last[document.id] !== state) {
        last[document.id] = state;
        (timelines[document.id] ||= []).push({
          atMs: Date.now() - started,
          status: document.status,
          indexVersion: document.indexVersion,
          activeIndexVersion: document.activeIndexVersion,
          isSearchable: document.isSearchable,
          statusMessage: document.statusMessage,
          failureCode: document.failureCode,
        });
      }
      if (TERMINAL.includes(document.status)) pending.delete(document.id);
    }
    if (pending.size) await sleep(1500);
  }
  return pending.size === 0;
}

async function getDocument(actor, org, id) {
  return (await call('read document', 'GET', ws(org, `/documents/${id}`), { actor, org, quiet: true })).data;
}

/** Fast-polls one document's detail to capture every status it passes through. */
async function traceDocument(actor, org, id, timeoutMs = 180_000) {
  const started = Date.now();
  const steps = [];
  let last = '';
  while (Date.now() - started < timeoutMs) {
    const doc = await getDocument(actor, org, id);
    const state = `${doc?.status} v${doc?.indexVersion} active=${doc?.activeIndexVersion} searchable=${doc?.isSearchable}${doc?.statusMessage ? ` "${doc.statusMessage}"` : ''}`;
    if (state !== last) {
      steps.push(`${Date.now() - started}ms ${state}`);
      last = state;
    }
    if (TERMINAL.includes(doc?.status) && (doc.status === 'FAILED' || doc.activeIndexVersion === doc.indexVersion)) break;
    await sleep(350);
  }
  return steps;
}

// ── AI service process control (opt-in outage injection) ────────────────────

function aiServicePid() {
  const output = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
  const line = output.split(/\r?\n/).find((entry) => /127\.0\.0\.1:8000\s+\S+\s+LISTENING/.test(entry) || /0\.0\.0\.0:8000\s+\S+\s+LISTENING/.test(entry));
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
  const logFile = fs.openSync(path.join(require('node:os').tmpdir(), `daiap-ai-service-${run}.log`), 'a');
  const child = spawn(python, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000'], {
    cwd: AI_DIR,
    env: inheritedEnv,
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
      lastHealth = { httpStatus: res.status, ai_service: info.ai_service, pii_detector: info.pii_detector };
      if (predicate(info)) return info;
    } catch {
      /* keep waiting */
    }
    await sleep(3000);
  }
  return null;
}

// ── Scenario ────────────────────────────────────────────────────────────────

const PERSONAS = [
  ['owner', 'Owner'],
  ['admin', 'Admin'],
  ['member', 'Member'],
  ['viewer', 'Viewer'],
  ['records', 'Records'],
  ['outsider', 'Outsider'],
];

async function main() {
  await call('liveness', 'GET', '/health/live');
  const ready = await call('readiness', 'GET', '/health/ready');
  const health = await call('health detail', 'GET', '/health');
  const info = health.data?.details ?? {};
  facts.dependencies = Object.fromEntries(Object.entries(info).map(([name, value]) => [name, value.status]));
  facts.readiness = ready.status;

  // Actors register through the public API.
  for (const [name, last] of PERSONAS) {
    const email = `${run}-${name}@example.invalid`;
    const password = `V9!${crypto.randomBytes(24).toString('base64url')}q@`;
    const res = await call(`register ${name}`, 'POST', '/api/v1/auth/register', {
      body: { email, password, firstName: 'PhaseThree', lastName: last },
      expect: 201,
    });
    const data = need(res, `register ${name}`);
    actors[name] = {
      name,
      email,
      user: data.user,
      token: data.tokens.accessToken,
      tokenAt: Date.now(),
      refreshCookie: readCookie(res.headers),
    };
  }
  const { owner, admin, member, viewer, records, outsider } = actors;

  const W = need(await call('create workspace', 'POST', '/api/v1/organizations', {
    actor: owner, body: { name: `Phase 3 verification ${run}`, slug: run }, expect: 201,
  }), 'workspace');
  workspaces.push({ id: W.id, actor: owner });
  const X = need(await call('create second tenant', 'POST', '/api/v1/organizations', {
    actor: outsider, body: { name: `Isolation ${run}`, slug: `${run}-x` }, expect: 201,
  }), 'second tenant');
  workspaces.push({ id: X.id, actor: outsider });
  const w = W.id;
  const x = X.id;

  // Roles and members, through invitations and real email.
  const roles = need(await call('roles', 'GET', ws(w, '/roles'), { actor: owner, org: w }), 'roles');
  const role = (slug) => roles.find((entry) => entry.slug === slug);
  const recordsRole = need(await call('create custom Records Manager role', 'POST', ws(w, '/roles'), {
    actor: owner, org: w, expect: 201,
    body: {
      name: `Records Manager ${run.slice(-6)}`,
      description: 'Restricted-clearance records custodian (Phase 3 fixture).',
      priority: 60,
      color: '#7C3AED',
      permissionKeys: [
        'workspace:read', 'knowledgebase:read', 'knowledgebase:create', 'knowledgebase:update',
        'document:read', 'document:create', 'document:update', 'document:download', 'rag:query',
        'clearance:restricted',
      ],
    },
  }), 'records role');
  const invitations = [
    [admin, role('admin').id],
    [member, role('member').id],
    [viewer, role('viewer').id],
    [records, recordsRole.id],
  ];
  for (const [actor, roleId] of invitations) {
    need(await call(`invite ${actor.name}`, 'POST', ws(w, '/invitations'), {
      actor: owner, org: w, expect: 201,
      body: { email: actor.email, roleId, message: 'Phase 3 verification fixture.' },
    }), `invite ${actor.name}`);
  }
  for (const [actor] of invitations) {
    const token = await invitationToken(actor.email);
    check(`invitation email delivered to ${actor.name} (Ethereal IMAP)`, !!token);
    need(await call(`accept invitation as ${actor.name}`, 'POST', '/api/v1/invitations/accept', {
      actor, body: { token },
    }), `accept ${actor.name}`);
  }
  for (const actor of [owner, admin, member, viewer, records]) {
    actor.member = need(await call(`membership ${actor.name}`, 'GET', ws(w, '/members/me'), { actor, org: w }), 'me');
    const me = await call(`contextual permissions ${actor.name}`, 'GET', '/api/v1/auth/me', { actor, org: w });
    actor.permissions = me.data?.permissions ?? me.data?.organization?.permissions ?? [];
  }
  facts.permissionCounts = Object.fromEntries(
    [owner, admin, member, viewer, records].map((actor) => [actor.name, actor.permissions.length]),
  );

  // ── Privacy catalogue and default policy ────────────────────────────────
  const entityTypes = need(await call('P3-API-19 entity types', 'GET', ws(w, '/pii/entity-types'), { actor: member, org: w }), 'entity types');
  samples.entityTypes = entityTypes.slice(0, 3);
  facts.entityTypes = entityTypes.map((entry) => `${entry.type}:${entry.detector}:${entry.available ? 'available' : 'unavailable'}:${entry.enabled ? 'on' : 'off'}`);
  sameKeys('entity type shape', entityTypes[0], ['type', 'label', 'description', 'detector', 'available', 'enabled', 'example']);
  await call('viewer lacks pii:policy:read (entity types)', 'GET', ws(w, '/pii/entity-types'), { actor: viewer, org: w, expect: 403, code: 'PERMISSION_DENIED' });
  const defaultPolicy = need(await call('P3-API-17 default policy as member', 'GET', ws(w, '/pii/policy'), { actor: member, org: w }), 'policy');
  samples.defaultPolicyAsMember = defaultPolicy;
  check('default policy: source default, version 0, deny list hidden from member', defaultPolicy.source === 'default' && defaultPolicy.version === 0 && defaultPolicy.denyList === null);
  sameKeys('policy shape', defaultPolicy, ['source', 'version', 'enabled', 'entityTypes', 'nerEntityTypes', 'scoreThreshold', 'onDetectorFailure', 'language', 'allowList', 'denyList', 'denyListCount', 'nerDetector', 'warnings', 'updatedAt']);
  const adminPolicy = need(await call('policy as admin shows deny list', 'GET', ws(w, '/pii/policy'), { actor: admin, org: w }), 'admin policy');
  check('pii:policy:update holder sees denyList array', Array.isArray(adminPolicy.denyList));
  await call('viewer cannot read policy', 'GET', ws(w, '/pii/policy'), { actor: viewer, org: w, expect: 403, code: 'PERMISSION_DENIED' });

  const scopeBefore = need(await call('P3-API-23 access scope before bases', 'GET', ws(w, '/rag/access-scope'), { actor: member, org: w }), 'scope');
  check('member scope: INTERNAL clearance, no bases yet', scopeBefore.clearance === 'INTERNAL' && scopeBefore.knowledgeBases.length === 0 && scopeBefore.bypassesCompartments === false);
  sameKeys('access scope shape', scopeBefore, ['clearance', 'readableClassifications', 'bypassesCompartments', 'knowledgeBases']);
  await call('viewer lacks rag:query (access scope)', 'GET', ws(w, '/rag/access-scope'), { actor: viewer, org: w, expect: 403, code: 'PERMISSION_DENIED' });

  // ── Knowledge bases ──────────────────────────────────────────────────────
  await call('member cannot create base', 'POST', ws(w, '/knowledge-bases'), { actor: member, org: w, body: { name: 'Denied' }, expect: 403, code: 'PERMISSION_DENIED' });
  const handbook = need(await call('P3-API-02 create WORKSPACE base', 'POST', ws(w, '/knowledge-bases'), {
    actor: owner, org: w, expect: 201, body: { name: 'Company Handbook', description: 'Policies every employee can read.' },
  }), 'handbook');
  samples.knowledgeBaseCreated = handbook;
  sameKeys('knowledge base shape', handbook, ['id', 'name', 'description', 'accessMode', 'defaultClassification', 'embeddingModel', 'embeddingDimensions', 'chunkSize', 'chunkOverlap', 'access', 'stats', 'createdById', 'createdAt', 'updatedAt']);
  check('create defaults: WORKSPACE, INTERNAL, inherit chunking, MANAGE, zero stats', handbook.accessMode === 'WORKSPACE' && handbook.defaultClassification === 'INTERNAL' && handbook.chunkSize === null && handbook.access === 'MANAGE' && handbook.stats.totalBytes === '0');
  facts.embedding = { model: handbook.embeddingModel, dimensions: handbook.embeddingDimensions };
  await call('duplicate name, different case', 'POST', ws(w, '/knowledge-bases'), { actor: owner, org: w, body: { name: 'company handbook' }, expect: 409, code: 'KNOWLEDGE_BASE_NAME_TAKEN' });
  const overlap = await call('create with overlap >= size', 'POST', ws(w, '/knowledge-bases'), { actor: owner, org: w, body: { name: 'Bad chunking', chunkSize: 128, chunkOverlap: 128 }, expect: 422, code: 'VALIDATION_FAILED' });
  check('overlap error filed under chunkOverlap', !!overlap.error?.details?.fields?.chunkOverlap, overlap.error?.details);
  samples.validationError = overlap.json;
  await call('create with unknown field', 'POST', ws(w, '/knowledge-bases'), { actor: owner, org: w, body: { name: 'X', embeddingModel: 'other' }, expect: 422 });
  await call('create with blank name', 'POST', ws(w, '/knowledge-bases'), { actor: owner, org: w, body: { name: '   ' }, expect: 422 });
  await call('create with chunkSize 63', 'POST', ws(w, '/knowledge-bases'), { actor: owner, org: w, body: { name: 'Small', chunkSize: 63 }, expect: 422 });
  const finance = need(await call('admin creates RESTRICTED base', 'POST', ws(w, '/knowledge-bases'), {
    actor: admin, org: w, expect: 201, body: { name: 'Finance Reports', accessMode: 'RESTRICTED', defaultClassification: 'CONFIDENTIAL' },
  }), 'finance');
  const tooHigh = await call('admin default classification above clearance', 'POST', ws(w, '/knowledge-bases'), {
    actor: admin, org: w, body: { name: 'Board Papers', defaultClassification: 'RESTRICTED' }, expect: 403, code: 'CLASSIFICATION_EXCEEDS_CLEARANCE',
  });
  check('clearance error details', tooHigh.error?.details?.requested === 'RESTRICTED' && tooHigh.error?.details?.clearance === 'CONFIDENTIAL', tooHigh.error?.details);
  samples.clearanceError = tooHigh.json;
  const hrRecords = need(await call('records manager creates RESTRICTED/RESTRICTED base', 'POST', ws(w, '/knowledge-bases'), {
    actor: records, org: w, expect: 201, body: { name: 'HR Records', accessMode: 'RESTRICTED', defaultClassification: 'RESTRICTED', chunkSize: 256, chunkOverlap: 32 },
  }), 'hr records');

  const listAs = async (actor, label) => (await call(label, 'GET', ws(w, '/knowledge-bases?limit=100'), { actor, org: w })).data ?? [];
  const visible = {};
  for (const actor of [owner, admin, member, viewer, records]) {
    visible[actor.name] = (await listAs(actor, `P3-API-01 list bases as ${actor.name}`)).map((base) => `${base.name}:${base.access}`);
  }
  facts.baseVisibilityInitial = visible;
  check('owner bypasses compartments', visible.owner.length === 3 && visible.owner.includes('HR Records:MANAGE'));
  check('admin sees own RESTRICTED base, not HR Records', visible.admin.includes('Finance Reports:MANAGE') && !visible.admin.some((v) => v.startsWith('HR Records')));
  check('member and viewer see only the WORKSPACE base', visible.member.join() === 'Company Handbook:MANAGE' && visible.viewer.join() === 'Company Handbook:MANAGE');
  check('records manager sees Handbook and HR Records', visible.records.length === 2 && visible.records.includes('HR Records:MANAGE'));
  const page1 = await call('list pagination limit=1', 'GET', ws(w, '/knowledge-bases?limit=1&page=2'), { actor: owner, org: w });
  check('pagination meta', page1.meta?.pagination?.totalItems === 3 && page1.meta.pagination.page === 2 && page1.data.length === 1, page1.meta?.pagination);
  const searched = await call('list search=hand', 'GET', ws(w, '/knowledge-bases?search=hand'), { actor: owner, org: w });
  check('search matches name', searched.data?.length === 1 && searched.data[0].id === handbook.id);
  const sorted = await call('list sortBy=createdAt (DESC default)', 'GET', ws(w, '/knowledge-bases?sortBy=createdAt'), { actor: owner, org: w });
  check('explicit sortBy uses DESC default', sorted.data?.[0]?.id === hrRecords.id);
  await call('list limit=101', 'GET', ws(w, '/knowledge-bases?limit=101'), { actor: owner, org: w, expect: 422 });
  await call('P3-API-03 read base', 'GET', ws(w, `/knowledge-bases/${handbook.id}`), { actor: viewer, org: w });
  samples.hiddenNotFound = (await call('hidden base is 404', 'GET', ws(w, `/knowledge-bases/${hrRecords.id}`), { actor: admin, org: w, expect: 404, code: 'KNOWLEDGE_BASE_NOT_FOUND' })).json;
  await call('unknown base is 404', 'GET', ws(w, `/knowledge-bases/${crypto.randomUUID()}`), { actor: owner, org: w, expect: 404, code: 'KNOWLEDGE_BASE_NOT_FOUND' });
  await call('malformed base id', 'GET', ws(w, '/knowledge-bases/not-a-uuid'), { actor: owner, org: w, expect: 400 });

  await call('member cannot update base', 'PATCH', ws(w, `/knowledge-bases/${handbook.id}`), { actor: member, org: w, body: { description: 'x' }, expect: 403, code: 'PERMISSION_DENIED' });
  const patched = need(await call('P3-API-04 update base', 'PATCH', ws(w, `/knowledge-bases/${handbook.id}`), {
    actor: owner, org: w, body: { description: 'Handbook for all staff.', chunkSize: 256, chunkOverlap: 32 },
  }), 'patch');
  check('chunking override saved', patched.chunkSize === 256 && patched.chunkOverlap === 32);
  const inherited = need(await call('chunk settings back to inherited (null)', 'PATCH', ws(w, `/knowledge-bases/${handbook.id}`), {
    actor: owner, org: w, body: { chunkSize: null, chunkOverlap: null },
  }), 'inherit');
  check('null returns to inheritance', inherited.chunkSize === null && inherited.chunkOverlap === null);
  const bigOverlap = await call('overlap against inherited size', 'PATCH', ws(w, `/knowledge-bases/${handbook.id}`), { actor: owner, org: w, body: { chunkOverlap: 600 }, expect: 422, code: 'VALIDATION_FAILED' });
  check('inherited-size overlap error under chunkOverlap', !!bigOverlap.error?.details?.fields?.chunkOverlap, bigOverlap.error?.details);
  await call('name null refused', 'PATCH', ws(w, `/knowledge-bases/${handbook.id}`), { actor: owner, org: w, body: { name: null }, expect: 422 });
  const noDescription = need(await call('description null clears', 'PATCH', ws(w, `/knowledge-bases/${handbook.id}`), { actor: owner, org: w, body: { description: null } }), 'desc');
  check('description cleared', noDescription.description === null);
  await call('empty PATCH is a no-op 200', 'PATCH', ws(w, `/knowledge-bases/${handbook.id}`), { actor: owner, org: w, body: {} });
  await call('admin raises default above clearance', 'PATCH', ws(w, `/knowledge-bases/${finance.id}`), { actor: admin, org: w, body: { defaultClassification: 'RESTRICTED' }, expect: 403, code: 'CLASSIFICATION_EXCEEDS_CLEARANCE' });
  await call('rename collides', 'PATCH', ws(w, `/knowledge-bases/${finance.id}`), { actor: admin, org: w, body: { name: 'COMPANY HANDBOOK' }, expect: 409, code: 'KNOWLEDGE_BASE_NAME_TAKEN' });

  // ── Grants ──────────────────────────────────────────────────────────────
  const financeGrants = need(await call('P3-API-06 list grants (creator auto-grant)', 'GET', ws(w, `/knowledge-bases/${finance.id}/grants`), { actor: admin, org: w }), 'grants');
  samples.grants = financeGrants;
  check('creator received MEMBER MANAGE grant', financeGrants.length === 1 && financeGrants[0].subjectType === 'MEMBER' && financeGrants[0].subjectId === admin.member.id && financeGrants[0].accessLevel === 'MANAGE');
  sameKeys('grant shape', financeGrants[0], ['id', 'subjectType', 'subjectId', 'subjectLabel', 'accessLevel', 'grantedById', 'createdAt']);
  const roleGrant = need(await call('P3-API-07 grant Member role READ', 'PUT', ws(w, `/knowledge-bases/${finance.id}/grants`), {
    actor: admin, org: w, body: { subjectType: 'ROLE', subjectId: role('member').id, accessLevel: 'READ' },
  }), 'role grant');
  const upgraded = need(await call('re-grant same subject changes level', 'PUT', ws(w, `/knowledge-bases/${finance.id}/grants`), {
    actor: admin, org: w, body: { subjectType: 'ROLE', subjectId: role('member').id, accessLevel: 'WRITE' },
  }), 'upgrade');
  check('upsert keeps grant id', upgraded.id === roleGrant.id && upgraded.accessLevel === 'WRITE');
  const viewerGrant = need(await call('grant viewer membership READ', 'PUT', ws(w, `/knowledge-bases/${finance.id}/grants`), {
    actor: admin, org: w, body: { subjectType: 'MEMBER', subjectId: viewer.member.id, accessLevel: 'READ' },
  }), 'viewer grant');
  await call('user id is not a membership id', 'PUT', ws(w, `/knowledge-bases/${finance.id}/grants`), {
    actor: admin, org: w, body: { subjectType: 'MEMBER', subjectId: viewer.user.id, accessLevel: 'READ' }, expect: 404, code: 'RESOURCE_NOT_FOUND',
  });
  const otherRoles = need(await call('second tenant roles', 'GET', ws(x, '/roles'), { actor: outsider, org: x }), 'x roles');
  await call('cross-tenant role refused', 'PUT', ws(w, `/knowledge-bases/${finance.id}/grants`), {
    actor: admin, org: w, body: { subjectType: 'ROLE', subjectId: otherRoles[0].id, accessLevel: 'READ' }, expect: 404, code: 'RESOURCE_NOT_FOUND',
  });
  await call('invalid access level', 'PUT', ws(w, `/knowledge-bases/${finance.id}/grants`), {
    actor: admin, org: w, body: { subjectType: 'ROLE', subjectId: role('member').id, accessLevel: 'OWNER' }, expect: 422,
  });
  const memberFinance = await call('member sees Finance through role grant', 'GET', ws(w, `/knowledge-bases/${finance.id}`), { actor: member, org: w });
  check('member effective level WRITE', memberFinance.data?.access === 'WRITE');
  const deniedGrants = await call('WRITE is not enough to list grants', 'GET', ws(w, `/knowledge-bases/${finance.id}/grants`), { actor: member, org: w, expect: 403, code: 'KNOWLEDGE_BASE_ACCESS_DENIED' });
  check('access denied details', deniedGrants.error?.details?.required === 'MANAGE' && deniedGrants.error?.details?.granted === 'WRITE', deniedGrants.error?.details);
  samples.levelDenied = deniedGrants.json;
  await call('member lacks knowledgebase:update for grants', 'PUT', ws(w, `/knowledge-bases/${handbook.id}/grants`), {
    actor: member, org: w, body: { subjectType: 'ROLE', subjectId: role('viewer').id, accessLevel: 'READ' }, expect: 403, code: 'PERMISSION_DENIED',
  });
  const handbookGrants = await call('member can list grants on a WORKSPACE base', 'GET', ws(w, `/knowledge-bases/${handbook.id}/grants`), { actor: member, org: w });
  facts.memberCanListWorkspaceBaseGrants = handbookGrants.status;
  await call('P3-API-08 revoke viewer grant', 'DELETE', ws(w, `/knowledge-bases/${finance.id}/grants/${viewerGrant.id}`), { actor: admin, org: w });
  await call('revoked grant takes effect next request', 'GET', ws(w, `/knowledge-bases/${finance.id}`), { actor: viewer, org: w, expect: 404, code: 'KNOWLEDGE_BASE_NOT_FOUND' });
  await call('revoke again', 'DELETE', ws(w, `/knowledge-bases/${finance.id}/grants/${viewerGrant.id}`), { actor: admin, org: w, expect: 404, code: 'KNOWLEDGE_BASE_GRANT_NOT_FOUND' });

  // Switching a WORKSPACE base to RESTRICTED keeps its editor inside.
  const projects = need(await call('admin creates WORKSPACE base to restrict', 'POST', ws(w, '/knowledge-bases'), { actor: admin, org: w, expect: 201, body: { name: 'Projects' } }), 'projects');
  await call('switch to RESTRICTED', 'PATCH', ws(w, `/knowledge-bases/${projects.id}`), { actor: admin, org: w, body: { accessMode: 'RESTRICTED' } });
  const projectGrants = need(await call('auto MANAGE grant after switch', 'GET', ws(w, `/knowledge-bases/${projects.id}/grants`), { actor: admin, org: w }), 'project grants');
  check('switch created editor grant', projectGrants.some((grant) => grant.subjectId === admin.member.id && grant.accessLevel === 'MANAGE'));
  await call('member loses switched base', 'GET', ws(w, `/knowledge-bases/${projects.id}`), { actor: member, org: w, expect: 404, code: 'KNOWLEDGE_BASE_NOT_FOUND' });
  // Self-lockout: revoking your own grant hides the base at once.
  await call('admin revokes own grant', 'DELETE', ws(w, `/knowledge-bases/${projects.id}/grants/${projectGrants[0].id}`), { actor: admin, org: w });
  await call('admin locked out of own base', 'GET', ws(w, `/knowledge-bases/${projects.id}`), { actor: admin, org: w, expect: 404, code: 'KNOWLEDGE_BASE_NOT_FOUND' });
  await call('records manager lacks knowledgebase:delete', 'DELETE', ws(w, `/knowledge-bases/${hrRecords.id}`), { actor: records, org: w, expect: 403, code: 'PERMISSION_DENIED' });
  await call('P3-API-05 owner deletes locked-out base', 'DELETE', ws(w, `/knowledge-bases/${projects.id}`), { actor: owner, org: w });
  await call('deleted base is 404', 'GET', ws(w, `/knowledge-bases/${projects.id}`), { actor: owner, org: w, expect: 404, code: 'KNOWLEDGE_BASE_NOT_FOUND' });
  const reuse = await call('name of a deleted base can be reused', 'POST', ws(w, '/knowledge-bases'), { actor: admin, org: w, body: { name: 'Projects' }, expect: 201 });
  if (reuse.data) await call('cleanup reused base', 'DELETE', ws(w, `/knowledge-bases/${reuse.data.id}`), { actor: admin, org: w });

  // ── Uploads ─────────────────────────────────────────────────────────────
  createdBases.push(...[handbook, finance, hrRecords].map((base) => ({ id: base.id, org: w, actor: owner })));
  const up = (label, actor, kb, file, fields, extra = {}) =>
    call(label, 'POST', ws(w, `/knowledge-bases/${kb}/documents`), { actor, org: w, form: upload(file, fields, extra.field), expect: 202, ...extra });

  const longMd = need(await up('multi-chunk handbook upload', owner, handbook.id, files.longMd, { title: 'Employee Handbook' }), 'long');
  facts.statusTrace = await traceDocument(viewer, w, longMd.id);
  const longDoc = await getDocument(owner, w, longMd.id);
  check('multi-chunk document READY with several chunks', longDoc?.status === 'READY' && longDoc.chunkCount > 1, { status: longDoc?.status, chunks: longDoc?.chunkCount });
  facts.longDocument = { chunkCount: longDoc?.chunkCount, tokenCount: longDoc?.tokenCount, metrics: longDoc?.processingMetrics };
  const chunkPage2 = await call('chunk page 2', 'GET', ws(w, `/documents/${longMd.id}/chunks?page=2&limit=1`), { actor: member, org: w });
  check('chunk pagination page 2', chunkPage2.meta?.pagination?.page === 2 && chunkPage2.data?.[0]?.chunkIndex === 1, chunkPage2.meta?.pagination);
  const urdu = need(await up('UTF-8 (Urdu) filename upload', owner, handbook.id, files.urdu, {}), 'urdu');
  check('Unicode filename and default title preserved', urdu.originalFilename === files.urdu.name.normalize('NFC') && urdu.title === 'سالانہ رخصت پالیسی', { filename: urdu.originalFilename, title: urdu.title });
  const pathName = need(await up('client path and quotes in filename', owner, handbook.id, files.pathName, {}), 'path name');
  facts.sanitizedFilename = pathName.originalFilename;
  check('path stripped and quotes replaced', pathName.originalFilename === 'quarterly _draft_.txt', pathName.originalFilename);

  const handbookMd = need(await up('P3-API-09 member uploads Markdown', member, handbook.id, files.handbookMd, { tags: 'Remote, Policy , remote' }), 'md');
  samples.documentAccepted = handbookMd;
  sameKeys('document shape', handbookMd, ['id', 'knowledgeBaseId', 'title', 'description', 'tags', 'originalFilename', 'fileType', 'mimeType', 'sizeBytes', 'classification', 'status', 'statusMessage', 'failureCode', 'isSearchable', 'indexVersion', 'activeIndexVersion', 'chunkCount', 'tokenCount', 'pageCount', 'language', 'embeddingModel', 'processingMetrics', 'uploadedById', 'lastStatusAt', 'processingCompletedAt', 'createdAt', 'updatedAt']);
  check('accepted upload: UPLOADED, not searchable, defaults applied', handbookMd.status === 'UPLOADED' && handbookMd.isSearchable === false && handbookMd.title === 'remote-work' && handbookMd.classification === 'INTERNAL' && JSON.stringify(handbookMd.tags) === '["remote","policy"]' && handbookMd.fileType === 'MARKDOWN');
  const leavePdf = need(await up('owner uploads PDF as PUBLIC with title', owner, handbook.id, files.leavePdf, { title: 'Leave Policy 2026', description: 'Annual, sick and parental leave.', classification: 'PUBLIC', tags: 'policy,2026,leave' }), 'pdf');
  const salaryTxt = need(await up('owner uploads CONFIDENTIAL text', owner, handbook.id, files.salaryTxt, { classification: 'CONFIDENTIAL' }), 'txt');
  const payrollDocx = need(await up('records manager uploads DOCX to HR Records', records, hrRecords.id, files.payrollDocx, {}), 'docx');
  check('DOCX inherits RESTRICTED default', payrollDocx.classification === 'RESTRICTED' && payrollDocx.fileType === 'DOCX');
  const financeMd = need(await up('admin uploads to Finance (CONFIDENTIAL default)', admin, finance.id, files.financeMd, {}), 'finance');
  await up('member upload inherits Finance default above clearance', member, finance.id, files.memberFinanceTxt, {}, { expect: 403, code: 'CLASSIFICATION_EXCEEDS_CLEARANCE' });
  const memberFinance2 = need(await up('member uploads to Finance as INTERNAL via role WRITE grant', member, finance.id, files.memberFinanceTxt, { classification: 'INTERNAL' }), 'member finance');
  const corruptPdf = need(await up('corrupt PDF is accepted then fails', owner, handbook.id, files.corruptPdf, {}), 'corrupt');
  const blankPdf = need(await up('text-less PDF is accepted then fails', owner, handbook.id, files.blankPdf, {}), 'blank');

  const bad = async (label, file, expectStatus, code, reason, fields = {}, extra = {}) => {
    const res = await up(label, owner, handbook.id, file, fields, { expect: expectStatus, code, ...extra });
    if (reason) check(`${label}: details.reason ${reason}`, res.error?.details?.reason === reason, res.error?.details);
    return res;
  };
  await bad('no file part', null, 400, 'BAD_REQUEST', null, { title: 'No file' });
  await bad('file under another field name', files.handbookMd, 400, 'BAD_REQUEST', null, {}, { field: 'document' });
  await bad('two files', [files.handbookMd, files.financeMd], 400, 'BAD_REQUEST');
  const emptyRes = await bad('empty file', files.empty, 415, 'DOCUMENT_EMPTY', 'EMPTY');
  samples.uploadRefused = emptyRes.json;
  await bad('executable extension', files.exe, 415, 'DOCUMENT_TYPE_NOT_ALLOWED', 'TYPE_NOT_ALLOWED');
  await bad('no extension', files.noExtension, 415, 'DOCUMENT_TYPE_NOT_ALLOWED', 'TYPE_NOT_ALLOWED');
  await bad('image extension', files.png, 415, 'DOCUMENT_TYPE_NOT_ALLOWED', 'TYPE_NOT_ALLOWED');
  await bad('executable named .pdf', files.disguisedPdf, 415, 'DOCUMENT_CONTENT_MISMATCH', 'CONTENT_MISMATCH');
  await bad('plain ZIP named .docx', files.zipAsDocx, 415, 'DOCUMENT_CONTENT_MISMATCH', 'CONTENT_MISMATCH');
  await bad('DOCX with macros', files.macroDocx, 415, 'DOCUMENT_TYPE_NOT_ALLOWED', 'MACROS_PRESENT');
  await bad('binary named .txt', files.binaryTxt, 415, 'DOCUMENT_CONTENT_MISMATCH', 'CONTENT_MISMATCH');
  await bad('invalid classification', files.handbookMd, 422, 'VALIDATION_FAILED', null, { classification: 'SECRET' });
  await bad('title over 255', files.handbookMd, 422, 'VALIDATION_FAILED', null, { title: 't'.repeat(256) });
  await bad('21 tags', files.handbookMd, 422, 'VALIDATION_FAILED', null, { tags: Array.from({ length: 21 }, (_, i) => `t${i}`).join(',') });
  await bad('tag over 40', files.handbookMd, 422, 'VALIDATION_FAILED', null, { tags: 'x'.repeat(41) });
  await bad('unknown form field', files.handbookMd, 422, 'VALIDATION_FAILED', null, { knowledgeBaseId: handbook.id });
  await up('member classification above clearance', member, handbook.id, files.memberFinanceTxt, { classification: 'CONFIDENTIAL' }, { expect: 403, code: 'CLASSIFICATION_EXCEEDS_CLEARANCE' });
  await up('viewer lacks document:create', viewer, handbook.id, files.memberFinanceTxt, {}, { expect: 403, code: 'PERMISSION_DENIED' });
  await up('upload into hidden base', member, hrRecords.id, files.memberFinanceTxt, {}, { expect: 404, code: 'KNOWLEDGE_BASE_NOT_FOUND' });
  const hiddenDuplicate = await up('member duplicates CONFIDENTIAL file', member, handbook.id, files.salaryTxt, { classification: 'INTERNAL' }, { expect: 409, code: 'DOCUMENT_DUPLICATE' });
  check('duplicate above clearance names nothing', keys(hiddenDuplicate.error?.details).length === 0, hiddenDuplicate.error?.details);
  const visibleDuplicate = await up('admin duplicates the same file', admin, handbook.id, files.salaryTxt, { classification: 'INTERNAL' }, { expect: 409, code: 'DOCUMENT_DUPLICATE' });
  check('duplicate within clearance names the existing copy', visibleDuplicate.error?.details?.existingDocumentId === salaryTxt.id, visibleDuplicate.error?.details);
  samples.duplicateVisible = visibleDuplicate.json;
  samples.duplicateHidden = hiddenDuplicate.json;
  await up('same bytes in another base are allowed', admin, finance.id, files.handbookMd, { classification: 'INTERNAL' }).then(async (res) => {
    if (res.data) {
      await waitForDocuments(owner, w, [res.data.id]);
      await call('cleanup cross-base copy', 'DELETE', ws(w, `/documents/${res.data.id}`), { actor: admin, org: w });
    }
  });
  const oversize = { name: 'too-large.txt', data: Buffer.alloc(MAX_UPLOAD + 1024, 'a'), type: 'text/plain' };
  samples.payloadTooLarge = (await bad('file over UPLOAD_MAX_FILE_SIZE', oversize, 413, 'PAYLOAD_TOO_LARGE')).json;
  samples.missingFile = (await call('no file part (sample)', 'POST', ws(w, `/knowledge-bases/${handbook.id}/documents`), { actor: owner, org: w, form: upload(null, { title: 'x' }), expect: 400 })).json;

  // ── Processing ──────────────────────────────────────────────────────────
  const processed = [handbookMd, leavePdf, salaryTxt, payrollDocx, financeMd, memberFinance2, corruptPdf, blankPdf, longMd, urdu, pathName].map((doc) => doc.id);
  const settled = await waitForDocuments(owner, w, processed, 300_000);
  check('all uploads reached READY or FAILED', settled);
  const final = {};
  for (const id of processed) final[id] = await getDocument(owner, w, id);
  const ok = (doc) => final[doc.id]?.status === 'READY';
  check('Markdown READY', ok(handbookMd), final[handbookMd.id]?.status);
  check('PDF READY with 2 pages', ok(leavePdf) && final[leavePdf.id].pageCount === 2, { status: final[leavePdf.id]?.status, pages: final[leavePdf.id]?.pageCount, failure: final[leavePdf.id]?.failureCode });
  check('TXT READY', ok(salaryTxt), final[salaryTxt.id]?.status);
  check('DOCX READY', ok(payrollDocx), { status: final[payrollDocx.id]?.status, failure: final[payrollDocx.id]?.failureCode, message: final[payrollDocx.id]?.statusMessage });
  check('Finance Markdown READY', ok(financeMd), final[financeMd.id]?.status);
  check('corrupt PDF FAILED permanently', final[corruptPdf.id]?.status === 'FAILED', { code: final[corruptPdf.id]?.failureCode, message: final[corruptPdf.id]?.statusMessage });
  check('text-less PDF FAILED', final[blankPdf.id]?.status === 'FAILED', { code: final[blankPdf.id]?.failureCode, message: final[blankPdf.id]?.statusMessage });
  facts.failures = {
    corruptPdf: { failureCode: final[corruptPdf.id]?.failureCode, statusMessage: final[corruptPdf.id]?.statusMessage },
    blankPdf: { failureCode: final[blankPdf.id]?.failureCode, statusMessage: final[blankPdf.id]?.statusMessage },
  };
  samples.documentReady = final[leavePdf.id];
  samples.documentFailed = final[corruptPdf.id];
  facts.processing = Object.fromEntries(processed.map((id) => [final[id]?.originalFilename, {
    status: final[id]?.status, chunkCount: final[id]?.chunkCount, tokenCount: final[id]?.tokenCount,
    pageCount: final[id]?.pageCount, language: final[id]?.language, metrics: final[id]?.processingMetrics,
    timeline: (timelines[id] || []).map((step) => `${step.atMs}ms ${step.status}`),
  }]));

  // ── Reading documents ───────────────────────────────────────────────────
  const docsAs = async (actor, query = '') => (await call(`P3-API-10 list documents as ${actor.name}${query ? ` ${query}` : ''}`, 'GET', ws(w, `/documents?limit=100${query}`), { actor, org: w })).data ?? [];
  const seen = {};
  for (const actor of [owner, admin, member, viewer, records]) seen[actor.name] = (await docsAs(actor)).map((doc) => doc.originalFilename).sort();
  facts.documentVisibility = seen;
  check('member sees no CONFIDENTIAL/RESTRICTED documents', !seen.member.includes('compensation-review.txt') && !seen.member.includes('Payroll Register.docx') && !seen.member.includes('q3-finance.md') && seen.member.includes('travel-claims.txt'));
  check('viewer sees Handbook INTERNAL/PUBLIC only', !seen.viewer.includes('compensation-review.txt') && !seen.viewer.includes('travel-claims.txt') && seen.viewer.includes('remote-work.md'));
  check('admin sees CONFIDENTIAL but not HR Records', seen.admin.includes('compensation-review.txt') && seen.admin.includes('q3-finance.md') && !seen.admin.includes('Payroll Register.docx'));
  check('records manager sees RESTRICTED payroll', seen.records.includes('Payroll Register.docx') && !seen.records.includes('q3-finance.md'));
  check('owner sees everything', seen.owner.length === processed.length);
  const statsMember = (await call('base stats as member', 'GET', ws(w, `/knowledge-bases/${handbook.id}`), { actor: member, org: w })).data?.stats;
  const statsOwner = (await call('base stats as owner', 'GET', ws(w, `/knowledge-bases/${handbook.id}`), { actor: owner, org: w })).data?.stats;
  facts.handbookStats = { member: statsMember, owner: statsOwner };
  check('stats count only documents within clearance', statsMember && statsOwner && statsMember.documents < statsOwner.documents);
  check('totalBytes is a string', typeof statsOwner?.totalBytes === 'string');

  const failedOnly = await docsAs(owner, '&status=FAILED');
  check('status filter FAILED', failedOnly.length === 2 && failedOnly.every((doc) => doc.status === 'FAILED'));
  const multi = await docsAs(owner, '&status=READY,FAILED');
  check('comma-separated status filter', multi.length === processed.length);
  await call('unknown status value', 'GET', ws(w, '/documents?status=DONE'), { actor: owner, org: w, expect: 422 });
  const memberConfidential = await docsAs(member, '&classification=CONFIDENTIAL');
  check('classification above clearance is an empty page', memberConfidential.length === 0);
  await call('filter by hidden base', 'GET', ws(w, `/documents?knowledgeBaseId=${hrRecords.id}`), { actor: member, org: w, expect: 404, code: 'KNOWLEDGE_BASE_NOT_FOUND' });
  const byBase = await docsAs(admin, `&knowledgeBaseId=${finance.id}`);
  check('knowledgeBaseId filter', byBase.length === 2 && byBase.every((doc) => doc.knowledgeBaseId === finance.id));
  const titleSearch = await docsAs(owner, '&search=leave');
  check('search matches title', titleSearch.length === 1 && titleSearch[0].id === leavePdf.id);
  const bySize = await docsAs(owner, '&sortBy=sizeBytes&sortDirection=ASC');
  check('sort by sizeBytes ASC', bySize.every((doc, i) => i === 0 || Number(bySize[i - 1].sizeBytes) <= Number(doc.sizeBytes)));
  await call('P3-API-11 read document', 'GET', ws(w, `/documents/${leavePdf.id}`), { actor: viewer, org: w });
  await call('above-clearance document is 404', 'GET', ws(w, `/documents/${salaryTxt.id}`), { actor: member, org: w, expect: 404, code: 'DOCUMENT_NOT_FOUND' });
  await call('out-of-compartment document is 404', 'GET', ws(w, `/documents/${payrollDocx.id}`), { actor: admin, org: w, expect: 404, code: 'DOCUMENT_NOT_FOUND' });

  const chunks = await call('P3-API-12 chunks', 'GET', ws(w, `/documents/${leavePdf.id}/chunks?limit=1`), { actor: viewer, org: w });
  samples.chunk = chunks.data?.[0] && { ...chunks.data[0], text: chunks.data[0].text.slice(0, 240) };
  sameKeys('chunk shape', chunks.data?.[0], ['id', 'chunkIndex', 'text', 'tokenCount', 'pageStart', 'pageEnd']);
  check('chunk pagination meta', chunks.meta?.pagination?.limit === 1 && chunks.meta.pagination.totalItems === final[leavePdf.id]?.chunkCount, chunks.meta?.pagination);
  const failedChunks = await call('chunks of a never-indexed document', 'GET', ws(w, `/documents/${corruptPdf.id}/chunks`), { actor: owner, org: w });
  check('never-indexed document has no chunks', failedChunks.data?.length === 0);
  await call('chunks of hidden document', 'GET', ws(w, `/documents/${salaryTxt.id}/chunks`), { actor: member, org: w, expect: 404, code: 'DOCUMENT_NOT_FOUND' });

  const download = await call('P3-API-13 download PDF', 'GET', ws(w, `/documents/${leavePdf.id}/download`), { actor: owner, org: w, raw: true });
  check('download bytes identical to upload', download.buf && sha256(download.buf) === sha256(files.leavePdf.data));
  facts.downloadHeaders = {
    contentType: download.headers.get('content-type'),
    contentDisposition: download.headers.get('content-disposition'),
    cacheControl: download.headers.get('cache-control'),
    contentLength: download.headers.get('content-length'),
    exposeHeaders: download.headers.get('access-control-expose-headers'),
  };
  check('download is an attachment, not cached', /attachment/.test(facts.downloadHeaders.contentDisposition || '') && /no-store/.test(facts.downloadHeaders.cacheControl || ''));
  const urduDownload = await call('download with a Unicode filename', 'GET', ws(w, `/documents/${urdu.id}/download`), { actor: owner, org: w, raw: true });
  facts.unicodeDisposition = urduDownload.headers.get('content-disposition');
  check('Unicode filename survives in filename*', /filename\*=UTF-8''%D8/.test(facts.unicodeDisposition || '') && sha256(urduDownload.buf || Buffer.alloc(0)) === sha256(files.urdu.data), facts.unicodeDisposition);
  const docxDownload = await call('records manager downloads DOCX', 'GET', ws(w, `/documents/${payrollDocx.id}/download`), { actor: records, org: w, raw: true });
  check('DOCX bytes identical', docxDownload.buf && sha256(docxDownload.buf) === sha256(files.payrollDocx.data));
  await call('member lacks document:download', 'GET', ws(w, `/documents/${leavePdf.id}/download`), { actor: member, org: w, raw: true, expect: 403, code: 'PERMISSION_DENIED' });
  await call('download of hidden document', 'GET', ws(w, `/documents/${payrollDocx.id}/download`), { actor: admin, org: w, raw: true, expect: 404, code: 'DOCUMENT_NOT_FOUND' });
  const failedDownload = await call('download of FAILED document still serves original', 'GET', ws(w, `/documents/${corruptPdf.id}/download`), { actor: owner, org: w, raw: true });
  check('FAILED document original is downloadable', failedDownload.buf && sha256(failedDownload.buf) === sha256(files.corruptPdf.data));

  // ── Editing, reclassification, reindex, deletion ────────────────────────
  await call('member lacks document:update', 'PATCH', ws(w, `/documents/${handbookMd.id}`), { actor: member, org: w, body: { title: 'x' }, expect: 403, code: 'PERMISSION_DENIED' });
  const edited = need(await call('P3-API-14 edit metadata', 'PATCH', ws(w, `/documents/${handbookMd.id}`), {
    actor: admin, org: w, body: { title: 'Remote Work Guidelines', description: 'How we work remotely.', tags: ['Remote', 'HR', 'remote'] },
  }), 'edit');
  check('tags normalised on PATCH', JSON.stringify(edited.tags) === '["remote","hr"]' && edited.title === 'Remote Work Guidelines');
  const cleared = need(await call('clear description and tags', 'PATCH', ws(w, `/documents/${handbookMd.id}`), { actor: admin, org: w, body: { description: '', tags: [] } }), 'clear');
  check('description "" → null, tags []', cleared.description === null && cleared.tags.length === 0);
  await call('title null refused', 'PATCH', ws(w, `/documents/${handbookMd.id}`), { actor: admin, org: w, body: { title: null }, expect: 422 });
  await call('blank title refused', 'PATCH', ws(w, `/documents/${handbookMd.id}`), { actor: admin, org: w, body: { title: '  ' }, expect: 422 });
  await call('classification null refused', 'PATCH', ws(w, `/documents/${handbookMd.id}`), { actor: admin, org: w, body: { classification: null }, expect: 422 });
  await call('reclassify above clearance', 'PATCH', ws(w, `/documents/${leavePdf.id}`), { actor: admin, org: w, body: { classification: 'RESTRICTED' }, expect: 403, code: 'CLASSIFICATION_EXCEEDS_CLEARANCE' });
  const reclassified = need(await call('reclassify PUBLIC → CONFIDENTIAL', 'PATCH', ws(w, `/documents/${leavePdf.id}`), { actor: admin, org: w, body: { classification: 'CONFIDENTIAL' } }), 'reclass');
  check('reclassified', reclassified.classification === 'CONFIDENTIAL');
  await call('reclassification hides it from member at once', 'GET', ws(w, `/documents/${leavePdf.id}`), { actor: member, org: w, expect: 404, code: 'DOCUMENT_NOT_FOUND' });
  const memberRagHidden = await call('reclassified document leaves member retrieval at once', 'POST', ws(w, '/rag/query'), { actor: member, org: w, body: { query: 'How many days of annual leave do employees get?' } });
  check('no CONFIDENTIAL passage for member', (memberRagHidden.data?.results ?? []).every((hit) => hit.documentId !== leavePdf.id), (memberRagHidden.data?.results ?? []).map((hit) => hit.documentTitle));
  await call('reclassify back to PUBLIC', 'PATCH', ws(w, `/documents/${leavePdf.id}`), { actor: admin, org: w, body: { classification: 'PUBLIC' } });

  await call('viewer lacks document:reindex', 'POST', ws(w, `/documents/${handbookMd.id}/reindex`), { actor: viewer, org: w, body: {}, expect: 403, code: 'PERMISSION_DENIED' });
  const reindexed = need(await call('P3-API-15 member reindexes READY document', 'POST', ws(w, `/documents/${handbookMd.id}/reindex`), { actor: member, org: w, body: {}, expect: 202 }), 'reindex');
  check('reindex: new version queued, previous still searchable', reindexed.status === 'UPLOADED' && reindexed.indexVersion === 2 && reindexed.activeIndexVersion === 1 && reindexed.isSearchable === true, { status: reindexed.status, v: reindexed.indexVersion, a: reindexed.activeIndexVersion });
  const again = await call('second reindex while in flight', 'POST', ws(w, `/documents/${handbookMd.id}/reindex`), { actor: member, org: w, body: {}, expect: 409, code: 'DOCUMENT_PROCESSING' });
  check('conflict carries current status', typeof again.error?.details?.status === 'string', again.error?.details);
  samples.processingConflict = again.json;
  facts.reindexTrace = await traceDocument(viewer, w, handbookMd.id);
  const retry = need(await call('retry FAILED document', 'POST', ws(w, `/documents/${corruptPdf.id}/reindex`), { actor: owner, org: w, body: {}, expect: 202 }), 'retry');
  check('retry bumps version, still not searchable', retry.indexVersion === 2 && retry.isSearchable === false);
  await waitForDocuments(owner, w, [handbookMd.id, corruptPdf.id]);
  const afterReindex = await getDocument(owner, w, handbookMd.id);
  check('reindex completed: v2 active', afterReindex?.status === 'READY' && afterReindex.activeIndexVersion === 2, { status: afterReindex?.status, a: afterReindex?.activeIndexVersion });
  facts.reindexTimeline = (timelines[handbookMd.id] || []).map((s) => `${s.status} v${s.indexVersion} active=${s.activeIndexVersion} searchable=${s.isSearchable}`);
  const afterRetry = await getDocument(owner, w, corruptPdf.id);
  check('permanent failure fails again on retry', afterRetry?.status === 'FAILED' && afterRetry.indexVersion === 2, afterRetry?.failureCode);

  await call('member lacks document:delete', 'DELETE', ws(w, `/documents/${blankPdf.id}`), { actor: member, org: w, expect: 403, code: 'PERMISSION_DENIED' });
  await call('P3-API-16 delete document', 'DELETE', ws(w, `/documents/${blankPdf.id}`), { actor: admin, org: w });
  await call('deleted document is 404', 'GET', ws(w, `/documents/${blankPdf.id}`), { actor: admin, org: w, expect: 404, code: 'DOCUMENT_NOT_FOUND' });
  await call('delete again is 404', 'DELETE', ws(w, `/documents/${blankPdf.id}`), { actor: admin, org: w, expect: 404, code: 'DOCUMENT_NOT_FOUND' });
  await call('re-upload after delete is not a duplicate', 'POST', ws(w, `/knowledge-bases/${handbook.id}/documents`), { actor: owner, org: w, form: upload(files.blankPdf), expect: 202 }).then(async (res) => {
    if (res.data) {
      await waitForDocuments(owner, w, [res.data.id]);
      await call('cleanup re-upload', 'DELETE', ws(w, `/documents/${res.data.id}`), { actor: owner, org: w });
    }
  });

  // ── Retrieval ───────────────────────────────────────────────────────────
  const leaveQuestion = 'How many days of annual leave do new employees get?';
  const ownerRag = need(await call('P3-API-22 retrieval as owner', 'POST', ws(w, '/rag/query'), { actor: owner, org: w, body: { query: leaveQuestion } }), 'rag');
  samples.retrieval = { ...ownerRag, results: ownerRag.results.slice(0, 2).map((hit) => ({ ...hit, text: hit.text.slice(0, 200) })) };
  sameKeys('retrieval shape', ownerRag, ['retrievalId', 'mode', 'topK', 'reranked', 'embeddingModel', 'knowledgeBasesSearched', 'clearance', 'effectiveClearance', 'results', 'timings']);
  sameKeys('retrieved passage shape', ownerRag.results[0], ['chunkId', 'documentId', 'documentTitle', 'knowledgeBaseId', 'knowledgeBaseName', 'classification', 'chunkIndex', 'pageStart', 'pageEnd', 'rank', 'score', 'text']);
  const leaveRank = ownerRag.results.findIndex((hit) => hit.documentId === leavePdf.id) + 1;
  check('leave policy passage ranked in the top 3', leaveRank >= 1 && leaveRank <= 3, ownerRag.results.map((hit) => `${hit.rank} ${hit.documentTitle} ${hit.score}`));
  facts.leaveQuestionRanking = ownerRag.results.map((hit) => `${hit.rank}. ${hit.documentTitle} (${hit.classification}, score ${hit.score})`);
  facts.retrievalDefaults = { mode: ownerRag.mode, topK: ownerRag.topK, reranked: ownerRag.reranked, model: ownerRag.embeddingModel, searched: ownerRag.knowledgeBasesSearched, timings: ownerRag.timings, results: ownerRag.results.length };
  const memberRag = need(await call('retrieval as member', 'POST', ws(w, '/rag/query'), { actor: member, org: w, body: { query: 'What is the corporate card number and salary of Ayesha Raza?' } }), 'member rag');
  check('member never receives CONFIDENTIAL/RESTRICTED passages', memberRag.results.every((hit) => ['PUBLIC', 'INTERNAL'].includes(hit.classification) && hit.documentId !== salaryTxt.id));
  const recordsRag = need(await call('records manager retrieves RESTRICTED payroll', 'POST', ws(w, '/rag/query'), { actor: records, org: w, body: { query: 'What is the chief executive annual salary?' } }), 'records rag');
  check('payroll passage returned to RESTRICTED clearance', recordsRag.results[0]?.documentId === payrollDocx.id, recordsRag.results.map((hit) => hit.documentTitle));
  const adminRag = need(await call('admin same question', 'POST', ws(w, '/rag/query'), { actor: admin, org: w, body: { query: 'What is the chief executive annual salary?' } }), 'admin rag');
  check('admin never receives HR Records passages', adminRag.results.every((hit) => hit.knowledgeBaseId !== hrRecords.id));
  const narrowedHidden = await call('narrow to a hidden base', 'POST', ws(w, '/rag/query'), { actor: admin, org: w, body: { query: 'salary', knowledgeBaseIds: [hrRecords.id] }, expect: 404, code: 'KNOWLEDGE_BASE_NOT_FOUND' });
  check('hidden narrowing echoes the ids', narrowedHidden.error?.details?.knowledgeBaseIds?.[0] === hrRecords.id);
  const narrowedDoc = need(await call('narrow to a hidden document', 'POST', ws(w, '/rag/query'), { actor: member, org: w, body: { query: 'salary', documentIds: [salaryTxt.id] } }), 'narrow doc');
  check('hidden document narrowing silently returns nothing', narrowedDoc.results.length === 0);
  const narrowedBase = need(await call('narrow to Finance', 'POST', ws(w, '/rag/query'), { actor: admin, org: w, body: { query: 'revenue growth', knowledgeBaseIds: [finance.id] } }), 'narrow base');
  check('narrowing searches one base', narrowedBase.knowledgeBasesSearched === 1 && narrowedBase.results.every((hit) => hit.knowledgeBaseId === finance.id));
  const dense = need(await call('dense mode with minScore 0.99', 'POST', ws(w, '/rag/query'), { actor: owner, org: w, body: { query: leaveQuestion, mode: 'dense', minScore: 0.99 } }), 'dense');
  check('high minScore filters dense results', dense.mode === 'dense' && dense.results.length === 0);
  const nonsense = need(await call('hybrid has no relevance floor', 'POST', ws(w, '/rag/query'), { actor: owner, org: w, body: { query: 'zebra quantum volcano', rerank: false } }), 'nonsense');
  facts.nonsenseQueryResults = nonsense.results.length;
  const capped = need(await call('topK above RAG_MAX_TOP_K is capped', 'POST', ws(w, '/rag/query'), { actor: owner, org: w, body: { query: leaveQuestion, topK: 200, rerank: false } }), 'cap');
  facts.topKCap = capped.topK;
  const noRerank = need(await call('rerank false', 'POST', ws(w, '/rag/query'), { actor: owner, org: w, body: { query: leaveQuestion, rerank: false, topK: 3 } }), 'norerank');
  check('rerank false honoured', noRerank.reranked === false && noRerank.results.length <= 3);
  await call('blank query', 'POST', ws(w, '/rag/query'), { actor: owner, org: w, body: { query: '   ' }, expect: 422 });
  const longQuery = await call('query over RAG_MAX_QUERY_LENGTH', 'POST', ws(w, '/rag/query'), { actor: owner, org: w, body: { query: 'leave '.repeat(400) }, expect: 422, code: 'VALIDATION_FAILED' });
  check('query length error under fields.query', !!longQuery.error?.details?.fields?.query, longQuery.error?.details);
  await call('topK 0', 'POST', ws(w, '/rag/query'), { actor: owner, org: w, body: { query: 'x', topK: 0 }, expect: 422 });
  await call('unknown retrieval field', 'POST', ws(w, '/rag/query'), { actor: owner, org: w, body: { query: 'x', clearance: 'RESTRICTED' }, expect: 422 });
  await call('viewer lacks rag:query', 'POST', ws(w, '/rag/query'), { actor: viewer, org: w, body: { query: 'leave' }, expect: 403, code: 'PERMISSION_DENIED' });
  const rateHeaders = await call('retrieval rate-limit headers', 'POST', ws(w, '/rag/query'), { actor: member, org: w, body: { query: 'core hours', topK: 1 } });
  facts.ragRateHeaders = { limit: rateHeaders.headers.get('x-ratelimit-limit'), remaining: rateHeaders.headers.get('x-ratelimit-remaining'), reset: rateHeaders.headers.get('x-ratelimit-reset') };
  const scopes = {};
  for (const actor of [owner, admin, member, records]) {
    const scope = need(await call(`access scope as ${actor.name}`, 'GET', ws(w, '/rag/access-scope'), { actor, org: w }), 'scope');
    scopes[actor.name] = { clearance: scope.clearance, bypass: scope.bypassesCompartments, bases: scope.knowledgeBases.map((base) => `${base.name}:${base.accessMode}:${base.access}`) };
  }
  facts.accessScopes = scopes;
  check('owner bypasses, member sees Finance via grant', scopes.owner.bypass === true && scopes.member.bases.includes('Finance Reports:RESTRICTED:WRITE'));

  // ── Privacy ─────────────────────────────────────────────────────────────
  const piiText = `Ayesha Raza (ayesha.raza@acme.test, +92 300 1234567) earns PKR 950,000 per year. Ref ${run}.`;
  const analyzed = need(await call('P3-API-20 analyze as member', 'POST', ws(w, '/pii/analyze'), { actor: member, org: w, body: { text: piiText } }), 'analyze');
  samples.analyze = analyzed;
  sameKeys('analyze shape', analyzed, ['maskedText', 'entities', 'entityCount', 'byType', 'degraded', 'detectors', 'revealed', 'timings']);
  check('names, email, phone and salary masked; no values', /\[PERSON_1\]/.test(analyzed.maskedText) && /\[EMAIL_ADDRESS_1\]/.test(analyzed.maskedText) && !analyzed.maskedText.includes('ayesha.raza') && analyzed.entities.every((entity) => !('value' in entity)) && analyzed.degraded === false, analyzed.maskedText);
  check('masking keeps the bracket after a phone number', analyzed.maskedText.includes('[PHONE_NUMBER_1]) earns'), analyzed.maskedText);
  const denied = await call('reveal without pii:reveal', 'POST', ws(w, '/pii/analyze'), { actor: admin, org: w, body: { text: piiText, reveal: true }, expect: 403, code: 'PERMISSION_DENIED' });
  samples.permissionDenied = denied.json;
  const revealed = need(await call('owner reveal', 'POST', ws(w, '/pii/analyze'), { actor: owner, org: w, body: { text: piiText, reveal: true } }), 'reveal');
  check('reveal returns values', revealed.revealed === true && revealed.entities.some((entity) => entity.value === 'ayesha.raza@acme.test'));
  await call('analysis text over PII_MAX_ANALYZE_LENGTH', 'POST', ws(w, '/pii/analyze'), { actor: member, org: w, body: { text: 'a'.repeat(20_001) }, expect: 422, code: 'VALIDATION_FAILED' });
  await call('empty analysis text', 'POST', ws(w, '/pii/analyze'), { actor: member, org: w, body: { text: '' }, expect: 422 });
  await call('viewer cannot analyze', 'POST', ws(w, '/pii/analyze'), { actor: viewer, org: w, body: { text: piiText }, expect: 403, code: 'PERMISSION_DENIED' });

  const report = need(await call('P3-API-21 document report', 'GET', ws(w, `/pii/documents/${salaryTxt.id}/report`), { actor: admin, org: w }), 'report');
  samples.report = report;
  sameKeys('report shape', report, ['documentId', 'chunks', 'byType', 'entityCount', 'page', 'totalChunks', 'degraded', 'revealed', 'timings']);
  check('report masks the document', report.chunks.length > 0 && !report.chunks[0].maskedText.includes('ayesha.raza@acme.test') && report.entityCount > 0);
  await call('report limit 21', 'GET', ws(w, `/pii/documents/${salaryTxt.id}/report?limit=21`), { actor: admin, org: w, expect: 422 });
  await call('report reveal without permission', 'GET', ws(w, `/pii/documents/${salaryTxt.id}/report?reveal=true`), { actor: admin, org: w, expect: 403, code: 'PERMISSION_DENIED' });
  const ownerReport = need(await call('owner report with reveal', 'GET', ws(w, `/pii/documents/${salaryTxt.id}/report?reveal=true&limit=1`), { actor: owner, org: w }), 'reveal report');
  check('revealed report includes values', ownerReport.revealed === true && ownerReport.chunks[0]?.entities.some((entity) => typeof entity.value === 'string'));
  await call('report on hidden document', 'GET', ws(w, `/pii/documents/${salaryTxt.id}/report`), { actor: member, org: w, expect: 404, code: 'DOCUMENT_NOT_FOUND' });
  await call('viewer cannot open report', 'GET', ws(w, `/pii/documents/${leavePdf.id}/report`), { actor: viewer, org: w, expect: 403, code: 'PERMISSION_DENIED' });
  const failedReport = need(await call('report on never-indexed document', 'GET', ws(w, `/pii/documents/${corruptPdf.id}/report`), { actor: owner, org: w }), 'failed report');
  check('never-indexed report is empty', failedReport.chunks.length === 0 && failedReport.totalChunks === 0);

  await call('member cannot update policy', 'PUT', ws(w, '/pii/policy'), { actor: member, org: w, body: { enabled: true }, expect: 403, code: 'PERMISSION_DENIED' });
  const updated = need(await call('P3-API-18 update policy', 'PUT', ws(w, '/pii/policy'), {
    actor: admin, org: w,
    body: { expectedVersion: 0, denyList: ['Project Falcon'], allowList: ['Acme Corporation'], entityTypes: [...defaultPolicy.entityTypes, 'LOCATION'], onDetectorFailure: 'REFUSE' },
  }), 'policy update');
  samples.policyUpdated = updated;
  check('saved policy: version 1, CUSTOM added, LOCATION added', updated.source === 'workspace' && updated.version === 1 && updated.entityTypes.includes('CUSTOM') && updated.entityTypes.includes('LOCATION'));
  const conflict = await call('stale expectedVersion', 'PUT', ws(w, '/pii/policy'), { actor: admin, org: w, body: { expectedVersion: 0, scoreThreshold: 0.6 }, expect: 409, code: 'RESOURCE_CONFLICT' });
  check('conflict reports current version', conflict.error?.details?.currentVersion === 1, conflict.error?.details);
  await call('score threshold above 1', 'PUT', ws(w, '/pii/policy'), { actor: admin, org: w, body: { scoreThreshold: 1.5 }, expect: 422 });
  await call('entity type pattern', 'PUT', ws(w, '/pii/policy'), { actor: admin, org: w, body: { entityTypes: ['X'] }, expect: 422 });
  await call('unknown failure mode', 'PUT', ws(w, '/pii/policy'), { actor: admin, org: w, body: { onDetectorFailure: 'IGNORE' }, expect: 422 });
  const nulls = await call('null fields keep current values', 'PUT', ws(w, '/pii/policy'), { actor: admin, org: w, body: { enabled: null, scoreThreshold: null, entityTypes: null } });
  facts.policyNullFields = { status: nulls.status, version: nulls.data?.version, enabled: nulls.data?.enabled };
  const memberView = need(await call('member view hides deny list', 'GET', ws(w, '/pii/policy'), { actor: member, org: w }), 'member policy');
  check('deny list hidden, counted', memberView.denyList === null && memberView.denyListCount === 1);
  const custom = need(await call('deny and allow lists applied', 'POST', ws(w, '/pii/analyze'), { actor: member, org: w, body: { text: `Project Falcon is run with Acme Corporation in Lahore. ${run}` } }), 'custom');
  check('deny term masked as CUSTOM, allow term kept', /\[CUSTOM_1\]/.test(custom.maskedText) && custom.maskedText.includes('Acme Corporation'), custom.maskedText);
  const disabled = need(await call('disable redaction', 'PUT', ws(w, '/pii/policy'), { actor: admin, org: w, body: { enabled: false } }), 'disable');
  check('disabled policy warns', disabled.enabled === false && disabled.warnings.some((warning) => /disabled/i.test(warning)));
  const passthrough = need(await call('analysis with redaction off', 'POST', ws(w, '/pii/analyze'), { actor: member, org: w, body: { text: piiText } }), 'off');
  check('redaction off passes text through', passthrough.maskedText === piiText && passthrough.entities.length === 0);
  await call('re-enable redaction', 'PUT', ws(w, '/pii/policy'), { actor: admin, org: w, body: { enabled: true } });

  // ── API keys and grants to keys ─────────────────────────────────────────
  const keyRes = need(await call('owner issues API key', 'POST', ws(w, '/api-keys'), {
    actor: owner, org: w, expect: 201,
    body: { name: `Phase 3 ${run}`, scopes: ['knowledgebase:read', 'document:read', 'document:create', 'rag:query', 'clearance:internal', 'pii:policy:read'] },
  }), 'key');
  const apiKey = keyRes.plaintextKey;
  const keyBases = await call('API key lists bases', 'GET', ws(w, '/knowledge-bases'), { apiKey, org: w });
  check('API key sees WORKSPACE base only', (keyBases.data ?? []).map((base) => base.name).join() === 'Company Handbook');
  const keyGrant = need(await call('grant API key READ on Finance', 'PUT', ws(w, `/knowledge-bases/${finance.id}/grants`), { actor: admin, org: w, body: { subjectType: 'API_KEY', subjectId: keyRes.apiKey.id, accessLevel: 'READ' } }), 'key grant');
  check('API key grant label', keyGrant.subjectType === 'API_KEY' && typeof keyGrant.subjectLabel === 'string');
  const keyBases2 = await call('API key sees Finance after grant', 'GET', ws(w, '/knowledge-bases'), { apiKey, org: w });
  check('grant admits the key', (keyBases2.data ?? []).some((base) => base.id === finance.id && base.access === 'READ'));
  await call('API key retrieval', 'POST', ws(w, '/rag/query'), { apiKey, org: w, body: { query: 'travel reimbursement', topK: 2 } });
  const keyChunks = await call('API key on bearer-only chunks route', 'GET', ws(w, `/documents/${leavePdf.id}/chunks`), { apiKey, org: w, expect: [401, 403] });
  facts.apiKeyOnBearerOnlyRoute = { status: keyChunks.status, code: keyChunks.error?.code };
  await call('API key cannot write to a READ base', 'POST', ws(w, `/knowledge-bases/${finance.id}/documents`), { apiKey, org: w, form: upload({ name: 'k.txt', data: Buffer.from(`key ${run}`) }), expect: 403, code: 'KNOWLEDGE_BASE_ACCESS_DENIED' });
  await call('revoke key', 'DELETE', ws(w, `/api-keys/${keyRes.apiKey.id}`), { actor: owner, org: w, body: { reason: 'Phase 3 verification complete' } });
  const afterRevoke = need(await call('revoked key grant hidden', 'GET', ws(w, `/knowledge-bases/${finance.id}/grants`), { actor: admin, org: w }), 'grants after revoke');
  check('revoked key grant no longer listed', !afterRevoke.some((grant) => grant.id === keyGrant.id));
  await call('revoked key refused', 'GET', ws(w, '/knowledge-bases'), { apiKey, org: w, expect: 401 });

  // ── Tenant isolation ────────────────────────────────────────────────────
  const foreign = await call('outsider addresses another workspace', 'GET', ws(w, '/knowledge-bases'), { actor: outsider, org: w, expect: [403, 404] });
  facts.nonMemberWorkspaceAccess = { status: foreign.status, code: foreign.error?.code };
  await call('foreign base id inside own workspace', 'GET', ws(x, `/knowledge-bases/${handbook.id}`), { actor: outsider, org: x, expect: 404, code: 'KNOWLEDGE_BASE_NOT_FOUND' });
  await call('foreign document id inside own workspace', 'GET', ws(x, `/documents/${leavePdf.id}`), { actor: outsider, org: x, expect: 404, code: 'DOCUMENT_NOT_FOUND' });
  await call('foreign download inside own workspace', 'GET', ws(x, `/documents/${leavePdf.id}/download`), { actor: outsider, org: x, raw: true, expect: 404, code: 'DOCUMENT_NOT_FOUND' });
  await call('foreign base in retrieval narrowing', 'POST', ws(x, '/rag/query'), { actor: outsider, org: x, body: { query: 'leave', knowledgeBaseIds: [handbook.id] }, expect: 404, code: 'KNOWLEDGE_BASE_NOT_FOUND' });
  const emptyScope = need(await call('empty workspace retrieval', 'POST', ws(x, '/rag/query'), { actor: outsider, org: x, body: { query: 'leave' } }), 'empty rag');
  check('no readable bases → empty results, 0 searched', emptyScope.results.length === 0 && emptyScope.knowledgeBasesSearched === 0);
  await call('foreign PII report', 'GET', ws(x, `/pii/documents/${salaryTxt.id}/report`), { actor: outsider, org: x, expect: 404, code: 'DOCUMENT_NOT_FOUND' });
  await call('header/path mismatch uses header', 'GET', ws(x, `/documents/${leavePdf.id}`), { actor: owner, org: w, expect: [200, 400, 403, 404] }).then((res) => {
    facts.headerPathMismatch = { status: res.status, code: res.error?.code };
  });

  // ── AI outage and recovery (opt-in) ─────────────────────────────────────
  if (INJECT_OUTAGE) await outage({ owner, admin, member, w, handbook, leavePdf });

  // ── Knowledge base deletion and purge ───────────────────────────────────
  await call('member cannot delete base', 'DELETE', ws(w, `/knowledge-bases/${handbook.id}`), { actor: member, org: w, expect: 403, code: 'PERMISSION_DENIED' });
  const before = {};
  for (const id of [financeMd.id, memberFinance2.id]) before[id] = await storageProbe(w, finance.id, id);
  facts.beforeDeletion = before;
  check('stored objects and vectors exist before deletion', Object.values(before).every((probe) => probe.object === true && probe.vectors > 0), before);
  await call('delete Finance base', 'DELETE', ws(w, `/knowledge-bases/${finance.id}`), { actor: admin, org: w });
  await call('documents of deleted base are gone', 'GET', ws(w, `/documents/${financeMd.id}`), { actor: owner, org: w, expect: 404, code: 'DOCUMENT_NOT_FOUND' });
  await call('download from deleted base', 'GET', ws(w, `/documents/${financeMd.id}/download`), { actor: owner, org: w, raw: true, expect: 404, code: 'DOCUMENT_NOT_FOUND' });
  const leftover = await docsAs(owner, `&search=q3`);
  check('deleted base documents absent from list', leftover.length === 0);
  const afterDelete = await call('retrieval after base deletion', 'POST', ws(w, '/rag/query'), { actor: owner, org: w, body: { query: 'revenue growth capital budget', rerank: false } });
  check('no passages from deleted base', (afterDelete.data?.results ?? [null]).every((hit) => hit && hit.knowledgeBaseId !== finance.id));
  facts.purge = await verifyPurge(w, finance.id, [financeMd.id, memberFinance2.id]);

  for (const base of [handbook, hrRecords]) {
    await call(`P3-API-05 delete ${base.name}`, 'DELETE', ws(w, `/knowledge-bases/${base.id}`), { actor: owner, org: w });
    base.deleted = true;
  }
  createdBases.length = 0;
  facts.workspaceContentAfterAllBasesDeleted = await workspaceRemainder(w);
  check('every stored object and vector of the workspace purged', facts.workspaceContentAfterAllBasesDeleted.objects === 0 && facts.workspaceContentAfterAllBasesDeleted.vectors === 0, facts.workspaceContentAfterAllBasesDeleted);
}

// The server's schema defaults, used when .env leaves these unset.
const STORAGE_PREFIX = (process.env.STORAGE_KEY_PREFIX ?? 'daiap/').replace(/^\/+|\/+$/g, '');
const COLLECTION_PREFIX = process.env.QDRANT_COLLECTION_PREFIX ?? 'daiap_';
let s3;
function storage() {
  if (s3 !== undefined) return s3;
  try {
    const { S3Client, HeadObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
    s3 = {
      client: new S3Client({
        region: process.env.STORAGE_S3_REGION || 'auto',
        endpoint: process.env.STORAGE_S3_ENDPOINT || undefined,
        forcePathStyle: process.env.STORAGE_S3_FORCE_PATH_STYLE === 'true',
        credentials: process.env.STORAGE_S3_ACCESS_KEY_ID
          ? { accessKeyId: process.env.STORAGE_S3_ACCESS_KEY_ID, secretAccessKey: process.env.STORAGE_S3_SECRET_ACCESS_KEY }
          : undefined,
      }),
      HeadObjectCommand,
      ListObjectsV2Command,
    };
  } catch {
    s3 = null;
  }
  return s3;
}
const objectPrefix = (org) => `${STORAGE_PREFIX ? `${STORAGE_PREFIX}/` : ''}orgs/${org}/`;
const objectKey = (org, kb, doc) => `${objectPrefix(org)}kbs/${kb}/documents/${doc}/original`;

async function countVectors(org, filter) {
  try {
    const collection = `${COLLECTION_PREFIX}ws_${org.replace(/-/g, '')}`;
    const res = await fetch(`${process.env.QDRANT_URL.replace(/\/+$/, '')}/collections/${collection}/points/count`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(process.env.QDRANT_API_KEY ? { 'api-key': process.env.QDRANT_API_KEY } : {}) },
      body: JSON.stringify({ exact: true, ...(filter ? { filter } : {}) }),
    });
    return res.ok ? (await res.json()).result.count : null;
  } catch {
    return null;
  }
}

/** Whether a document's stored object exists, and how many of its vectors remain. */
async function storageProbe(org, kb, documentId) {
  let object = null;
  const store = storage();
  if (store) {
    try {
      await store.client.send(new store.HeadObjectCommand({ Bucket: process.env.STORAGE_S3_BUCKET, Key: objectKey(org, kb, documentId) }));
      object = true;
    } catch (error) {
      object = error?.$metadata?.httpStatusCode === 404 || error?.name === 'NotFound' ? false : null;
    }
  }
  const vectors = await countVectors(org, { must: [{ key: 'document_id', match: { value: documentId } }] });
  return { object, vectors };
}

/** Confirms the background purge removed stored objects and vectors. */
async function verifyPurge(org, knowledgeBaseId, documentIds) {
  const report = {};
  for (const documentId of documentIds) {
    const started = Date.now();
    let probe = await storageProbe(org, knowledgeBaseId, documentId);
    while (Date.now() - started < 150_000 && !(probe.object === false && probe.vectors === 0)) {
      await sleep(3000);
      probe = await storageProbe(org, knowledgeBaseId, documentId);
    }
    report[documentId] = { ...probe, purgedWithinMs: Date.now() - started };
    check(`purge removed stored object and vectors for ${documentId.slice(0, 8)}`, probe.object === false && probe.vectors === 0, report[documentId]);
  }
  return report;
}

/** Objects and vectors left anywhere in the workspace, waiting for the purge to finish. */
async function workspaceRemainder(org) {
  const store = storage();
  const started = Date.now();
  let objects = null;
  let vectors = null;
  while (Date.now() - started < 180_000) {
    if (store) {
      const listed = await store.client.send(new store.ListObjectsV2Command({ Bucket: process.env.STORAGE_S3_BUCKET, Prefix: objectPrefix(org) }));
      objects = listed.KeyCount ?? 0;
    }
    vectors = await countVectors(org);
    if (objects === 0 && vectors === 0) break;
    await sleep(4000);
  }
  return { objects, vectors, waitedMs: Date.now() - started };
}

async function outage({ owner, admin, member, w, handbook, leavePdf }) {
  check('AI service stopped for outage test', stopAiService());
  await waitForHealth((info) => info.ai_service?.status === 'down', 45_000);
  facts.outageHealth = lastHealth;
  const readyDuring = await call('readiness during AI outage', 'GET', '/health/ready', { expect: [200, 503] });
  facts.readinessDuringOutage = readyDuring.status;
  const ragDown = await call('retrieval during AI outage', 'POST', ws(w, '/rag/query'), { actor: owner, org: w, body: { query: 'annual leave days' }, expect: 503, code: 'AI_SERVICE_UNAVAILABLE' });
  samples.aiUnavailable = ragDown.json;
  const piiDown = await call('analysis during outage, policy REFUSE', 'POST', ws(w, '/pii/analyze'), { actor: member, org: w, body: { text: `Ayesha Raza called from Lahore (${crypto.randomUUID()}).` }, expect: 503, code: 'PII_DETECTION_UNAVAILABLE' });
  samples.piiUnavailable = piiDown.json;
  await call('switch policy to DEGRADE_TO_PATTERNS', 'PUT', ws(w, '/pii/policy'), { actor: admin, org: w, body: { onDetectorFailure: 'DEGRADE_TO_PATTERNS' } });
  const degraded = need(await call('analysis degraded to patterns', 'POST', ws(w, '/pii/analyze'), { actor: member, org: w, body: { text: `Ayesha Raza (ayesha@acme.test) ${crypto.randomUUID()}` } }), 'degraded');
  check('degraded: email masked, name not', degraded.degraded === true && /\[EMAIL_ADDRESS_1\]/.test(degraded.maskedText) && degraded.maskedText.includes('Ayesha Raza'), degraded.maskedText);
  await call('chunks still readable during outage', 'GET', ws(w, `/documents/${leavePdf.id}/chunks`), { actor: owner, org: w });
  await call('download still works during outage', 'GET', ws(w, `/documents/${leavePdf.id}/download`), { actor: owner, org: w, raw: true });
  const outageDoc = need(await call('upload during AI outage is accepted', 'POST', ws(w, `/knowledge-bases/${handbook.id}/documents`), {
    actor: owner, org: w, form: upload({ name: 'outage-note.txt', data: Buffer.from(`Office closure notice: the Lahore office is closed on 1 November (${run}).\n`) }), expect: 202,
  }), 'outage doc');
  // Watch the first retry appear while the service is still down.
  const firstRetry = Date.now();
  let retrying = null;
  while (Date.now() - firstRetry < 90_000) {
    const doc = await getDocument(owner, w, outageDoc.id);
    (timelines[outageDoc.id] ||= []).push({ atMs: Date.now() - firstRetry, status: doc?.status, statusMessage: doc?.statusMessage, failureCode: doc?.failureCode });
    if (doc?.statusMessage) {
      retrying = doc;
      break;
    }
    await sleep(2000);
  }
  check('in-flight retry is visible in statusMessage', !!retrying && ['UPLOADED', 'PARSING'].includes(retrying.status), retrying && { status: retrying.status, message: retrying.statusMessage });
  facts.retryMessage = retrying && { status: retrying.status, statusMessage: retrying.statusMessage };
  startAiService();
  const up = await waitForHealth((info) => info.ai_service?.status === 'up' && info.pii_detector?.status === 'up', 180_000);
  check('AI service recovered', !!up);
  const recovered = await waitForDocuments(owner, w, [outageDoc.id], 420_000);
  const recoveredDoc = await getDocument(owner, w, outageDoc.id);
  check('upload made during outage becomes READY after recovery', recovered && recoveredDoc?.status === 'READY', { status: recoveredDoc?.status, failure: recoveredDoc?.failureCode, attempts: recoveredDoc?.processingMetrics?.attempts });
  facts.outageRecovery = (timelines[outageDoc.id] || []).map((step) => `${step.atMs}ms ${step.status}${step.statusMessage ? ` "${step.statusMessage}"` : ''}`);
  await call('retrieval after recovery', 'POST', ws(w, '/rag/query'), { actor: owner, org: w, body: { query: 'When is the Lahore office closed?', rerank: false } });
  await call('restore REFUSE policy', 'PUT', ws(w, '/pii/policy'), { actor: admin, org: w, body: { onDetectorFailure: 'REFUSE' } });
}

main()
  .catch((error) => {
    console.log(JSON.stringify({ fatal: error.message }));
    results.push({ label: 'run completed', pass: false, error: error.message });
  })
  .finally(async () => {
    for (const base of createdBases) {
      await call('cleanup delete remaining base', 'DELETE', ws(base.org, `/knowledge-bases/${base.id}`), { actor: base.actor, org: base.org, expect: [200, 404] });
    }
    for (const workspace of workspaces) {
      await call('cleanup delete disposable workspace', 'DELETE', ws(workspace.id), { actor: workspace.actor, org: workspace.id });
    }
    for (const actor of Object.values(actors)) {
      await call('cleanup logout all fixture sessions', 'POST', '/api/v1/auth/logout-all', { actor, body: {} });
    }
    const passed = results.filter((row) => row.pass).length;
    const operations = [...new Set(results.map((row) => /^P3-API-(\d+)/.exec(row.label)?.[1]).filter(Boolean))];
    const report = {
      run,
      baseUrl: BASE,
      completedAt: new Date().toISOString(),
      outageInjected: INJECT_OUTAGE,
      summary: { total: results.length, passed, failed: results.length - passed },
      facts,
      timelines,
      samples,
      results,
      fixtureUsers: Object.values(actors).map((actor) => actor.user?.id),
      fixtureWorkspaces: workspaces.map((workspace) => workspace.id),
      limitations: [
        'Members joined through real invitation emails read from the Ethereal test inbox; no direct database writes.',
        'Fixture accounts retained with sessions revoked; workspaces soft-deleted through the API.',
        'Workspace vector collections are removed by the organization purge after ORGANIZATION_PURGE_GRACE.',
        'No browser/frontend tests.',
      ],
    };
    // Revealed values are synthetic, but they are still not stored.
    const scrub = (value) => (Array.isArray(value) ? value.map(scrub) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'value' ? '<revealed value omitted>' : scrub(item)]))
      : value);
    report.samples = scrub(report.samples);
    fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ total: results.length, passed, failed: results.length - passed, operationsLabelled: operations.length }));
    process.exitCode = results.some((row) => !row.pass) ? 1 : 0;
  });
