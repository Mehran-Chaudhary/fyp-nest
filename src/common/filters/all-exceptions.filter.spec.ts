import { HttpStatus, type ArgumentsHost } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ErrorCode } from '../enums/error-code.enum';
import { AppException } from '../exceptions/app.exception';
import { AllExceptionsFilter } from './all-exceptions.filter';

/** The parts of an Express response the filter touches. */
function fakeResponse(headers: Record<string, string>) {
  const sent: { status?: number; body?: unknown } = {};
  const response = {
    headersSent: false,
    writableEnded: false,
    setHeader: (name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    },
    removeHeader: (name: string) => {
      delete headers[name.toLowerCase()];
    },
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(body: unknown) {
      // As Express does: a Content-Type already set is kept.
      headers['content-type'] ??= 'application/json; charset=utf-8';
      sent.body = body;
      return this;
    },
  };
  return { response, sent };
}

function host(response: unknown): ArgumentsHost {
  const request = {
    requestId: 'req-1',
    originalUrl: '/api/v1/x/audit-logs/export',
    url: '',
  };
  return {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
  } as unknown as ArgumentsHost;
}

describe('AllExceptionsFilter on a download route', () => {
  const filter = new AllExceptionsFilter({
    get: () => ({ isProduction: true }),
  } as unknown as ConfigService);

  it('answers an error as JSON, without the attachment headers the route declared', () => {
    // The audit export declares Content-Type: application/x-ndjson and an
    // attachment disposition; its 422 went out with both.
    const headers: Record<string, string> = {
      'content-type': 'application/x-ndjson',
      'content-disposition': 'attachment; filename="audit-log.ndjson"',
    };
    const { response, sent } = fakeResponse(headers);
    filter.catch(
      new AppException(ErrorCode.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY),
      host(response),
    );
    expect(sent.status).toBe(422);
    expect(headers['content-type']).toBe('application/json; charset=utf-8');
    expect(headers['content-disposition']).toBeUndefined();
    const body = sent.body as { success: boolean; error: { code: string } };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_FAILED');
  });
});
