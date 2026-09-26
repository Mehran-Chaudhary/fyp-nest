import {
  Classification,
  classificationRank,
  isClassification,
} from '../../knowledge/domain/classification';
import type { InformationLabel } from '../../agents/domain/labels';

/**
 * Information-flow control at tool sinks.
 *
 * Phase 3 made every piece of derived text carry a **confidentiality** label:
 * the high-water mark of what it was derived from (ADR 0003, decision 9).
 * Tools are where that label finally matters most, because a tool is the only
 * way data leaves an agent's answer: an HTTP call to a third party, an email
 * to a colleague. And tools add a second threat that labels on data alone do
 * not address — **prompt injection**: text the model read (a web page, a
 * poisoned document) steering it into an action the user never asked for.
 *
 * So the context of every tool call carries two labels, and every tool
 * declares what it will accept:
 *
 *  - **Confidentiality** (Bell–LaPadula, "no write down"): the call's context
 *    — everything the model has seen so far — must not be more sensitive than
 *    the tool's sink ceiling. An HTTP tool to an outside API accepts PUBLIC
 *    context by default; a workspace-internal search accepts anything.
 *  - **Integrity** (Biba, "no read up" for actions): once the context contains
 *    text from an untrusted source, a tool with side effects may not run on
 *    the model's say-so. The model may still *read* — search, compute — but it
 *    can no longer *act*.
 *
 * Both are the model of recent agent-security work — dual confidentiality and
 * integrity labels checked at tool sinks (Microsoft's FIDES, 2025; Google
 * DeepMind's CaMeL, 2025) — built here on the label machinery the platform
 * already had.
 */

/** How far the context can be trusted not to have been written by an attacker. */
export enum Integrity {
  /** Written by the principal or the platform: the question, instructions, computations. */
  TRUSTED = 'TRUSTED',
  /** Workspace data: documents members uploaded, answers derived from them. */
  INTERNAL = 'INTERNAL',
  /** From outside the workspace: an HTTP tool's response. */
  EXTERNAL = 'EXTERNAL',
}

/** Most trusted first. The order *is* the dominance relation. */
export const INTEGRITY_ORDER: readonly Integrity[] = [
  Integrity.EXTERNAL,
  Integrity.INTERNAL,
  Integrity.TRUSTED,
];

export function integrityRank(integrity: Integrity): number {
  const rank = INTEGRITY_ORDER.indexOf(integrity);
  // Unknown values rank lowest: fail closed.
  return rank < 0 ? 0 : rank;
}

export function isIntegrity(value: unknown): value is Integrity {
  return INTEGRITY_ORDER.includes(value as Integrity);
}

/** The greatest lower bound: a context is as trustworthy as its least trustworthy input. */
export function meetIntegrity(
  ...values: ReadonlyArray<Integrity | null | undefined>
): Integrity {
  let lowest = Integrity.TRUSTED;
  for (const value of values) {
    if (!value) continue;
    const candidate = isIntegrity(value) ? value : Integrity.EXTERNAL;
    if (integrityRank(candidate) < integrityRank(lowest)) lowest = candidate;
  }
  return lowest;
}

/** The labels of everything that has flowed into a context so far. */
export interface FlowContext {
  label: InformationLabel;
  integrity: Integrity;
}

/**
 * What a tool accepts, and how its arguments are treated.
 *
 * `piiArguments` decides what happens to masked values the model passes:
 *
 *  - `unmask` — placeholders are replaced by the real values before the tool
 *    runs. For tools that stay inside the platform's trust boundary
 *    (knowledge search) or whose recipient is checked against the data's
 *    label (email to a member).
 *  - `deny` — a call carrying any placeholder is refused, and the outgoing
 *    request is re-scanned for personal data the way the LLM gateway scans
 *    prompts. The default for anything that talks to a third party.
 */
export interface ToolDataPolicy {
  /** The most sensitive context that may flow into this tool. */
  maxClassification: Classification;
  /** The least trusted context this tool may be called from. */
  minIntegrity: Integrity;
  piiArguments: 'unmask' | 'deny';
  /** Whether calling the tool changes something outside the platform. */
  sideEffects: boolean;
}

export type FlowViolation =
  | {
      kind: 'CONFIDENTIALITY';
      contextClassification: Classification;
      ceiling: Classification;
    }
  | { kind: 'INTEGRITY'; contextIntegrity: Integrity; required: Integrity };

/** Null when `context` may flow into a tool with `policy`; otherwise why not. */
export function checkFlow(
  context: FlowContext,
  policy: ToolDataPolicy,
): FlowViolation | null {
  const classification = isClassification(context.label.classification)
    ? context.label.classification
    : Classification.RESTRICTED;

  if (classificationRank(classification) > classificationRank(policy.maxClassification)) {
    return {
      kind: 'CONFIDENTIALITY',
      contextClassification: classification,
      ceiling: policy.maxClassification,
    };
  }
  if (integrityRank(context.integrity) < integrityRank(policy.minIntegrity)) {
    return {
      kind: 'INTEGRITY',
      contextIntegrity: context.integrity,
      required: policy.minIntegrity,
    };
  }
  return null;
}

/** An explanation for the model, which will read it as the tool's observation. */
export function describeViolation(violation: FlowViolation): string {
  return violation.kind === 'CONFIDENTIALITY'
    ? `This conversation contains ${violation.contextClassification} information, and this ` +
        `tool only accepts ${violation.ceiling} or lower. It cannot be used here.`
    : 'This conversation contains content from an untrusted source, so tools that take ' +
        'actions are disabled for the rest of it. Answer with the information you have, ' +
        'or ask the user to act.';
}

/** Sensible defaults: a tool that reaches outside is locked down unless configured otherwise. */
export function defaultDataPolicy(options: {
  external: boolean;
  sideEffects: boolean;
}): ToolDataPolicy {
  return {
    maxClassification: options.external ? Classification.PUBLIC : Classification.RESTRICTED,
    minIntegrity: options.sideEffects ? Integrity.INTERNAL : Integrity.EXTERNAL,
    piiArguments: options.external ? 'deny' : 'unmask',
    sideEffects: options.sideEffects,
  };
}
