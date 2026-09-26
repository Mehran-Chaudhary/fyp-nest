/**
 * In-process security events (`@nestjs/event-emitter`).
 *
 * Emitted wherever access is withdrawn or changed — a member removed or
 * suspended, roles edited, every session revoked, an API key revoked — so that
 * long-lived connections can be re-checked at once instead of at their next
 * periodic revalidation. The real-time layer turns them into cross-process
 * control messages.
 */
export const SECURITY_EVENT = {
  ACCESS_CHANGED: 'security.access_changed',
} as const;

export interface AccessChangedEvent {
  organizationId?: string;
  userId?: string;
  apiKeyId?: string;
}
