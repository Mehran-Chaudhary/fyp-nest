import { HttpStatus } from '@nestjs/common';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { AppException } from '../../common/exceptions/app.exception';
import { InvocationStatus } from './entities/llm-invocation.entity';
import { LlmProviderError } from './providers/provider.types';

/** What had been generated when a stream stopped early. */
export interface PartialGeneration {
  /** Unmasked, as the user saw it. */
  text: string;
  /** As the model wrote it. */
  maskedText: string;
  ttftMs: number | null;
}

/**
 * A generation that started streaming and then stopped: the client left, the
 * model went silent, or the endpoint failed mid-answer.
 *
 * Carries what was produced so far. Text already shown to a user cannot be
 * unsent, so the caller records it (as a cancelled or failed message) rather
 * than pretending the turn never happened.
 */
export class GenerationInterruptedError extends AppException {
  constructor(
    code: ErrorCode,
    status: HttpStatus,
    readonly partial: PartialGeneration,
    readonly cancelled: boolean,
    options: { message?: string; cause?: unknown } = {},
  ) {
    super(code, status, options);
  }
}

/**
 * Maps a provider failure *before* any token was produced to the API's error
 * contract. The client learns which kind of failure; the provider's own text
 * stays in the server log.
 */
export function toGatewayException(error: LlmProviderError): AppException {
  switch (error.code) {
    case 'MODEL_NOT_FOUND':
      return new AppException(
        ErrorCode.LLM_MODEL_NOT_FOUND,
        HttpStatus.UNPROCESSABLE_ENTITY,
        {
          cause: error,
        },
      );
    case 'REJECTED':
      return new AppException(ErrorCode.LLM_REJECTED, HttpStatus.BAD_GATEWAY, {
        cause: error,
        details: { status: error.status },
      });
    case 'INVALID_RESPONSE':
    case 'TOO_LARGE':
      return new AppException(ErrorCode.LLM_RESPONSE_INVALID, HttpStatus.BAD_GATEWAY, {
        cause: error,
      });
    case 'TIMEOUT':
      return new AppException(ErrorCode.LLM_TIMEOUT, HttpStatus.GATEWAY_TIMEOUT, {
        cause: error,
      });
    case 'OVERLOADED':
      return new AppException(ErrorCode.LLM_BUSY, HttpStatus.SERVICE_UNAVAILABLE, {
        cause: error,
        retryAfterSeconds: Math.max(1, Math.ceil((error.retryAfterMs ?? 5_000) / 1000)),
      });
    case 'AUTH':
    case 'UNREACHABLE':
    case 'SERVER_ERROR':
    default:
      return new AppException(ErrorCode.LLM_UNAVAILABLE, HttpStatus.SERVICE_UNAVAILABLE, {
        cause: error,
        details: { reason: error.code },
      });
  }
}

/**
 * Governance refusals (phase 5): a model call throttled by a token budget, the
 * token rate, an agent's circuit breaker or a conversation budget — refused
 * before anything was sent, and recorded as THROTTLED rather than FAILED.
 */
const THROTTLING_CODES: ReadonlySet<string> = new Set([
  ErrorCode.QUOTA_EXCEEDED,
  ErrorCode.TOKEN_RATE_LIMITED,
  ErrorCode.AGENT_CIRCUIT_OPEN,
  ErrorCode.CONVERSATION_TOKEN_BUDGET_EXCEEDED,
]);

/** The usage-ledger status a failed model call is recorded with. */
export function invocationStatusOf(error: unknown): InvocationStatus {
  if (error instanceof GenerationInterruptedError && error.cancelled) {
    return InvocationStatus.CANCELLED;
  }
  if (error instanceof AppException) {
    if (error.code === ErrorCode.PII_EGRESS_BLOCKED) return InvocationStatus.BLOCKED;
    if (THROTTLING_CODES.has(error.code)) return InvocationStatus.THROTTLED;
  }
  return InvocationStatus.FAILED;
}
