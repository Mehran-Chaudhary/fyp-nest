import { sanitizeEventData, type RealtimeEvent } from '../../shared/events/realtime-event';
import { Rooms, roomsFor, toClientEvent } from './realtime-routing';

/**
 * Real-time routing (proposal module 6.16): which sockets an event reaches is
 * decided from ids the server verified, and what an event may carry is
 * decided before it is published.
 */

const ORG = 'org-1';

function event(overrides: Partial<RealtimeEvent>): RealtimeEvent {
  return {
    id: '1-0',
    type: 'step.completed',
    organizationId: ORG,
    at: '2026-01-01T00:00:00.000Z',
    runId: 'run-1',
    initiatorUserId: 'user-1',
    data: {},
    ...overrides,
  };
}

describe('real-time routing', () => {
  it('sends step detail only to the run’s room: watchers subscribed to that run', () => {
    expect(roomsFor(event({ type: 'step.completed' }))).toEqual([Rooms.run('run-1')]);
  });

  it('sends run lifecycle to the run, the initiator and the workspace’s supervisors', () => {
    expect(roomsFor(event({ type: 'run.completed' })).sort()).toEqual(
      [Rooms.run('run-1'), Rooms.runs(ORG), Rooms.user(ORG, 'user-1')].sort(),
    );
    expect(
      roomsFor(
        event({
          type: 'run.failed',
          initiatorUserId: undefined,
          initiatorApiKeyId: 'key-1',
        }),
      ),
    ).toContain(Rooms.key(ORG, 'key-1'));
  });

  it('sends approval requests to the workspace’s approvers', () => {
    expect(roomsFor(event({ type: 'approval.requested' }))).toContain(Rooms.approvers(ORG));
  });

  it('sends a notification to exactly its recipients, in that workspace', () => {
    expect(
      roomsFor(
        event({
          type: 'notification',
          runId: undefined,
          recipientUserIds: ['user-2', 'user-3'],
        }),
      ),
    ).toEqual([Rooms.user(ORG, 'user-2'), Rooms.user(ORG, 'user-3')]);
    expect(roomsFor(event({ type: 'notification', recipientUserIds: undefined }))).toEqual(
      [],
    );
  });

  it('never routes an event without a run, other than a notification', () => {
    expect(roomsFor(event({ type: 'step.completed', runId: undefined }))).toEqual([]);
  });

  it('strips routing internals before an event reaches a client', () => {
    const visible = toClientEvent(
      event({ recipientUserIds: ['user-2'], initiatorApiKeyId: 'key-1' }),
    );
    expect(visible).not.toHaveProperty('recipientUserIds');
    expect(visible).not.toHaveProperty('initiatorApiKeyId');
    expect(visible.runId).toBe('run-1');
  });
});

describe('event payloads', () => {
  it('keeps flat, bounded metadata and drops anything structured', () => {
    const clean = sanitizeEventData({
      attempt: 2,
      ok: true,
      none: null,
      nodeType: 'agent',
      long: 'x'.repeat(500),
      infinite: Number.POSITIVE_INFINITY,
      ids: Array.from({ length: 80 }, (_, index) => `id-${index}`),
      counts: [1, 2, 3],
      mixed: [1, 'two'],
      nested: { prompt: 'the whole prompt' },
      fn: () => 'nothing',
    });
    expect(clean).toEqual({
      attempt: 2,
      ok: true,
      none: null,
      nodeType: 'agent',
      long: 'x'.repeat(200),
      infinite: null,
      ids: Array.from({ length: 50 }, (_, index) => `id-${index}`),
      counts: [1, 2, 3],
    });
  });
});
