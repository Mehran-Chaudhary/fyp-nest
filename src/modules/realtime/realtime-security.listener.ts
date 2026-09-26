import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  SECURITY_EVENT,
  type AccessChangedEvent,
} from '../../common/constants/security-events';
import { EventBusService } from '../../shared/events/event-bus.service';

/**
 * Turns an in-process "access changed" event into a control message every
 * process receives, so that sockets held by *any* API instance are re-checked
 * at once — a removed member's live connection closes now, not at the next
 * periodic check.
 */
@Injectable()
export class RealtimeSecurityListener {
  constructor(private readonly events: EventBusService) {}

  @OnEvent(SECURITY_EVENT.ACCESS_CHANGED, { async: true })
  async onAccessChanged(event: AccessChangedEvent): Promise<void> {
    await this.events.publishControl({
      kind: 'revalidate',
      ...(event.organizationId ? { organizationId: event.organizationId } : {}),
      ...(event.userId ? { userId: event.userId } : {}),
      ...(event.apiKeyId ? { apiKeyId: event.apiKeyId } : {}),
    });
  }
}
