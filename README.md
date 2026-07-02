# Webhook Inspector

Self-hosted webhook inspection: get a unique URL, send any HTTP request to it, and watch the full capture (method, path, query, headers, body) appear **live** in a dashboard — streamed over SSE the moment it lands, no polling. Captured requests can be **replayed** to any target with faithful reconstruction, **edited before resending** (method/headers/body), or **auto-forwarded** as they arrive — all SSRF-guarded. An open-source, self-hosted take on RequestBin / webhook.site.

> Full architecture rationale lives in [docs/decisions.md](docs/decisions.md).

## Run locally

Requires Node 24 (`nvm use`) and Docker.

```bash
docker compose up -d          # Postgres 16 + Redis 7
npm install
npm run dev:backend           # Fastify on :3000 (migrates on boot)
npm run dev:frontend          # Vite on :5173, proxies /api and /in to :3000
```

Open http://localhost:5173, register, create an endpoint, then:

```bash
curl -X POST http://localhost:5173/in/<your-slug>/anything?x=1 \
  -H 'content-type: application/json' -d '{"hello": "world"}'
```

The capture appears in the dashboard instantly — delivery is SSE-streamed (`EventSource`), with `Last-Event-ID` catch-up replaying anything missed across reconnects.

## Test

```bash
npm test        # integration tests against a throwaway Postgres database
npm run lint
npm run build
```

## Deploy (Railway)

One service runs everything: the backend serves the built frontend, and migrations run on boot.

1. Push this repo to GitHub — CI (lint, test, build) runs on every push/PR.
2. In Railway: **New Project → Deploy from GitHub repo**, and add a **PostgreSQL** database to the project.
3. On the service, set variables:
   - `DATABASE_URL` → reference the Railway Postgres variable (`${{Postgres.DATABASE_URL}}`)
   - `NODE_ENV` → `production`
4. Build/start commands (Railway usually infers these from package.json): build `npm run build`, start `npm start`.
5. Generate a public domain for the service — `https://<domain>/` is the dashboard, `https://<domain>/in/<slug>` is your webhook URL.

## Route map

| Path | Traffic type | Notes |
|---|---|---|
| `/in/:slug[/*]` | **Ingest** — untrusted | Any method, any content-type, raw-byte capture, no auth. 1 MiB body cap (413), per-endpoint rate limit (429, Redis-backed, fails open), 15s request timeout. Retention: newest 500 per endpoint, 7-day TTL |
| `/api/*` | **Viewer** — authenticated | Cookie sessions, JSON, schema-validated |
| `/api/endpoints/:id/stream` | **Viewer** — authenticated | SSE live stream with Last-Event-ID catch-up |
| `/api/endpoints/:eid/requests/:rid/replay` | **Viewer** — authenticated | Replay / edit-and-resend to a target URL (SSRF-guarded) |
| `/healthz` | Ops | Liveness probe |
| `/*` | Static | Built frontend (production) |
