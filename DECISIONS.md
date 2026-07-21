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
