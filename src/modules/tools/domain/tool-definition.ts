import { createHash } from 'node:crypto';
import { stableStringify } from '../../../common/utils/stable-stringify';
import { uuidV5 } from '../../../common/utils/uuid.util';
import {
  checkSchema,
  isPlainObject,
  type JsonSchema,
  type SchemaIssue,
} from './json-schema';
import type { Integrity, ToolDataPolicy } from './information-flow';

export enum ToolKind {
  /** Implemented by the platform. The same id in every workspace. */
  BUILTIN = 'BUILTIN',
  /** An outbound HTTP call a workspace administrator defined. */
  HTTP = 'HTTP',
}

/** Model-facing tool names: short identifiers the model can copy exactly. */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{2,47}$/;

/**
 * Built-in tool ids are name-based UUIDs in a fixed namespace, so every
 * workspace refers to `calculator` by the same id and an agent's grant list
 * holds only UUIDs whichever kind of tool it names.
 */
export const BUILTIN_TOOL_NAMESPACE = '6f1c2a9e-3d4b-5e8f-9a0b-7c6d5e4f3a2b';

export function builtinToolId(name: string): string {
  return uuidV5(`builtin-tool:${name}`, BUILTIN_TOOL_NAMESPACE);
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type HttpAuth =
  | { type: 'none' }
  | { type: 'bearer' }
  | { type: 'header'; headerName: string }
  | { type: 'basic'; username: string };

/**
 * An HTTP tool: a request template the model fills with arguments.
 *
 * `url` is a fixed origin followed by a path that may contain `{{argument}}`
 * placeholders, e.g. `https://api.example.com/v1/orders/{{orderId}}`. Values
 * are URL-encoded into path segments and query parameters; they can never
 * reach the scheme, host or port, which are fixed when the tool is defined
 * and checked against the platform allowlist on every call.
 */
export interface HttpToolConfig {
  method: HttpMethod;
  url: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  /** JSON body for POST/PUT/PATCH. String leaves may be templates. */
  body?: unknown;
  auth: HttpAuth;
  /** JSON pointer selecting part of a JSON response, e.g. `/data/items`. */
  responsePath?: string;
}

/** Everything the engine needs to offer and run one tool. */
export interface ToolDescriptor {
  id: string;
  kind: ToolKind;
  name: string;
  displayName: string;
  description: string;
  parameters: JsonSchema;
  dataPolicy: ToolDataPolicy;
  /** How trustworthy the tool's output is, for the integrity label of what follows. */
  resultIntegrity: Integrity;
  requiresApproval: boolean;
  /** Permissions the delegating principal must hold, beyond `tool:execute`. */
  requiredPermissions: string[];
  timeoutMs: number;
  /** Calls allowed per agent answer or workflow run, below the platform-wide ceiling. */
  maxCallsPerRun?: number;
  version: number;
  /** SHA-256 of the behaviour-defining fields, recorded with every execution. */
  digest: string;
  enabled: boolean;
  http?: HttpToolConfig;
}

export function descriptorDigest(
  descriptor: Pick<
    ToolDescriptor,
    | 'name'
    | 'description'
    | 'parameters'
    | 'dataPolicy'
    | 'requiresApproval'
    | 'timeoutMs'
    | 'http'
  >,
): string {
  return createHash('sha256')
    .update(
      stableStringify({
        name: descriptor.name,
        description: descriptor.description,
        parameters: descriptor.parameters,
        dataPolicy: descriptor.dataPolicy,
        requiresApproval: descriptor.requiresApproval,
        timeoutMs: descriptor.timeoutMs,
        http: descriptor.http ?? null,
      }),
    )
    .digest('hex');
}

// ── Validating an HTTP tool definition ──────────────────────────────────────

const TEMPLATE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** Headers a tool may not set: transport-level, or reserved for its auth configuration. */
const FORBIDDEN_HEADERS: ReadonlySet<string> = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'proxy-authorization',
  'proxy-connection',
  'authorization',
  'cookie',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
]);

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;

export interface HttpDefinitionCheck {
  issues: SchemaIssue[];
  /** The fixed origin, when the URL is well formed. */
  origin: string | null;
}

/**
 * Checks an HTTP tool definition: the URL's origin is fixed and parseable,
 * templates appear only where they are safe, every template names a declared
 * parameter, and no forbidden header is set.
 */
export function checkHttpDefinition(
  config: HttpToolConfig,
  parameters: JsonSchema,
): HttpDefinitionCheck {
  const issues: SchemaIssue[] = [];
  const declared = new Set(Object.keys(parameters.properties ?? {}));

  const referenced = (text: string, path: string) => {
    for (const match of text.matchAll(new RegExp(TEMPLATE.source, 'g'))) {
      if (!declared.has(match[1])) {
        issues.push({
          path,
          message: `{{${match[1]}}} does not name a declared parameter.`,
        });
      }
    }
  };

  // The origin must be fixed: no template before the path begins.
  let origin: string | null = null;
  const authority = splitToolUrl(config.url).origin;
  if (!config.url.includes('://')) {
    issues.push({ path: '/http/url', message: 'The URL must be absolute (https://…).' });
  } else if (authority.includes('{{')) {
    issues.push({
      path: '/http/url',
      message: 'Arguments may fill the path and query, never the scheme, host or port.',
    });
  } else {
    try {
      const parsed = new URL(config.url.replace(new RegExp(TEMPLATE.source, 'g'), 'x'));
      if (!['https:', 'http:'].includes(parsed.protocol)) {
        issues.push({ path: '/http/url', message: 'Only http(s) URLs are supported.' });
      } else if (parsed.username || parsed.password) {
        issues.push({
          path: '/http/url',
          message: 'Credentials belong in the tool’s authentication, not the URL.',
        });
      } else if (parsed.hash) {
        issues.push({ path: '/http/url', message: 'URLs may not contain a fragment.' });
      } else {
        origin = parsed.origin;
      }
    } catch {
      issues.push({ path: '/http/url', message: 'The URL is not valid.' });
    }
  }
  referenced(config.url, '/http/url');

  for (const [name, value] of Object.entries(config.query ?? {})) {
    if (typeof value !== 'string') {
      issues.push({
        path: `/http/query/${name}`,
        message: 'Query values must be strings.',
      });
    } else {
      referenced(value, `/http/query/${name}`);
    }
  }

  for (const [name, value] of Object.entries(config.headers ?? {})) {
    if (!HEADER_NAME.test(name) || FORBIDDEN_HEADERS.has(name.toLowerCase())) {
      issues.push({
        path: `/http/headers/${name}`,
        message: `The header "${name}" may not be set by a tool.`,
      });
    } else if (typeof value !== 'string' || /[\r\n]/.test(value)) {
      issues.push({
        path: `/http/headers/${name}`,
        message: 'Header values must be single-line strings.',
      });
    } else {
      referenced(value, `/http/headers/${name}`);
    }
  }

  if (config.body !== undefined) {
    if (config.method === 'GET' || config.method === 'DELETE') {
      issues.push({
        path: '/http/body',
        message: `${config.method} requests carry no body.`,
      });
    }
    forEachString(config.body, '/http/body', (value, path) => referenced(value, path));
  }

  if (config.auth.type === 'header') {
    const headerName = config.auth.headerName;
    if (!HEADER_NAME.test(headerName) || FORBIDDEN_HEADERS.has(headerName.toLowerCase())) {
      if (headerName.toLowerCase() !== 'authorization') {
        issues.push({
          path: '/http/auth/headerName',
          message: `The header "${headerName}" cannot carry a credential.`,
        });
      }
    }
  }

  if (
    config.responsePath !== undefined &&
    !/^(\/[^/]{1,64}){0,8}$/.test(config.responsePath)
  ) {
    issues.push({
      path: '/http/responsePath',
      message:
        'responsePath must be a JSON pointer such as /data/items (at most 8 segments).',
    });
  }

  return { issues, origin };
}

/** Checks a tool's parameter schema. */
export function checkParameters(parameters: unknown): SchemaIssue[] {
  return checkSchema(parameters, { rootObject: true });
}

// ── Rendering an HTTP request from arguments ────────────────────────────────

export interface RenderedHttpRequest {
  url: URL;
  headers: Record<string, string>;
  body?: string;
}

/**
 * Fills an HTTP tool's templates with (validated) arguments.
 *
 * Path values are percent-encoded one segment at a time, so `../admin` stays a
 * literal segment; query values go through `URLSearchParams`. A body string
 * that is exactly one template takes the argument's JSON type (a number stays
 * a number); anything else is string interpolation.
 */
export function renderHttpRequest(
  config: HttpToolConfig,
  args: Record<string, unknown>,
): RenderedHttpRequest {
  const text = (value: unknown): string =>
    value === undefined || value === null
      ? ''
      : typeof value === 'string'
        ? value
        : JSON.stringify(value);

  const { origin, path: pathTemplate } = splitToolUrl(config.url);
  const questionMark = pathTemplate.indexOf('?');
  const pathPart = questionMark === -1 ? pathTemplate : pathTemplate.slice(0, questionMark);
  const queryPart = questionMark === -1 ? '' : pathTemplate.slice(questionMark + 1);

  const path = pathPart.replace(
    new RegExp(TEMPLATE.source, 'g'),
    (_match, name: string) => {
      const value = text(args[name]);
      // The URL parser collapses "." and ".." segments — even percent-encoded
      // ones — so a value that is one would walk up the tool's fixed path.
      if (/^\s*(\.|%2e){1,2}\s*$/i.test(value)) {
        throw new HttpTemplateError(`"${name}" may not be "." or "..".`);
      }
      return encodeURIComponent(value);
    },
  );
  const url = new URL(`${origin}${path}`);

  // Belt and braces: whatever the arguments were, the request stays under the
  // tool's fixed path prefix.
  const fixedPrefix = pathPart.split('{{')[0];
  if (!url.pathname.startsWith(fixedPrefix)) {
    throw new HttpTemplateError('The arguments would change the tool’s fixed path.');
  }

  for (const pair of queryPart.split('&')) {
    if (!pair) continue;
    const equals = pair.indexOf('=');
    const name = safeDecode(equals === -1 ? pair : pair.slice(0, equals));
    const template = safeDecode(equals === -1 ? '' : pair.slice(equals + 1));
    const value = interpolate(template, args, text);
    if (value.length > 0 || !template.includes('{{')) url.searchParams.append(name, value);
  }
  for (const [name, template] of Object.entries(config.query ?? {})) {
    const value = interpolate(template, args, text);
    // An optional argument the model left out drops its query parameter.
    if (value.length > 0) url.searchParams.set(name, value);
  }

  const headers: Record<string, string> = {};
  for (const [name, template] of Object.entries(config.headers ?? {})) {
    const value = interpolate(template, args, text).replace(/[\r\n]+/g, ' ');
    if (value.length > 0) headers[name.toLowerCase()] = value.slice(0, 1024);
  }

  let body: string | undefined;
  if (config.body !== undefined && !['GET', 'DELETE'].includes(config.method)) {
    body = JSON.stringify(renderBody(config.body, args, text));
    headers['content-type'] = 'application/json';
  }

  return { url, headers, body };
}

/** An argument that cannot be placed into the request safely. */
export class HttpTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HttpTemplateError';
  }
}

/**
 * Splits a tool URL into its fixed origin and its path-and-query template. A
 * URL with no path gets `/`.
 */
export function splitToolUrl(url: string): { origin: string; path: string } {
  const schemeEnd = url.indexOf('://');
  const afterScheme = schemeEnd === -1 ? 0 : schemeEnd + 3;
  let pathStart = url.length;
  for (const delimiter of ['/', '?']) {
    const index = url.indexOf(delimiter, afterScheme);
    if (index !== -1 && index < pathStart) pathStart = index;
  }
  const origin = url.slice(0, pathStart);
  const rest = url.slice(pathStart);
  return { origin, path: rest.startsWith('/') ? rest : `/${rest}` };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

function interpolate(
  template: string,
  args: Record<string, unknown>,
  text: (value: unknown) => string,
): string {
  return template.replace(new RegExp(TEMPLATE.source, 'g'), (_match, name: string) =>
    text(args[name]),
  );
}

function renderBody(
  node: unknown,
  args: Record<string, unknown>,
  text: (value: unknown) => string,
): unknown {
  if (typeof node === 'string') {
    const whole = new RegExp(`^${TEMPLATE.source}$`).exec(node.trim());
    if (whole) return args[whole[1]] ?? null;
    return interpolate(node, args, text);
  }
  if (Array.isArray(node)) return node.map((item) => renderBody(item, args, text));
  if (isPlainObject(node)) {
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) => [key, renderBody(value, args, text)]),
    );
  }
  return node;
}

function forEachString(
  node: unknown,
  path: string,
  visit: (value: string, path: string) => void,
): void {
  if (typeof node === 'string') visit(node, path);
  else if (Array.isArray(node))
    node.forEach((item, i) => forEachString(item, `${path}/${i}`, visit));
  else if (isPlainObject(node)) {
    for (const [key, value] of Object.entries(node))
      forEachString(value, `${path}/${key}`, visit);
  }
}

/** Resolves a JSON pointer against a parsed JSON value. */
export function resolvePointer(value: unknown, pointer: string | undefined): unknown {
  if (!pointer) return value;
  let current = value;
  for (const raw of pointer.split('/').slice(1)) {
    const segment = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) current = current[Number(segment)];
    else if (isPlainObject(current)) {
      // Own properties only: a pointer selects data, never what an object inherits.
      current = Object.hasOwn(current, segment) ? current[segment] : undefined;
    } else return undefined;
  }
  return current;
}
