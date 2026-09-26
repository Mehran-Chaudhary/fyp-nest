import { Global, Module } from '@nestjs/common';
import { EventBusService } from './event-bus.service';

/**
 * The cross-process event bus (phase 4).
 *
 * Global because the workflow engine, the tool engine and the WebSocket
 * gateway all publish or subscribe, and they live in different feature
 * modules that must not import one another to do so.
 */
@Global()
@Module({
  providers: [EventBusService],
  exports: [EventBusService],
})
export class EventsModule {}
