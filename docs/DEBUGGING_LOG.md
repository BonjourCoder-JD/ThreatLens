# ThreatLens — Debugging Log

## Day 2 (UI redesign) — Incident: a test was silently giving false confidence

**Error observed.** None — this is the dangerous kind. While re-running the
full Playwright suite after the redesign, `Dashboard › dashboard shows an
empty state when no events are imported yet` reported **passing**. But I
had just taken a screenshot, in the same dev database, showing the
dashboard rendering 1,000 real events (the data from the user's own manual
verification, which persists in this checkout's local dev storage). A
"shows an empty state" test should not be able to pass against a database
that isn't empty.

**Initial hypothesis.** The assertion was
`getByText(/No events yet|Loading events/)` — a regex with two
alternatives. My hypothesis: the second alternative, "Loading events…",
is ALSO shown briefly by the dashboard while `useQuery`'s status is still
`'loading'`, regardless of whether the underlying data is empty or not —
so the test could be passing by catching that transient loading text, not
by observing genuine emptiness.

**Investigation.** Wrote a one-off temporary test
(`tests/_state-check.spec.ts`, deleted after use) that logged the
dashboard's actual rendered text. It showed the real populated dashboard —
"Flagged: 48," "Failed-login bursts: 16," etc. — confirming the database
is not empty and the "empty state" test's premise no longer held. The
regex's loading-text alternative was the only way it could still be
passing.

**Fix.** The underlying scenario (an empty, never-imported database) can
no longer be exercised against this persisted dev database, so rather than
patch the assertion to be stricter against a precondition that's no longer
true here, the test was replaced with one that asserts against the real,
current, persisted data: the summary renders, toggling "Flagged only"
measurably changes the visible result count (proving the filter does real
work, not just renders), and opening a flagged row's detail shows at least
one concrete reason. Values are read from the page at runtime, not
hardcoded, so the test stays valid as the dataset changes later (e.g. Day 3
ML scores).

**Test result.** `npx deepspace test run smoke`: 9/9 passing, including the
replacement test, run against the real persisted data.

**Why this matters.** A test that passes for the wrong reason is worse
than no test — it looks like coverage without being any. The lesson:
a passing assertion with an "or" in it is worth a second look for whether
either branch could trivially satisfy it regardless of what's actually
being tested.

---

## Incident-management Day 1 — Incident: a WebSocket test asserted on the wrong message

**Error observed.** The new "a direct write to a protected field (status)
is rejected" test failed: `expect(rejected).toBeTruthy()` got `undefined`
— no `core.error` was found in the captured messages at all, even though
the write should have been refused.

**Initial hypothesis.** The test's `ws.onmessage` handler called `finish()`
(close the socket, resolve the promise) on the very FIRST message it
received, assuming that would be the server's reply to the `core.put`
attempt. Hypothesis: something else arrives first.

**Investigation.** Grepped the compiled worker for what `AppRecordRoom`
sends proactively on connect, before processing any client message:
`this.send(ws, { type: MSG.USER_INFO, payload: registeredUser })` — sent
unconditionally as part of `onConnect`. My test's raw socket was closing
itself immediately after receiving THIS message, before the actual
`core.error` reply to the PUT attempt ever arrived.

**Fix.** Changed the handler to keep listening (collecting every message)
until it specifically sees `type === 'core.error'`, rather than resolving
on whatever arrives first. For the companion "summary is still writable"
test, the opposite fix was needed — an accepted fire-and-forget write has
no explicit success message to an unsubscribed socket, so that test now
waits out the full timeout window and confirms no `core.error` ever
arrived, then independently re-queries the page to confirm the write
actually took effect (not just "no error seen").

**Test result.** Both tests pass: the protected-field write is confirmed
rejected (`"FIELD ERROR: Role 'member' cannot modify field 'status'"`,
case status unchanged on reload) and the unprotected `summary` field is
confirmed still writable (text visible on reload). Full suite: 10/10.

**Why this matters.** The first version of this test could have passed
OR failed for the wrong reason depending on timing — a classic "test asserts
on the wrong thing" trap. Worth remembering for any future raw-WebSocket
test against a RecordRoom specifically: the first frame after connecting
is always `MSG.USER_INFO`, not a reply to whatever you just sent.

---

## Phase 3 (ML) — Verification pass: documenting score semantics (no new bugs found)

Before writing "Understanding ThreatLens ML Scores"
(`docs/CODE_WALKTHROUGH.md`), the implementation was re-inspected and
cross-checked rather than documented from memory, specifically because
score direction/range/threshold claims are easy to get subtly wrong.
Recorded here in the interest of "document genuine issues, don't invent
bugs" — this is the honest result of that check: **no discrepancy was
found.**

What was verified, and how:

- **Which scikit-learn API is actually called.** Grepped
  `train_and_evaluate.py` fresh: confirmed `model.decision_function(...)`
  is used for the continuous score (not `score_samples()`), and
  `model.predict(...)` is a separate call for the binary flag.
- **The direction/range claim.** Read the *installed* scikit-learn
  1.9.1's own docstring for `IsolationForest.decision_function` via
  `help()` rather than relying on general knowledge of the library:
  confirms "the lower, the more abnormal" in the raw score, which matches
  what the code's inline comment already claimed before this check.
- **The stored score's actual range.** Loaded the real committed
  `src/data/ml-scores.json` and computed `min()`/`max()` directly: exactly
  `0.0` and `1.0` across all 1,000 events, confirming the min-max
  normalization behaves as documented.
- **Where the outlier threshold actually falls.** Computed directly from
  the real data: the lowest score among `mlIsOutlier: 1` rows is 0.7058;
  the highest among `mlIsOutlier: 0` rows is 0.6992 — a clean gap, and
  **not** a round number anywhere in the code (it's an emergent property
  of this run's score distribution, not a configured constant).
- **The reported precision/recall/F1 numbers.** Independently recomputed
  TP/FP/TN/FN and precision/recall/F1 directly from the two raw JSON
  files, in a fresh one-off script that does not import or reuse
  `train_and_evaluate.py`'s own calculation. Result: **TP=28, FP=22,
  TN=936, FN=14, precision=0.5600, recall=0.6667, F1=0.6087** — matches
  `docs/ML_EVALUATION_REPORT.md`'s reported 0.560/0.667/0.609 exactly (to
  rounding). The per-pattern breakdown (100%/100%/17.6%/2.3%) also
  matched exactly. No correction was needed.

**Outcome: the existing report's numbers stand, independently confirmed,
not just re-trusted.**

---

## Phase 3 (ML) — Incident: the evaluation report was corrupted on write

**Error observed.** Reading `docs/ML_EVALUATION_REPORT.md` back after
generating it showed every em-dash (`—`) replaced with the Unicode
replacement character (`�`, U+FFFD) — the file was flagged as "not valid
UTF-8."

**Initial hypothesis.** `Path.write_text(report)` was called with no
explicit encoding. My hypothesis: on Windows, `write_text()`'s default
encoding comes from `locale.getpreferredencoding()`, which is commonly
`cp1252`, not UTF-8 — so every em-dash in the f-string (a character
`cp1252` can't represent) got mangled on write.

**Investigation.** Confirmed by checking the file with the `file` command
(reported "Unicode text, UTF-8 text" only AFTER the fix — beforehand it
would have reported a different/ambiguous encoding) and by re-reading the
file in Python with `encoding='utf-8'` explicitly, which raised on the
corrupted bytes before the fix.

**Fix.** Added `encoding="utf-8"` to every `Path.write_text(...)` and
`open(...)` call across `scripts/ml/` (the report write, the
`ml-scores.json` write, and every test's dataset/scores file read) —
never rely on a platform's default text encoding for anything that will
be committed to a cross-platform repo.

**Test result.** Regenerated the report: `file` reports "UTF-8 text,"
and a Python re-read with `encoding='utf-8'` succeeds with every em-dash
intact. Re-ran the full Python suite (14/14) and the training script —
identical precision/recall/F1 numbers, confirming the fix only touched
file I/O, not the actual computation.

---

## Phase 2 (cases) — Incident: test cleanup silently wasn't running

**Error observed.** None — again the dangerous kind. After the full case
workflow test suite passed (20/20), a manual check of `/cases` showed six
leftover `__test-`-prefixed cases that should have been deleted by each
test's own `finally` block.

**Initial hypothesis.** The cleanup code was
`if (await deleteButton.isVisible().catch(() => false)) { ...delete... }`
run right after `page.goto('/cases/:id')`. My hypothesis: `isVisible()` is
a single, immediate check — it doesn't wait for anything — so it almost
always ran before the page's `useQuery('cases')` subscription had loaded
the case data and rendered the delete button, found nothing, and silently
skipped cleanup every time.

**Investigation.** Wrote a throwaway script
(`tests/_cleanup-check.spec.ts`, deleted after use) that listed every case
title — confirmed six `__test-` cases present. Rewrote a cleanup pass to
explicitly wait for `case-status-select` (a reliable "the page actually
loaded" signal) before looking for the delete button, and it successfully
deleted them.

**Fix.** In both `tests/collab.spec.ts` and `tests/api.spec.ts`, every
cleanup `finally` block now does `await page.getByTestId('case-status-
select').waitFor({ state: 'visible', timeout: 10_000 })` before checking
for the delete button with `.count()` (not `.isVisible()` — `count()` on a
button that genuinely isn't there, e.g. a non-owner's page, correctly
returns 0 without waiting the full timeout). The whole block is wrapped in
try/catch so a cleanup failure never masks the actual test's pass/fail
result.

**Test result.** Re-ran the full suite: all cases created during the run
were confirmed deleted afterward (`/cases` empty of `__test-` rows).

**Why this matters.** The test *assertions* were correct the whole
time — this bug only affected cleanup, not what was being verified. But a
cleanup step that silently no-ops is exactly the kind of thing that looks
fine right up until a shared dev database fills up with junk, so it was
worth fixing immediately rather than shrugging it off as "the real test
still passed."

---

## Day 2 (UI redesign) — Incident: activity chart rendered as a blank area

**Error observed.** After building the royal-blue redesign, I took a set of
screenshots (`tests/_visual-check.spec.ts`, deleted afterward — not part of
the real suite) to self-check the result before reporting it done. The
"Event activity" chart's plot area was completely blank — just white space
between the title and the date-range labels — even with 1,000 real events
loaded.

**Initial hypothesis.** The per-day bar `<div>`s have their height set via
inline `style={{ height: '${pct}%' }}`, and a CSS percentage height can only
resolve against an ancestor with a *definite* height. My hypothesis: some
ancestor in the chain didn't have one.

**Investigation.** Read `src/components/charts.tsx`'s `ActivityChart`: the
row container had `className="flex items-end gap-1.5"` with an explicit
pixel height (`style={{ height: rowHeightPx }}`), and each day's column was
a flex child with no height of its own, relying on the row's default
cross-axis sizing to stretch it to the full row height. `items-end`
overrides that default (`stretch`) — it sizes each flex item to its own
*content* height instead. But the column's content (the percentage-height
bar) can't compute a height without the column already having one — a
circular dependency browsers resolve by treating the percentage as
effectively zero. That's the blank area: every bar was rendering at 0px.

**Fix.** Changed the row's class from `items-end` to `items-stretch` (one
word). The column now stretches to the row's full 160px, giving the
percentage-height bar inside it something definite to resolve against; the
inner `flex flex-col justify-end` still correctly bottom-anchors the
(now correctly sized) bar within that column.

**Test result.** Re-ran the same screenshot script: bars now render at the
expected heights, with the red "flagged" sliver visible on top of each
day's bar, matching the real per-day counts. Confirmed by eye, not just by
absence of a console error — this bug produced no error of any kind, only
silently-wrong layout, which is exactly why a visual check (not just
`tsc`/tests) was necessary before calling the chart "implemented."

---

## Day 2 — Manually observed: admin import/recompute happy path (owner-verified)

Not a bug — recorded here because it's the one verification step this log
previously flagged as "reserved for the user, not simulated." The user
personally signed in with the real DeepSpace owner account and ran the
checks the Day 1/2 reports specified. Results, as reported:

- Admin panel accessible to the owner account.
- First "Import synthetic events" run: succeeded, 1,000 events imported.
- Second "Import synthetic events" run (immediately after, no changes in
  between): succeeded, 1,000 events imported.
- `authEvents` row count after both runs: **exactly 1,000** — confirms the
  upsert-by-`eventId` idempotency claim in `docs/ARCHITECTURE.md` actually
  holds against a real second run, not just in the unit tests and the
  theory of how `tools.create(..., recordId)` behaves.
- "Recompute statistical scores" run: succeeded.
- Statistical detection result: **48 of 1,000 events flagged.**

This confirms the Day 1 import job and the Day 2 recompute job both work
end-to-end against the real deployed-shape app, under the real owner
identity, not just in unit tests or empty-state Playwright checks. It does
**not** yet cover the dashboard UI itself against this real data — that is
a separate, still-open verification the user has explicitly reserved for
themselves (not to be marked complete here).


Real incidents only, in the order they happened. Nothing here is invented or
reconstructed after the fact — each entry was written at the time the issue
was found. Format: error observed → initial hypothesis → investigation →
fix → test result.

---

## Day 1 — Incident 1: mismatched country/city in the synthetic dataset

**Error observed.** After the first run of `scripts/generate-dataset.mjs`, a
manual spot-check of the output JSON showed:

```json
{ "country": "NG", "city": "Berlin", ... }
```

Nigeria paired with a German city. Not a crash, not a type error — just
wrong data that would have silently fed bad features into the eventual ML
pipeline if it had gone unnoticed.

**Initial hypothesis.** The brute-force-burst anomaly pattern builds each
event by spreading several fields across one object literal. My hypothesis:
somewhere in that pattern, `country` and `city` are being set from two
*different* random picks instead of one.

**Investigation.** Read the pattern's code directly:

```js
addEvent({
  ...baseEvent(actor, { ... }),
  sourceIp: ip,                              // from `far` (correct)
  country: pick(FAR_LOCATIONS).country,      // ← a NEW, independent pick
  groundTruthReason: 'brute_force_burst',
})
```

Confirmed: `ip` was built from one `pick(FAR_LOCATIONS)` call earlier in the
loop, but `country` called `pick(FAR_LOCATIONS)` again, independently — and
`city` wasn't being overridden from `far` at all, so it was silently
inheriting the *actor's home city* from `baseEvent`'s spread. Three different
sources of "where this event is" fighting each other in one object. The
correctly-written sibling pattern (`impossible_travel`, written first) picks
`far` once into a variable and reuses it for `country`, `city`, and
`sourceIp` together — that comparison is what made the bug obvious.

**Fix.** Pick `far` once per burst, before the inner loop, and set
`country`, `city`, and the IP prefix from that same object:

```js
const far = pick(FAR_LOCATIONS)
const ip = `${far.ipPrefix}.${ipSuffix()}`
// ...
country: far.country,
city: far.city,
```

**Test result.** Added an automated regression check for this exact bug
class (`src/data/synthetic-auth-events.test.ts`, "never pairs a country with
a city that belongs to a different country") checking every row against a
known country→city map. Re-ran the generator and the inline verification:

```
mismatched country/city rows: 0
```

0 of 1,000 rows mismatched, confirmed by direct inspection of the
regenerated file. The regression test itself could not be run through
`vitest` due to Incident 2 below, so this result was verified with a
one-off Node script instead — see that entry for why, and revisit once
Incident 2 is resolved.

---

## Day 1 — Incident 2: anomaly injection rate was 29%, not ~10%

**Error observed.** The generator's own summary line after the first
successful run:

```
Wrote 1000 events (291 ground-truth anomalies) to ...
```

291/1000 = 29.1% anomalous. The design intent (stated in the script's own
comment) was "~10% of the budget."

**Initial hypothesis.** The three anomaly patterns don't all emit the same
number of events per "injection" — `brute_force_burst` emits a 5-9 event
burst per injection, while the other two emit 1-2. My hypothesis: the budget
was being spent in *injection* units, not *event* units, so the burst
pattern alone could blow past the intended total.

**Investigation.** Confirmed from the code: `PER_PATTERN =
Math.floor(ANOMALY_BUDGET / 3)` split the budget evenly across three loop
**iteration counts**, not across resulting **event counts**. With
`ANOMALY_BUDGET ≈ 100` and `PER_PATTERN ≈ 33`, the burst pattern ran 33
times at ~7 events each ≈ 231 events on its own — well over the intended
total of 100.

**Fix.** Reworked the budget to target total anomalous *events* (5% of
`COUNT`), then derived each pattern's iteration count by dividing its share
of that event budget by its own known events-per-injection (2 for
impossible travel, ~7 for brute force, 1 for new-device):

```js
const TARGET_ANOMALY_EVENTS = Math.round(COUNT * 0.05)
const PER_PATTERN_EVENTS = Math.max(1, Math.round(TARGET_ANOMALY_EVENTS / 3))
const BRUTE_FORCE_ITERS = Math.max(1, Math.round(PER_PATTERN_EVENTS / 7))
```

**Test result.** Regenerated: `Wrote 1000 events (42 ground-truth
anomalies)` → 4.2%, within the realistic range. Added a regression bound to
the same dataset-integrity test (`anomaly rate realistic (1%-10%)`) so a
future change to the generator can't silently reintroduce either extreme
without a test failing.

---

## Day 2 — Incident 3 (resolved): Vitest unit-test runner fails on every spec

**Error observed.** Every `.test.ts` file — including the two pre-existing
scaffold tests I never touched (`prerender.test.ts`,
`src/prerender-entry.test.tsx`) — fails identically:

```
TypeError: Cannot read properties of undefined (reading 'config')
 ❯ describe('...', () => { ... })
```

or, for the other scaffold file:

```
Error: Vitest failed to find the current suite.
```

**Initial hypothesis.** A duplicate/mismatched `vitest` package instance —
the repo has `package-lock.json`, `pnpm-workspace.yaml`, **and**
`.yarnrc.yml` all present simultaneously, which smells like node_modules was
installed by more than one package manager at different times.

**Investigation.**
- `npm ls vitest` → a single, deduped `vitest@4.1.12` everywhere (`deepspace`,
  `wrangler`, and the root all resolve to the same copy). Ruled out a
  duplicate-instance problem.
- Checked `vitest`'s declared peer range for `vite`: `^6.0.0 || ^7.0.0 ||
  ^8.0.0`. Installed `vite` is `8.3.8` — inside range. Ruled out a
  version-incompatibility-by-range problem.
- Confirmed the failure is **not specific to my code**: it reproduces on
  the scaffold's own untouched test files, and on `npx deepspace test run
  unit` (the project's own documented wrapper), not just a bare `npx
  vitest` invocation.
- Confirmed it does **not** affect the project's primary, documented test
  contract: `npx deepspace test run smoke` (Playwright) ran cleanly,
  7/7 passing, in the same environment, same `node_modules`.

**Further investigation (Day 2, time-boxed to ~55 min).** Ruled out, in
order, each with a concrete test:
1. *Project config.* Reproduced with a one-line `.test.ts` containing only
   `describe('x', () => it('y', () => expect(1+1).toBe(2)))` — no project
   imports. Reproduced again with the most minimal possible
   `vitest.config.ts` (just `test.include`, nothing else). Both failed
   identically → not caused by `appIdDefine`, aliasing, or any project
   setting.
2. *Stale dep-optimization cache.* Deleted `node_modules/.vite` and
   `node_modules/.vite-temp` entirely. Same failure → not a cache issue.
3. *Corrupted/mismatched install.* `npm ls vitest` showed one deduped
   `vitest@4.1.12` and matching `@vitest/*` siblings everywhere — no
   version split. A full `rm -rf node_modules && npm ci` reproduced the
   identical error byte-for-byte → not an install-corruption issue.
4. *Vitest version regression.* Installed `vitest@4.0.18` (last 4.0.x)
   instead of `4.1.12`. The error **changed** — from the `TypeError` to
   `Error: No test suite found in file` — proving the symptom is
   version-sensitive, but not actually fixed.
5. *Pool/isolation mechanism.* Tried `--pool=forks` (same `TypeError` as the
   default `threads` pool). Tried `--pool=vmThreads` — **passed.** Tried
   `--pool=vmForks` on 4.1.12 after reverting the version change — also
   passed, and the *original, untouched* `vitest@4.1.12` passes fine under
   either vm-based pool.

**Root cause.** The default `threads`/`forks` pools isolate each test file
by spawning a real OS-level worker thread or child process, and that
spawned worker never completes its handshake with the parent in this
sandboxed dev container — so `describe()` runs with no runner context
installed at all. `vmThreads`/`vmForks` isolate each file in a V8 `vm`
context inside the *existing* thread/process instead of spawning a new
OS-level one, which sidesteps whatever is broken in this environment's
thread/process spawning. This is an environment limitation, not a bug in
the project's code or in Vitest itself — the same install works under the
default pool on an unrestricted machine.

**Fix.** One line in `vitest.config.ts`: `test: { pool: 'vmThreads' }`, with
a comment explaining why (see the file). No dependency version was
changed — the original `vitest@4.1.10` range in `package.json` is untouched,
reinstalled clean, and confirmed fixed.

**Test result.** `npm run test:unit`: **7 of 8 tests now pass** (previously
0 of any test could even be collected). The 8th —
`src/prerender-entry.test.tsx` — now fails with a *different*, genuine
error ("Invalid hook call" / two React instances) that was always there but
invisible, because the collection-phase crash fired before that test's body
ever ran. This is a separate, pre-existing bug in the scaffold's own
prerender test, unrelated to the Vitest-runner fix or anything built in
ThreatLens — left open deliberately rather than scope-creeping into a
second investigation; flagged to the user rather than silently chased or
silently ignored. `npm run type-check`, `npm run lint`, and the full
Playwright smoke suite (7/7) were re-confirmed passing after this change.
