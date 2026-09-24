import {
  CallHandler,
  ExecutionContext,
  Injectable,
  RequestTimeoutException,
  type NestInterceptor,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { TimeoutError, type Observable, throwError } from 'rxjs';
import { catchError, timeout } from 'rxjs/operators';
import { METADATA_KEY } from '../constants/app.constants';
import {
  APP_CONFIG_KEY,
  type AppConfig,
  type RequestTimeoutBudget,
} from '../../config/app.config';

/**
 * Caps how long any single request may occupy a worker.
 *
 * Without a ceiling, one slow dependency degrades into total unavailability:
 * requests pile up, the connection pool drains, and healthy endpoints start
 * failing too. A bounded timeout converts that into a clean, attributable 408.
 *
 * A handful of routes legitimately need longer — a 50 MB upload over a slow
 * link, a retrieval that embeds, searches and reranks — and declare a named
 * budget with `@TimeoutBudget()`. They get a longer ceiling, never an unbounded
 * one.
 */
@Injectable()
export class TimeoutInterceptor implements NestInterceptor {
  private readonly defaultTimeoutMs: number;
  private readonly budgets: Partial<Record<RequestTimeoutBudget, number>>;

  constructor(
    private readonly configService: ConfigService,
    private readonly reflector: Reflector,
  ) {
    const app = this.configService.get<AppConfig>(APP_CONFIG_KEY);
    this.defaultTimeoutMs = app?.requestTimeoutMs ?? 30_000;
    this.budgets = app?.requestTimeoutBudgets ?? {};
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const budget = this.reflector.getAllAndOverride<RequestTimeoutBudget | undefined>(
      METADATA_KEY.TIMEOUT_BUDGET,
      [context.getHandler(), context.getClass()],
    );
    const timeoutMs = (budget && this.budgets[budget]) || this.defaultTimeoutMs;

    return next.handle().pipe(
      timeout(timeoutMs),
      catchError((error: unknown) => {
        if (error instanceof TimeoutError) {
          return throwError(
            () =>
              new RequestTimeoutException(
                `The request exceeded the ${timeoutMs}ms server time budget.`,
              ),
          );
        }
        return throwError(() => error);
      }),
    );
  }
}
