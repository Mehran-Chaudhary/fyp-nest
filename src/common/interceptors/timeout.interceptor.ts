import {
  CallHandler,
  ExecutionContext,
  Injectable,
  RequestTimeoutException,
  type NestInterceptor,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TimeoutError, type Observable, throwError } from 'rxjs';
import { catchError, timeout } from 'rxjs/operators';
import { APP_CONFIG_KEY, type AppConfig } from '../../config/app.config';

/**
 * Caps how long any single request may occupy a worker.
 *
 * Without a ceiling, one slow dependency degrades into total unavailability:
 * requests pile up, the connection pool drains, and healthy endpoints start
 * failing too. A bounded timeout converts that into a clean, attributable 408.
 *
 * This matters more here than in a typical CRUD API. From phase 3 the request
 * path includes local LLM inference, which the proposal itself flags as
 * hardware-dependent and slow. Those routes will need their own, longer budget
 * and streaming responses; the global default exists so that everything *else*
 * stays bounded in the meantime.
 */
@Injectable()
export class TimeoutInterceptor implements NestInterceptor {
  private readonly timeoutMs: number;

  constructor(private readonly configService: ConfigService) {
    this.timeoutMs =
      this.configService.get<AppConfig>(APP_CONFIG_KEY)?.requestTimeoutMs ?? 30_000;
  }

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      timeout(this.timeoutMs),
      catchError((error: unknown) => {
        if (error instanceof TimeoutError) {
          return throwError(
            () =>
              new RequestTimeoutException(
                `The request exceeded the ${this.timeoutMs}ms server time budget.`,
              ),
          );
        }
        return throwError(() => error);
      }),
    );
  }
}
