import { Global, Module } from '@nestjs/common';
import { QueueService } from './queue.service';

/**
 * Background job infrastructure (BullMQ on the platform's Redis).
 *
 * Introduced in phase 2 rather than phase 4 because parsing and embedding a
 * 200-page PDF cannot happen inside an HTTP request. Phase 4's workflow engine
 * adds its own queues through the same service.
 */
@Global()
@Module({
  providers: [QueueService],
  exports: [QueueService],
})
export class QueueModule {}
