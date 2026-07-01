# Webhook Inspector

Self-hosted webhook inspection: get a unique URL, send any HTTP request to it, and inspect the full capture (method, path, query, headers, body) in a dashboard. An open-source, self-hosted take on RequestBin / webhook.site.

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

Hit **Refresh** in the dashboard to see the capture (live updates land in Phase 2).

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
| `/in/:slug[/*]` | **Ingest** — untrusted | Any method, any content-type, raw-byte capture, no auth |
| `/api/*` | **Viewer** — authenticated | Cookie sessions, JSON, schema-validated |
| `/healthz` | Ops | Liveness probe |
| `/*` | Static | Built frontend (production) |
