/**
 * Provider-neutral request types for the LLM gateway.
 */

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/**
 * Sampling parameters, validated and clamped before they reach a provider.
 *
 * `topK` and `repeatPenalty` exist only in Ollama's API; the OpenAI-compatible
 * provider drops them rather than risk a strict server rejecting the request.
 */
export interface GenerationParameters {
  temperature: number;
  topP?: number;
  topK?: number;
  maxOutputTokens: number;
  repeatPenalty?: number;
  seed?: number;
  stop?: string[];
}

/** Parameters a caller may request; everything is optional. */
export type RequestedParameters = Partial<GenerationParameters>;

export interface ParameterLimits {
  defaultTemperature: number;
  defaultMaxOutputTokens: number;
  /** Platform, workspace and model ceilings, already combined. */
  maxOutputTokens: number;
}

export const PARAMETER_BOUNDS = {
  temperature: { min: 0, max: 2 },
  topP: { min: 0.01, max: 1 },
  topK: { min: 1, max: 500 },
  repeatPenalty: { min: 0.5, max: 2 },
  stopSequences: 4,
  stopLength: 32,
} as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Merges layers of parameters — agent defaults, then a per-request override —
 * and clamps the result to the platform's bounds.
 *
 * Clamping rather than rejecting: the DTOs already reject absurd input, and
 * what remains are legitimate requests that exceed a ceiling someone lowered
 * later (a workspace cutting its output limit after an agent was configured).
 * Those should run within the new ceiling, not fail.
 */
export function resolveParameters(
  limits: ParameterLimits,
  ...layers: Array<RequestedParameters | undefined>
): GenerationParameters {
  const merged: RequestedParameters = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [key, value] of Object.entries(layer) as Array<
      [keyof GenerationParameters, GenerationParameters[keyof GenerationParameters]]
    >) {
      if (value !== undefined && value !== null) {
        (merged as Record<string, unknown>)[key] = value;
      }
    }
  }

  const bounds = PARAMETER_BOUNDS;
  const resolved: GenerationParameters = {
    temperature: clamp(
      merged.temperature ?? limits.defaultTemperature,
      bounds.temperature.min,
      bounds.temperature.max,
    ),
    maxOutputTokens: Math.max(
      1,
      Math.min(
        merged.maxOutputTokens ?? limits.defaultMaxOutputTokens,
        limits.maxOutputTokens,
      ),
    ),
  };

  if (merged.topP !== undefined) {
    resolved.topP = clamp(merged.topP, bounds.topP.min, bounds.topP.max);
  }
  if (merged.topK !== undefined) {
    resolved.topK = Math.round(clamp(merged.topK, bounds.topK.min, bounds.topK.max));
  }
  if (merged.repeatPenalty !== undefined) {
    resolved.repeatPenalty = clamp(
      merged.repeatPenalty,
      bounds.repeatPenalty.min,
      bounds.repeatPenalty.max,
    );
  }
  if (merged.seed !== undefined && Number.isInteger(merged.seed)) {
    resolved.seed = merged.seed;
  }
  if (merged.stop && merged.stop.length > 0) {
    resolved.stop = merged.stop
      .filter((sequence) => sequence.length > 0)
      .slice(0, bounds.stopSequences)
      .map((sequence) => sequence.slice(0, bounds.stopLength));
  }

  return resolved;
}
