/**
 * A strict subset of JSON Schema (draft 2020-12) for tool signatures.
 *
 * Tool arguments are written by a language model, which is to say by whoever
 * managed to influence its context. They are validated against the tool's
 * schema before anything runs, so the schema is a security boundary, and a
 * boundary must mean exactly what it says. Hence the rule this module enforces:
 *
 *     **a keyword the validator does not enforce is a keyword the registry
 *     rejects.**
 *
 * A schema written with `pattern` or `oneOf` against a validator that ignored
 * them would *look* like it constrained the arguments while constraining
 * nothing. So those keywords are refused when a tool is registered, and what a
 * registered schema says is precisely what is checked.
 *
 * Deliberately absent:
 *
 *  - `$ref`, `$defs` — no references, so no remote fetches and no recursion.
 *  - `pattern`, `patternProperties` — regular expressions supplied by one
 *    party and run against text written by another are a ReDoS vector.
 *    `format` covers the common cases with fixed, linear-time checks.
 *  - `oneOf` / `anyOf` / `allOf` / `not` / `if` — composition makes a schema's
 *    meaning hard to review, and tool signatures do not need it.
 */

export type JsonSchemaType =
  'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

export type JsonSchemaFormat = 'email' | 'uri' | 'uuid' | 'date' | 'date-time';

export interface JsonSchema {
  type?: JsonSchemaType | JsonSchemaType[];
  title?: string;
  description?: string;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  // string
  minLength?: number;
  maxLength?: number;
  format?: JsonSchemaFormat;
  // number / integer
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  // object
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  // array
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
}

export interface SchemaIssue {
  /** JSON-pointer-style location, e.g. `/properties/query` or `/recipients/2`. */
  path: string;
  message: string;
}

export const SCHEMA_LIMITS = {
  maxDepth: 6,
  maxProperties: 100,
  maxEnumValues: 100,
  maxStringLength: 100_000,
  maxDescriptionLength: 1_000,
  maxPropertyNameLength: 64,
} as const;

const TYPES: ReadonlySet<string> = new Set([
  'string',
  'number',
  'integer',
  'boolean',
  'object',
  'array',
  'null',
]);

const FORMATS: ReadonlySet<string> = new Set(['email', 'uri', 'uuid', 'date', 'date-time']);

/** Keywords accepted, and therefore enforced. `$schema` is tolerated and ignored. */
const KNOWN_KEYWORDS: ReadonlySet<string> = new Set([
  '$schema',
  'type',
  'title',
  'description',
  'enum',
  'const',
  'default',
  'examples',
  'minLength',
  'maxLength',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'uniqueItems',
]);

const PROPERTY_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ── Checking a schema (at registration) ─────────────────────────────────────

/**
 * Problems with a schema itself. Empty means it may be registered.
 *
 * `rootObject` requires the schema to describe an object — a tool's parameters
 * are always named, so the model's call is `{ "name": …, "arguments": { … } }`.
 */
export function checkSchema(
  schema: unknown,
  options: { rootObject?: boolean } = {},
): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const counter = { properties: 0 };

  if (!isPlainObject(schema)) {
    return [{ path: '', message: 'A schema must be a JSON object.' }];
  }
  if (options.rootObject && schema.type !== 'object') {
    issues.push({
      path: '/type',
      message: 'A tool’s parameters must be an object schema ("type": "object").',
    });
  }
  checkNode(schema, '', 1, issues, counter);
  return issues;
}

function checkNode(
  node: Record<string, unknown>,
  path: string,
  depth: number,
  issues: SchemaIssue[],
  counter: { properties: number },
): void {
  if (depth > SCHEMA_LIMITS.maxDepth) {
    issues.push({
      path,
      message: `Schemas may nest at most ${SCHEMA_LIMITS.maxDepth} levels deep.`,
    });
    return;
  }

  for (const keyword of Object.keys(node)) {
    if (!KNOWN_KEYWORDS.has(keyword)) {
      issues.push({
        path: `${path}/${keyword}`,
        message:
          `"${keyword}" is not supported. Only keywords the platform enforces are accepted ` +
          '(see docs/contracts/workflow-graph-v1.md, "Tool schemas").',
      });
    }
  }

  const types = typesOf(node.type);
  if (node.type !== undefined) {
    if (types.length === 0 || types.some((type) => !TYPES.has(type))) {
      issues.push({ path: `${path}/type`, message: 'Unknown type.' });
    }
  } else if (node.const === undefined && node.enum === undefined) {
    issues.push({ path: `${path}/type`, message: 'Every schema must declare a type.' });
  }

  for (const key of ['title', 'description'] as const) {
    const value = node[key];
    if (value !== undefined && typeof value !== 'string') {
      issues.push({ path: `${path}/${key}`, message: `"${key}" must be a string.` });
    } else if (
      typeof value === 'string' &&
      value.length > SCHEMA_LIMITS.maxDescriptionLength
    ) {
      issues.push({
        path: `${path}/${key}`,
        message: `"${key}" is limited to ${SCHEMA_LIMITS.maxDescriptionLength} characters.`,
      });
    }
  }

  if (node.enum !== undefined) {
    if (!Array.isArray(node.enum) || node.enum.length === 0) {
      issues.push({ path: `${path}/enum`, message: '"enum" must be a non-empty array.' });
    } else if (node.enum.length > SCHEMA_LIMITS.maxEnumValues) {
      issues.push({
        path: `${path}/enum`,
        message: `"enum" is limited to ${SCHEMA_LIMITS.maxEnumValues} values.`,
      });
    }
  }

  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems'] as const) {
    const value = node[key];
    if (value !== undefined && (!Number.isInteger(value) || (value as number) < 0)) {
      issues.push({
        path: `${path}/${key}`,
        message: `"${key}" must be a non-negative integer.`,
      });
    }
  }
  if (
    typeof node.maxLength === 'number' &&
    node.maxLength > SCHEMA_LIMITS.maxStringLength
  ) {
    issues.push({
      path: `${path}/maxLength`,
      message: `"maxLength" is limited to ${SCHEMA_LIMITS.maxStringLength}.`,
    });
  }
  for (const key of [
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
  ] as const) {
    const value = node[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
      issues.push({ path: `${path}/${key}`, message: `"${key}" must be a number.` });
    }
  }
  if (
    node.format !== undefined &&
    (typeof node.format !== 'string' || !FORMATS.has(node.format))
  ) {
    issues.push({
      path: `${path}/format`,
      message: `Unsupported format. Use one of: ${[...FORMATS].join(', ')}.`,
    });
  }
  for (const key of ['additionalProperties', 'uniqueItems'] as const) {
    if (node[key] !== undefined && typeof node[key] !== 'boolean') {
      issues.push({
        path: `${path}/${key}`,
        message: `"${key}" must be true or false (schemas are not supported here).`,
      });
    }
  }

  if (node.properties !== undefined) {
    if (!isPlainObject(node.properties)) {
      issues.push({
        path: `${path}/properties`,
        message: '"properties" must be an object.',
      });
    } else {
      for (const [name, child] of Object.entries(node.properties)) {
        counter.properties += 1;
        if (
          !PROPERTY_NAME.test(name) ||
          name.length > SCHEMA_LIMITS.maxPropertyNameLength
        ) {
          issues.push({
            path: `${path}/properties/${name}`,
            message:
              'Property names must be identifiers (letters, digits, underscores) of at most ' +
              `${SCHEMA_LIMITS.maxPropertyNameLength} characters.`,
          });
        }
        if (!isPlainObject(child)) {
          issues.push({
            path: `${path}/properties/${name}`,
            message: 'Each property must be a schema object.',
          });
          continue;
        }
        checkNode(child, `${path}/properties/${name}`, depth + 1, issues, counter);
      }
    }
  }
  if (counter.properties > SCHEMA_LIMITS.maxProperties) {
    issues.push({
      path,
      message: `Schemas are limited to ${SCHEMA_LIMITS.maxProperties} properties in total.`,
    });
    counter.properties = Number.NEGATIVE_INFINITY; // report once
  }

  if (node.required !== undefined) {
    if (
      !Array.isArray(node.required) ||
      node.required.some((entry) => typeof entry !== 'string')
    ) {
      issues.push({
        path: `${path}/required`,
        message: '"required" must be an array of property names.',
      });
    } else if (isPlainObject(node.properties)) {
      const properties = node.properties;
      for (const name of node.required as string[]) {
        if (!(name in properties)) {
          issues.push({
            path: `${path}/required`,
            message: `"${name}" is required but not declared in "properties".`,
          });
        }
      }
    }
  }

  if (node.items !== undefined) {
    if (!isPlainObject(node.items)) {
      issues.push({
        path: `${path}/items`,
        message: '"items" must be a single schema object.',
      });
    } else {
      checkNode(node.items, `${path}/items`, depth + 1, issues, counter);
    }
  }
  if (types.includes('array') && node.items === undefined) {
    issues.push({ path: `${path}/items`, message: 'Array schemas must declare "items".' });
  }
}

// ── Validating a value (at execution) ───────────────────────────────────────

/**
 * Problems with `value` against `schema`. Empty means valid.
 *
 * Messages are written for the model as much as for people: when a call fails
 * validation, they are returned to the model as the observation, and a model
 * that is told "`/topK` must be at most 10" usually corrects itself.
 */
export function validateValue(
  schema: JsonSchema,
  value: unknown,
  path = '',
): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  validateInto(schema, value, path || '', issues);
  return issues.slice(0, 20);
}

function validateInto(
  schema: JsonSchema,
  value: unknown,
  path: string,
  issues: SchemaIssue[],
): void {
  const at = path || '/';

  if (schema.const !== undefined && !deepEqual(schema.const, value)) {
    issues.push({ path: at, message: `must equal ${JSON.stringify(schema.const)}` });
    return;
  }
  if (schema.enum && !schema.enum.some((option) => deepEqual(option, value))) {
    issues.push({
      path: at,
      message: `must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(', ')}`,
    });
    return;
  }

  const types = typesOf(schema.type);
  if (types.length > 0 && !types.some((type) => matchesType(type, value))) {
    issues.push({ path: at, message: `must be ${types.join(' or ')}` });
    return;
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) {
      issues.push({ path: at, message: `must be at least ${schema.minLength} characters` });
    }
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) {
      issues.push({ path: at, message: `must be at most ${schema.maxLength} characters` });
    }
    if (schema.format && !matchesFormat(schema.format, value)) {
      issues.push({ path: at, message: `must be a valid ${schema.format}` });
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      issues.push({ path: at, message: `must be at least ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      issues.push({ path: at, message: `must be at most ${schema.maximum}` });
    }
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      issues.push({ path: at, message: `must be greater than ${schema.exclusiveMinimum}` });
    }
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
      issues.push({ path: at, message: `must be less than ${schema.exclusiveMaximum}` });
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      issues.push({ path: at, message: `must contain at least ${schema.minItems} items` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      issues.push({ path: at, message: `must contain at most ${schema.maxItems} items` });
    }
    if (schema.uniqueItems) {
      const seen = new Set<string>();
      for (const item of value) {
        const key = JSON.stringify(item);
        if (seen.has(key)) {
          issues.push({ path: at, message: 'must not contain duplicate items' });
          break;
        }
        seen.add(key);
      }
    }
    if (schema.items) {
      value.forEach((item, index) =>
        validateInto(schema.items as JsonSchema, item, `${path}/${index}`, issues),
      );
    }
  }

  if (isPlainObject(value) && (types.length === 0 || types.includes('object'))) {
    const properties = schema.properties ?? {};
    for (const name of schema.required ?? []) {
      if (value[name] === undefined) {
        issues.push({ path: `${path}/${name}`, message: 'is required' });
      }
    }
    for (const [name, child] of Object.entries(value)) {
      const childSchema = properties[name];
      if (childSchema) {
        validateInto(childSchema, child, `${path}/${name}`, issues);
      } else if (schema.additionalProperties === false) {
        issues.push({ path: `${path}/${name}`, message: 'is not an accepted property' });
      }
    }
  }
}

/**
 * Fills declared `default`s for absent properties, recursively. Returns a new
 * value; the input is not modified.
 */
export function applyDefaults(schema: JsonSchema, value: unknown): unknown {
  if (!isPlainObject(value) || !schema.properties) return value;
  const result: Record<string, unknown> = { ...value };
  for (const [name, child] of Object.entries(schema.properties)) {
    if (result[name] === undefined && child.default !== undefined) {
      result[name] = structuredClone(child.default);
    } else if (result[name] !== undefined) {
      result[name] = applyDefaults(child, result[name]);
    }
  }
  return result;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function typesOf(type: unknown): string[] {
  if (typeof type === 'string') return [type];
  if (Array.isArray(type))
    return type.filter((entry): entry is string => typeof entry === 'string');
  return [];
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isPlainObject(value);
    default:
      return false;
  }
}

const EMAIL =
  /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME =
  /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

/** Fixed, linear-time format checks. */
export function matchesFormat(format: JsonSchemaFormat, value: string): boolean {
  switch (format) {
    case 'email':
      return value.length <= 254 && EMAIL.test(value);
    case 'uuid':
      return UUID.test(value);
    case 'uri': {
      if (value.length > 2048) return false;
      try {
        const url = new URL(value);
        return url.protocol === 'https:' || url.protocol === 'http:';
      } catch {
        return false;
      }
    }
    case 'date': {
      const match = DATE.exec(value);
      if (!match) return false;
      const date = new Date(`${value}T00:00:00Z`);
      return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
    }
    case 'date-time':
      return DATE_TIME.test(value) && !Number.isNaN(Date.parse(value));
    default:
      return false;
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) {
    return (
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => deepEqual(item, b[i]))
    );
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => deepEqual(a[key], b[key]))
    );
  }
  return false;
}
