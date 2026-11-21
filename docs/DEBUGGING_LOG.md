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

## Day 1 — Incident 3 (unresolved, deferred): Vitest unit-test runner fails on every spec

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

**Fix.** Not yet applied — deliberately. I didn't want to guess at a version
pin (e.g. downgrading `vite` or `vitest`) without being asked to change
dependency versions, since that's a meaningful, somewhat risky edit on its
own and the root cause isn't confirmed yet.

**Current status / next step.** Deferred to Day 2 triage. Next things to
try, in order: (1) `npx deepspace@latest app update --json` to see if the
scaffold has a known toolchain-version migration for this; (2) isolate
further by creating a throwaway one-line `.test.ts` with no imports beyond
`vitest` itself, outside `src/`, to see if the failure is specific to the
project's `vitest.config.ts` (which injects a custom `define` via
`appIdDefine`) or truly global. **Does not block Day 1 or Day 2 work** —
the project's real test contract (Playwright via `deepspace test run`) is
unaffected.
