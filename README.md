# Webhook Inspector

**Get a unique URL, point any webhook at it, and inspect every request — live.**

A self-hosted webhook inspection service: full request capture (method, path, query, headers, body — any content type, including binary and malformed payloads), streamed to the dashboard over SSE the moment it lands. Captured requests can be **replayed** to any target with faithful reconstruction, **edited before resending**, or **auto-forwarded** as they arrive — all SSRF-guarded. An open-source take on RequestBin / webhook.site.

**Live demo:** https://webhook-inspector-production.up.railway.app

---

## Architecture

Two fundamentally different traffic types, architected separately from day one:

```
   webhook senders                                    you, in a browser
   (untrusted, bursty,                                (authenticated,
    unauthenticated)                                   normal API traffic)
         │                                                    │
         ▼                                                    ▼
┌──────────────────────┐                      ┌──────────────────────────┐
│     INGEST PATH       │                      │       VIEWER PATH         │
│      /in/:slug        │                      │         /api/*            │
│                       │                      │                           │
│ • no auth, no parsing │                      │ • cookie sessions         │
│ • raw-byte capture    │                      │ • JSON + schema-validated │
│ • 1 MiB cap, 15s t/o  │                      │ • endpoints, history,     │
│ • per-endpoint rate   │                      │   replay, SSE stream      │
│   limit (Redis)       │                      │                           │
└──────────┬───────────┘                      └────────────┬──────────────┘
           │ INSERT                                         │ SSE
           ▼                                                ▲
      ┌─────────┐        publish          ┌──────────┐     │ subscribe
      │Postgres │ ─────────────────────▶  │  Redis   │ ────┘
      │(bytea   │◀── catch-up on          │ pub/sub  │
      │ bodies) │    reconnect            └──────────┘
      └─────────┘

  Ingest and viewer share only Postgres (source of truth) and Redis (the
  live-event plane). Because live events go through Redis pub/sub, a
  webhook landing on ANY instance reaches dashboards connected to ANY
  other instance — that's the horizontal-scaling story. Missed events are
  never the bus's job: on reconnect, the SSE layer replays from Postgres.
```

## The six engineering problems this project is built around

1. **Two traffic types, one system.** Ingest (untrusted, must never trust input, must be fast and defensive) and viewer (authenticated, normal API) are split in routing, middleware, and body handling. The ingest plugin even swaps in its own raw-buffer content-type parser so it *cannot* accidentally parse hostile input. ([routes/ingest.ts](backend/src/routes/ingest.ts), ADRs 0001, 0010)
2. **Live delivery to the browser.** A capture reaches connected dashboards in ~100–150ms with no polling: SSE, notified by a `RequestBus`. In-process for one instance, Redis pub/sub across many. ([routes/api/stream.ts](backend/src/routes/api/stream.ts), [events.ts](backend/src/events.ts), ADRs 0012, 0013, 0020)
3. **Arbitrary untrusted input, handled safely.** Any method/content-type accepted; bodies stored as `bytea` (never rejected for bad UTF-8), decoded to text or base64 at read time, rendered only as React text nodes (no XSS). Size cap + request timeout bound the damage. ([lib/…], ADRs 0009, 0014)
4. **Retention and storage growth.** Age TTL *and* per-endpoint cap, swept every 10 min under an advisory lock; the cap query reuses the history index. ([lib/retention.ts](backend/src/lib/retention.ts), ADR 0016)
5. **Replay and forwarding.** Faithful reconstruction (hop-by-hop headers, `host`, `content-length` handled correctly); edit-and-resend as the same engine; async auto-forward that can't slow a capture; connect-time SSRF guard. ([lib/replay.ts](backend/src/lib/replay.ts), [lib/ssrf.ts](backend/src/lib/ssrf.ts), ADRs 0017–0019)
6. **Abuse and rate limiting.** Per-endpoint Redis fixed-window limiter that fails open, plus the connection/body/timeout layers. ([lib/rate-limit.ts](backend/src/lib/rate-limit.ts), ADR 0015)

## Tech stack — and why

| Choice | Why (short version — full rationale in [docs/decisions.md](docs/decisions.md)) |
|---|---|
| **Fastify** (not Express) | Ingest must accept bodies without parsing; Fastify parses by opt-in, Express by default. Plus schema validation + speed. |
| **PostgreSQL**, raw `pg` (not an ORM) | The hard problems are DB problems (index design, `bytea`, retention) — an ORM hides the layer worth demonstrating. |
| **Redis** | Per-endpoint rate limiting *and* the cross-instance live-event bus (pub/sub). |
| **SSE** (not WebSockets) | One-directional feed; `EventSource` gives reconnection + `Last-Event-ID` resume for free over plain HTTP. |
| **Cookie sessions** (not JWT) | Instant revocation on logout; httpOnly keeps the credential away from JS (this app renders hostile payloads). |
| **scrypt** (built-in) | OWASP-approved, memory-hard, zero native-addon build risk on deploy. |
| **React + Vite** | Deliberately simple — the backend is the star. Served by the backend in prod (no CORS). |

## Engineering challenges (interview conversations this project enables)

- *Why split ingest from the viewer API?* — opposite requirements: one is untrusted/bursty/unauth, the other is authenticated normal traffic.
- *How does a capture reach the browser live, and what happens with multiple instances?* — SSE + Redis pub/sub; Postgres is the source of truth so nothing is lost on disconnect.
- *Why SSE over WebSockets?* — one-way data; browser-native reconnect and resume.
- *How do you stop one abusive sender?* — four layers: connection timeout, body cap, per-endpoint rate limit, retention.
- *Retention strategy and the fast history query?* — TTL + per-endpoint cap; one `(endpoint_id, received_at DESC)` index serves history, SSE catch-up, and cap enforcement.
- *Storing/displaying a payload you don't control?* — `bytea` in, text/base64 out, text-node render only.
- *If traffic 100×'d, what breaks first?* — DELETE-based retention (vacuum pressure) → partition-and-drop; and shared-DB coupling.

## Run locally

Requires Node 24 (`nvm use`) and Docker.

```bash
docker compose up -d          # Postgres 16 + Redis 7
npm install
npm run dev:backend           # Fastify on :3000 (migrates + cleans on boot)
npm run dev:frontend          # Vite on :5173, proxies /api and /in to :3000
```

Open http://localhost:5173, register, create an endpoint, then:

```bash
curl -X POST http://localhost:5173/in/<your-slug>/anything?x=1 \
  -H 'content-type: application/json' -d '{"hello": "world"}'
```

The capture appears in the dashboard instantly (SSE). To replay to a local
target during dev, set `REPLAY_ALLOW_PRIVATE=1`.

## Test

```bash
npm test        # unit + integration (needs Postgres + Redis running)
npm run test:e2e  # Playwright: create endpoint → send webhook → see it live
npm run lint
npm run build
```

73 unit/integration tests + 1 Playwright e2e. CI (GitHub Actions) runs
lint, tests against Postgres + Redis service containers, build, and the
e2e on every push/PR.

## Deploy (Railway)

One app service serves the built frontend and the API; Postgres and Redis
are Railway plugins. Migrations run on boot.

1. Push to GitHub — CI runs on every push/PR.
2. Railway: **Deploy from GitHub repo**, add **PostgreSQL** and **Redis**.
3. On the app service, set: `NODE_ENV=production`, `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `REDIS_URL=${{Redis.REDIS_URL}}`. For GitHub login, also `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` (see below).
4. Generate a public domain. `https://<domain>/` is the dashboard; `https://<domain>/in/<slug>` is the webhook URL.

### GitHub OAuth (optional)

Register an OAuth app at github.com/settings/developers with callback
`https://<your-domain>/api/auth/github/callback`, then set
`GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. The login button appears
only when both are set; without them, email/password still works.

All environment variables are documented in [.env.example](.env.example).

## Route map

| Path | Traffic type | Notes |
|---|---|---|
| `/in/:slug[/*]` | **Ingest** — untrusted | Any method/content-type, raw-byte capture, no auth. 1 MiB cap (413), per-endpoint rate limit (429), 15s timeout. Optional auto-forward. |
| `/api/auth/*` | **Viewer** | Register/login/logout/me, GitHub OAuth, providers. |
| `/api/endpoints/*` | **Viewer** — authenticated | CRUD, request history + detail, forward config. |
| `/api/endpoints/:id/stream` | **Viewer** — authenticated | SSE live stream with `Last-Event-ID` catch-up. |
| `/api/endpoints/:eid/requests/:rid/replay` | **Viewer** — authenticated | Replay / edit-and-resend (SSRF-guarded). |
| `/healthz` | Ops | Liveness probe. |
| `/*` | Static | Built frontend (SPA fallback). |
