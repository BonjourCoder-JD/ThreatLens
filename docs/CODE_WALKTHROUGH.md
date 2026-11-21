# ThreatLens — Code Walkthrough

Living document, one section per major feature, added as it's built. Written
for a CS senior comfortable with programming fundamentals but newer to
full-stack / Durable Object-style backends — jargon is defined inline.

---

## Feature: Shared RBAC-bypass record access (`src/server/record-tools.ts`)

### What it does and why it exists

DeepSpace enforces per-record permissions ("RBAC": role-based access
control) inside the Durable Object that owns the data. That's correct for
normal user traffic, but **system code** — a background job importing 1,000
rows, a server action orchestrating two collections — needs to write data
the calling user couldn't write themselves. The SDK's answer is a special
HTTP header, `X-App-Action: true`, that tells the Durable Object "trust this
caller completely; they're the app itself."

The scaffold's `src/server/action-routes.ts` already builds a small client
(`ActionTools`) that sets this header for server actions. I extracted it
into its own module so `src/jobs.ts` could use the **exact same**
implementation instead of a second, subtly-different copy.

### Files, functions, data structures

- `src/server/record-tools.ts` — `createActionTools(env, userId, callerJwt)`
  returns an `ActionTools` object: `{ create, update, remove, deleteWhere,
  get, query, integration, registerUser }`.
- `src/server/action-routes.ts` — now just imports it.
- `src/jobs.ts` — imports it too, calling
  `createActionTools(env, env.OWNER_USER_ID, '')` (jobs run as the app
  owner; they have no caller JWT to forward).

### Data flow

```
runJob(job, ctx, env)
  → createActionTools(env, OWNER_USER_ID, '')
    → tools.create('authEvents', data, eventId)
      → fetch('https://internal/api/tools/execute',
               headers: { X-User-Id, X-App-Action: 'true' })
        → AppRecordRoom Durable Object (RBAC bypassed, row written)
```

### Design decisions & tradeoffs

- **Extraction, not duplication.** The alternative was copy-pasting the
  fetch-to-the-DO logic into `jobs.ts`. That would work today but silently
  diverge the moment one side got a bug fix the other didn't.
- **`callerJwt` is an empty string for jobs.** `ActionTools.integration(...)`
  needs a caller JWT for "the user pays" billing; jobs have no user in the
  loop, so if a job ever needs an integration call, it must be owner-billed
  — passing `''` makes that explicit rather than silently wrong.

### DeepSpace SDK capabilities used

- `apiWorkerFetch`, `lookupOwn`, `normalizeApiError`, `splitIntegrationEndpoint`
  from `deepspace/worker` (the same ones the scaffold already imported).
- The `X-App-Action` / `X-User-Id` internal header contract, documented in
  `action-routes.ts`'s own header comment and the Server Actions guide.

### Likely bugs & how to diagnose them

- **Symptom: a job's write silently does nothing.** Check
  `result.success` — every `tools.*` call returns `{ success, data }` or
  `{ success: false, error }`; it never throws on a normal RBAC/validation
  failure. The import job logs up to 10 errors into its result — read
  `job.result.errors` via `useJobs`.
- **Symptom: "Cannot find module '../../worker.js'" type error.** This file
  sits at `src/server/record-tools.ts`, two levels under the repo root, so
  `Env` is imported as `'../../worker.js'`. A file moved to a different
  depth needs the relative path updated — this is the single most common
  mistake when adding a new `src/server/*.ts` file.

### Interview questions you might get, and good answers

- **"Why does a background job need its own way to write records — doesn't
  the SDK give you that?"** → No: `JobContext` only gives you `progress`,
  `continue`, and `signal`. Record access for system code is something the
  *app* builds, following the scaffold's own `action-routes.ts` pattern — I
  checked the SDK's type definitions (`worker.d.ts`) to confirm there's no
  built-in factory before writing one.
- **"What stops a malicious client from sending `X-App-Action: true`
  themselves?"** → That header is only honored because it arrives on an
  internal `fetch()` call the Worker makes to its own Durable Object — a
  browser's request never reaches that code path with headers the Worker
  didn't set itself. (Good follow-up to ask yourself: trace the actual
  request path in `action-routes.ts` to confirm this before stating it with
  confidence live.)

### Practice exercise

Add a `tools.count(collection, where?)` convenience wrapper to
`ActionTools`... except it isn't part of the real SDK type. Instead: write a
tiny helper function *next to* `createActionTools` (not inside it) that
calls `tools.query(collection, { where, limit: 1 })` and returns
`result.data?.count` — note that `QueryActionData.count` is already provided
by the SDK's query result. Call it from `admin.tsx` to show the authEvents
total without pulling 2,000 full records into the browser.

### Verifying the modification

Run `npm run type-check` (catches any typo in the `ActionTools` shape
immediately — it's a real SDK type, not `any`), then `npx deepspace test run
smoke --port=5273` and confirm the admin page still shows a correct count.

---

## Feature: Collection schemas — `authEvents`, `cases`, `caseNotes`

### What it does and why it exists

Defines the three app-specific tables and their permissions. All three are
locked in during Day 1, even though `cases`/`caseNotes` aren't built until
Day 3 — DeepSpace schemas are **baked into the Worker at deploy time**
("Schemas are baked in at deploy time — there is no runtime schema
registry," per the SDK docs), so changing one later means a redeploy and
(for anything beyond adding a column) a migration plan. Deciding the shape
once, before real data exists in any of them, avoids that entirely.

### Files, functions, data structures

- `src/schemas/auth-events-schema.ts`, `cases-schema.ts`,
  `case-notes-schema.ts` — each exports one `CollectionSchema` object:
  `{ name, columns, permissions }`.
- `src/schemas.ts` — the single array every other file imports.

### Data flow

`src/schemas.ts` is imported in exactly two places: `worker.ts` (so
`AppRecordRoom` knows the tables exist and enforces their RBAC) and
`src/pages/(app)/_layout.tsx` (so the browser's `<RecordScope>` knows how to
decode columns, e.g. which ones are JSON-encoded).

### Design decisions & tradeoffs

- **`authEvents` denies all client writes, for every role including
  `admin`.** `create`/`update`/`delete` are `false` everywhere in the
  permissions block. Rows only ever get written by the `X-App-Action`
  path (jobs), which bypasses this block entirely. This is deliberate: the
  log is a *system of record*, not something anyone hand-edits, and setting
  `admin: { update: true }` here would invite exactly that temptation later.
- **`cases`/`caseNotes` use flat `member`-wide visibility, not
  `'shared'`/`collaboratorsField`.** DeepSpace supports per-case
  collaborator lists for apps that need private, members-only-by-invitation
  documents. ThreatLens is one small analyst team working one shared queue
  — every analyst should see every case. Using `'shared'` here would be
  unnecessary complexity for a requirement that doesn't exist.
- **Removed the scaffold's `settings` collection.** It was an unused
  admin-only key/value store with nothing in this app depending on it. Kept
  removing it narrow — it's not one of the four "core features" protected by
  the approved plan (dashboard, stats, ML, collaboration); it's scaffold
  boilerplate.

### DeepSpace SDK capabilities used

- `CollectionSchema`, `PermissionLevel`, `ColumnInterpretation` types from
  `deepspace/schema`.
- The `'*'` wildcard role (anonymous), explicit `viewer: false` (this app has
  no real "public, read-only" audience), `'own'` ownership default
  (`createdBy`), and the `{ kind: 'json' }` / `{ kind: 'reference' }` /
  `{ kind: 'select' }` column interpretations.

### Likely bugs & how to diagnose them

- **Symptom: a query for `authEvents` returns an empty array even for an
  admin.** Check the role actually resolved for that session —
  `useUsers().users.find(u => u.id === userId)?.role` — before assuming the
  schema is wrong. The permissions guide's own debugging checklist
  (role → rule → envelope → `'*'` fallback) is the right order to check.
- **Symptom: `record.data.statReasons` throws when you `JSON.parse` it.**
  Columns with `{ kind: 'json' }` arrive **already parsed** — calling
  `JSON.parse` on an already-parsed array throws. This is explicitly called
  out in the SDK docs and is an easy mistake to repeat later in `cases`'
  `relatedEventIds`.

### Interview questions you might get, and good answers

- **"Why is `create` a plain boolean on `RolePermissions` but `read` can be
  `'own'`/`'shared'`/etc.?"** → `create` has no existing row to evaluate
  ownership/visibility against yet — there's nothing to check `'own'`
  *against* until the row exists. `read`/`update`/`delete` all act on an
  existing row, so they can ask "is the caller the owner / a collaborator /
  on the team."
- **"Walk me through what happens if I change `authEvents`'s `admin: update`
  to `true` and a client calls `useMutations('authEvents').put(id, {...})`
  from the browser console."** → It would succeed — RBAC would allow it
  because the session's role actually is `admin`. This is exactly why that
  permission is `false`: the only legitimate writer is the import job, which
  doesn't go through this check at all.

### Practice exercise

Add a `priority: 'critical'` option to `cases`' `status` interpretation...
actually, try the harder, more realistic version: add a brand new column
`watchers` (`{ kind: 'json' }`, array of userIds) to `cases`, update the
schema, redeploy to local dev, and confirm via `useQuery('cases')` in the
browser console that **existing** case rows now show `watchers: undefined`
rather than an error. This is the "add a field without losing data" pattern
DeepSpace documents — practicing it now means you're not learning it live
in the interview.

### Verifying the modification

`npm run type-check` catches a malformed `ColumnDefinition` immediately
(wrong `storage`/`interpretation` pairing is a type error, not just a
runtime surprise). Then `npx deepspace dev start` and inspect the collection
with the local Durable Object explorer the dev server prints
(`/cdn-cgi/local/explorer/api/...`), or just query it from a page.

---

## Feature: Canonical synthetic dataset generator (`scripts/generate-dataset.mjs`)

### What it does and why it exists

Produces the one, single, canonical dataset of synthetic auth events —
`src/data/synthetic-auth-events.json` — that both the DeepSpace import job
**and** the Day-3 Python Isolation Forest script read. The approved plan
explicitly rejected maintaining two independent generators (one TS, one
Python) because they'd inevitably drift; this script is the fix: generate
once, export, consume twice.

### Files, functions, data structures

- `scripts/generate-dataset.mjs` — plain Node ESM script (no build step, no
  new dependency — deliberately simple so it stays trivially re-runnable).
- `mulberry32(seed)` — a small deterministic pseudo-random number generator.
  "Deterministic" here means: same seed, same sequence of "random" numbers,
  every time, on every machine.
- Three anomaly-injection loops (`impossible_travel`, `brute_force_burst`,
  `new_device_odd_hour`), each tagged with `groundTruthAnomaly`.
- Output shape: `{ datasetVersion, generatedAt, seed, count, anomalyCount,
  events: SyntheticEvent[] }`.

### Data flow

```
node scripts/generate-dataset.mjs 1000 1337
  → 50 synthetic "actors," each with a home location/device/typical hour
  → ~4-5% of events deliberately injected as one of 3 anomaly patterns
  → remaining ~95% ordinary logins (occasional incidental typo-failures)
  → sorted by timestamp, written to src/data/synthetic-auth-events.json
```

### Design decisions & tradeoffs

- **Deterministic, not `Math.random()`.** Reproducibility was an explicit
  requirement (the eventual ML evaluation report has to be reproducible).
  A seeded PRNG also means growing the dataset later (`count=5000`, same
  seed) only *appends* new events rather than regenerating everything
  differently — events `0..999` stay byte-identical.
- **Anomalies are departures from an actor's *own* history**, not globally
  rare values. `impossible_travel` and `new_device_odd_hour` are defined
  relative to each actor's home profile, which is what makes them learnable
  features later (the Isolation Forest can key off "distance from this
  actor's usual location," not "distance from some global average").
- **Target anomaly rate is ~4-5% of events, not ~10%.** See the debugging
  log — an earlier version hit 29% by budgeting "anomaly injections" instead
  of "anomalous events," and the brute-force pattern emits 5-9 events per
  injection.

### DeepSpace SDK capabilities used

None — intentionally. This script runs offline, outside the Worker, with
plain Node. It's the generator for data DeepSpace will later store, not
DeepSpace code itself.

### Likely bugs & how to diagnose them

- **Symptom: a derived field (country, city, IP) doesn't match the rest of
  the row.** This exact bug happened today — see
  `docs/DEBUGGING_LOG.md`. The general lesson: when "picking a location"
  needs multiple correlated fields (country + city + IP prefix), pick the
  *location object* once and destructure from it, never call `pick(...)`
  twice for parts that must agree.
- **Symptom: regenerating with a larger `count` changes early events.**
  Only possible if `SEED` also changed, or if the anomaly-injection loops
  run in a different order relative to the "fill with normal events" loop
  for a different `count` (they don't currently — anomalies are injected
  first, in a fixed order, before the filler loop runs to `COUNT`). If this
  ever breaks, diff `events.slice(0, 1000)` between two runs.

### Interview questions you might get, and good answers

- **"Why not just use `Math.random()`?"** → Reproducibility. The ML
  evaluation report (Day 3/4) needs to report real numbers against a fixed
  dataset — if regenerating the data changed it every time, "precision:
  0.81" wouldn't mean anything from one run to the next.
- **"How would you know if your anomaly rate was unrealistic?"** → I'd ask
  what real-world base rates look like (low single digits for
  auth-anomaly), then actually check: I printed `anomalyCount` and did the
  division, found 29%, and fixed the budget math rather than asserting a
  number without checking it. (This is a real thing that happened — see the
  debugging log — it's a strong, honest answer to lead with.)

### Practice exercise

Add a fourth anomaly pattern of your own design (e.g. "login from a
disabled/former employee account" — pick a few actors to mark `inactive`
and inject a login anomaly for them). Decide: does it need a new ground-truth
reason string? Does it change any schema column? Keep the ~4-5% total rate
roughly intact when you size its iteration count.

### Verifying the modification

Re-run the script, then run the dataset-integrity unit test:
`npx vitest run src/data/synthetic-auth-events.test.ts` (see the note in
`docs/DEBUGGING_LOG.md` about this runner currently failing in this
environment for unrelated reasons — if that's still unresolved, at minimum
re-run the inline Node sanity checks used today: unique `eventId`s,
country/city consistency, and the anomaly rate bound).

---

## Feature: Idempotent synthetic-event import (`src/jobs.ts`)

### What it does and why it exists

Loads the canonical dataset into the live `authEvents` collection, as a
DeepSpace **background job** (not a server action), because bulk-inserting
up to thousands of rows is exactly what the background-jobs guide calls out
as the reason that mechanism exists ("bulk imports" is one of its two
named examples), and a server action must finish inside a single HTTP
response.

### Files, functions, data structures

- `src/jobs.ts` — `runJob(job, ctx, env)` dispatches on `job.type`;
  `importSyntheticEvents(ctx, env, payload)` does the real work.
- `ImportSyntheticEventsPayload` — `{ limit?: number }`, lets an admin import
  a smaller slice for a quick smoke check without touching the committed
  dataset.
- Progress reporting via `ctx.progress(fraction, message)` every 25 rows (so
  `useJobs`'s live subscribers see motion without flooding the WebSocket on
  every single row).

### Data flow

```
Admin clicks "Import synthetic events" (admin.tsx)
  → useJobs(SCOPE_ID).enqueue('import-synthetic-events', {})
    → AppJobRoom.authorizeWrite (admin-only check, see below)
      → runJob → importSyntheticEvents
        → for each of 1000 events:
            tools.create('authEvents', data, eventId)   // upsert by eventId
            ctx.progress(...)                             // live UI update
        → returns { imported, failed, errors }  → job.result
```

### Design decisions & tradeoffs

- **One row at a time, not batched/parallel.** At 1,000 rows this finishes
  comfortably inside the 15-minute Durable Object alarm limit. The SDK
  doesn't expose a bulk-insert tool, so going faster would mean either
  `Promise.all`-ing chunks (more complexity, harder to reason about partial
  failure) or accepting the simple, correct, slightly slower version. For
  Day 1's 1,000-row target, simple wins. **This is the first thing to
  revisit if the dataset grows to tens of thousands of rows** — flagged in
  `docs/ARCHITECTURE.md`'s risk list, not silently left unscalable.
- **`payload.limit` exists for exactly one reason**: letting an admin (or a
  future test) import 50 rows instead of 1,000 for a fast manual check,
  without needing a second job type or a second dataset file.
- **Errors don't abort the whole import.** A single failed row (e.g. a
  validation error) is recorded in `errors` (capped at 10) and the loop
  continues — one bad row shouldn't block the other 999.

### DeepSpace SDK capabilities used

- `JobRoom`/`runJob`/`JobContext` (`ctx.progress`, `ctx.signal`) from
  `deepspace/worker`.
- The documented **upsert-by-recordId** behavior of `tools.create` — this is
  the single mechanism idempotency is built on; nothing custom was added on
  top of it.
- `useJobs(roomId)` on the client (`admin.tsx`) for the live job list and
  `enqueue`.

### Likely bugs & how to diagnose them

- **Symptom: re-running the import "does nothing" / event count doesn't
  change.** That's the *intended* behavior for unchanged data — upsert means
  identical rows are harmlessly re-written. If you expect new rows to
  appear, confirm the committed JSON actually changed (`datasetVersion` in
  the job's result, or just check `src/data/synthetic-auth-events.json`'s
  `count`).
- **Symptom: job never reaches `succeeded`, stuck at `running`.** Check
  `ctx.signal.aborted` — the loop checks it, but only between rows; if a
  single `tools.create` call hangs, the whole job hangs with it. First
  thing to check: is the Durable Object `AppRecordRoom` itself reachable
  (`npx deepspace logs --follow` during the run)?
- **Symptom: `job.result.errors` shows RBAC-style messages even though jobs
  bypass RBAC.** That would mean a *schema validation* error (e.g. a
  required column missing, or wrong type), not RBAC — `X-App-Action` skips
  permission checks but not schema enforcement (`required`, `maxLength`,
  enum options).

### Interview questions you might get, and good answers

- **"Why a background job instead of a server action here?"** → Server
  actions run inside one HTTP request/response and are meant for
  orchestration that finishes quickly. Importing up to thousands of rows,
  one DO round-trip each, is exactly the "might take seconds to minutes"
  case the SDK's own background-jobs guide says to use a job for.
- **"What happens if I click the import button twice in a row, fast?"** →
  Two jobs get queued; `JobRoom` runs jobs one at a time per the docs, so
  the second one runs after the first finishes, and because the import is
  idempotent, the second run just re-applies the same 1,000 rows — no
  duplicates, no corruption. I'd be honest that I reasoned this through from
  the documented upsert behavior rather than having clicked it twice myself
  yet — see Day 1's open verification note below.

### Practice exercise

Change `importSyntheticEvents` to also write a `lastImportedAt` timestamp
onto each row's `datasetVersion` field's sibling... actually, simpler and
more useful: add a *second* job type, `'count-auth-events'`, that just calls
`tools.query('authEvents', { limit: 1 })` and returns `result.data.count` as
`job.result`. This exercises the full `runJob` dispatch pattern on a much
smaller, easier-to-reason-about handler before you touch the real import
logic.

### Verifying the modification

`npm run type-check`, then in local dev (`npx deepspace dev start`), sign in
as the app owner, open `/admin`, click import, and watch the job's status
and `authEvents` count change live. **This exact happy-path click-through is
the one thing not yet verified end-to-end as of Day 1** — see the Day 1
report for why (test accounts can't be the app owner) and do this once
yourself before Day 2.

---

## Feature: Admin-only enforcement, server-side

### What it does and why it exists

The approved plan required that admin-only operations be enforced
server-side, "not merely hidden in the UI." Two independent layers now do
that for every job type in this app:

1. `worker.ts`'s `AppJobRoom.authorizeWrite` — resolves the connected user's
   **current** app role and requires `'admin'`, re-checked on every
   `enqueue`/`cancel`/`retry`, not just once at connect.
2. `admin.tsx`'s UI check (`user?.role === 'admin'`) — convenience only; it
   makes the page not show a button a non-admin couldn't use anyway.

### Files, functions, data structures

- `worker.ts` — `AppJobRoom` constructor, `authorizeWrite` callback.
- `src/pages/(app)/(protected)/admin.tsx` — the `isAdmin` early-return.
- `tests/smoke.spec.ts` — the "non-admin analyst sees 'Admins only'" test.

### Data flow

```
Non-admin's browser opens a WebSocket to /ws/jobs/:roomId
  → AppJobRoom constructs, resolveAppRole(env, userId) → 'member'
  → authorizeWrite returns false
  → an enqueue attempt from this connection is refused by the DO itself,
    before runJob/importSyntheticEvents ever executes
```

### Design decisions & tradeoffs

- **One `authorizeWrite`, not per-job-type logic.** `JobRoomConfig.authorizeWrite`
  is a single predicate for the whole room, not job-type-aware. That's fine
  *here* because every job type this app defines is an admin operation —
  if a future member-triggerable job type were added, this would need to
  become type-aware (read `job.type` isn't available in `authorizeWrite`'s
  signature at all — it only receives the user — so that would actually
  require a different mechanism, like checking the type inside `runJob`
  itself and returning an explicit `{ success: false }`-style result).
  Worth saying out loud if asked: this is a real limit of the current
  design, not something glossed over.

### DeepSpace SDK capabilities used

- `JobRoomConfig.authorizeWrite`, `resolveAppRole` from `deepspace/worker`.

### Likely bugs & how to diagnose them

- **Symptom: an admin can't enqueue either.** Check `resolveAppRole`'s
  result directly — the app owner is pinned to `admin` automatically, but
  anyone else must have been promoted via `useUsers().setRole(userId,
  'admin')` by an existing admin first. A fresh sign-in defaults to
  `member`.
- **Symptom: the UI shows "Admins only" for someone who should be admin.**
  `useUser()` loads asynchronously — if the role check runs before
  `user` has loaded, it may briefly read `undefined !== 'admin'`. Confirm
  with `useAuthProfileReady` or an `isLoaded` check before concluding RBAC
  is wrong.

### Interview questions you might get, and good answers

- **"How do you *prove* this is enforced server-side and not just hidden?"**
  → Two ways, in order of rigor: (1) read `worker.ts` and show the callback
  runs inside the Durable Object, independent of any client code; (2) the
  stronger proof is a test that connects as a non-admin and attempts the
  actual operation, confirming it's refused at the protocol level — which
  I haven't written yet (see below) precisely because I didn't want to
  fake that confidence with something weaker.
- **"Why didn't you write that test on Day 1?"** → Good, honest question to
  expect. Testing it properly means opening a raw WebSocket as a non-admin
  and sending a real `enqueue` wire message — I didn't want to guess at an
  undocumented wire format. The right time is once there's an HTTP-visible
  surface (a server action, Day 3) or once I've confirmed the wire protocol
  from the SDK's own client source, not before.

### Practice exercise

Temporarily change `authorizeWrite` to `role === 'member' || role ===
'admin'`, redeploy to local dev, confirm (via the smoke test) that it now
*fails* — the "Admins only" UI still hides the button, so you'd need to look
at the DO logs or temporarily loosen the UI check too to see a member
successfully enqueue. Then revert and confirm the test passes again. This
is a safe way to feel the difference between "the UI hides it" and "the
server refuses it."

### Verifying the modification

`npx deepspace test run smoke --port=5273` — the "Admins only" test is the
automated proof for the UI half today.

---

## Feature: Explainable statistical anomaly detection (`src/lib/anomaly-detection.ts`, `src/lib/geo.ts`)

### What it does and why it exists

Scores every `authEvents` row with three named, independent rules —
failed-login burst, impossible travel, new device — and records *why* in
plain English, not just a number. This is the "live, explainable" half of
the two-layer detection design (`docs/ARCHITECTURE.md`); the Day 3 offline
Isolation Forest is the other half, and the two are deliberately never
mixed into one score.

### Files, functions, data structures

- `src/lib/geo.ts` — `CITY_COORDINATES` (a small hardcoded lat/lon table)
  and `distanceBetweenCities(a, b)` (haversine great-circle distance).
- `src/lib/anomaly-detection.ts` — `computeStatScores(events)` is the only
  export most callers need; internally it groups by `actorId`, sorts each
  actor's events by time, and runs three private detector functions:
  `detectFailedLoginBursts`, `detectImpossibleTravel`, `detectNewDevice`.
  Also exports every threshold (`FAILED_LOGIN_BURST_THRESHOLD`,
  `IMPOSSIBLE_TRAVEL_MIN_KMH`, etc.) and `RULE_WEIGHTS`, so nothing is a
  buried magic number.

### Data flow

```
authEvents rows (from the DB, via the recompute job)
  → group by actorId → sort each actor's events by timestamp
  → detectFailedLoginBursts(sorted)   — two-pointer sliding window
  → detectImpossibleTravel(sorted)    — compare each event to the ONE before it
  → detectNewDevice(sorted)           — track a running Set of seen devices
  → merge each event's matched reasons → score = sum of matched weights, capped at 1
```

### Design decisions & tradeoffs

- **Failed-login burst uses a two-pointer sliding window, not a naive
  O(n²) scan.** `right` advances through an actor's failed logins one at a
  time; `left` only ever advances to keep the window within
  `FAILED_LOGIN_BURST_WINDOW_SECONDS`. This is the standard sliding-window
  technique — worth being able to draw on a whiteboard live, since it's
  exactly the kind of thing an interviewer might ask you to re-derive.
- **Impossible travel compares only to the immediately preceding event**,
  not to every prior event. Comparing to every prior event would also
  "catch" the same anomaly multiple times from different anchors and
  muddies which single comparison is being described in the reason string.
  Anchoring to the immediate predecessor keeps the explanation exact: "this
  event, versus the one right before it."
- **A device, once seen, is seen forever** — switching away and back
  doesn't re-flag it (tested explicitly: see "does NOT re-flag a device
  once it has been seen, even after switching away and back"). This models
  "do you own a second device," not "are you currently using your most
  recent device."
- **An actor's very first event is never flagged by the new-device rule.**
  Without this, *every* actor's first appearance in the dataset would be a
  guaranteed false positive — there's no prior history to compare against
  yet. This is the single most important edge case in the whole detector,
  and it's the first thing tested.
- **Score is literally `sum(matched rule weights)`, capped at 1.** No
  model, no calibration, no hidden logic — if `statReasons` has two
  entries, the score is deterministically the sum of those two rules'
  weights. An analyst (or an interviewer) can verify the math by hand from
  the displayed reasons alone.
- **`geo.ts` is NOT shared with `scripts/generate-dataset.mjs`**, even
  though both files "know about" cities. The generator only needs "this is
  home" vs. "this is far" to inject a pattern; the detector needs to
  measure real distance between *any* two cities an actor used, which is a
  more general capability. Forcing a shared module across a `.mjs` script
  (outside the TS build) and a `.ts` library (inside it) would have added
  real friction for no benefit — the thing that actually proves they agree
  is the cross-validation test below, not sharing a file.

### DeepSpace SDK capabilities used

None directly — this module is intentionally plain TypeScript with zero
DeepSpace imports, so it can be unit-tested with nothing but Vitest. The
*integration* with DeepSpace lives one layer up, in the `recompute-stat-
scores` job.

### Likely bugs & how to diagnose them

- **Symptom: an event that looks anomalous isn't flagged.** First check
  which rule you expected to fire and its exact threshold constant (e.g.
  `IMPOSSIBLE_TRAVEL_MIN_DISTANCE_KM = 300` — two cities closer than that
  never trigger travel detection regardless of speed). Then check whether
  the event is actually that actor's *first* event (new-device rule) or
  whether enough OTHER failed logins exist within the window (burst rule).
- **Symptom: `distanceBetweenCities` returns `null` unexpectedly.** It
  returns `null` for any city not in `CITY_COORDINATES` — this will happen
  immediately if real-world city names are ever introduced without adding
  them to the table. This is a deliberate fail-closed choice (the caller
  skips the comparison via `if (distanceKm == null) continue`) rather than
  guessing a distance.
- **Symptom: the dashboard shows a score but an empty reasons list, or
  vice versa.** Should be structurally impossible — `computeScore` only
  ever sums weights for labels present in `statReasons`. If you see this,
  something wrote `statAnomalyScore` directly without going through
  `computeStatScores` (check for a stray manual `tools.update` bypassing
  the job).

### Interview questions you might get, and good answers

- **"Walk me through the sliding window for failed-login bursts."** → Sort
  an actor's failed logins by time. Keep two pointers, `left` and `right`.
  Advance `right` one event at a time; before checking the window size,
  advance `left` forward (never backward) until the window
  `[left, right]` fits inside the configured number of seconds. The window
  size is `right - left + 1`; if that's at least the threshold, every
  event in `[left, right]` is part of a burst. Because `left` never moves
  backward, the whole pass over one actor's failed logins is O(n), not
  O(n²).
- **"Why cap the score at 1 instead of letting it grow unbounded?"** → A
  capped, bounded score is easier to display consistently (a progress bar,
  a 0-1 badge) and easier to reason about when comparing two events — an
  event matching all three rules isn't "3x worse," it's "matches
  everything we check for," and the cap reflects that the three rules
  don't claim to be independently, linearly severity-additive beyond that.
- **"What's a false positive this detector could produce in the real
  world, and would you accept it?"** → A person who legitimately travels
  internationally and logs in shortly after landing could trip the
  impossible-travel rule if their *previous* login was from home right
  before departure — the rule can't distinguish "spoofed location" from
  "someone who just got off a long flight but logged in sooner than the
  implied-speed threshold allows for commercial travel." I'd accept this
  as a reasonable false-positive rate for a flagging (not auto-blocking)
  system — it surfaces a case for a human analyst to dismiss quickly,
  which is the whole point of a review queue.

### Update (P0 roadmap, post-Day-2): thresholds are now part of the explanation

Each reason string now states the threshold alongside the observed
evidence — e.g. "Failed-login burst: 6 failed attempts within 12 minutes
(flagged at 4+ within 15 min)" — generated by string-interpolating the same
exported constants the detector itself checks against, not retyped as
separate text. `RULE_WEIGHTS` was extended with a `threshold` field used
by the dashboard's "Detection rule reference" panel (always visible in the
event detail modal, independent of any one event's stored reason — so it
reads correctly even for events scored before this change, under the old
string format). A new test ("rule reference thresholds match the actual
constants") fails if a future edit changes a threshold constant without
updating its description — the mechanism that actually enforces "displayed
explanations match the scoring logic," not just a comment promising it.

### Practice exercise

Add a fourth rule: flag a `password_reset` event that's immediately
followed (within, say, 5 minutes) by a `login` from a *different* device
than the one that requested the reset — a classic account-takeover
pattern. Decide: does it need a new weight in `RULE_WEIGHTS`? Write at
least one test proving it does NOT fire when the subsequent login uses the
SAME device (the benign "I reset my password and logged back in" case).

### Verifying the modification

`npx vitest run src/lib/anomaly-detection.test.ts` — fast (well under a
second), no DB or dev server needed. Then re-run the full canonical-dataset
cross-validation tests in the same file to make sure your new rule doesn't
change any existing counts unexpectedly.

---

## Feature: `recompute-stat-scores` job and the admin console's second panel

### What it does and why it exists

The only code path that actually writes `statAnomalyScore`/`statReasons`.
Mirrors the Day 1 import job's shape exactly on purpose — same admin-only
gating, same idempotency argument, same progress-reporting pattern — so
there's only one "how do background jobs work here" mental model to carry,
not two.

### Files, functions, data structures

- `src/jobs.ts` — `recomputeStatScores(ctx, env)`, dispatched from
  `runJob` on `job.type === 'recompute-stat-scores'`.
- `src/pages/(app)/(protected)/admin.tsx` — a second panel, "Statistical
  anomaly detection," with its own button and its own job list (`JobList`,
  now a small shared component parameterized by `renderResult` so the
  import and recompute panels don't duplicate the job-row markup).

### Data flow

```
Admin clicks "Recompute statistical scores"
  → enqueue('recompute-stat-scores', {})
    → AppJobRoom.authorizeWrite (admin-only, same check as the import job)
      → tools.query('authEvents', { limit: 5000 })        — load everything
        → computeStatScores(...)                            — pure, in-memory
          → tools.update(...) per row                        — patch scores back
            → ctx.progress(...) every 25 rows                — live UI update
```

### Design decisions & tradeoffs

- **Loads all events into memory in one `tools.query` call** (`limit:
  5000`), rather than paging. At 1,000-5,000 rows this is simple and fast;
  it's the first thing that would need to change (paged loading, or moving
  the computation itself to stream) if the dataset grows an order of
  magnitude beyond that — flagged, not silently assumed to scale forever.
- **Always re-patches every row**, even ones whose score wouldn't change.
  Simpler code, and harmless at this scale; an optimization (skip the
  `tools.update` call when old and new values are identical) is a cheap,
  well-scoped follow-up if write volume ever becomes a real cost.
- **The admin UI's `AnyJobResult` is a union type**, narrowed per job type
  with a type guard (`isRecomputeResult`), because `useJobs<P, R>` is
  generic over ONE payload/result pair for the whole room — there are two
  different job types with two different result shapes sharing one room,
  so the type has to be a union, not two separate hook calls.

### DeepSpace SDK capabilities used

Same as the import job: `createActionTools` (shared RBAC-bypass helper),
`ctx.progress`/`ctx.signal` from `JobContext`, `useJobs` on the client.

### Likely bugs & how to diagnose them

- **Symptom: recompute succeeds but the dashboard still shows stale
  reasons.** `useQuery`'s WebSocket subscription should push the update
  live — if it doesn't appear, check whether the browser tab's connection
  dropped (look for a `[RecordRoom] webSocketClose` line in dev server
  logs) rather than assuming the job itself failed.
- **Symptom: `job.result.failed > 0` for a handful of rows.** Check
  `job.result.errors` (capped at 10) — a schema validation failure
  (`required`/`maxLength`) is the most likely cause, not an RBAC rejection
  (this path bypasses RBAC entirely via `X-App-Action`).

### Interview questions you might get, and good answers

- **"Why recompute everything instead of only new/changed rows?"** →
  Simplicity and correctness over micro-optimization at this data scale.
  Incremental recomputation would need to track "what changed since last
  run," which adds real state and real bugs (a row that should have been
  rescored but wasn't, because the tracking logic missed it) to save a
  cost that doesn't yet exist. I'd revisit this specific tradeoff if the
  dataset grew by 10-100x.

### Practice exercise

Add a "skip unchanged" optimization: before calling `tools.update`,
compare the newly computed `statAnomalyScore`/`statReasons` against the
row's current values (you already have them from the initial `tools.query`)
and skip the write if they're identical. Report how many writes this saves
on a full recompute against the Day 1 dataset.

### Verifying the modification

`npm run type-check` first (the admin page's union-typed job results are
exactly the kind of thing a careless edit breaks silently without it).
Then, once real data exists (see the Day 2 report), run the job from
`/admin` and watch the dashboard's summary counts update live.

---

## Feature: The dashboard (`src/pages/(app)/(protected)/dashboard.tsx`)

### What it does and why it exists

The analyst-facing investigation surface: a live table of `authEvents`
with filters, an alert summary, and a click-through detail view. It is
intentionally "dumb" — it computes nothing about anomalies itself, it only
displays what the `recompute-stat-scores` job already wrote.

### Files, functions, data structures

- `useQuery<AuthEventRecord>('authEvents', { limit: 2000, orderBy:
  'timestamp', orderDir: 'desc' })` — the only data source.
- Three pieces of local UI state: `eventType`, `flaggedOnly`,
  `actorSearch`, `sortMode`, `selected` (the row open in the detail modal).
- `summary` (`useMemo`) — counts over the FULL dataset, independent of
  filters.
- `filtered` (`useMemo`) — the subset of rows the current filters/sort
  actually show.

### Data flow

```
authEvents (live WebSocket query)
  → summary: scan ALL rows → { total, flagged, burst, travel, newDevice }
  → filtered: apply eventType / flaggedOnly / actorSearch → sort by time or score
  → render: summary cards (always) + filter bar + table (or empty state)
  → click a row → Modal showing full statReasons
```

### Design decisions & tradeoffs

- **Filtering happens in React (`useMemo`), not via a DeepSpace `where`
  query.** `where` is equality-only; there's no "score > 0.5" or "reasons
  is non-empty" query the SDK supports today. At ≤ a few thousand rows,
  fetching once and filtering client-side is simpler and fast enough — see
  `docs/ARCHITECTURE.md` for the scaling boundary this implies.
- **The alert summary is computed over the full dataset, not the filtered
  view.** A summary that changes meaning every time you adjust a filter
  (e.g. "Flagged: 3" meaning something different after you toggle
  "Flagged only") would be confusing. The summary answers "what's the
  state of everything"; the table answers "what am I currently looking
  at." Deliberately two different questions, kept visually separate.
- **The empty state replaces the whole page**, including the filter bar,
  when there are zero events. Showing filter controls over a table that
  can never have rows would be confusing UI with nothing to test. This is
  also, right now, the actual state of the dev database (see the testing
  boundary below).

### DeepSpace SDK capabilities used

`useQuery` only — this page makes no mutations and no job calls.

### Likely bugs & how to diagnose them

- **Symptom: a filtered search for an actor shows nothing even though you
  know events exist.** `actorSearch` matches a case-insensitive substring
  of `actorId` — check for a typo in the id format (`user_045`, not
  `User045` or `045`).
- **Symptom: the "Why" column always shows "—".** Means `statReasons` is
  either `undefined` (never recomputed) or `[]` (recomputed, found nothing
  to flag) for that row — the detail modal's body text explicitly
  distinguishes these two cases for exactly this reason.

### Interview questions you might get, and good answers

- **"This page fetches up to 2000 rows into the browser. What's your
  plan if this app had 200,000 events?"** → Client-side filtering stops
  being viable at that scale. I'd move filtering server-side — either a
  denormalized boolean column (`isFlagged`) DeepSpace's `where` can match
  on directly, or a dedicated query mechanism if/when one exists — and
  probably paginate the table instead of rendering everything. I'd treat
  this as the first thing to revisit, not something to pre-build before
  there's a real need (see `docs/ARCHITECTURE.md`'s known-risks list).

### Practice exercise

Add a fifth summary stat: "Events in the last 24 hours." You'll need
`Date.now()` compared against each row's `timestamp` (careful: `timestamp`
is Unix *seconds*, `Date.now()` is milliseconds — this exact unit mismatch
is a realistic bug to practice catching).

### Verifying the modification

`npm run type-check`, then (once real data exists) load `/dashboard` and
confirm the new stat updates when you toggle "Flagged only" — if it
changes when you expected it to stay fixed (or vice versa), re-read
"summary vs. filtered" above.

---

## Feature: Royal-blue design system (theme, sidebar, charts)

### What it does and why it exists

Replaces the scaffold's placeholder dark theme with the approved
professional "security SaaS" look, implemented as real DeepSpace theme
tokens rather than hardcoded colors, so every page that already used
`bg-card`/`text-foreground`/etc. re-themed automatically.

### Files, functions, data structures

- `src/themes.css` (`[data-theme="threatlens"]` block), `src/themes.ts`
  (catalog entry), `index.html` (`data-theme` attribute + first-paint
  background).
- `src/components/Navigation.tsx` — rewritten layout (sidebar + mobile
  drawer), same hooks/testids as before.
- `src/components/ui/StatCard.tsx` — shared KPI tile.
- `src/components/charts.tsx` — `ActivityChart` (stacked bar, flagged vs.
  clean, per day) and `RuleDistributionChart` (labeled horizontal bars per
  detection rule).

### Design decisions & tradeoffs

- **Charts are hand-built in CSS, not a new dependency.** At two simple
  shapes (a time-bucketed stacked bar, a short labeled bar list), a
  charting library would be meaningfully more weight for no real gain —
  consistent with the brief's "no unnecessary dependencies."
- **Chart colors reuse existing semantic tokens** (`bg-destructive`,
  `bg-warning`, `bg-info`) rather than a new arbitrary palette — the same
  red/orange/blue already mean the same thing elsewhere (score badges), so
  there's one color vocabulary for severity across the whole app, not two.
- **The sidebar is one component with two responsive variants**, not two
  separate components, wrapped in a `display:contents` div carrying the
  single `data-testid="app-navigation"` — this keeps exactly one DOM
  element matching that testid regardless of viewport, so existing
  Playwright locators don't need to pick a variant.

### Likely bugs & how to diagnose them

- **A real one, already hit:** a flex row with `items-end` instead of
  `items-stretch` silently collapses percentage-height children to zero —
  no console error, just a blank chart. See `docs/DEBUGGING_LOG.md`. If a
  future chart or bar-style component renders blank with no error, check
  the flex `align-items` on its row container first.
- **Symptom: the sidebar's dropdown menu opens off-screen.** Check
  `side`/`align` on `DropdownMenuContent` — it's `side="top" align="start"`
  for the sidebar variant specifically because the trigger sits at the
  bottom-left of the screen, not the top-right like the old top bar.

### Interview questions you might get, and good answers

- **"Why theme tokens instead of hardcoding the hex values in components?"**
  → One file controls the whole app's palette; any component written
  against `bg-card`/`text-foreground` automatically re-themes. Hardcoding
  `#0B3DAA` directly into a dozen components would mean a future palette
  change touches a dozen files instead of one.
- **"Walk me through why the chart was blank, live."** → See the
  `items-end` vs. `items-stretch` explanation above — a good one to be
  able to draw as two nested boxes on a whiteboard.

### Practice exercise

Add a dark-mode variant of the `threatlens` theme (a second
`[data-theme="threatlens-dark"]` block) and a way to toggle it — exercises
the exact mechanism `sdk-reference/client/theming.md` documents
(`DeepSpaceThemeProvider`/`useIsDarkTheme`) without touching any component.

### Verifying the modification

`npm run build` (confirms the new CSS compiles), then visually check both
the dashboard and a narrow (mobile) viewport — this exact class of bug
(a blank chart, a wrong-sized sidebar) produces no type error and no test
failure, so a visual check is the only thing that catches it.

---

## Feature: Case investigation workflow

### What it does and why it exists

Lets analysts turn one or more flagged events into a tracked investigation:
status, priority, assignment, a chronological note thread, and the linked
events with their detection explanations inline. This is the collaborative
half of ThreatLens — everything before this phase was one analyst looking
at data; this is multiple analysts working a shared queue together.

### Files, functions, data structures

- `src/actions/case-actions.ts` — `createCaseFromEvents`, the one server
  action in the whole feature.
- `src/lib/call-action.ts` — tiny shared `callAction(name, params)` client
  helper (the documented fetch-with-bearer-token pattern, in one place).
- `src/components/CreateCaseModal.tsx` — the creation form, used from two
  entry points on the dashboard.
- `src/components/EventReasons.tsx` — `EventReasons`/`RuleReference`,
  extracted from the dashboard's detail modal so the case detail page's
  linked-events list shows the identical explanation UI.
- `src/pages/(app)/(protected)/cases/index.tsx` — case list.
- `src/pages/(app)/(protected)/cases/[id].tsx` — case detail (status/
  priority/assignment, linked events, notes).
- `src/pages/(app)/(protected)/dashboard.tsx` — gained a checkbox column,
  a selection-aware "Open case from N selected" bar, and an "Open case from
  this event" button in the detail modal.

### Data flow

See `docs/ARCHITECTURE.md`'s "Phase 2" section for the full creation →
sync → authorization trace. The short version: creation goes through a
server action (justified below); every other write is a plain client
mutation; every read is `useQuery`, which is also what makes sync free —
nobody wrote any sync code, `useQuery`'s WebSocket subscription already
does it.

### Design decisions & tradeoffs

- **One server action, not a blanket "wrap everything in actions"
  policy.** Status/priority/assignment edits and note creation are plain
  `useMutations` calls — the schema already permits them for `member`, and
  wrapping a single-table write in a server action would add a network hop
  and a second code path for zero benefit. The ONE place a server action
  earns its keep is creation, because it genuinely orchestrates two
  collections (case + its origin note) — see the action-routes.ts header
  comment on when an action is actually warranted versus reflexive.
- **`EventReasons`/`RuleReference` extracted mid-phase, not written twice.**
  The case detail page needed the exact same "why was this flagged" UI the
  dashboard already had. Copy-pasting it would have meant two places to
  keep in sync forever; extracting it the moment a second caller appeared
  is the normal "rule of three... actually rule of two here" judgment call.
- **Delete is the one case operation gated to the creator (or admin).**
  Every other mutation is open to any analyst (small shared-team model).
  Narrowing specifically for delete — not status, not assignment — is a
  deliberate asymmetry: destructive operations get a narrower boundary
  than collaborative edits, which is the same instinct behind Day 1's
  "authEvents denies writes to every role" decision, applied with a
  lighter touch here because cases, unlike the log, are meant to be
  collaboratively edited.

### DeepSpace SDK capabilities used

- Server action (`ActionHandler`, `ActionContext`, `tools.create`) for
  `createCaseFromEvents`.
- `useQuery`/`useMutations` (`put`, `createConfirmed`, `removeConfirmed`)
  for everything else.
- `useUsers()` for the assignee dropdown (the public-identity roster —
  exactly what it's documented for: "fields collaborators need to name
  each other").
- `useUserLookup().getName(userId)` to resolve note authors and assignees
  to display names.
- `getAuthToken()` (via `callAction`) for the server-action POST.

### Likely bugs & how to diagnose them

- **A real one, already hit:** a test cleanup step using
  `element.isVisible()` immediately after `page.goto(...)` almost always
  returns `false`, because it doesn't wait for the page's data to load —
  it's an instant check, not an assertion. See `docs/DEBUGGING_LOG.md`
  ("test cleanup silently wasn't running"). The fix pattern —
  `await locator.waitFor({ state: 'visible', timeout })` before checking —
  applies anywhere a test needs to know "has this async-loaded thing
  actually appeared," not just in cleanup code.
- **Symptom: a case shows 0 linked events even though it was created with
  some.** Check whether `authEvents` has finished loading before
  `relatedEventIds` is matched against it — both queries resolve
  independently, so there's a brief window where `cases` has loaded but
  `authEvents` hasn't. Not currently guarded with a combined loading state;
  a good thing to add if this becomes a visible flicker in practice.
- **Symptom: the assignee dropdown is empty.** `useUsers()` only returns
  users who have connected at least once (the roster is populated from the
  `users` collection, written at sign-in) — a newly test-created account
  won't appear until it has signed in once.

### Interview questions you might get, and good answers

- **"Walk me through exactly what happens, server-side, when I click
  'Open case.'"** → The browser POSTs to `/api/actions/createCaseFromEvents`
  with a bearer token; `action-routes.ts` verifies the JWT, looks up the
  action by name, and calls it with `{ userId, params, tools, env,
  callerJwt }`. The action validates the input, calls
  `tools.create('cases', ...)` (which reaches the `AppRecordRoom` DO via an
  internal fetch carrying `X-App-Action: true` — RBAC bypassed because this
  is the app's own server code, not a user's direct write), then does the
  same for `caseNotes`. Both writes are attributed to the real caller's
  userId, not the app owner, because that's what `X-User-Id` was set to.
- **"How do you know the real-time sync actually works, not just that the
  code looks right?"** → `tests/collab.spec.ts` opens two separate,
  independently-signed-in Playwright browser contexts, has one create a
  case/change its status/add a note, and asserts the OTHER browser's
  already-rendered page updates without a reload — a real WebSocket
  round-trip between two real client connections, not a mock.
- **"Why didn't you just let any analyst delete any case, like the other
  fields?"** → Deletion is destructive and irreversible; the other edits
  (status, priority, assignment, notes) are corrections a team can make to
  each other's work without real loss, and deliberately stay open to
  support that. I'd revisit this if cases needed an audit trail of status
  changes too — right now, overwriting `status` is also technically
  "destructive" to the previous value, and the only place that history
  survives is the notes thread if someone wrote one.

### Practice exercise

Add a "reopen" action: when a `resolved` or `false_positive` case's status
is changed back to `open` or `investigating`, automatically append a system
note ("Reopened by `<name>`") the same way case creation appends its
origin note. Decide: does this belong in the client (call
`createConfirmed` right after `put` succeeds) or does it need a server
action? (Hint: compare against why `createCaseFromEvents` needed one and
status edits didn't — what's actually different here?)

### Verifying the modification

Add a case, change its status back and forth, and check `caseNotes` for
the new row — `npx deepspace test run e2e --port=5273` is the fastest way
to confirm nothing else in the case workflow broke, since `collab.spec.ts`
exercises the full create → status → note lifecycle already.

---

## Feature: Offline Isolation Forest ML integration

### What it does and why it exists

The second, independent anomaly-detection layer the project's design has
promised since Day 1: an unsupervised scikit-learn model, trained and
scored once outside the app, whose output (a score + outlier flag per
event) is imported as a static enrichment. It exists specifically to be
**different** from the statistical detector — not a reimplementation of
the same three rules, but a model that finds its own structure in
engineered features without being told what "anomalous" means in advance.

### Files, functions, data structures

- `scripts/ml/features.py` — `engineer_features(events)`, pure, no model,
  no I/O, no ground truth. `FEATURE_NAMES` is the canonical column order.
- `scripts/ml/train_and_evaluate.py` — `transform_features`,
  `fit_and_score` (both unit-tested directly), `main()` (the full
  pipeline), `build_report()` (generates `docs/ML_EVALUATION_REPORT.md`
  from this run's real numbers).
- `scripts/ml/test_features.py`, `test_scoring.py` — 14 pytest tests.
- `src/jobs.ts` — `importMlScores`, dispatched on `job.type ===
  'import-ml-scores'`.
- `src/pages/.../admin.tsx` — third panel, same `JobList` component the
  other two jobs already use.
- `src/pages/.../dashboard.tsx` — ML score column, "ML outliers only"
  filter, side-by-side scores in the detail modal with an explicit
  explanation of what each score is.

### Data flow

See `docs/ARCHITECTURE.md`'s Phase 3 section for the full pipeline
diagram. The short version: Python reads the same dataset JSON the TS
import job reads, engineers features, trains, scores, evaluates against
ground truth (only at the very end), and writes two committed files; the
TS job then does nothing but a keyed `update` loop over one of those
files.

### Design decisions & tradeoffs

- **`tools.update`, not `tools.create`, for the import.** This isn't a
  style choice — `update` is documented to refuse to create a row that
  doesn't exist ("updates never create"), which means the import
  literally cannot produce a duplicate, a stronger guarantee than
  "we're careful about it." The tradeoff: if `authEvents` doesn't already
  have a row for some `eventId` (e.g. the synthetic import hasn't run
  yet), that row's ML score silently fails to apply — counted in
  `job.result.failed`, not thrown, same pattern as the other jobs.
- **One Python process, two outputs, both committed.** `ml-scores.json`
  (what the app imports) and `ML_EVALUATION_REPORT.md` (what a human or
  interviewer reads) come from the exact same run, so the report's claimed
  numbers and the actually-imported scores can never quietly diverge —
  there's no second manual step where someone could hand-edit the report.
- **Ground truth is read in exactly one place, at the very end.** Not a
  style preference — it's what makes "no data leakage" checkable by a
  test rather than just asserted in a comment (see
  `test_engineer_features_never_reads_ground_truth`).
- **`contamination=0.05` is informed by the known injection rate.**
  Disclosed as a limitation in the report rather than hidden — a cleaner
  number would have been to leave it at sklearn's default and report worse
  metrics, but that would have been less informative about what the
  features and model CAN do, so the tradeoff was made consciously and
  written down.
- **The admin-triggered import itself was handed off, not clicked by the
  agent.** Same reasoning as Day 1's synthetic-event import: test accounts
  can never be admin, and driving the real owner's OAuth session isn't
  something to automate. What's verified directly: the Python pipeline
  (real run, real tests), the job's logic (type-checked, reviewed against
  the SDK's documented guarantees), and that a non-admin's attempt is
  refused at the wire-protocol level.

### DeepSpace SDK capabilities used

Identical job/action infrastructure to the earlier jobs — no new SDK
surface was needed for this feature. The interesting part of this phase
is almost entirely in `scripts/ml/`, which (deliberately) uses no
DeepSpace imports at all.

### Likely bugs & how to diagnose them

- **A real one, already hit:** `Path.write_text(report)` with no
  explicit encoding corrupted every em-dash in the generated report on
  Windows (default text encoding isn't UTF-8). See
  `docs/DEBUGGING_LOG.md`. The general lesson: any Python file write that
  will be committed to a cross-platform repo needs `encoding="utf-8"`
  explicitly — never rely on a platform default.
- **Symptom: a dashboard row shows "Not yet scored" for ML but has a
  statistical score.** Expected and correct until `import-ml-scores` has
  been run at least once — the two jobs are completely independent, and
  running one doesn't imply the other has run.
- **Symptom: re-running `train_and_evaluate.py` changes the scores.**
  Shouldn't happen with `random_state=42` fixed — if it does, check
  whether the dataset file itself changed (a different `datasetVersion`
  means different input, which legitimately changes output) before
  suspecting the model.

### Interview questions you might get, and good answers

- **"Explain how Isolation Forest decides a point is anomalous."** → It
  builds many trees that split the feature space on random features at
  random thresholds. A typical point takes many splits to end up alone in
  its own leaf; an unusual point — one that's extreme on some feature —
  gets isolated in far fewer splits, because a random cut is more likely
  to separate an extreme value quickly. Average path-to-isolation length
  across all trees, inverted, is the anomaly score. No labels involved
  anywhere in that process.
- **"Why not just feed the model the same three signals the statistical
  detector checks, with the same thresholds?"** → That would make it a
  slower, less-explainable copy of the existing rules, not a second
  independent signal. The features here (distance, speed, device novelty,
  failed-count, time-of-day) are continuous and the model finds its own
  combinations and thresholds in them — which is exactly why it disagrees
  with the rule engine sometimes (see the per-pattern breakdown in the
  evaluation report, especially how poorly it does on `new_device_odd_hour`
  compared to the rule engine, which catches it by definition).
- **"How do you know there's no leakage?"** → Point to the actual test,
  not just the design: `test_engineer_features_never_reads_ground_truth`
  passes events with the ground-truth keys entirely absent and asserts
  feature engineering still succeeds — the function physically cannot
  depend on data that isn't there.
- **"Precision 0.56 — is that good?"** → For catching two of three
  pattern types perfectly and being informed by the true contamination
  rate, it's about what I'd expect, not something to oversell. The honest
  framing is in the report's limitations: this measures agreement with
  three known synthetic patterns in a small dataset, not real-world
  accuracy, and I'd say that plainly before quoting the number.

### Practice exercise

Add a 9th feature: `is_first_event_for_actor` (0/1) — directly encodes
what currently has to be inferred from `minutes_since_prev_event` hitting
its sentinel value. Retrain, re-evaluate, and check whether precision/
recall actually changed. (It might not move much — that's a legitimate,
useful finding too: it tells you the sentinel was already doing that job
adequately.) Write one test asserting the new feature is 1.0 for exactly
one row per actor.

### Verifying the modification

```
source .venv-ml/Scripts/activate   (Windows) — see scripts/ml/requirements.txt
python scripts/ml/train_and_evaluate.py
pytest scripts/ml
```

Then re-check `docs/ML_EVALUATION_REPORT.md`'s numbers actually changed
(or didn't, and you understand why).

---

## Understanding ThreatLens ML Scores

This section documents exactly how the ML score pipeline behaves, verified
directly against the installed library and the actual committed data — not
assumed from how Isolation Forest is "supposed to" work. Every specific
number below (the score range, the threshold location, the worked
examples) was read out of `src/data/ml-scores.json` and
`src/data/synthetic-auth-events.json` with a one-off script, not estimated.
Where a claim is about *this run's data* rather than Isolation Forest in
general, it's labeled as such.

### 1. What Isolation Forest is and how it detects anomalies

An **unsupervised** ensemble model: it builds many random binary trees
over the feature space, and never sees a label (not even at training
time — `scikit-learn`'s `IsolationForest.fit(X)` takes no `y`). It finds
structure in the features alone.

### 2. How isolation trees separate normal and unusual observations

Each tree picks a random feature and a random split value, repeatedly,
until every point is alone in its own leaf. A "normal" point — similar to
many others — tends to need many splits to isolate, because it's
surrounded by similar points that a random cut is likely to group it
with. An unusual point — extreme on some feature — tends to get isolated
in very few splits, because a random cut is much more likely to separate
it from everything else on the first or second try. **Average path length
to isolation, across all trees, is the raw signal**; short average paths
mean "easy to isolate," i.e. anomalous.

### 3. The eight engineered features (`scripts/ml/features.py`)

| # | Feature | Calculation | Purpose |
|---|---|---|---|
| 1 | `hour_of_day` | `datetime.fromtimestamp(ts, utc).hour` — 0-23 | Captures an actor's normal time-of-day pattern. |
| 2 | `is_weekend` | 1.0 if `weekday() >= 5` else 0.0 | Weekday vs. weekend login patterns can differ. |
| 3 | `is_failed` | 1.0 if `not success` else 0.0 | A failed attempt is inherently more noteworthy. |
| 4 | `minutes_since_prev_event` | `(ts - prev_ts) / 60`, floored at 1 second, capped at 10,080 (7 days) — the cap value is also the sentinel for an actor's very first event, which has no "previous" | Very short gaps can indicate automation or a burst. |
| 5 | `distance_km_from_prev` | Haversine distance between this event's city and the actor's immediately preceding event's city (0.0 for a first event or same city) | The core geographic-novelty signal. |
| 6 | `implied_speed_kmh` | `distance_km_from_prev / elapsed_hours`, capped at 5,000 | Turns raw distance into a travel-plausibility signal; the cap stops a near-zero elapsed time from producing a near-infinite value. |
| 7 | `is_new_device` | 1.0 if this device was never seen before in the actor's own history (0.0 for the actor's first event — there's no baseline to compare against yet) | Device novelty relative to that specific actor. |
| 8 | `failed_logins_last_15min` | Count of the actor's `failed_login` events (including this one, if it's a failure) within the trailing 900 seconds | A continuous analogue of the statistical detector's burst rule. |

**Preprocessing**: features 4-6 are right-skewed (a 10,080-minute sentinel
sitting next to mostly-small gaps; a handful of >1,000 km/h speeds next to
mostly-zero values), so each gets `np.log1p()` applied before the model
sees it (`train_and_evaluate.py`'s `transform_features()`). No categorical
one-hot encoding is used anywhere.

**No ground truth anywhere in this step** — `engineer_features()` doesn't
accept, read, or require `groundTruthAnomaly`/`groundTruthReason`; see
`test_engineer_features_never_reads_ground_truth`.

### 4-8. Exactly how the score is produced — verified against the installed library, not assumed

Read directly from `train_and_evaluate.py`'s `fit_and_score()`:

```python
raw = model.decision_function(X_transformed)        # NOT score_samples()
inverted = -raw
normalized = (inverted - inverted.min()) / (inverted.max() - inverted.min())
predictions = model.predict(X_transformed)           # separate call
is_outlier = (predictions == -1).astype(int)
```

**ThreatLens uses `decision_function()`, not `score_samples()`.** The
installed scikit-learn's own docstring for `IsolationForest.decision_function`
(confirmed by running `help()` against the actual installed package,
version 1.9.1) states:

> "The anomaly score of the input samples. **The lower, the more
> abnormal. Negative scores represent outliers, positive scores represent
> inliers.**"

So in scikit-learn's own raw output: **lower (and negative) = more
anomalous**. ThreatLens then does two transformations before storing
anything:

1. **Inverts the sign** (`-raw`), so now higher = more anomalous.
2. **Min-max normalizes to exactly [0, 1]** across the whole scored
   dataset.

**The stored `mlAnomalyScore` therefore has this exact, verified
contract: a float in `[0.0, 1.0]`, where higher means more anomalous.**
Confirmed empirically: across all 1,000 scored events in the committed
`ml-scores.json`, the minimum score is exactly `0.0` and the maximum is
exactly `1.0` (that's what min-max normalization guarantees by
construction, not a coincidence).

**`mlIsOutlier` is NOT computed by thresholding `mlAnomalyScore`.** It
comes from a **separate** call, `model.predict(X)`, which returns `-1`
for an outlier and `1` for an inlier using scikit-learn's own internal
decision boundary — derived at fit time from the `contamination=0.05`
parameter (scikit-learn sets an internal `offset_` such that the
requested fraction of the fitted data falls on the outlier side of raw
`decision_function() < 0`). `is_outlier = (predictions == -1)`.

**Where does that boundary land in the stored, normalized score, in this
actual run?** Checked directly against the committed data: the lowest
score among events marked `mlIsOutlier: 1` is **0.7058**; the highest
score among events marked `mlIsOutlier: 0` is **0.6992**. There is a clean
gap between them — no event scores between 0.6992 and 0.7058 in this run.
**This boundary is not a fixed constant anywhere in the code** — it's
wherever scikit-learn's contamination-based decision happens to fall
after min-max normalization, for this specific fitted model on this
specific dataset. A different run (different data, different
`contamination`, even a different `n_estimators`) could place it
somewhere else. If you need "is this score above the model's own outlier
line," read `mlIsOutlier` — don't hardcode 0.70 anywhere.

Exactly **50 of 1,000** events are flagged (`mlIsOutlier: 1`) — precisely
5.0%, matching `contamination=0.05` by construction (that parameter
directly controls how many points `predict()` calls outliers).

### 9. How the offline model's results are matched to authentication events

By the dataset's stable `eventId` string (e.g. `evt_000026`) — the exact
same id used as the authEvents `recordId` everywhere else in the app.
`ml-scores.json` is a flat array of `{eventId, mlAnomalyScore,
mlIsOutlier}`; there is no separate "matching" or "linking" logic to
inspect — the key was chosen on Day 1 specifically so that none would
ever be needed.

### 10. How the ML scores are imported into RecordRoom

`src/jobs.ts`'s `importMlScores()` (job type `import-ml-scores`, same
admin-only `AppJobRoom.authorizeWrite` gate as every other job) loops over
every entry in the committed `ml-scores.json` and calls
`tools.update('authEvents', eventId, { mlAnomalyScore, mlIsOutlier })` —
one `update` per event, nothing else. `update` (not `create`) is the
reason a repeat run cannot duplicate a row (scikit-learn... no — the
SDK's own `records.update` refuses to create a row that doesn't exist),
and because the patch only names these two fields, the envelope-merge
semantics of `update` leave `statAnomalyScore`/`statReasons` — written by
the completely separate `recompute-stat-scores` job — untouched.

### 11. How the dashboard displays and filters ML results

`src/pages/(app)/(protected)/dashboard.tsx` reads `mlAnomalyScore`/
`mlIsOutlier` straight off each `authEvents` record (no recomputation in
the browser). Three places:

- **Table column** ("ML score"): shows `mlAnomalyScore.toFixed(2)` in a
  badge — `destructive` (red) if `mlIsOutlier === 1`, `secondary`
  (neutral) otherwise. Shows an em-dash if the row hasn't been scored yet
  (`mlAnomalyScore == null`).
- **"ML outliers only" filter** (`mlOutlierOnly` state): filters directly
  on `r.data.mlIsOutlier === 1` — the model's own flag, not a
  dashboard-chosen threshold on the score.
- **Detail modal**: shows the statistical score and the ML score
  side by side, each labeled, plus a fixed explanatory note (see point 12
  below) distinguishing what each one is.

Note the ML badge is simpler than the statistical one: `scoreBadgeVariant`
(used for `statAnomalyScore`) has three tiers (clean/warning/high); the ML
badge only has two (outlier/not), because `mlIsOutlier` is already a
binary flag — there's no separate "medium ML risk" tier anywhere in the
code.

### 12. How ML detection differs from statistical rule-based detection

| | Statistical (`src/lib/anomaly-detection.ts`) | ML (this section) |
|---|---|---|
| Runs | Live, inside the app, on every recompute | Once, offline, outside the app |
| Logic | Three named, human-readable rules with fixed thresholds | A model that finds its own structure in 8 numeric features |
| Output | A score that's literally the sum of matched rule weights, plus a list of reasons | A single float plus a binary flag, with no "reason" beyond "the features put this point in isolation quickly" |
| Explainability | Exact — `statReasons` names precisely which rule(s) fired and why | None at the per-event level — there's no equivalent of `statReasons` for the ML score |

### 13. Why the two systems can disagree

They're built from different information in different ways, so agreement
is expected, not guaranteed. Concretely, in this run (verified against the
committed data, not a general claim): the ML model catches **100%** of
`impossible_travel` and `brute_force_burst` events but only **17.6%**
(3 of 17) of `new_device_odd_hour` events — because a *single* binary
feature (`is_new_device`) spread among seven other features that are
mostly unremarkable for those events doesn't isolate the point as
strongly as a very large `implied_speed_kmh` or a very high
`failed_logins_last_15min` does. The statistical detector, by contrast,
catches a new device 100% of the time by rule-definition (minus the
actor's-first-event exemption) — it isn't weighing that signal against
seven others, it's just checking it directly.

### 14. Why an ML score is NOT a probability that an event is malicious

Three concrete reasons, not just a disclaimer:

- **It's a relative, in-sample measure.** The min-max normalization (step
  4-8 above) divides by *this dataset's own* min/max isolation depth —
  the number `0.73` means "more isolated than most other events in this
  specific 1,000-row run," not any absolute probability of maliciousness.
  Re-score a different dataset and the same underlying event could
  normalize to a different number.
- **The model has no concept of "malicious."** It was never shown a
  single label. "Isolated easily" and "malicious" are a hypothesis this
  project is testing (and partially confirming — see the precision/recall
  numbers), not a guarantee built into the math.
- **The outlier flag depends on an assumed contamination rate.** `0.05`
  came from the known injection rate of this synthetic dataset — a
  choice, not a discovered fact — so the flag answers "is this among the
  most unusual ~5% of this dataset," which is a different question from
  "how likely is this to be a real attack."

### Worked examples (real values, from the committed data — not illustrative)

**Example A — the most normal event in the dataset.**
`evt_000590`: actor `user_005`, an ordinary `login` from Berlin on
macOS-Safari. `mlAnomalyScore = 0.0` (the literal minimum in this run),
`mlIsOutlier = 0`. Ground truth agrees: `groundTruthAnomaly = 0`. Nothing
about this event stood out on any of the 8 features.

**Example B — the most anomalous event in the dataset, correctly caught.**
`evt_000026`: actor `user_045`, a `failed_login` from Lagos on
Android-App. `mlAnomalyScore = 1.0` (the literal maximum), `mlIsOutlier =
1`. Ground truth: `groundTruthAnomaly = 1`, `groundTruthReason =
brute_force_burst` — a true positive, and specifically the single
easiest-to-isolate point in the whole dataset (likely a high
`failed_logins_last_15min` combined with an unusual `is_new_device`/
location signal for that actor).

**Example C — a real false negative, illustrating the recall gap from
point 13.** `evt_000036`: actor `user_043`, ground truth
`groundTruthReason = new_device_odd_hour` (a real injected anomaly) —
but `mlAnomalyScore = 0.5635`, well below the ~0.706 boundary, so
`mlIsOutlier = 0`. The statistical detector *would* catch this one (new
device is new device, by rule), but the ML model's isolation-based score
wasn't pushed high enough by that one feature alone. This is the single
clearest concrete illustration of why `new_device_odd_hour` has only
17.6% recall in the evaluation report.

---

## AI-assisted code: how it was verified

Every piece of SDK usage above was checked against the documented contract
before being used, not assumed from training knowledge or guessed from a
plausible-looking pattern:

- `ActionTools`, `ActionResult`, `MutateActionData`, `JobContext`, `Job`,
  `CollectionSchema`, `ColumnDefinition`, `PermissionLevel` — read directly
  from the installed SDK's type definitions
  (`node_modules/deepspace/dist/worker.d.ts`, `schema.d.ts`), not inferred.
- The upsert-by-`recordId` behavior of `tools.create` — read from the SDK
  docs' own prose ("If a record with that id already exists, the incoming
  `data` is merged on top of it"), then relied on directly rather than
  re-implemented with a manual "check-then-write."
- `buildCronContext`'s `CronContext.records.create` was considered and
  **rejected** for the import job specifically because its type signature
  has no `recordId` parameter — it can't upsert, so it would have silently
  broken idempotency. Catching that required reading the actual type, not
  just the one-line doc summary.
- Every change was run through `tsc --noEmit` and `eslint .` (both clean),
  `vite build` (confirms the Worker bundle actually includes the dataset
  JSON correctly), and the real Playwright suite (`npx deepspace test run
  smoke`, 7/7 passing including a new test written for this feature) —
  see the Day 1 report for exact commands and output.
