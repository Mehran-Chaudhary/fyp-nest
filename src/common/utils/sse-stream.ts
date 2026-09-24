import type { Response } from 'express';
import { ErrorCode, ERROR_CODE_MESSAGES } from '../enums/error-code.enum';
import { AppException } from '../exceptions/app.exception';
import { SseWriter } from './sse-writer';

/** What a streamed operation may send while it runs. */
export interface SseChannel {
  /** Opens the stream (status 200, headers) and sends the first event. Idempotent. */
  open(event: string, data: unknown): void;
  send(event: string, data: unknown): void;
}

/**
 * Runs a long operation as a Server-Sent Events response, with the error
 * contract split at the moment the stream opens.
 *
 * Everything that can fail *before* the first event — validation, access,
 * redaction being unavailable, the model being busy — fails as an ordinary
 * HTTP error with its proper status and the standard error envelope: the
 * operation simply throws before calling `open`, and the exception filter
 * answers. Once the stream is open the status line is gone, so later failures
 * arrive as an `error` event followed by the end of the stream.
 *
 * A client that disconnects aborts `signal`, which the operation passes down to
 * the model request so generation stops on the GPU rather than running on for
 * nobody.
 */
export async function runAsEventStream<T>(
  response: Response,
  operation: (channel: SseChannel, signal: AbortSignal) => Promise<T>,
  done: (result: T) => unknown,
): Promise<void> {
  const writer = new SseWriter(response);
  const controller = new AbortController();
  let settled = false;

  const onClose = () => {
    if (!settled) controller.abort(new Error('The client disconnected.'));
  };
  response.on('close', onClose);

  const channel: SseChannel = {
    open: (event, data) => {
      writer.open();
      writer.send(event, data);
    },
    send: (event, data) => writer.send(event, data),
  };

  try {
    const result = await operation(channel, controller.signal);
    settled = true;
    writer.open();
    writer.send('done', done(result));
    writer.end();
  } catch (error) {
    settled = true;
    // Not yet streaming: let the exception filter send a normal error response.
    if (!writer.isOpen) {
      if (writer.isClosed) return;
      throw error;
    }
    writer.send('error', describe(error));
    writer.end();
  } finally {
    response.off('close', onClose);
  }
}

/**
 * The `error` event: the same code, message and details as the JSON error
 * envelope, plus the HTTP status and retry hint the failure would have had
 * before the stream opened — so a client handles both forms with one code path.
 */
function describe(error: unknown): {
  code: string;
  message: string;
  status: number;
  details?: unknown;
  retryAfterSeconds?: number;
} {
  if (error instanceof AppException) {
    return {
      code: error.code,
      message: error.displayMessage,
      status: error.getStatus(),
      ...(error.details !== undefined ? { details: error.details } : {}),
      ...(error.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: error.retryAfterSeconds }
        : {}),
    };
  }
  return {
    code: ErrorCode.INTERNAL_SERVER_ERROR,
    message: ERROR_CODE_MESSAGES[ErrorCode.INTERNAL_SERVER_ERROR],
    status: 500,
  };
}
