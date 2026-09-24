import { createHash } from 'node:crypto';
import { stableStringify } from '../../../common/utils/stable-stringify';
import type { Classification } from '../../knowledge/domain/classification';
import type { RequestedParameters } from '../../llm/domain/generation';

/** Who can find and use an agent. */
export enum AgentVisibility {
  /** A draft: its creator and agent managers only. */
  PRIVATE = 'PRIVATE',
  /** Published: every member with `agent:read` / `agent:execute`, subject to access mode. */
  WORKSPACE = 'WORKSPACE',
}

/** Whether a published agent is open to the workspace or restricted to roles. */
export enum AgentAccessMode {
  WORKSPACE = 'WORKSPACE',
  RESTRICTED = 'RESTRICTED',
}

export type AgentTone = 'neutral' | 'formal' | 'friendly' | 'concise';

/**
 * How closely answers must stick to retrieved material.
 *
 * `STRICT` answers only from the knowledge bases and says "I don't know"
 * otherwise — the right default for policy, HR and compliance agents, where a
 * confident invented answer is worse than none. `BALANCED` may fall back on
 * general knowledge, and says when it does.
 */
export type GroundingMode = 'STRICT' | 'BALANCED';

export interface AgentPersona {
  /** "a strict HR auditor", "the IT helpdesk". */
  role: string | null;
  tone: AgentTone;
  /** Answer language; null means the user's. */
  language: string | null;
  /** Shown by the UI when a conversation starts. Never sent to the model. */
  greeting: string | null;
}

export interface AgentRetrievalConfig {
  enabled: boolean;
  /** Where the agent looks. Always intersected with the user's own access. */
  knowledgeBaseIds: string[];
  topK: number;
  mode: 'hybrid' | 'dense';
  rerank: boolean;
  /** Token budget for retrieved passages. */
  maxContextTokens: number;
  minScore: number | null;
  /**
   * The most sensitive classification the agent may retrieve, whoever uses
   * it: a public-facing helpdesk agent can be capped at INTERNAL even when an
   * executive talks to it.
   */
  maxClassification: Classification | null;
}

export interface AgentMemoryConfig {
  /** Most recent messages considered, before the token budget. 0 disables memory. */
  maxMessages: number;
  maxHistoryTokens: number;
}

/**
 * Everything that determines an agent's behaviour, versioned as one unit.
 * The instructions (system prompt) are versioned alongside it but stored
 * encrypted, separately.
 */
export interface AgentConfig {
  persona: AgentPersona;
  /** Null: the workspace default model, whatever it is at the time. */
  model: string | null;
  parameters: RequestedParameters;
  /** Null: the model's, within the platform and workspace ceilings. */
  contextWindow: number | null;
  retrieval: AgentRetrievalConfig;
  memory: AgentMemoryConfig;
  grounding: GroundingMode;
  citations: boolean;
}

export interface AgentConfigDefaults {
  retrievalTopK: number;
  maxContextTokens: number;
  memoryMaxMessages: number;
  memoryMaxHistoryTokens: number;
}

export function defaultAgentConfig(defaults: AgentConfigDefaults): AgentConfig {
  return {
    persona: { role: null, tone: 'neutral', language: null, greeting: null },
    model: null,
    parameters: {},
    contextWindow: null,
    retrieval: {
      enabled: true,
      knowledgeBaseIds: [],
      topK: Math.min(defaults.retrievalTopK, 20),
      mode: 'hybrid',
      rerank: false,
      maxContextTokens: defaults.maxContextTokens,
      minScore: null,
      maxClassification: null,
    },
    memory: {
      maxMessages: defaults.memoryMaxMessages,
      maxHistoryTokens: defaults.memoryMaxHistoryTokens,
    },
    grounding: 'STRICT',
    citations: true,
  };
}

/** A partial update: every key optional, nested objects merged one level deep. */
export interface AgentConfigPatch {
  persona?: Partial<AgentPersona>;
  model?: string | null;
  parameters?: RequestedParameters;
  contextWindow?: number | null;
  retrieval?: Partial<AgentRetrievalConfig>;
  memory?: Partial<AgentMemoryConfig>;
  grounding?: GroundingMode;
  citations?: boolean;
}

/**
 * Applies a patch. `parameters` is replaced wholesale rather than merged, so
 * that removing an override (going back to the default temperature) is
 * possible by omitting it.
 */
export function applyConfigPatch(base: AgentConfig, patch: AgentConfigPatch): AgentConfig {
  const next: AgentConfig = {
    persona: { ...base.persona, ...definedOnly(patch.persona) },
    model: patch.model === undefined ? base.model : patch.model,
    parameters:
      patch.parameters === undefined ? { ...base.parameters } : { ...patch.parameters },
    contextWindow:
      patch.contextWindow === undefined ? base.contextWindow : patch.contextWindow,
    retrieval: { ...base.retrieval, ...definedOnly(patch.retrieval) },
    memory: { ...base.memory, ...definedOnly(patch.memory) },
    grounding: patch.grounding ?? base.grounding,
    citations: patch.citations ?? base.citations,
  };
  next.retrieval.knowledgeBaseIds = [...new Set(next.retrieval.knowledgeBaseIds)].sort();
  return next;
}

function definedOnly<T extends object>(value: Partial<T> | undefined): Partial<T> {
  if (!value) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

/**
 * A digest of an agent's behaviour: config and instructions together.
 *
 * Saving an unchanged configuration creates no new version, and two versions
 * with the same digest are known to behave identically — which is what makes
 * "restore version 3" verifiable.
 */
export function configDigest(config: AgentConfig, instructions: string): string {
  return createHash('sha256')
    .update(stableStringify(config))
    .update('\n')
    .update(instructions)
    .digest('hex');
}
