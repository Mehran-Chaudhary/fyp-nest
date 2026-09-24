import { stripControlCharacters } from '../../../common/utils/text.util';
import { parseRetryAfter, readBoundedText } from '../../../common/utils/http.util';
import { LlmProviderError } from './provider.types';

/**
 * Turns a non-2xx response from a model endpoint into an `LlmProviderError`.
 *
 * The provider's own message is kept (sanitised, truncated) for the server
 * log, but the API reports only the error code: an upstream message can name
 * internal hosts, model paths or account details.
 */
export async function errorFromResponse(response: Response): Promise<LlmProviderError> {
  let detail = '';
  try {
    const body = await readBoundedText(response, 64 * 1024);
    detail = extractMessage(body);
  } catch {
    // The status alone is enough to classify.
  }

  const status = response.status;
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
  const suffix = detail ? `: ${detail}` : '';

  if (status === 401 || status === 403) {
    return new LlmProviderError(
      'AUTH',
      `The model endpoint rejected the credentials (HTTP ${status})${suffix}. Check LLM_API_KEY.`,
      false,
      status,
    );
  }
  if (status === 404 || /model .*not found|does not exist|unknown model/i.test(detail)) {
    return new LlmProviderError(
      'MODEL_NOT_FOUND',
      `Model not found${suffix}`,
      false,
      status,
    );
  }
  if (status === 429) {
    return new LlmProviderError(
      'OVERLOADED',
      `The model endpoint is rate limiting (HTTP 429)${suffix}`,
      true,
      status,
      retryAfterMs,
    );
  }
  if (status === 408 || status >= 500) {
    return new LlmProviderError(
      'SERVER_ERROR',
      `The model endpoint failed (HTTP ${status})${suffix}`,
      true,
      status,
      retryAfterMs,
    );
  }
  return new LlmProviderError(
    'REJECTED',
    `The model endpoint rejected the request (HTTP ${status})${suffix}`,
    false,
    status,
  );
}

/** `{"error": "…"}` (Ollama) or `{"error": {"message": "…"}}` (OpenAI-style). */
export function extractMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: unknown;
      message?: unknown;
      detail?: unknown;
    };
    const error = parsed.error;
    const nested =
      typeof error === 'object' && error !== null
        ? (error as { message?: unknown }).message
        : undefined;
    const candidates = [error, nested, parsed.message, parsed.detail];
    const message =
      candidates.find((value): value is string => typeof value === 'string') ?? '';
    return stripControlCharacters(message).slice(0, 300);
  } catch {
    return stripControlCharacters(body).slice(0, 300);
  }
}

/** A `fetch` failure before any response: refused, reset, DNS, or our own timeout. */
export function connectionError(
  error: unknown,
  timedOut: boolean,
  timeoutMs: number,
): LlmProviderError {
  return timedOut
    ? new LlmProviderError(
        'TIMEOUT',
        `The model endpoint did not respond within ${timeoutMs}ms.`,
        true,
        undefined,
        undefined,
        { cause: error },
      )
    : new LlmProviderError(
        'UNREACHABLE',
        `The model endpoint could not be reached: ${(error as Error).message}.`,
        true,
        undefined,
        undefined,
        { cause: error },
      );
}
