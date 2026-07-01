# Webhook Inspector — Project Prompt for Claude Code

> **How to use this file:** This is the standing project brief. Every Claude Code session reads it automatically. When starting a session, say which phase you're on and what to build next.

---

## What we are building

A self-hosted webhook inspection service. A user gets a unique URL; any HTTP request sent to that URL is captured and displayed in full (method, headers, query params, body) in a live web dashboard — with request history, replay, and forwarding. Think an open-source, self-hosted RequestBin / webhook.site.

This is a **portfolio flagship project**. The goal is not feature count — it is depth. Every architectural decision must be defensible in a technical interview. When there is a tradeoff, explain it to me and let me decide; I need to understand and own every choice.

## My role and your role

- I am a student building this to learn and to interview with. **Do not just generate the whole app.** Work phase by phase, explain the "why" behind each decision, and quiz me on tradeoffs when we make them.
- Prefer small, reviewable changes over large dumps of code.
- Keep commits small and meaningful — I will commit frequently with descriptive messages.
- If I ask you to skip ahead, remind me which phase we're in and what's unfinished.

## Tech stack

- **Backend:** Node.js + TypeScript (Express or Fastify — recommend one and justify it)
- **Database:** PostgreSQL (captured requests, endpoints, users)
- **Cache / rate limiting / pub-sub:** Redis
- **Real-time delivery:** Server-Sent Events (SSE) first; be ready to justify SSE vs WebSockets
- **Frontend:** React + TypeScript (Vite), kept deliberately simple — the backend is the star
- **Local dev:** Docker Compose for Postgres + Redis
- **Deployment:** Railway, with CI/CD via GitHub Actions
- **Auth:** basic email/password first, GitHub OAuth in Phase 5
- **Testing:** unit + integration tests (Vitest/Jest + Supertest), Playwright e2e in Phase 5

## Core architectural rule

There are **two fundamentally different traffic types** and they must be architected separately:

1. **Ingest path** — webhooks arriving from the outside world: untrusted, unpredictable, bursty, unauthenticated by nature. Must be fast, defensive, and never trust its input.
2. **Viewer path** — authenticated users watching the dashboard: normal API traffic.

Keep these separated in routing, middleware, and design from day one, even in a single process. The ingest handler notifies the viewer layer via an in-process event emitter early on, replaced by Redis pub/sub in Phase 5 (this is the horizontal-scaling story).

## The six engineering problems (design around these)

Every feature must serve one of these. These are the interview conversations the project exists to enable:

1. **Two traffic types, one system** — ingest vs viewer, opposite requirements, architected separately.
2. **Live delivery to the browser** — when a webhook lands, connected dashboards for that endpoint see it within ~1 second, no polling. SSE layer + the question of how ingest notifies viewers (event emitter → Redis pub/sub).
3. **Arbitrary, untrusted input handled safely** — any method, any content-type, malformed, huge, or malicious. Enforce body-size limits, request timeouts, safe storage of binary vs text, and never execute or trust anything. Payloads must be rendered safely in the UI (no XSS from a captured body).
4. **Retention and storage growth** — captured requests pile up fast. Retention policy (last N per endpoint and/or TTL), a cleanup job, and correct indexes so history queries stay fast. Unbounded growth is a design smell.
5. **Request replay and forwarding** — re-send a captured request faithfully to a target URL (headers, body, method reconstructed correctly — this is deceptively tricky), plus optional auto-forwarding of incoming requests.
6. **Abuse and rate limiting** — a public ingest endpoint will get hammered. Per-endpoint rate limits (Redis-backed), global protections, graceful shedding under load.

## Build order (phases — each ends with a working, deployed milestone)

### Phase 1 — Capture & display (the MVP that already impresses)
- Ingest route that catches ANY request (any method, any path under the endpoint's unique URL) and stores it in Postgres.
- Dashboard that lists captured requests per endpoint and shows full detail (method, path, query, headers, body).
- Endpoint creation (generate unique URL/slug).
- Basic auth (email/password, sessions or JWT — recommend and justify).
- Docker Compose for local Postgres.
- **Deploy live to Railway with GitHub Actions CI/CD. Keep it running from here on.** A working demo link is worth more than any extra feature.

### Phase 2 — Go live (real-time)
- SSE stream so the dashboard updates the instant a request arrives — no refresh, no polling.
- In-process event emitter connects ingest → SSE layer.
- Handle SSE reconnection and missed events sensibly.

### Phase 3 — Robustness (the part that separates this from a demo)
- Body-size limits and request timeouts on the ingest path.
- Per-endpoint rate limiting backed by Redis.
- Retention policies + scheduled cleanup job.
- Safe handling of binary and malformed payloads (store safely, render safely).
- Proper indexes for the history query.
- **Write the test suite here** — unit tests for limits/retention logic, integration tests for the ingest path.

### Phase 4 — Replay & forward (most technically interesting; lead with this in interviews)
- Replay: re-send a captured request to a target URL with faithful reconstruction.
- Edit-and-resend: let the user modify the request before replaying (headers/body/method). *(This is our differentiator over existing tools — treat it as first-class, not a bolt-on.)*
- Optional auto-forwarding of incoming requests to a configured target.
- Guard against SSRF when replaying/forwarding (do not let users make the server hit internal addresses).

### Phase 5 — Scale & polish
- Redis pub/sub replaces the in-process emitter so multiple backend instances share live events (the "how does it scale horizontally" answer).
- GitHub OAuth.
- Playwright end-to-end test (create endpoint → send request → see it live).
- README with: one-line pitch, live demo link, architecture diagram (showing the ingest/viewer split), tech stack with reasoning, and an "engineering challenges" section mirroring the six problems above.
- Custom domain.

Phases 4–5 are the flagship tier; stopping cleanly after Phase 3 still yields a strong project.

## Non-negotiables

- The live deployment stays up. Never merge something that breaks the demo.
- No secrets in the repo. Use environment variables; document them in `.env.example`.
- Never render captured payloads unsafely (treat all captured content as hostile).
- Every phase's decisions get a short note in `docs/decisions.md` (a lightweight ADR log) — one paragraph per decision: what we chose, what we rejected, why. This is my interview prep.

## Interview questions this project must let me answer (design checkpoints)

Before we call any phase done, check that the work so far gives concrete answers to the relevant questions below, and quiz me on them:

1. Why did you separate the ingest path from the dashboard API?
2. How does a captured request get from the ingest handler to the browser in real time? What happens with multiple server instances?
3. Why SSE instead of WebSockets (or vice versa)?
4. How do you stop one abusive sender from taking the service down?
5. What's your retention strategy and why? What index makes the history query fast?
6. How do you safely store and display a payload you don't control?
7. If traffic 100x'd tomorrow, what breaks first and what do you change?

## Resume line this project is building toward

"Built a self-hosted webhook inspection service with real-time request streaming (SSE), per-endpoint rate limiting, and request replay with edit-and-resend; handles arbitrary untrusted payloads with size/timeout guards; deployed on Railway with CI/CD via GitHub Actions."

Every line of that sentence must be true and demonstrable by the end of Phase 4.

## Project conventions (established during setup)

- Node 24 (see `.nvmrc`); npm workspaces monorepo: `backend/` + `frontend/`.
- Backend framework: **Fastify** (see `docs/decisions.md` for why).
- Run everything from the repo root: `npm run lint`, `npm test`, `npm run build`.
- Local infra: `docker compose up -d` (Postgres 16 + Redis 7).
