import { registerAs } from '@nestjs/config';
import { parseByteSize } from '../common/utils/byte-size.util';
import { parseDuration } from '../common/utils/duration.util';

/**
 * The Tool Execution Engine (proposal module 6.11).
 *
 * Tools are the only way an agent affects anything outside its own answer, so
 * every limit on them lives here: how many calls, how long, how much output,
 * and — for tools that make outbound HTTP calls — exactly which hosts they may
 * reach.
 */
export interface ToolsConfig {
  enabled: boolean;
  /** Built-in tools switched off platform-wide, by name. */
  disabledBuiltins: string[];
  /** Ceiling on reason → act → observe iterations in one agent answer. */
  maxIterations: number;
  /** Iterations an agent gets when it does not choose its own. */
  defaultIterations: number;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  /** Largest result (bytes) a tool may return before it is truncated. */
  maxResultBytes: number;
  /** Tokens of one tool result that may be placed in a prompt. */
  resultMaxTokens: number;
  /** Tool calls one workflow run may make in total. */
  maxCallsPerRun: number;
  http: {
    /**
     * The platform egress allowlist: hostnames (`api.example.com`) or
     * wildcard suffixes (`*.example.com`). Empty disables outbound HTTP tools
     * entirely. Each tool narrows this further with its own fixed origin.
     */
    allowedHosts: string[];
    /** Development only: permits private, loopback and link-local addresses. */
    allowPrivateNetworks: boolean;
    /** Development only: permits plain `http://`. */
    allowInsecure: boolean;
    maxResponseBytes: number;
    userAgent: string;
  };
  email: {
    enabled: boolean;
    /** Emails one agent answer or workflow run may send. */
    maxPerRun: number;
  };
}

export const TOOLS_CONFIG_KEY = 'tools';

function csv(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export default registerAs(TOOLS_CONFIG_KEY, (): ToolsConfig => ({
  enabled: process.env.TOOLS_ENABLED !== 'false',
  disabledBuiltins: csv(process.env.TOOLS_DISABLED_BUILTINS),
  maxIterations: Number(process.env.TOOL_MAX_ITERATIONS),
  defaultIterations: Number(process.env.TOOL_DEFAULT_ITERATIONS),
  defaultTimeoutMs: parseDuration(process.env.TOOL_DEFAULT_TIMEOUT as string),
  maxTimeoutMs: parseDuration(process.env.TOOL_MAX_TIMEOUT as string),
  maxResultBytes: parseByteSize(process.env.TOOL_MAX_RESULT_SIZE as string),
  resultMaxTokens: Number(process.env.TOOL_RESULT_MAX_TOKENS),
  maxCallsPerRun: Number(process.env.TOOL_MAX_CALLS_PER_RUN),
  http: {
    allowedHosts: csv(process.env.TOOL_HTTP_ALLOWED_HOSTS),
    allowPrivateNetworks: process.env.TOOL_HTTP_ALLOW_PRIVATE_NETWORKS === 'true',
    allowInsecure: process.env.TOOL_HTTP_ALLOW_INSECURE === 'true',
    maxResponseBytes: parseByteSize(process.env.TOOL_HTTP_MAX_RESPONSE_SIZE as string),
    userAgent: `${process.env.APP_NAME ?? 'daiap'} tool-runner`.slice(0, 120),
  },
  email: {
    enabled: process.env.TOOL_EMAIL_ENABLED !== 'false',
    maxPerRun: Number(process.env.TOOL_EMAIL_MAX_PER_RUN),
  },
}));
