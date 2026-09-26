/**
 * Templates: how one step's input is made from the run input and earlier
 * outputs.
 *
 *     "Summarise for {{input.audience}}: {{nodes.research.output}}"
 *
 * The language is deliberately tiny. A template can *reference* data —
 * `input`, `input.<path>`, `nodes.<id>.output`, `nodes.<id>.output.<path>` —
 * and do nothing else: no expressions, no function calls, no loops. A
 * workflow definition is written by one person and run with another person's
 * data and access, so it must not be able to compute anything the engine
 * cannot see. References are checked when the definition is saved: each named
 * node must exist and precede the step that uses it.
 */

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

/**
 * `optional` (a trailing `?`: `{{nodes.review.output.feedback?}}`) renders as
 * nothing when the value does not exist yet — for a loop's first iteration,
 * which has no earlier review to read.
 */
export type TemplateRef =
  | { root: 'input'; path: string[]; optional: boolean }
  | { root: 'nodes'; nodeId: string; path: string[]; optional: boolean };

export type TemplatePart = { literal: string } | { ref: TemplateRef; source: string };

const MARKER = /\{\{\s*([^{}]*?)\s*\}\}/g;
const SEGMENT = /^(?:[A-Za-z_][A-Za-z0-9_-]*|\d+)$/;
const NODE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_PATH = 8;

/** Parses one reference expression: `input.a.b`, `nodes.x.output.y`. */
export function parseRef(expression: string): TemplateRef {
  const optional = expression.trimEnd().endsWith('?');
  const body = optional ? expression.trimEnd().slice(0, -1) : expression;
  const segments = body
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((segment) => segment.trim());

  if (segments.some((segment) => segment.length === 0)) {
    throw new TemplateError(`"{{${expression}}}" is not a valid reference.`);
  }

  if (segments[0] === 'input') {
    const path = segments.slice(1);
    assertPath(expression, path);
    return { root: 'input', path, optional };
  }

  if (segments[0] === 'nodes') {
    const [, nodeId, field, ...path] = segments;
    if (!nodeId || !NODE_ID.test(nodeId) || field !== 'output') {
      throw new TemplateError(
        `"{{${expression}}}" must look like {{nodes.<node id>.output}} or {{nodes.<node id>.output.<field>}}.`,
      );
    }
    assertPath(expression, path);
    return { root: 'nodes', nodeId, path, optional };
  }

  throw new TemplateError(
    `"{{${expression}}}" must start with "input" or "nodes": templates only reference data.`,
  );
}

function assertPath(expression: string, path: string[]): void {
  if (path.length > MAX_PATH || path.some((segment) => !SEGMENT.test(segment))) {
    throw new TemplateError(`"{{${expression}}}" has an invalid path.`);
  }
}

export function parseTemplate(template: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let cursor = 0;
  for (const match of template.matchAll(new RegExp(MARKER.source, 'g'))) {
    const start = match.index ?? 0;
    if (start > cursor) parts.push({ literal: template.slice(cursor, start) });
    parts.push({ ref: parseRef(match[1]), source: match[0] });
    cursor = start + match[0].length;
  }
  if (cursor < template.length) parts.push({ literal: template.slice(cursor) });

  // An unbalanced brace pair is almost always a typo that would otherwise
  // reach the model verbatim.
  const leftover = parts
    .filter((part): part is { literal: string } => 'literal' in part)
    .map((part) => part.literal)
    .join('');
  if (leftover.includes('{{') || leftover.includes('}}')) {
    throw new TemplateError('The template has an unbalanced "{{" or "}}".');
  }
  return parts;
}

/** The references a template makes, for validation. */
export function templateRefs(template: string): TemplateRef[] {
  return parseTemplate(template)
    .filter((part): part is { ref: TemplateRef; source: string } => 'ref' in part)
    .map((part) => part.ref);
}

/** What templates can see while a run executes. */
export interface TemplateScope {
  input: unknown;
  /** Outputs of steps that have finished, by node id. */
  nodes: Readonly<Record<string, { output: unknown }>>;
}

export function resolveRef(ref: TemplateRef, scope: TemplateScope): unknown {
  let value: unknown;
  if (ref.root === 'input') {
    value = scope.input;
  } else {
    const node = scope.nodes[ref.nodeId];
    if (!node) {
      if (ref.optional) return '';
      throw new TemplateError(
        `{{nodes.${ref.nodeId}.output}} is not available: that step has not run.`,
      );
    }
    value = node.output;
  }

  for (const segment of ref.path) {
    if (Array.isArray(value) && /^\d+$/.test(segment)) value = value[Number(segment)];
    else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      value = (value as Record<string, unknown>)[segment];
    } else {
      value = undefined;
    }
    if (value === undefined) break;
  }
  if (value === undefined) {
    if (ref.optional) return '';
    const label =
      ref.root === 'input'
        ? ['input', ...ref.path].join('.')
        : ['nodes', ref.nodeId, 'output', ...ref.path].join('.');
    throw new TemplateError(`{{${label}}} has no value.`);
  }
  return value;
}

/** Text form of a value inside a template: strings as they are, everything else as JSON. */
export function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export interface Rendered {
  text: string;
  /** Node ids whose outputs were read: their labels flow into the result. */
  nodes: string[];
  usedInput: boolean;
}

export function renderTemplate(template: string, scope: TemplateScope): Rendered {
  const nodes = new Set<string>();
  let usedInput = false;
  const text = parseTemplate(template)
    .map((part) => {
      if ('literal' in part) return part.literal;
      if (part.ref.root === 'nodes') nodes.add(part.ref.nodeId);
      else usedInput = true;
      return stringify(resolveRef(part.ref, scope));
    })
    .join('');
  return { text, nodes: [...nodes], usedInput };
}

/**
 * Renders a structured value (tool arguments): strings are templates, and a
 * string that is exactly one reference keeps the referenced value's type.
 */
export function renderValue(
  value: unknown,
  scope: TemplateScope,
  used: { nodes: Set<string>; input: boolean } = { nodes: new Set(), input: false },
): unknown {
  if (typeof value === 'string') {
    const parts = parseTemplate(value);
    const only = parts.length === 1 ? parts[0] : null;
    if (only && 'ref' in only) {
      if (only.ref.root === 'nodes') used.nodes.add(only.ref.nodeId);
      else used.input = true;
      return resolveRef(only.ref, scope);
    }
    const rendered = renderTemplate(value, scope);
    rendered.nodes.forEach((node) => used.nodes.add(node));
    used.input ||= rendered.usedInput;
    return rendered.text;
  }
  if (Array.isArray(value)) return value.map((item) => renderValue(item, scope, used));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, renderValue(item, scope, used)]),
    );
  }
  return value;
}

/** Every template string inside a structured value (tool arguments), for validation. */
export function templatesIn(value: unknown): string[] {
  if (typeof value === 'string') return value.includes('{{') ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(templatesIn);
  if (typeof value === 'object' && value !== null)
    return Object.values(value).flatMap(templatesIn);
  return [];
}
