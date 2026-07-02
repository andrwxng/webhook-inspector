# Decision log (lightweight ADRs)

One paragraph per decision: what we chose, what we rejected, why. Newest at the bottom.

## 0001 — Fastify over Express (2026-07-01)

**Chose Fastify 5. Rejected Express.** Three reasons that matter for *this* project specifically. (1) The ingest path must accept arbitrary bodies of any content-type without parsing them; Fastify makes body parsing explicit and per-content-type (`addContentTypeParser`), while Express's middleware model makes "don't touch the body" the awkward exception. (2) Fastify has first-class JSON schema validation and serialization on routes, which we'll want on the viewer API. (3) It's meaningfully faster per request, which is a defensible answer to "the ingest path is bursty and unauthenticated." Express's advantage is familiarity and ecosystem size, but every middleware we'd want (rate limiting, auth) has a maintained Fastify equivalent. Interview answer in one line: "Express parses by default and opts out; Fastify parses by choice and opts in — an ingest service wants the second."

## 0002 — npm workspaces monorepo: `backend/` + `frontend/` (2026-07-01)

**Chose a single repo with npm workspaces. Rejected two repos, and rejected pnpm/turborepo.** One repo means one CI pipeline, one issue tracker, and atomic commits that touch API and UI together — right-sized for a solo portfolio project. npm workspaces (vs pnpm/turborepo) because it ships with Node, needs zero extra tooling to explain, and our build graph is trivial (two packages, no shared libs yet). If a shared types package appears later, workspaces already handles it.

## 0003 — `buildApp()` factory + `app.inject()` for tests, no Supertest (2026-07-01)

**Chose exporting a `buildApp()` factory and testing with Fastify's built-in `inject()`. Rejected Supertest.** `inject()` simulates the HTTP request in-process without binding a real port, so tests are faster, can run in parallel without port collisions, and need one less dependency. Supertest exists to give Express apps exactly this ability; Fastify has it natively. The factory pattern (app construction separate from `listen()`) is what makes any of this testable.

## 0004 — TypeScript: strict everywhere, `noEmit` for checking, separate build config (2026-07-01)

**Chose `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` from day one.** Retrofitting strictness is much harder than starting with it, and this codebase will handle untrusted data where "this header might be undefined" is a real bug class, not pedantry. The main `tsconfig.json` is `noEmit` and covers src + tests (what the editor and CI type-check); `tsconfig.build.json` emits only `src/` to `dist/` so test files never ship. Dev runs through `tsx watch` (no compile step); production runs compiled JS.

## 0005 — Node 24 via `.nvmrc` (2026-07-01)

**Chose Node 24 (current LTS line on this machine). Rejected staying on the shell-default Node 16.** Node 16 is end-of-life and below the minimum for Fastify 5, Vite 7, and Vitest 3. `.nvmrc` pins the version for nvm users and for `actions/setup-node` in CI (`node-version-file`), so local and CI can't drift.

## 0006 — Cookie sessions in Postgres over JWT (2026-07-01)

**Chose server-side sessions: random 256-bit token in an httpOnly cookie, SHA-256 of the token stored in a `sessions` table. Rejected JWT.** Three reasons. (1) Revocation: logout deletes the row and the cookie is instantly dead everywhere — JWTs stay valid until expiry unless you add a denylist, at which point you've rebuilt sessions anyway. (2) XSS posture: this app renders attacker-supplied payloads, so keeping the credential in an httpOnly cookie (invisible to JS) instead of anywhere a script could reach matters more than usual. (3) JWT's real advantage — stateless verification across services — buys nothing in a single-backend app that hits Postgres on every request anyway. Storing only the token hash means a leaked DB dump can't be replayed as live sessions. Interview answer in one line: "JWTs solve distributed verification; I had a revocation problem, and sessions solve revocation."

## 0007 — scrypt from node:crypto over bcrypt/argon2 packages (2026-07-01)

**Chose Node's built-in `crypto.scrypt` for password hashing. Rejected the `bcrypt` and `argon2` npm packages.** scrypt is a memory-hard KDF on OWASP's approved list, and it ships with Node — no native-addon dependency that has to compile on every deploy target (bcrypt's node-gyp builds are a classic CI/Railway failure mode). Parameters (N=16384, r=8, p=1) are stored inside each hash string, so they can be raised later without invalidating existing users. Verification uses `timingSafeEqual`. Argon2id is the newer recommendation, but "zero dependencies, OWASP-approved, parameters upgradeable in place" is the stronger engineering story at this scale.

## 0008 — Raw `pg` + hand-written SQL migrations over an ORM (2026-07-01)

**Chose the `pg` driver, hand-written SQL, and a ~50-line migration runner (ordered SQL strings tracked in a `schema_migrations` table, guarded by a Postgres advisory lock). Rejected Prisma/Drizzle and rejected migration frameworks.** This project's hard problems are database problems — index design for the history query, `bytea` storage, retention deletes — and an ORM abstracts away exactly the layer I need to demonstrate command of. Embedding migration SQL as strings in a TS module (rather than `.sql` files) means migrations ship inside `dist/` with no build-step file copying. The advisory lock makes boot-time migration safe even with multiple instances. Tradeoff accepted: no auto-generated types from the schema; query result types are declared by hand at each call site.

## 0009 — Bodies stored as `bytea`, decoded to utf8/base64 at read time (2026-07-01)

**Chose to store every captured body as raw bytes (`bytea`), exactly as received, and decide text-vs-binary when the viewer reads it (strict UTF-8 decode → utf8 string; failure → base64 + flag). Rejected storing bodies as `text` and rejected classifying at capture time.** `text` columns reject invalid UTF-8, so a malformed or binary payload would corrupt or crash the write path — the one path that must never fail. Deciding at read time keeps ingest dumb and fast (write bytes, done) and keeps the stored artifact faithful for Phase 4 replay, which needs the original bytes, not a lossy text rendering. The client is told which encoding it got and renders payloads only as text nodes — never interpreted.

## 0010 — Ingest captures raw buffers via scoped content-type parser (2026-07-01)

**Chose to give the ingest plugin its own content-type parser (`removeAllContentTypeParsers()` + a `'*'` parser that returns the raw buffer). Rejected global raw-body parsing and rejected per-route body handling.** Fastify encapsulates content-type parsers per plugin scope, so `/in/*` treats every body — JSON, XML, protobuf, malformed garbage — as opaque bytes it never parses, while `/api/*` keeps normal JSON parsing with schema validation. This is the ingest/viewer split expressed in actual middleware, not just folder names: the ingest path also has no cookie plugin, no auth, and touches nothing user-supplied except to store it. Malformed JSON sent with a JSON content-type is *captured*, not rejected — a webhook inspector that 400s on bad payloads would be useless for debugging exactly the case you care about.

## 0011 — Backend serves the built frontend; no CORS anywhere (2026-07-01)

**Chose to have Fastify serve `frontend/dist` via `@fastify/static` in production (one Railway service), with Vite's dev server proxying `/api` and `/in` locally. Rejected a separate static-hosting service.** Same-origin everywhere means zero CORS configuration, cookies just work (`SameSite=Lax`, no third-party-cookie problems), and one deploy target keeps the demo cheap and hard to break. The SPA fallback only applies to GET requests outside `/api` and `/in`, so API 404s stay JSON and unknown webhook slugs stay 404. Tradeoff: static files share the Node process with ingest traffic — acceptable now, and the migration path (CDN in front) is a good Phase 5+ interview answer.

## 0012 — SSE over WebSockets for live delivery (2026-07-02)

**Chose Server-Sent Events for the dashboard stream. Rejected WebSockets.** The data flow is strictly one-directional — the server announces captures; the browser never sends anything upstream on that channel — and SSE is purpose-built for exactly that. What it buys concretely: (1) it's plain HTTP, so the session cookie, TLS termination, and Railway's proxy all work with zero special handling (WebSockets need an Upgrade hop that proxies and corporate middleboxes sometimes mangle); (2) `EventSource` has **reconnection and resume built into the browser** — it auto-reconnects and echoes the last seen `id:` back as a `Last-Event-ID` header, which would be hand-rolled protocol work on a WebSocket; (3) the server side is just a long-lived HTTP response — no new framing protocol, no ws library. WebSockets win when traffic is bidirectional (chat, games, collaborative editing) or binary; none of that applies. Known SSE limit worth naming in an interview: browsers cap ~6 concurrent SSE connections per origin over HTTP/1.1 — a non-issue here (one stream per open dashboard) and gone under HTTP/2 multiplexing, which Railway serves. Heartbeat comments go out every 25s so idle proxies don't reap the connection.

## 0013 — In-process event bus behind an interface; DB-backed catch-up on reconnect (2026-07-02)

**Chose a ~40-line `RequestBus` interface (publish/subscribe by endpoint id) implemented with Node's `EventEmitter`, and made Postgres — not the bus — the source of truth for missed events. Rejected Redis pub/sub now (it's Phase 5, when there are multiple instances to connect) and rejected in-memory replay buffers.** The interface is the scaling seam: ingest publishes after the row is durable in Postgres, the SSE layer subscribes, and neither knows the transport — swapping in Redis pub/sub later changes one binding, not the routes. Missed events: every SSE event's `id:` is the row's `received_at` (Postgres text, microsecond precision), so a reconnecting `EventSource` presents `Last-Event-ID` and the server replays newer rows straight from the `requests` table using the same `(endpoint_id, received_at DESC)` index the history query uses — no second storage system, no ring buffer that loses data on restart. The subtle race (an event arriving *between* the catch-up query and going live) is closed by subscribing first, buffering during catch-up, and flushing the buffer deduped by request id. Failure honesty: delivery is at-least-once (dedupe client-side by id), and a request arriving during a *hard server crash* window is never lost — it's in Postgres, and reload/catch-up finds it.
