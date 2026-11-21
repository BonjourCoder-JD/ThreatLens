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
