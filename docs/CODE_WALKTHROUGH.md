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
