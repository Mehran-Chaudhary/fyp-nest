/**
 * Token-budgeted conversational memory (proposal module 6.10).
 *
 * The proposal asks for "the last N messages". A fixed N is the wrong unit:
 * twenty one-line messages and twenty pasted reports differ by two orders of
 * magnitude in tokens, and a local model's context window is small (8k is
 * typical). So N is a ceiling, and the real constraint is a token budget:
 *
 *     window = system prompt + retrieved passages + history + question + answer
 *
 * The answer's share is reserved first (it cannot be negotiated after the
 * fact), then a safety margin for estimation error. The question and the
 * system prompt are mandatory — if they alone do not fit, the request is
 * refused rather than silently cut. Passages come next, in rank order, up to
 * the agent's passage budget: for a knowledge agent, fresh evidence matters
 * more than old small talk. History fills what remains, newest first.
 */

export interface BudgetPlan {
  contextWindow: number;
  reservedForAnswer: number;
  margin: number;
  /** Tokens available to the prompt as a whole. */
  promptBudget: number;
}

export function planBudget(contextWindow: number, maxOutputTokens: number): BudgetPlan {
  const margin = 32 + Math.ceil(contextWindow * 0.03);
  return {
    contextWindow,
    reservedForAnswer: maxOutputTokens,
    margin,
    promptBudget: Math.max(0, contextWindow - maxOutputTokens - margin),
  };
}

export interface RankedPassage {
  id: string;
  tokens: number;
}

/** Passages in rank order until the budget is spent. A passage never goes in half. */
export function selectPassages<T extends RankedPassage>(
  passages: readonly T[],
  budget: number,
): { included: T[]; dropped: number; tokens: number } {
  const included: T[] = [];
  let tokens = 0;
  for (const passage of passages) {
    if (tokens + passage.tokens > budget) continue; // a later, shorter one may still fit
    included.push(passage);
    tokens += passage.tokens;
  }
  return { included, dropped: passages.length - included.length, tokens };
}

export interface HistoryCandidate {
  id: string;
  role: 'USER' | 'ASSISTANT';
  tokens: number;
}

export interface HistorySelection {
  /** Chronological. */
  included: string[];
  tokens: number;
  excludedByBudget: number;
  excludedByLimit: number;
}

/**
 * The most recent history that fits, as a contiguous block ending at the
 * latest message.
 *
 * Contiguous on purpose: skipping an old long message to squeeze in an even
 * older short one would show the model a conversation with a hole in it. The
 * block never starts with an assistant reply whose question was cut off.
 */
export function selectHistory(
  candidates: readonly HistoryCandidate[],
  budget: number,
  maxMessages: number,
): HistorySelection {
  const chosen: HistoryCandidate[] = [];
  let tokens = 0;
  let excludedByBudget = 0;
  let excludedByLimit = 0;

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    if (chosen.length >= maxMessages) {
      excludedByLimit = index + 1;
      break;
    }
    if (tokens + candidate.tokens > budget) {
      excludedByBudget = index + 1;
      break;
    }
    chosen.unshift(candidate);
    tokens += candidate.tokens;
  }

  while (chosen.length > 0 && chosen[0].role === 'ASSISTANT') {
    const dropped = chosen.shift() as HistoryCandidate;
    tokens -= dropped.tokens;
    excludedByBudget += 1;
  }

  return {
    included: chosen.map((candidate) => candidate.id),
    tokens,
    excludedByBudget,
    excludedByLimit,
  };
}
