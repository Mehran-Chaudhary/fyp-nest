# Real-time contract, v1

Live execution events for the workflow canvas and the notification tray
(proposal module 6.16), over Socket.IO. This document is the specification for
clients; the server side lives in `src/modules/realtime/` and
`src/shared/events/`. Design rationale:
[ADR 0004](../adr/0004-orchestration-tools-realtime.md), Decision 11.

**Events are metadata.** They say which run and step changed, to what status,
how long it took, how many tokens and tool calls — never what was said. A
client that wants content (a step's input or output, a run's result) fetches
it over HTTP, where access and information-flow labels are checked:
`GET /v1/organizations/{org}/workflow-runs/{run}/content` and
`…/steps/{step}/content`.

---

## Connecting

```js
import { io } from 'socket.io-client';

const socket = io('https://api.example.com', {
  path: '/realtime',               // REALTIME_PATH
  transports: ['websocket'],       // REALTIME_TRANSPORTS (default: websocket only)
  auth: { token: accessToken, organizationId: workspaceId },   // a person
  // auth: { apiKey: 'daiap_…' },                              // or an API key
});
```

- **Credentials go in the handshake `auth` payload — never in the URL.** A
  `token` or `apiKey` in the query string is refused (`AUTH_SCHEME_NOT_ALLOWED`).
- A person's socket belongs to **one workspace**, given as `organizationId`
  (UUID or slug) and checked against the token's user. To watch two
  workspaces, open two sockets.
- An API key's socket belongs to the key's workspace; it needs the
  `workflow:read` scope to watch runs.
- A browser may connect only from an origin in `CORS_ORIGINS`.

### Refusals

A refused handshake arrives as `connect_error`; `err.data` carries the same
`code` an HTTP error would:

```js
socket.on('connect_error', (err) => console.log(err.data?.code, err.message));
```

| `code` | Meaning |
|---|---|
| `AUTH_TOKEN_MISSING`, `AUTH_TOKEN_INVALID`, `AUTH_TOKEN_EXPIRED`, `AUTH_TOKEN_REVOKED` | No usable credential. Refresh the access token over HTTP and reconnect. |
| `AUTH_SCHEME_NOT_ALLOWED` | Credentials in the URL. |
| `ORGANIZATION_CONTEXT_REQUIRED`, `ORGANIZATION_NOT_FOUND`, `ORGANIZATION_SUSPENDED`, `MEMBERSHIP_SUSPENDED` | No workspace given; unknown or not yours (answered alike, so workspaces cannot be probed); suspended; or your membership is. |
| `IP_NOT_ALLOWED` | The workspace's IP allowlist refuses this address. |
| *(no code)* | The page's origin is not in `CORS_ORIGINS`: refused at the engine level before authentication, so the browser sees a bare transport error (`err.data` undefined). `REALTIME_ORIGIN_NOT_ALLOWED` exists but cannot reach a browser. |
| `REALTIME_CONNECTION_LIMIT` | More than `REALTIME_MAX_CONNECTIONS_PER_USER` sockets for this user or key. |
| `RATE_LIMIT_EXCEEDED` | More than `REALTIME_MAX_HANDSHAKES_PER_MINUTE` handshakes from this IP. |
| *(no code)* | `REALTIME_ENABLED=false`: also refused at the engine level (`REALTIME_DISABLED` cannot reach a client). |

Refused handshakes are audited (`realtime.connection.rejected`).

### `ready`

The first message after a successful handshake:

```json
{
  "organizationId": "6d87f94d-…",
  "rooms": ["org:6d87f94d-…:user:3e02a46c-…", "org:6d87f94d-…:approvers"],
  "expiresAt": 1790000000000,
  "serverTime": "2026-09-26T09:40:00.000Z"
}
```

`expiresAt` (epoch ms, or `null` for an API key) is when the socket will be
closed with `auth:expired` unless the client sends a fresh token first (see
`auth:refresh`).

---

## What a socket receives without asking

The server places each socket in rooms derived only from what it verified —
never from anything the client named:

| Room | Joined when | Receives |
|---|---|---|
| your runs | always | `run.*` events of runs **you** started |
| your notifications | always (people) | `notification` events addressed to you |
| all runs of the workspace | you hold `workflow:read_all` | `run.*` events of every run |
| approvers | you hold `workflow:approve` | `approval.requested`, `approval.decided` |

Rooms follow access as it changes: permissions are re-checked every
`REALTIME_REVALIDATE_INTERVAL` and immediately whenever access changes
anywhere in the platform (a role edited, a member removed, tokens revoked, an
API key revoked). Rooms you are no longer entitled to are left at once.

## Watching one run's steps

Step-level events (`step.*`, `tool.*`) go only to sockets subscribed to that
run. Every client message takes an acknowledgement callback:

```js
socket.emit('subscribe', { runId, lastEventId }, (ack) => {
  if (!ack.ok) return console.warn(ack.code, ack.message);
  ack.events.forEach(apply);          // missed events after lastEventId, oldest first
});
socket.emit('unsubscribe', { runId }, (ack) => {});
```

- You may subscribe to **your own** runs, or to any run of the workspace with
  `workflow:read_all`. Anything else — someone else's run, another
  workspace's, a run that does not exist — is answered identically:
  `{ ok: false, code: "WORKFLOW_RUN_NOT_FOUND" }`, and the attempt is audited.
- At most 50 subscriptions per socket.
- With `lastEventId`, the ack also returns the events of that run you missed
  (`replayed` counts them), so subscribing after a page load loses nothing.

### Acknowledgements

```json
{ "ok": true, "runId": "…", "replayed": 3, "events": [ /* Event */ ] }
{ "ok": false, "code": "PERMISSION_DENIED", "message": "Watching runs requires workflow:read." }
```

---

## Events

Delivered as `event` (and `notification` for notifications):

```js
socket.on('event', (event) => { /* … */ });
socket.on('notification', (event) => { /* … */ });
```

```json
{
  "id": "1790000000000-0",
  "type": "step.completed",
  "organizationId": "6d87f94d-…",
  "at": "2026-09-26T09:40:01.234Z",
  "runId": "ed7a6cde-…",
  "workflowId": "960e3587-…",
  "stepId": "49051763-…",
  "nodeId": "research",
  "initiatorUserId": "3e02a46c-…",
  "data": { "iteration": 0, "nodeType": "agent", "handles": ["out"], "durationMs": 2310,
            "tokens": 1480, "toolCalls": 1, "classification": "INTERNAL" }
}
```

`id` is the event's position in the workspace's stream: keep the last one you
saw, for `resume` and `subscribe`. `data` is always flat: strings (≤ 200
characters), numbers, booleans, `null`, arrays of strings or numbers.

| `type` | `data` |
|---|---|
| `run.started` | `workflowVersion`, `steps` (dispatched) |
| `run.resumed` | `stepsReset` |
| `run.completed`, `run.failed`, `run.cancelled`, `run.timed_out` | `status`, `errorCode?`, `steps`, `tokensUsed` |
| `step.queued`, `step.skipped` | `iteration`, `nodeType` |
| `step.started` | `iteration`, `nodeType`, `attempt` |
| `step.retrying` | `attempt`, `errorCode`, `delayMs` |
| `step.completed` | `handles` (the outcome taken), `durationMs`, `tokens`, `toolCalls`, `classification` |
| `step.failed` | `errorCode`, `failureClass`, `attempt` |
| `step.waiting_approval` | `expiresAt` |
| `tool.called` | `tool`, `executionId`, `ok`, `durationMs`, `errorCode?` |
| `tool.denied` | `tool`, `executionId`, `reason` (`INTEGRITY`, `CONFIDENTIALITY`, `RECIPIENT`, …) |
| `approval.requested` | `expiresAt`, `classification` — then fetch the approval queue over HTTP |
| `approval.decided` | `decision`, `decidedBy` |
| `notification` | depends on the source; from the `send_email` tool: `kind: "agent_email"`, `agentId`, `subjectLength` (never the subject or body) |

### Reconnecting

Socket.IO reconnects by itself. After it does, ask for what you missed:

```js
socket.emit('resume', { lastEventId }, (ack) => ack.events.forEach(apply));
```

Replay covers the events still in the workspace's stream (the last
`REALTIME_STREAM_MAXLEN`, at most `REALTIME_STREAM_TTL` old) for the rooms the
socket is in, up to `REALTIME_REPLAY_MAX`. Older gaps: reload the run over
HTTP (`GET …/workflow-runs/{run}`), which is always authoritative.

---

## Keeping the socket authorised

| Server → client | Meaning | What to do |
|---|---|---|
| `auth:expired` `{ code }` | The access token's lifetime ended; the socket closes. | Refresh the token over HTTP and reconnect — or, better, send `auth:refresh` before `expiresAt`. |
| `auth:revoked` `{ code }` | Access is gone (removed from the workspace, suspended, token or key revoked, permissions changed); the socket closes. | Do not reconnect automatically with the same credential. |
| `error` `{ code: "RATE_LIMIT_EXCEEDED" }` | More than 30 messages in 10 s; the socket closes. | Back off. |

Refreshing in place, keeping subscriptions:

```js
socket.emit('auth:refresh', { token: newAccessToken }, (ack) => {
  if (ack.ok) scheduleRefresh(ack.expiresAt);
});
```

The new token must belong to the same user; anything else closes the socket.

---

## Limits

| Limit | Value |
|---|---|
| Message size from a client | `REALTIME_MAX_MESSAGE_SIZE` (4 KB) |
| Messages per socket | 30 per 10 s |
| Subscriptions per socket | 50 |
| Sockets per user or key | `REALTIME_MAX_CONNECTIONS_PER_USER` (10) |
| Handshakes per IP per minute | `REALTIME_MAX_HANDSHAKES_PER_MINUTE` (60) |
| Heartbeat | ping every `REALTIME_PING_INTERVAL` (25 s), timeout `REALTIME_PING_TIMEOUT` (20 s) |
