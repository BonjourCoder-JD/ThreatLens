# ThreatLens — Debugging Log

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
