# Decisions

Running log of what was built each step and why. This is the interview script —
keep it current and in plain language.

## Step 1 — Data layer (`feature/data-layer`)

- **Single-table DynamoDB.** Monitors, check results, and incidents all live in
  one table keyed by `PK`/`SK`. A user's monitors are one query
  (`PK = USER#<id>`), and a monitor's checks/incidents are one query
  (`PK = MONITOR#<id>`) — no joins, no GSIs needed yet. Domain types in
  `src/types` stay clean (no `PK`/`SK`); the persistence layer in
  `src/lib/monitors.ts` translates to/from table items.
- **SSRF-aware URL validation** (`src/lib/schemas.ts`). A monitor URL is
  user-supplied data that a server-side Lambda will fetch, so it's an SSRF
  vector. The Zod schema requires `https` and rejects localhost + private/
  reserved ranges (10/8, 172.16–31, 192.168/16, 127/8, and the
  169.254.169.254 cloud-metadata address) for both IPv4 and IPv6. Treated as
  defence-in-depth — DNS rebinding is still possible, so the checker also needs
  locked-down networking later.
- **Vitest** for tests (no runner was configured). Unit-tested the URL rejection
  logic, including near-miss public IPs (172.15/172.32) to prove the private
  range boundaries are exact.
- `setMonitorActive` and `createMonitor` use DynamoDB condition expressions so a
  missing monitor returns `null` instead of silently creating/upserting.

## Step 2 — Monitor CRUD API (`feature/monitor-api`)

- **Routes** under `src/app/api/monitors`: `GET`/`POST` on the collection,
  `GET`/`PATCH`/`DELETE` on `[id]`. Thin handlers — validate, call the Step 1
  lib, map results to status codes (201 create, 403 over limit, 404 missing,
  204 delete, 400 bad input).
- **5-monitor cap** enforced in the POST handler by counting the user's existing
  monitors first; returns 403 with a clear message.
- **Auth seam** (`src/lib/auth.ts`): `getUserId(request)` currently reads an
  `x-user-id` header and falls back to a dev user, so every route is testable
  before Clerk. Step 6 swaps the body for Clerk's `auth()` — handlers don't
  change.
- **`getRecentChecks`** (`src/lib/checks.ts`): newest-first by querying the
  check-result partition backwards (ISO timestamps sort lexicographically), so
  no GSI is needed. Used by `GET /[id]`.
- **Tests** mock the data layer and call the handlers directly, asserting status
  codes for the happy path, validation failures, the limit, and not-found.

## Step 3 — Checker Lambda (`feature/checker-lambda`)

- **`infrastructure/lambda/checker.ts`** is the EventBridge entry point: list
  active monitors, probe each URL, write a `CheckResult`, then open/close an
  incident on a state change. Monitors run via `Promise.allSettled` so one bad
  URL can't fail the whole batch.
- **`probeUrl`**: native `fetch` with a 10s `AbortSignal.timeout`. 2xx/3xx = up.
  Redirects are **not** followed (`redirect: "manual"`) — this keeps 3xx as "up"
  and stops a redirect from reaching an address the URL validation already
  blocked (SSRF defence-in-depth). Timeouts/network errors record `isUp: false`
  with a null status code and an error string.
- **Incident logic is a pure function** (`incident-logic.ts`,
  `decideIncidentTransition`) with no IO, so the up->down / down->up transitions
  are unit-tested directly. The Lambda just wires it to DynamoDB reads/writes.
  `closeIncident` uses a conditional write (`attribute_not_exists(resolvedAt)`)
  to avoid double-closing.
- **Sparse GSI for active monitors** (`GSI1`, keys `GSI1PK/GSI1SK`): only active
  monitors carry the index keys, so the checker lists them with one `Query`
  instead of scanning a table that will be dominated by check results. Pausing a
  monitor removes the keys, dropping it from the index. `createMonitor` /
  `setMonitorActive` maintain these keys. **Step 5 (CDK) must declare GSI1**, and
  the Lambda bundler needs tsconfig path aliases (`@/*`) enabled in esbuild.
- Local end-to-end run (writes + incident open/close against a real table) is
  deferred to after the Step 5 deploy / DynamoDB Local; the pure logic and
  `probeUrl` are covered by unit tests now.

## Step 4 — Alerting (`feature/alerting`)

- **Alert only on the up->down edge.** The checker enqueues an SQS message when
  it *opens* an incident — never on every failing check — so one outage means
  one email, not one per minute.
- **Shared message contract** (`infrastructure/lambda/queue.ts`): a Zod schema
  both the producer (checker) and consumer (alert lambda) validate against, so
  malformed messages fail at the boundary.
- **Partial batch failures** (`alert.ts`): the consumer returns
  `batchItemFailures`, so in a batch of 10 only the failed sends are retried.
  After `maxReceiveCount` retries SQS moves a message to the DLQ. Messages that
  fail *validation* are also marked failed on purpose — poison messages land in
  the DLQ where they're visible instead of being silently dropped.
- **Enqueue is best-effort** in the checker: a queue hiccup logs an error but
  never fails the check — the incident row is already written either way.
- **Per-monitor `alertEmail`** (optional, Zod-validated) with an
  `ALERT_FALLBACK_EMAIL` env fallback in the consumer. Step 6 will default it
  to the signed-in user's email at creation time.
- The Resend SDK reports failures via a returned `error` field rather than
  throwing; the consumer converts that into an exception so the SQS retry/DLQ
  path actually engages.

## Step 5 — CDK infrastructure (`feature/cdk-infra`)

- **One stack** (`infrastructure/lib/uptime-service-stack.ts`), CDK app under
  `infrastructure/` with its own `cdk.json` (runs via `tsx`); `npm run synth` /
  `npm run deploy` from the repo root. Region pinned to ap-southeast-2.
- **DynamoDB on-demand**: traffic is one checker run per minute — provisioned
  capacity would be guesswork. GSI1 declared to match the sparse active-monitor
  index from Step 3. `RemovalPolicy.DESTROY` for painless demo teardown
  (production would RETAIN + PITR).
- **Lambdas as `NodejsFunction`** (esbuild bundling, `tsconfig` passed so the
  `@/*` alias resolves): Node 22 on ARM64 (cheaper per ms), 256MB. Checker
  timeout 30s (10s-capped probes run concurrently); alert 15s. Explicit
  `LogGroup`s with 7-day retention (avoids the deprecated `logRetention`
  custom resource).
- **Queue numbers**: visibility timeout 90s (≥6x consumer timeout per SQS
  guidance), DLQ after 3 receives, 14-day DLQ retention.
- **Least privilege**: checker gets table read/write + queue send; alert
  lambda only receives from the queue via the event source. Nothing else.
- **Assertion tests** on the synthesized template (table + GSI, 1-minute rule,
  redrive policy, partial-batch flag, exactly two lambdas, log retention) —
  they run in the normal vitest suite and catch config drift.
- Resend secrets go in as deploy-time env passthrough; noted Secrets Manager
  as the production-grade alternative.

## Step 6 — Auth with Clerk (`feature/auth`)

- **`src/proxy.ts`** (Next 16's middleware convention) runs `clerkMiddleware`:
  everything is protected except `/`, `/sign-in` and `/status/*` (the public
  status pages). Page visits redirect to sign-in; API calls get 401.
- **The Step 2 auth seam paid off**: `getUserId()` swapped its body from the
  dev header stub to Clerk's `auth()` — route handlers only gained a null
  check (401). Handlers are defence-in-depth behind the middleware.
- **Monitors are bound to the Clerk userId** (the table's `USER#<id>` PK), so
  users can only ever query their own partition — isolation comes from the key
  design, not filtering.
- **Alert email defaulting**: on create, if the user didn't specify
  `alertEmail`, the route fills it from the Clerk account's primary email —
  downtime alerts work with zero configuration.
- Tests mock `@/lib/auth` and assert 401s on every route when unauthenticated.
- Keys live in `.env.local` (see `.env.example`); `next build`/`next dev` need
  them, typecheck and tests do not.

## Step 7 — Dashboard (`feature/dashboard`)

- **Server components read, API routes write.** List and detail pages are
  server components that call the data layer directly (no self-fetch hop);
  mutations (create/pause/delete) go through the existing API routes from
  client components, then `router.refresh()` re-renders the server data.
- **One schema, both sides**: the add-monitor form validates with the same
  `createMonitorSchema` the API uses — client and server can't disagree about
  what a valid monitor is. Server responses (403 limit, Zod issues) surface in
  the form as a fallback.
- **Uptime/duration/relative-time helpers** live in `src/lib/stats.ts` as pure
  functions with unit tests; `computeUptimePercent` returns null (rendered "—")
  when a monitor has no checks in the window, rather than a misleading 100%.
- **Chart**: recharts line of the last 24h of response times; failed checks map
  to `null` so downtime renders as visible gaps instead of fake zeros.
- **Incident ordering** happens in memory (incident ids are random, not
  time-sortable) — counts per monitor are tiny, so a sort beats redesigning
  keys.
- Clerk v7 dropped `SignedIn`/`SignedOut`; the layout reads `auth()` server-side
  and branches on `userId`, which also keeps the header out of the client
  bundle.
