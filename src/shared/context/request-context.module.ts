import { Global, Module } from '@nestjs/common';
import { RequestContextMiddleware } from './request-context.middleware';
import { RequestContextService } from './request-context.service';

/**
 * Ambient request context.
 *
 * Global because the audit logger, the structured logger and several guards all
 * read it, and because the service holds a single `AsyncLocalStorage` instance
 * that must be shared process-wide — two instances would mean a writer and a
 * reader looking at different stores.
 */
@Global()
@Module({
  providers: [RequestContextService, RequestContextMiddleware],
  exports: [RequestContextService, RequestContextMiddleware],
})
export class RequestContextModule {}
