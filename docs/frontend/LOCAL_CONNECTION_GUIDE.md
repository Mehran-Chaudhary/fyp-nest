# Local frontend ↔ backend testing

Frontend: `http://localhost:5173`. Backend: `http://localhost:3000`.

## 1. Backend `.env` (already configured)

```dotenv
NODE_ENV=development
APP_HOST=0.0.0.0
APP_PORT=3000
APP_URL=http://localhost:3000
FRONTEND_URL=http://localhost:5173
CORS_ORIGINS=http://localhost:5173,http://localhost:3000
CORS_CREDENTIALS=true
COOKIE_SECURE=false
COOKIE_SAME_SITE=lax
REFRESH_TOKEN_COOKIE_ENABLED=true
REFRESH_TOKEN_COOKIE_DOMAIN=
```

These cookie settings are for local HTTP testing. Restart the backend after `.env` changes: stop the existing process, then run `npm run start:dev`.

## 2. Frontend `.env`

Create `.env` in the **frontend project root**, beside its `package.json`:

```dotenv
VITE_API_BASE_URL=http://localhost:3000/api/v1
```

Restart Vite with `npm run dev -- --port 5173 --strictPort`. Use `localhost` consistently in the browser and API URL.

The API client must actually read the variable and include cookies:

```ts
const API = import.meta.env.VITE_API_BASE_URL;

const response = await fetch(`${API}/auth/me`, {
  credentials: 'include',
  headers: { Authorization: `Bearer ${accessToken}` },
});
const body = await response.json();
if (!response.ok) throw new Error(body.error?.message ?? 'Request failed');
const user = body.data;
```

Use `credentials: 'include'` on login, refresh, logout, and other API requests too (Axios: `withCredentials: true`). Send the access token on protected requests; keep it in memory. The refresh token is an HttpOnly cookie. Do not copy backend secrets into the frontend `.env`.

For workspace requests, send `X-Organization-Id` with the same workspace UUID used in the URL. For Socket.IO, connect to `http://localhost:3000` with `path: '/realtime'` and `transports: ['websocket']`; `/realtime` is the transport path, not a namespace.

## 3. Test the connection

1. Open `http://localhost:3000/health/ready` and `http://localhost:3000/docs`.
2. Open the frontend at `http://localhost:5173`; sign in and check DevTools → Network: requests must target `http://localhost:3000/api/v1/...`.
3. Confirm login sets the refresh cookie; `/auth/me` succeeds with the access token. Reload and confirm `POST /auth/refresh` restores the session; then test logout.
4. Test workspace creation, document upload → processing → retrieval/chat, and a workflow run.

Email currently uses Ethereal: verification, reset, and invitation messages appear in its test inbox, not real recipients' inboxes.
