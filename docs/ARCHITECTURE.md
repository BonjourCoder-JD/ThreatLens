# ThreatLens — Architecture

Living document. Updated at the end of each build day. Last updated: **Day 2**.

## What this app is

ThreatLens is a collaborative tool for analysts to investigate synthetic
authentication logs. It has two anomaly-detection layers on purpose:

1. **Live, explainable statistics** (Day 2) — rule-based scoring (burst
   detection, impossible travel, new device) computed in TypeScript, inside
   the app, on every event. An analyst can always see *why* something was
   flagged.
2. **Offline Isolation Forest ML** (Day 3) — a `scikit-learn` model trained
   **outside** the app, once, against an exported copy of the same dataset.
   Its scores are imported as a one-time enrichment, never computed live.

That split isn't a workaround — it's the honest answer to "where does ML run
on Cloudflare Workers?" It doesn't; Workers can't run Python/scikit-learn.
Point this out proactively in the interview; it reads as architectural
judgment, not a gap.

## Why DeepSpace fits this app

Everything below is implemented with **documented** DeepSpace SDK surfaces
only — no invented APIs, no second backend:

| Need                              | DeepSpace mechanism                                   |
| --------------------------------- | ------------------------------------------------------ |
| Auth, roles                       | `DeepSpaceAuthProvider`, `<AuthGate>`, `useAuth`        |
| Persistent, schema'd data         | `RecordRoom` collections (`src/schemas/`)               |
| RBAC on that data                 | Per-collection `permissions` block (server-enforced)    |
| Real-time sync across analysts    | `useQuery`/`useMutations` WebSocket fan-out             |
| Bulk, long-running data ops       | `JobRoom` background jobs (`src/jobs.ts`)                |
| Orchestration bypassing user RBAC | Server actions (`src/actions/`, Day 3)                   |
| "Who's looking at this case"      | `usePresence` (Day 3/4, deliberately last)               |

## Data model

Four collections, all defined in `src/schemas/` and registered in
`src/schemas.ts`:

- **`users`** — scaffold-required, untouched.
- **`authEvents`** — one row per synthetic log entry. System-written only
  (client `create`/`update` are `false` for every role); analysts have
  read-only access. See "Synthetic data pipeline" below for how rows get in.
- **`cases`** (Day 3) — an investigation opened against one or more flagged
  events. Every analyst can read and edit every case — this is a small team
  working one shared queue, not a multi-tenant product, so there's no
  per-case collaborator list.
- **`caseNotes`** (Day 3) — the comment timeline on a case.

Full column lists and the RBAC rationale for each are in
`docs/CODE_WALKTHROUGH.md` under "Collection schemas."

## Auth model: deliberately still "Mixed," not "Fully gated"

The scaffold ships three documented auth models (Mixed / Fully gated /
Fully public). I kept **Mixed** rather than switching to Fully gated. This
was a conscious tradeoff, not an oversight — be ready to explain it:

- The sensitive collections (`authEvents`, `cases`, `caseNotes`) already deny
  `'*'` (anonymous) and `viewer` at the **schema permissions** level. An
  anonymous visitor hitting `/admin` or any gated page gets nothing from the
  record room regardless of what the page renders — the RBAC check happens
  in the Durable Object, before data reaches the WebSocket.
- Gated pages (`/admin`, `/settings`, future `/cases`) still sit under the
  existing `src/pages/(app)/(protected)/` group, which already wraps them in
  `<AuthGate>`.
- Switching the *whole app* to Fully gated would also require hardening
  `wsRoute` in `src/server/realtime-routes.ts` to reject tokenless
  connections — a real security-relevant edit — for no additional protection
  on the collections that actually matter, since they're already closed to
  anonymous/viewer roles.

Net effect: public landing page stays public (and the existing smoke tests
that assert that keep passing), investigation data stays genuinely private,
and one less structural change was made than necessary. If asked "why not
fully gate it," this is the answer — not "I didn't think of it."

## Synthetic data pipeline (Day 1)

One canonical generator, not two. This directly satisfies the approved
requirement to avoid maintaining parallel TypeScript/Python generators:

```
scripts/generate-dataset.mjs  (run once, by hand, offline)
        │
        ▼
src/data/synthetic-auth-events.json   ← committed to the repo
        │                                    │
        ▼                                    ▼
src/jobs.ts: import-synthetic-events    Day 3: isolation_forest.py reads
  (background job, admin-only,            the SAME file for features/
   upserts into `authEvents`)             training — no second generator
```

Key properties, and why each one exists:

- **Deterministic.** A seeded PRNG (`mulberry32`) means `(count, seed)`
  always produces byte-identical output. This is what makes growing the
  dataset later ("start with 1,000, scale up without redesign") safe: bump
  `count`, keep the seed, rerun — events `0..999` are untouched, only new
  ones are appended.
- **Idempotent import.** The dataset's `eventId` (e.g. `evt_000042`) is
  passed as the DeepSpace `recordId` when importing. The SDK's
  `tools.create(collection, data, recordId)` upserts (merges) when that id
  already exists instead of inserting a duplicate — so re-running the import
  job, including after a redeploy, never duplicates a row or leaves
  inconsistent scores. This is the SDK's own documented mechanism, not
  something built on top of it.
- **ML-ready.** Every field the Day-3 Isolation Forest will engineer
  features from (`timestamp`, `actorId`, `country`/`city`, `device`,
  `eventType`, `success`) is already in the one JSON file, plus a
  `groundTruthAnomaly`/`groundTruthReason` pair injected by the generator for
  the eventual precision/recall evaluation — see "Ground truth" below.

## Ground truth and the evaluation report (Day 3/4, scaffolded now)

The generator injects three known anomaly patterns (`impossible_travel`,
`brute_force_burst`, `new_device_odd_hour`) at a **realistic ~4-5% rate** —
not 10%, and very much not the 29% an early version of the generator
accidentally produced (see `docs/DEBUGGING_LOG.md`). Each injected event
carries `groundTruthAnomaly: 1` and a reason string.

This label exists **only** to let the Day-3/4 evaluation report compute real
precision/recall for both detectors against a known answer. It is a property
of the synthetic dataset, not a verdict on a real event, and the plan is to
never show it to analysts as if it were one — the main dashboard will not
render "ground truth: true." Reporting it as if it were an independent,
trustworthy label would be the "misleading metrics" the brief explicitly
asked to avoid, since the detectors and the label come from the same
author's assumptions about what an anomaly looks like.

## Admin-only enforcement (server-side, not UI-only)

Every current job type (`import-synthetic-events`, and the Day 2/3
`recompute-stat-scores` / `import-ml-scores`) is an administrative operation.
`worker.ts`'s `AppJobRoom` sets:

```ts
authorizeWrite: async (user) => {
  if (user.userId.startsWith('anon-')) return false
  const role = await resolveAppRole(env, user.userId)
  return role === 'admin'
}
```

This runs **in the Durable Object**, re-checked on every `enqueue` /
`cancel` / `retry` — not just once at connect. `src/pages/.../admin.tsx`
also hides the button from non-admins, but that's UX; the real boundary is
this callback. `tests/smoke.spec.ts` ("non-admin analyst sees 'Admins only'")
proves the UI half with a real signed-in non-admin session. The DO-level
rejection itself still needs a direct test once there's an HTTP or WS surface
worth asserting against — see `docs/CODE_WALKTHROUGH.md` for why that wasn't
forced into Day 1.

## Day 2: the statistical detection engine and dashboard

The live, explainable detector promised in "Why DeepSpace fits this app" is
now real. Three pieces:

1. **`src/lib/anomaly-detection.ts`** — pure, dependency-free TypeScript.
   Three named rules (failed-login burst, impossible travel, new device),
   each contributing a fixed weight to `statAnomalyScore`, each producing a
   human-readable string in `statReasons`. No DB, no network, no
   randomness — same input always produces the same output, which is what
   makes it unit-testable without a Durable Object and what makes "why was
   this flagged" answerable by printing `statReasons` back verbatim.
2. **`src/jobs.ts`'s `recompute-stat-scores` job** — the only thing that
   writes these fields. Queries every `authEvents` row, calls
   `computeStatScores`, patches each row's `statAnomalyScore`/`statReasons`.
   Admin-gated through the same `AppJobRoom.authorizeWrite` as the import
   job. Recomputing is idempotent by construction (pure function in, pure
   function out) — there's nothing to duplicate, only existing rows to
   patch.
3. **`/dashboard`** — reads `authEvents` live via `useQuery`, filters and
   sorts client-side (event type, flagged-only, actor search, sort by
   time/score), shows an alert summary (total/flagged/per-rule counts), and
   a click-through detail view listing the exact matched reasons for one
   event. It computes nothing — all it does is render what the job already
   wrote.

**Why client-side filtering, not `where` queries.** DeepSpace's `where`
clause is equality-only (per the records reference) — there's no "score >
0.5" query. At this data scale (≤ a few thousand rows) fetching everything
once and filtering/sorting in React with `useMemo` is simpler and perfectly
adequate; a `where`-based filter would need either a derived boolean column
(e.g. `isFlagged`) or server-side filtering logic that doesn't exist yet.
Documented as a scaling boundary, not a premature optimization.

**Why `/dashboard` is NOT admin-gated.** Every analyst needs to investigate,
not just admins — `src/nav.ts` has no `roles` restriction on it, unlike
`/admin`. The data underneath (`authEvents`) is still closed to anonymous
visitors at the schema level (`'*': { read: false }`), so this doesn't
widen who can see the data, only confirms every signed-in `member` can.

**Owner-verified (Day 2, post-report): the admin happy path actually
works.** The user personally signed in with the real owner account and ran
the checks this document previously left open:

- Import synthetic events, twice in a row: both succeeded, 1,000 imported
  each time, **final count stayed at exactly 1,000** — the upsert-by-
  `eventId` idempotency claim holds against a real second run, not just
  against unit tests.
- Recompute statistical scores: succeeded, **48 of 1,000 events flagged.**

Full detail in `docs/DEBUGGING_LOG.md`. **Still open:** the dashboard UI
itself has not yet been verified against this real, now-populated data by
the user — that check is explicitly reserved for them and is not claimed
complete here. For what it's worth: while self-checking the Day 2 UI
redesign below, I (the agent) took screenshots signed in as a non-admin
test account and incidentally observed the dashboard rendering correctly
against this same real data (1,000 events, 48 flagged, 16/16/17 per-rule
counts — matching what the user reported). That's a good sign, and it's
how a real chart rendering bug was caught and fixed (see
`docs/DEBUGGING_LOG.md`), but it is an agent observation, not the user's
own verification, and isn't a substitute for it.

## Day 2 (continued): the royal-blue design system

The app's visual design is implemented entirely through DeepSpace's
sanctioned theming mechanism — a new `[data-theme="threatlens"]` block in
`src/themes.css` (registered in `src/themes.ts`, activated via
`<html data-theme="threatlens">` in `index.html`) — not ad-hoc hex values
scattered through components. Every color is a CSS custom property
(`--color-background`, `--color-primary`, `--color-shell`, etc.); components
reference the generated Tailwind utilities (`bg-card`, `text-primary`,
`bg-shell`) so the whole app re-themes from one file.

- **`--color-shell`/`--color-shell-panel`** (royal blue / white) drive the
  sidebar chrome vs. the main content panel — this is the SDK's own
  documented mechanism for "the area behind a multi-panel layout" vs. "the
  raised surface a page renders into," not a new concept introduced for
  this palette.
- **`src/components/Navigation.tsx`** was restructured from a horizontal
  top bar into a vertical sidebar (collapsing to a mobile top bar + drawer
  below the `md` breakpoint). Every `data-testid` the existing Playwright
  suite depends on (`app-navigation`, `nav-sign-in-button`, `nav-user-name`,
  `nav-user-email`, the `Account menu` accessible name) is unchanged — only
  the layout changed, not the contract, and the full suite still passes.
- **`src/components/ui/StatCard.tsx`** and **`src/components/charts.tsx`**
  (`ActivityChart`, `RuleDistributionChart`) are new, shared, reusable
  components — used by both the dashboard and the admin page, per the
  "shared design tokens and reusable components" requirement. The charts
  are plain CSS/flex, not a new charting dependency — justified in
  `docs/CODE_WALKTHROUGH.md`.
- **No chart or stat value is invented.** Every number on the dashboard and
  in both charts is derived from the same `authEvents` records the table
  below renders — there is no separate "demo data" path.

## Known risks / limitations (living list)

- **Worker bundle size.** The committed dataset JSON is bundled into the
  Worker. At 1,000 events it's ~370KB raw (~480KB gzip for the whole worker
  bundle). Growing the dataset 10-50x should be re-checked against Cloudflare
  Workers' bundle size limits before assuming "just bump count" scales
  indefinitely.
- **Sequential bulk writes.** The import job writes one record at a time
  (no bulk-insert API is exposed by the SDK). Fine at 1,000 rows; at much
  larger counts this would need chunked/parallel writes or a different
  strategy — a known, documented tradeoff, not an oversight.
- **Vitest unit-test runner needed a sandbox-specific pool setting**
  (`pool: 'vmThreads'` in `vitest.config.ts`) — the default pool spawns real
  OS worker threads/processes for test isolation, which didn't complete
  their handshake in this dev container. Fixed Day 2; see
  `docs/DEBUGGING_LOG.md` for the full investigation. One pre-existing,
  unrelated test (`src/prerender-entry.test.tsx`) now fails for a genuine
  reason (likely two React instances under `vmThreads`) that was previously
  masked — left open, not silently patched over.
