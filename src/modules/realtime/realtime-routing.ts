import type { RealtimeEvent } from '../../shared/events/realtime-event';

/**
 * Room names. Every room is derived from ids the server verified — the
 * socket's own workspace, user or key, or a run it was authorised to
 * subscribe to — never from anything the client named.
 */
export const Rooms = {
  /** Lifecycle of every run in a workspace: supervisors (`workflow:read_all`). */
  runs: (organizationId: string) => `org:${organizationId}:runs`,
  /** A person's own runs and notifications. */
  user: (organizationId: string, userId: string) => `org:${organizationId}:user:${userId}`,
  /** An API key's own runs. */
  key: (organizationId: string, apiKeyId: string) =>
    `org:${organizationId}:key:${apiKeyId}`,
  /** Approval requests: members holding `workflow:approve`. */
  approvers: (organizationId: string) => `org:${organizationId}:approvers`,
  /** Every event of one run: step-level detail for the canvas. */
  run: (runId: string) => `run:${runId}`,
} as const;

/** The rooms an event is delivered to. */
export function roomsFor(event: RealtimeEvent): string[] {
  const organizationId = event.organizationId;
  const rooms = new Set<string>();

  if (event.type === 'notification') {
    for (const userId of event.recipientUserIds ?? [])
      rooms.add(Rooms.user(organizationId, userId));
    return [...rooms];
  }
  if (!event.runId) return [];

  rooms.add(Rooms.run(event.runId));
  if (event.type.startsWith('run.')) {
    rooms.add(Rooms.runs(organizationId));
    if (event.initiatorUserId) rooms.add(Rooms.user(organizationId, event.initiatorUserId));
    if (event.initiatorApiKeyId)
      rooms.add(Rooms.key(organizationId, event.initiatorApiKeyId));
  }
  if (event.type === 'approval.requested' || event.type === 'approval.decided') {
    rooms.add(Rooms.approvers(organizationId));
  }
  return [...rooms];
}

/** What a client receives: routing internals stripped. */
export function toClientEvent(
  event: RealtimeEvent,
): Omit<RealtimeEvent, 'recipientUserIds' | 'initiatorApiKeyId'> {
  const { recipientUserIds: _recipients, initiatorApiKeyId: _key, ...visible } = event;
  void _recipients;
  void _key;
  return visible;
}
