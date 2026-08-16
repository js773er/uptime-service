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

## Step 8 — Public status page (`feature/status-page`)

- **`/status/[id]` is public** (allow-listed in the proxy middleware) and
  read-only: current state banner, 24h uptime, recent incidents with durations.
- **New GSI2 (monitor by id)**: the public URL carries only a monitorId, but
  the base-table key is `USER#<userId>` — so monitors also carry
  `GSI2PK = MONITOR#<id>` for an id-only lookup. Added to both the data layer
  and the CDK stack in the same branch (an unguessable UUID in the URL is the
  access model, same as most status/share links).
- **The page shows the monitor's name but never its URL** — visitors see
  whether the service is healthy without learning which endpoint is probed.
- Checks and incidents were already keyed by `MONITOR#<id>`, so those queries
  needed no changes — only the monitor lookup did.

## Step 9 — Polish (`feature/polish`)

- **README** rewritten: mermaid architecture diagram, data model table, local
  setup, env-var reference, deploy steps (CDK bootstrap + deploy, Vercel,
  billing budget), and a short tech-rationale section pointing here.
- **CI** (GitHub Actions): lint, typecheck, tests and `cdk synth` on every PR
  and on pushes to `dev`/`main` — synth in CI means broken infra code can't
  merge, not just broken app code.
- Deployment itself is a credentialed action done from a local machine (CDK)
  and the Vercel dashboard; the README documents both paths. The $10 AWS
  budget is a console step — CloudFormation budget resources are only
  supported in us-east-1, so documenting beat adding a second-region stack.

## Hardening pass (`feature/hardening`) — post-review fixes

A full-codebase review before deploy surfaced real bugs; fixed in one branch:

- **URL validation bug**: the IPv6 private-prefix checks ran against *domain
  names* too, so `fda.gov` / `fcbarcelona.com` were rejected. IP checks now
  live in one exported `isBlockedIpAddress()` and only apply to hosts
  containing `:` (IPv6 literals), plus IPv4-mapped-IPv6 handling in both
  dotted and hex spellings (URL parsers canonicalize `::ffff:10.0.0.1` to
  `::ffff:a00:1`).
- **DNS rebinding defence**: validation happens at create time but DNS can
  change afterwards, so the checker now re-resolves the hostname before every
  probe and refuses to fetch anything that resolves to a private/reserved
  address — same blocklist, both layers.
- **Race-proof incidents (redesign)**: the open incident now lives at a fixed
  key (`INCIDENT#OPEN`). Opening is a conditional put — two overlapping
  checker runs can't both open one (the loser skips the alert), which kills
  both duplicate emails and the "stuck open incident suppresses all future
  alerts" failure. Closing atomically moves it into a time-ordered history key
  (`INCIDENT#<startedAt>#<id>`) via a transaction. Side benefits: reading the
  open incident is a single GetItem (was: query the whole incident history
  with a filter — which could even *miss* the open incident past 1MB), and
  history queries are DB-ordered with a `Limit` instead of sort-in-memory.
- **Atomic monitor cap**: the 5-monitor limit moved from a read-then-write
  count in the route (racy) into the data layer — a per-user counter item
  updated in the same transaction as the monitor put, with a condition that
  makes the cap impossible to exceed. The route just maps `MonitorLimitError`
  to 403; the dashboard imports the same constant.
- **Data lifecycle**: check results now carry a 30-day TTL (`expiresAt` +
  `timeToLiveAttribute` on the table) so minutely history stops growing
  forever and deleted monitors' checks clean themselves up. Deleting a monitor
  is now a transaction: item + counter + any open incident (no more
  permanently-"ongoing" incidents for deleted monitors).
- **Alert config bugs**: the CDK stack injects unset deploy-time vars as `""`,
  which is not nullish — the alert lambda's `??` fallbacks could never fire.
  Switched to `||`, and `bin/app.ts` now loads the repo-root `.env.local` at
  synth time (shell exports still win), so `npm run deploy` actually picks up
  the Resend keys the docs promised it would.
- **Status page caching**: `/status/[id]` is public, and `force-dynamic` meant
  every anonymous hit was a DynamoDB read. Now ISR (`revalidate = 60` —
  checks only change once a minute). This required moving header auth from a
  server-side `auth()` in the root layout (which forces *every* route dynamic)
  into a client `useUser()` component.
- **UI robustness**: the add form and row actions now surface non-OK responses
  and network failures instead of silently swallowing them.
- **Dedup**: one `monitorKey()` builder (was defined 3×), shared
  `CHECKS_FOR_24H`/`DAY_MS` constants (3×), one `monitorState()` state machine
  for dashboard + status page (2×), one `formatIncidentCause()` for email +
  UI (2×), and a `serviceLambda()` factory in the stack. `engines: node>=20.9`
  pins the runtime family.

## AI features (`feature/ai-analysis`)

Two features, both chosen because a language model does something rules can't —
not to have AI in the project.

### Semantic content checking

- **The problem**: a status code only proves the server answered. A deploy that
  breaks the checkout button still returns 200, and uptime tools call that
  healthy. Keyword checks don't solve it either — they require knowing which
  string to look for, and nobody predicts the wording of a failure they haven't
  had yet.
- **The approach**: when a monitor opts in, the checker reads the body, strips
  markup, and asks the model whether the page looks like a working product page
  or an error/maintenance/empty one. A "not healthy" verdict overrides the HTTP
  verdict and opens an incident, because from the user's side the site is down.
- **Why this is the right use of an LLM**: the failure space is open-ended
  (stack traces, "be right back", blank shells, rate-limit pages) but "this
  looks wrong" is obvious to a human. That's a semantic judgment, which is
  exactly what rules can't express and a model can.
- **Cost control is the real design work.** Analysing every check would be
  ~43,000 model calls per monitor per month. Instead: only when the page is
  HTTP-healthy (a 500 is already known-down), only when a content hash shows
  the page actually changed, and at most once an hour per monitor. The steady
  state — an unchanged page — costs nothing. The policy lives in a pure
  `shouldAnalyze()` function so it's unit-tested without touching the API.
- The throttle state (`contentHash`, `contentAnalyzedAt`) lives on the monitor
  item, which the checker already has in memory from its work-list query — so
  reading it is free, and it's only written when an analysis actually runs.

### Alert correlation

- **The problem**: five services failing at once produces five emails, and the
  reader has to work out at 3am that they share one cause. That's how people
  learn to ignore alert channels. Paging tools call the fix alert correlation.
- **The approach**: the SQS consumer groups a batch by recipient and, when a
  recipient has 2+ incidents, asks the model what they have in common — same
  domain, same provider, same status code, same timing — and sends **one**
  email leading with that. Added a 20s `maxBatchingWindow` so incidents from
  one checker run actually arrive in the same batch; that's well inside the
  1-minute check interval, so alerting stays sub-minute.
- **Grouped by recipient before correlating**, so one tenant's monitors can
  never appear in another tenant's email.
- Failure of the combined send fails *every* message in that group, so they
  retry together rather than some incidents silently vanishing.

### Cross-cutting decisions

- **Both features degrade to nothing.** No API key, a failed call, a malformed
  reply, a refusal — every path returns null and the system falls back to the
  plain HTTP verdict and one-email-per-incident. A monitoring product must not
  stop monitoring because a third-party API is down.
- **The model output is validated with Zod**, exactly like the SQS message
  contract and the API request bodies. The API constrains the shape via
  structured outputs; Zod is still the boundary check, because an LLM is an
  external service like any other.
- **Where I deliberately did *not* use a model**: up/down is decided by the
  status code, because that's a deterministic answer and a model would be
  slower, costlier, and less predictable. Same reasoning for the incident state
  machine — it stays a pure function.
- Model is `claude-opus-5`, overridable via `ANTHROPIC_MODEL` without a code
  change, so cost/latency can be tuned by config.

### Four bugs found reviewing the feature before it went live

Worth knowing in detail — the first two made the feature actively worse than
not having it, and both passed the original test suite.

1. **The incident state machine read the raw HTTP verdict.** `CheckResult`
   recorded `isUp: false` for a broken page, but `decideIncidentTransition`
   was still passed `probe.isUp`, so no incident ever opened and no alert was
   ever sent. The feature detected outages and then silently discarded them.
2. **The verdict evaporated after one check.** It was stored per-check but not
   on the monitor, so the next check — throttled, no fresh verdict — fell back
   to the HTTP result and closed the incident 60 seconds after opening it.
   And because the hash comparison sits *before* the throttle, an unchanged
   broken page was never re-analysed: one minute of alarm, then silence while
   the site stayed down. Fixed by storing the verdict next to the hash it
   belongs to and carrying it forward while the content is unchanged.
3. **Content incidents reported "HTTP 200".** The incident and alert were
   built from `probe.statusCode`/`probe.error`, so the email read
   `[DOWN] Shop (HTTP 200)` and dropped the actual reason. Content failures
   now report `statusCode: null` and the model's explanation.
4. **The body read was unbounded and untyped.** `response.text()` pulled an
   entire response into a 256MB Lambda with no cap and no content-type check —
   one monitor pointed at a large file would exhaust memory and take every
   other monitor in that invocation down with it. Now capped at 512KB,
   streamed, cancelled early, and restricted to textual content types.

The lesson worth repeating out loud: every one of these was a **seam** bug —
each individual function was correct, and the defects lived in what got passed
between them. That is exactly what unit tests with mocked neighbours are worst
at catching, which is what pushed me to add the integration suite below.

## Integration tests (`feature/ai-analysis`)

- **Why**: the 90 unit tests all mock the data layer, so the parts I was most
  confident about — the conditional write on `INCIDENT#OPEN`, the transactional
  monitor cap — had never actually run against DynamoDB. "I reasoned about it"
  is not the same as "it works."
- **Setup**: DynamoDB Local as a Java process (no Docker needed), launched from
  a vitest `globalSetup`. Separate config and `npm run test:integration`, so
  the unit suite stays fast and dependency-free. `DYNAMODB_ENDPOINT` on the
  shared client points it at localhost; unset everywhere else.
- **What they prove**, none of which a mock can: five concurrent `openIncident`
  calls yield exactly one winner; four concurrent creates against the last free
  slot yield exactly one monitor; `closeIncident` is idempotent on retry;
  pausing removes a monitor from GSI1 rather than filtering it after the read;
  deleting frees a counter slot; one user's `getMonitorById` can't reach
  another's partition.
- **I checked the tests can fail.** Deleting the `ConditionExpression` from
  `openIncident` makes the race test report 5 winners instead of 1. A test that
  has never failed isn't evidence of anything.
- The table schema in `local-table.ts` is maintained by hand against the CDK
  stack. That duplication is the weak point — an index added in one and not the
  other would give green tests against a schema production doesn't have.

## Self-monitoring (`feature/ai-analysis`)

A monitoring product with no monitoring of its own is a bad look, and more to
the point I had no way to know if the checker died.

- Six CloudWatch alarms on an SNS topic: checker errors, checker p95 duration
  approaching the 30s timeout, alert-consumer errors, DLQ depth, alert queue
  backlog, and — the important one — **checker invocations dropping toward
  zero**.
- That last alarm is the only one that catches the failure mode that matters
  most. If EventBridge stops delivering, nothing throws, nothing retries, and
  every monitor silently stops being checked. It's set to `breaching` on
  missing data, because "no data" is exactly the symptom.
- This still doesn't cover the whole system: alarms run in the same AWS
  account, so a regional problem takes out the watcher and the watched
  together. The real fix is an external heartbeat (dead man's switch) —
  documented as a known limitation rather than pretended away.
