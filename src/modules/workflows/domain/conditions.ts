import type { ConditionRule } from './graph';
import {
  resolveRef,
  stringify,
  templateRefs,
  type TemplateScope,
  renderTemplate,
} from './templates';

/**
 * Deterministic branching: a condition node tests values with fixed
 * operators, and its first matching rule picks the edge to follow. No model is
 * involved, so the branch a run takes is reproducible from its data alone.
 */

/** The value a rule tests: typed when the template is one reference, text otherwise. */
export function ruleValue(rule: ConditionRule, scope: TemplateScope): unknown {
  const refs = templateRefs(rule.value);
  const trimmed = rule.value.trim();
  if (refs.length === 1 && /^\{\{[^{}]*\}\}$/.test(trimmed))
    return resolveRef(refs[0], scope);
  return renderTemplate(rule.value, scope).text;
}

export function evaluateRule(rule: ConditionRule, value: unknown): boolean {
  const caseSensitive = rule.caseSensitive ?? false;
  const text = normalize(stringify(value), caseSensitive);
  const operand =
    rule.operand === undefined ? '' : normalize(stringify(rule.operand), caseSensitive);

  switch (rule.operator) {
    case 'equals':
      return typeof value === 'number' && typeof rule.operand === 'number'
        ? value === rule.operand
        : text === operand;
    case 'not_equals':
      return !evaluateRule({ ...rule, operator: 'equals' }, value);
    case 'contains':
      return text.includes(operand);
    case 'not_contains':
      return !text.includes(operand);
    case 'starts_with':
      return text.startsWith(operand);
    case 'ends_with':
      return text.endsWith(operand);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const left = toNumber(value);
      const right = toNumber(rule.operand);
      if (left === null || right === null) return false;
      if (rule.operator === 'gt') return left > right;
      if (rule.operator === 'gte') return left >= right;
      if (rule.operator === 'lt') return left < right;
      return left <= right;
    }
    case 'is_true':
      return value === true || ['true', 'yes', 'y', '1'].includes(text.trim());
    case 'is_false':
      return value === false || ['false', 'no', 'n', '0'].includes(text.trim());
    case 'is_empty':
      return isEmpty(value);
    case 'is_not_empty':
      return !isEmpty(value);
    default:
      return false;
  }
}

function normalize(text: string, caseSensitive: boolean): string {
  const trimmed = text.trim();
  return caseSensitive ? trimmed : trimmed.toLowerCase();
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/,/g, '');
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)(e[-+]?\d+)?$/i.test(cleaned)) return null;
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : null;
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return ['', 'null', '[]', '{}'].includes(value.trim());
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}
