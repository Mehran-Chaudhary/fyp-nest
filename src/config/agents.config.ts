import { registerAs } from '@nestjs/config';
import { parseDuration } from '../common/utils/duration.util';

/**
 * Agents and conversational memory (proposal modules 6.8 and 6.10).
 *
 * These are platform defaults and ceilings. Each agent chooses its own values
 * within them, and each value is versioned with the agent.
 */
export interface AgentsConfig {
  memory: {
    /** Most recent messages an agent considers, before the token budget applies. */
    defaultMaxMessages: number;
    maxMessages: number;
    /** Tokens of history an agent may spend, by default. */
    defaultMaxHistoryTokens: number;
  };
  retrieval: {
    /** Tokens of retrieved passages an agent may spend, by default. */
    defaultMaxContextTokens: number;
  };
  /** Longest single user message accepted. */
  maxMessageLength: number;
  /**
   * How long a conversation stays locked to one in-flight turn. A lease rather
   * than a flag, so a crashed process cannot wedge a conversation forever.
   */
  turnLockTtlMs: number;
}

export const AGENTS_CONFIG_KEY = 'agents';

export default registerAs(AGENTS_CONFIG_KEY, (): AgentsConfig => {
  const maxMessages = Number(process.env.AGENT_MEMORY_MAX_MESSAGES_CEILING);

  return {
    memory: {
      defaultMaxMessages: Math.min(
        Number(process.env.AGENT_MEMORY_MAX_MESSAGES),
        maxMessages,
      ),
      maxMessages,
      defaultMaxHistoryTokens: Number(process.env.AGENT_MEMORY_MAX_TOKENS),
    },
    retrieval: {
      defaultMaxContextTokens: Number(process.env.AGENT_CONTEXT_MAX_TOKENS),
    },
    maxMessageLength: Number(process.env.AGENT_MAX_MESSAGE_LENGTH),
    // The lease outlives the longest request it can belong to.
    turnLockTtlMs: parseDuration(process.env.LLM_REQUEST_TIMEOUT ?? '300s') + 30_000,
  };
});
