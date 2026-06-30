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
