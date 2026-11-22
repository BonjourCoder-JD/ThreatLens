# ThreatLens — Interview Prep

Living document. Maps what's actually been built to the DeepSpace live
coding rubric. The goal is genuine understanding you could reconstruct
live, not memorized lines — use the "practice exercise" in
`docs/CODE_WALKTHROUGH.md` for each feature to test that for real before
relying on this.

## The rubric, and where this app gives you material for each line

**"Can explain and modify the submitted work."**
`docs/CODE_WALKTHROUGH.md` has one section per feature with the exact files,
functions, and a practice exercise. Before the interview, actually *do* at
least 3 of those exercises — reading an explanation and being able to
produce the change live are different skills.

**"Reads errors, forms a hypothesis, and tests it."**
`docs/DEBUGGING_LOG.md` has two resolved incidents (bad data, not a crash —
arguably harder to notice than a stack trace) and one genuinely unresolved
one, written in hypothesis → investigation → fix → test-result order as
they happened. Walk through Incident 1 (country/city mismatch) out loud
until you can narrate it without reading — it's a strong, concrete answer to
"tell me about a bug you found."

**"Thinks aloud and asks useful questions."**
Practice narrating a *design* decision, not just a bug. Good one: "why does
`authEvents` deny writes to every role including admin?" (Answer's in
`CODE_WALKTHROUGH.md` — because the only legitimate writer is a background
job that bypasses RBAC entirely; giving admin a client-side write path would
invite hand-editing the log.) The useful *question* version of this, if an
interviewer pushes back: "would it change your answer if an admin needed to
manually correct one bad row?" — a good live answer is "yes, I'd add a
narrow server action for that specific correction, not open `update: true`
on the schema" — because it shows you can extend the design under a new
constraint instead of just defending the original choice.

**"Directs AI tools deliberately and verifies their output."**
This is the one most worth being concrete about, because it's checkable.
For every SDK-facing piece built so far: the type signatures
(`ActionTools`, `JobContext`, `CollectionSchema`, etc.) were read from the
installed package's own `.d.ts` files before being used — not assumed. One
real example to have ready: `buildCronContext` looked like it might save
writing `src/server/record-tools.ts` from scratch, but reading its actual
type (`CronContext.records.create(collection, data)` — no `recordId`
parameter) showed it couldn't upsert, so it was rejected for the import job
specifically. That's "verified the output/suggestion against the documented
API, found it insufficient, and said why" — a concrete, honest story, not
"AI wrote it and it worked."

**"Responds constructively to review."**
Two real, available examples once Day 1's work has been looked at: (1) the
anomaly-rate bug (Incident 2) — found by *you* checking your own output
("291 anomalies, that doesn't look like 10%"), which is the habit a
reviewer wants to see happening before they have to point it out; (2) the
deferred Vitest issue — a case where the honest answer to "did you fix it?"
is "no, and here's exactly why I stopped rather than guess," which is a
*better* interview answer than a fabricated fix.

## Glossary — DeepSpace concepts used so far

- **Durable Object (DO).** A Cloudflare primitive: a single-instance,
  stateful server object addressable by name, with its own private
  storage. DeepSpace's `RecordRoom`/`JobRoom`/etc. are all DOs. One DO
  instance = one `roomId` = one isolated unit of data/state.
- **RecordRoom.** The DO subclass holding your app's collections
  (`authEvents`, `cases`, ...) and enforcing their RBAC on every read/write.
- **JobRoom.** The DO subclass running background jobs (`src/jobs.ts`), with
  its own queue, retry, and progress-broadcast machinery.
- **RBAC (role-based access control).** The `permissions` block on each
  schema. Checked server-side, inside the DO, before data is ever sent to a
  client — not a client-side filter.
- **`X-App-Action` / RBAC bypass.** The internal header that tells a
  RecordRoom "trust this request completely" — used only by server-side
  code (`createActionTools`), never reachable from a browser directly.
- **Upsert by recordId.** Passing a known id as `tools.create`'s third
  argument merges onto an existing row instead of creating a duplicate —
  the entire idempotency story for the import job rests on this one
  documented behavior.
- **Server action vs. background job.** Both run "as the app" (RBAC
  bypassed); a server action must finish inside one HTTP response, a
  background job can run for up to 15 minutes per alarm tick (longer with
  `backgroundJobTypes`) and reports live progress.

## Day 2 additions to the rubric mapping

**"Can explain and modify the submitted work."** New practice targets: the
sliding-window burst detector and the "why is `/dashboard` not admin-gated
but `authEvents` is still safe" question — both have exact answers in
`CODE_WALKTHROUGH.md` now.

**"Directs AI tools deliberately and verifies their output."** Concrete
new example: before writing the dashboard's filtering, I confirmed from the
SDK's own records reference that `where` is equality-only — there is no
"score greater than 0.5" query — and designed the filtering client-side
*because of* that confirmed constraint, not as an assumption. That's the
difference between "AI wrote a filter" and "verified what the API can and
can't do, then chose an approach that fits."

**"Thinks aloud and asks useful questions."** Good one to practice: "the
alert summary counts the full dataset, but the table below it only shows
filtered rows — why not make them agree?" Answer lives in
`CODE_WALKTHROUGH.md`'s dashboard section — rehearse saying it without
reading.

## Day 2 learning session (~20-25 min)

**1. What got built today (5 min).** A pure, three-rule statistical
detector with no DeepSpace dependency at all (testable with nothing but
Vitest); a background job that's the *only* thing allowed to write scores,
following the exact same admin-gated pattern as Day 1's import job; and a
dashboard that reads and displays what that job wrote, computing nothing
itself.

**2. The idea worth being able to defend (5 min).** The detector and the
dashboard are deliberately separated by a hard boundary: all the "is this
suspicious" logic lives in one pure, synchronously-testable file
(`anomaly-detection.ts`); the dashboard is pure presentation. If someone
asks you to change a threshold, you'd touch one file and re-run one fast
test suite — not hunt through React components for a stray magic number.

**3. The two-pointer sliding window (5 min).** This is the one piece of
real algorithm in Day 2, and it's exactly the kind of thing worth being
able to re-derive at a whiteboard. Practice: sort an actor's failed logins
by time; walk `right` forward one at a time; before checking anything,
walk `left` forward (never back) until the window fits the time budget;
the window size is `right - left + 1`. Say it out loud twice.

**4. The honest limitation to lead with, not hide (5 min).** The dashboard
has only been tested in its empty state — real-data behavior (filters with
actual flagged rows, the summary counts actually changing) is a known,
tracked gap until the Day 1 import verification you're doing yourself has
happened. If asked "is the dashboard fully tested," the accurate answer is
"the detection logic is thoroughly tested against real data; the dashboard
UI is tested structurally and in its empty state; testing it against real
flagged rows is the next step once data exists" — not a flat "yes."

**5. Practice before Day 3 (5 min).** Pick ONE of: (a) the new-device
"never flag the first event" edge case, or (b) the impossible-travel
"compare only to the immediately preceding event" choice — and explain out
loud why removing it would make the detector worse, with a concrete
example event sequence.

## Phase 2 (cases): the three things to be able to explain cold

**1. The case-creation data flow, start to finish.** Practice saying this
without notes: "Analyst selects events on the dashboard → clicks Open case
→ a modal collects a title → that calls a server action, not a direct
database write, because I want the case AND its origin note created
together → the action verifies the caller's JWT, then uses the RBAC-bypass
tools to write both `cases` and `caseNotes`, attributed to the real analyst
→ the browser gets redirected to the new case's URL." If asked "why a
server action and not just `useMutations`," the answer is specifically
about the TWO writes needing to happen together, not a blanket policy —
see `docs/CODE_WALKTHROUGH.md`'s "one server action, not a blanket policy."

**2. How real-time sync works here, mechanically.** There is no sync code
to point to — that's the point. `useQuery` opens a WebSocket per scope; a
write from any client (fire-and-forget `put`, or the confirmed variants)
goes to the Durable Object, which broadcasts a `core.record_change` to
every connected client whose RBAC allows reading that row; every other
mounted `useQuery` for that collection updates its local state and
re-renders. Practice drawing this as a diagram: Browser A → DO → broadcast
→ Browser B's existing subscription — three arrows, no "polling" or
"refresh" anywhere in it.

**3. How authorization is enforced, and how you'd prove it live.** Two
layers: schema-level `permissions` (checked in the DO before data reaches
a socket) and the one additional narrowing (`delete: 'own'`). If asked to
prove it live rather than describe it: open two browser profiles, sign in
as two different accounts, have one create a case, and try to delete it
from the other — the button won't even be there (UI), but the stronger
answer is to open devtools and note that even a fabricated delete request
over the socket gets refused server-side (this is literally what
`tests/api.spec.ts`'s RBAC tests do, just in Playwright instead of
devtools).

### Coding exercise for this phase

Implement the "reopen note" feature described in
`docs/CODE_WALKTHROUGH.md`'s practice exercise for this feature: when a
case's status changes from `resolved`/`false_positive` back to
`open`/`investigating`, automatically create a `caseNotes` row saying who
reopened it. Constraints to work within:

- Don't add a new server action unless you can articulate why the existing
  client-side `put` isn't enough on its own (it probably is — this is a
  "call `createConfirmed` right after `put` resolves" problem, not a
  multi-collection-orchestration problem, which is exactly the judgment
  call the "one server action, not a blanket policy" principle is testing).
- Write at least one test: reopening a resolved case adds exactly one new
  note, and resolving an already-open case does NOT add one (the
  transition direction matters, not just "status changed").
- Verify by hand in the running app, not just by reading your own code: a
  case you resolve, then reopen, should show the system note in its thread
  without a page refresh.

## Explaining Isolation Forest and ML Scores

### The 30-second explanation

"We added a second, independent anomaly detector alongside the rule-based
one. It's a scikit-learn Isolation Forest — an unsupervised model that
isolates unusual data points by how few random splits it takes to
separate them from everything else. It runs once, offline, outside the
app — Cloudflare Workers can't run Python — and only its output, a score
and a flag per event, gets imported into DeepSpace. We evaluated it
against synthetic ground-truth labels: precision 0.56, recall 0.67, and
it's upfront in the docs that those numbers describe this synthetic
dataset, not real-world accuracy."

### The two-minute technical explanation

"Isolation Forest builds many random binary trees over the feature space.
A normal point is surrounded by similar points, so a tree needs many
splits to isolate it alone; an unusual point gets isolated in very few
splits, because a random cut is more likely to separate an extreme value
quickly. Average isolation depth across all trees is the signal — short
paths mean anomalous.

"We engineer 8 features per event from the actor's own history — time of
day, success/failure, gap since their last event, distance and implied
speed from their last login, device novelty, and a rolling failed-login
count — all computed in a pure Python module with zero access to the
ground-truth labels, which a test enforces structurally, not just by
convention.

"Scikit-learn's `decision_function()` gives a raw score where, by its own
documentation, lower means more abnormal. We invert that and min-max
normalize it to exactly [0, 1], so higher means more anomalous — verified
against the real output, not assumed. The binary outlier flag is a
separate call, `model.predict()`, driven by a `contamination=0.05`
parameter we set from the dataset's own known injection rate — which is
itself a disclosed simplification, since a real deployment wouldn't know
that in advance.

"We evaluate against the synthetic ground truth only at the very end,
after scoring: precision 0.56, recall 0.67, F1 0.61. The model catches
100% of two of the three injected patterns but only 17.6% of the third —
new-device novelty alone is a weaker isolation signal than a large
geographic jump or a login burst. That's a real, informative finding
about the feature set, not something we tuned away.

"The whole thing runs once, by hand, in a Python venv that never ships —
the deployed app only ever imports a static JSON file of scores, the same
admin-gated background-job pattern used everywhere else in this app for
bulk data operations."

### At least 10 realistic interview questions, with technically accurate answers

1. **"Does Isolation Forest need labeled training data?"** No — `.fit(X)`
   takes no `y`. It's purely unsupervised; the labels are used only
   afterward, for evaluation.
2. **"What's the actual score your app stores, and what's its range?"**
   `mlAnomalyScore`, a float in exactly `[0.0, 1.0]`, higher = more
   anomalous — derived from `-decision_function()`, min-max normalized.
   Verified against the real committed data: the min and max are
   literally 0.0 and 1.0.
3. **"Is the outlier flag just `score > 0.5`?"** No — that's a common
   wrong guess. `mlIsOutlier` comes from a separate `model.predict()`
   call, using scikit-learn's own `contamination`-derived decision
   boundary, not a hand-picked threshold on the stored score.
4. **"Why `decision_function()` instead of `score_samples()`?"**
   `decision_function()` already incorporates the fitted
   `contamination`-based offset (so 0 is meaningfully "the boundary"),
   which lines up with wanting a score whose sign/magnitude already
   reflects the chosen contamination; `score_samples()` is the more raw,
   offset-free form. (Honest follow-up if pushed further: both are
   monotonic transforms of the same underlying isolation depth, so the
   *ranking* of events would be identical either way — the choice mainly
   affected convenience of deriving the final normalization, not which
   events end up more or less anomalous relative to each other.)
5. **"How do you prevent data leakage?"** `engineer_features()` never
   receives `groundTruthAnomaly`/`groundTruthReason` — a test passes
   events where those keys are entirely absent and confirms it still
   works, which is a structural guarantee, not a promise.
6. **"Why does the model do so much worse on `new_device_odd_hour`?"**
   Device novelty is one binary feature among eight; the other injected
   patterns (impossible travel, brute-force burst) push multiple features
   to extreme values simultaneously (huge implied speed *and* a big
   distance; a high failed-count *and* repeated short gaps), which
   isolates faster. One modest binary signal isolates less aggressively.
7. **"What would change if you didn't know the true contamination rate?"**
   We'd have to pick a generic default (or tune it some other way), and
   precision/recall would very likely shift — this is explicitly called
   out as a disclosed limitation, not hidden.
8. **"Is this evaluation measuring generalization?"** No — it's in-sample:
   the model is fit and scored on the same dataset, because there's no
   "future" data for a static historical dataset. It measures agreement
   with three known, injected patterns in this dataset, not how the model
   would do on new, unseen traffic.
9. **"How does this get from a Python script into the live app?"** The
   script writes `src/data/ml-scores.json`, committed to the repo. An
   admin clicks "Import ML scores," which enqueues a background job that
   does one `tools.update` per event, keyed by the same `eventId` used as
   the record id everywhere else.
10. **"What happens if an admin clicks import twice?"** Nothing bad —
    `tools.update` can only patch an existing row (the SDK's own
    `records.update` refuses to create one), so it's idempotent by a
    guarantee from the platform, not just careful coding. And because the
    patch only touches `mlAnomalyScore`/`mlIsOutlier`, the statistical
    score fields are never affected.
11. **"Could you deploy this model to run live, inside the Worker?"** No —
    Cloudflare Workers run JavaScript/Wasm, not Python; there's no runtime
    there that could import scikit-learn. That's the actual constraint
    driving the whole offline-import design, not a stylistic choice.

### Precision, recall, and F1 — how to explain them

- **Precision** = TP / (TP + FP): of everything the model flagged, what
  fraction was a real injected anomaly? (0.56 here — 28 of the 50 flagged
  events were real.)
- **Recall** = TP / (TP + FN): of everything that's actually anomalous,
  what fraction did the model catch? (0.667 — 28 of 42 real anomalies.)
- **F1** = 2 × precision × recall / (precision + recall): the harmonic
  mean, a single number that penalizes a big gap between the two more
  than a plain average would. (0.609.)
- Confusion matrix to have memorized: TN=936, FP=22, FN=14, TP=28 (sums
  to 1,000, the full dataset).

### Why the model performs differently across anomaly types

Already covered above (Q6) — worth being able to say in one sentence:
"features that move multiple signals at once isolate more aggressively
than features that move only one."

### Why ML scores are not attack probabilities

Three reasons, memorize all three, not just one: (1) the score is
min-max-normalized *within this dataset*, so it's relative to this run,
not an absolute probability; (2) the model never saw a label, so
"isolated easily" is a hypothesis about maliciousness, not a guarantee
built into the math; (3) the outlier flag depends on an assumed
contamination rate that was informed by *knowing* the injection rate —
a real deployment wouldn't have that luxury.

### How to explain statistical-vs-ML disagreements

Lead with: "they're not supposed to always agree — they're built from
different information." Then the concrete example: the real false
negative `evt_000036` (`docs/CODE_WALKTHROUGH.md`'s Example C) — a true
`new_device_odd_hour` anomaly the statistical detector catches by rule,
that the ML model scored only 0.56 (below its ~0.706 boundary) because
device novelty alone didn't isolate it strongly enough among eight
features. That's a specific, real, nameable disagreement — much stronger
in an interview than "they can differ in general."

### How to explain the model's limitations and engineering tradeoffs

- Synthetic, author-designed data — the model is finding patterns its own
  author knows are there.
- `contamination` informed by the known injection rate, not discovered
  blind.
- In-sample scoring, not a generalization test.
- No adversarial evaluation.
- The tradeoff of choosing simple, explainable numeric features over a
  larger, more expressive feature set (e.g. no categorical one-hot
  encoding) — kept the model's behavior easy to reason about and explain,
  at the cost of not capturing every possible signal (e.g. country-level
  risk, which is partially but not fully captured by the distance/speed
  features).

### Coding exercise 1 — extend a feature, verify it with tests

Add a 9th feature, `is_first_event_for_actor` (0/1) — this currently has
to be *inferred* from `minutes_since_prev_event` hitting its 10,080
sentinel value; making it explicit is a reasonable, well-scoped change.

**Instructions:**
1. Add the feature to `FEATURE_NAMES` and compute it in
   `engineer_features()` in `scripts/ml/features.py`.
2. Write at least one test in `test_features.py` asserting it's exactly
   `1.0` for each actor's first chronological event and `0.0` for every
   other event of theirs.
3. Re-run `pytest scripts/ml` — all existing tests should still pass
   unmodified (adding a feature shouldn't break anything that doesn't
   reference `FEATURE_NAMES`'s exact length).
4. Re-run `python scripts/ml/train_and_evaluate.py` and compare the new
   precision/recall/F1 to the committed report's 0.560/0.667/0.609.

**Expected outcome:** the numbers may shift slightly (a 9th feature
changes the split geometry) or may barely move — both are legitimate,
informative results. Don't chase a "better" number; report what actually
happened and reason about *why*, the same way the project's own report
treats the `new_device_odd_hour` gap as a finding, not a failure to fix.

**Keep this implementation for yourself to complete** — it's good,
genuine practice for exactly the kind of live modification a DeepSpace
interview might ask for.

### Coding exercise 2 — precision, recall, and F1 without scikit-learn

Recompute the confusion matrix and precision/recall/F1 directly from
`src/data/ml-scores.json` and `src/data/synthetic-auth-events.json`,
**without calling any `sklearn.metrics` function** — plain loops and
arithmetic only.

**Instructions:**
1. Load both JSON files; join them on `eventId`.
2. For each event, compare `groundTruthAnomaly` (actual) against
   `mlIsOutlier` (predicted) and increment one of four counters: TP, FP,
   TN, FN.
3. Compute `precision = TP / (TP + FP)`, `recall = TP / (TP + FN)`,
   `f1 = 2 * precision * recall / (precision + recall)`.
4. Compare your numbers against the committed report's 0.560 / 0.667 /
   0.609 — they should match exactly (to rounding), since this is the
   same calculation scikit-learn's metric functions perform internally,
   just written out by hand.

**Expected outcome:** an exact match. If it doesn't match, the bug is
almost certainly in how you're joining the two files (check for a typo'd
key name, or comparing the wrong pair of fields) — that's a more valuable
debugging exercise than getting it right on the first try.

**Keep this implementation for yourself to complete** as well — this
exercise is specifically about being able to derive precision/recall/F1
from first principles on a whiteboard, not about trusting a library
function.

## Phase 3 (ML): the six things you were asked to be able to explain

**1. How Isolation Forest works.** Random trees, random splits. A normal
point takes many splits to end up alone in a leaf; an unusual point gets
isolated in far fewer, because a random cut is likelier to separate an
extreme value fast. Average isolation-path length across all trees,
inverted, is the anomaly score. No labels anywhere in that process —
practice saying "it finds structure, I never tell it what anomalous means."

**2. Why offline inference was chosen.** Not a preference — a hard
constraint. Cloudflare Workers run JS/Wasm; there is no Python runtime in
the deployed app. The model runs once, by a human, outside the app; only
its numeric output (score + flag per event) ever reaches DeepSpace, via
the same admin-gated background-job pattern as every other bulk operation
in this app.

**3. How features are generated.** Eight numeric features per event,
computed per-actor from their own history (`scripts/ml/features.py`):
time-of-day/weekend, failed/success, gap since the actor's previous event,
geographic distance and implied speed from their previous event, device
novelty, and a rolling failed-login count. Skewed ones get a `log1p`
transform. None of it touches the ground-truth labels — practice pointing
at `test_engineer_features_never_reads_ground_truth` as the proof, not
just the design.

**4. How scores are mapped to events.** Every feature row and every score
is keyed by the dataset's stable `eventId` — the same id used as the
DeepSpace `recordId` throughout the whole app. `ml-scores.json` is a flat
list of `{eventId, mlAnomalyScore, mlIsOutlier}`; the import job does one
`tools.update('authEvents', eventId, {...})` per row. There's no
"matching" logic to get wrong because the key was chosen to be the same
key everywhere, on purpose, back on Day 1.

**5. How precision and recall are calculated.** Standard binary
classification against `groundTruthAnomaly`: precision = TP/(TP+FP) — of
everything the model flagged, how much was really injected; recall =
TP/(TP+FN) — of everything actually injected, how much the model caught.
Both computed with `sklearn.metrics` against the model's `mlIsOutlier`
flag, not the continuous score. Practice reciting the confusion matrix
numbers from `docs/ML_EVALUATION_REPORT.md` (TN=936, FP=22, FN=14, TP=28)
and deriving precision/recall from them by hand on a whiteboard.

**6. What limitations exist with synthetic data.** Lead with this, don't
wait to be asked: the three patterns are the same ones the generator
injects, so the model is finding patterns its own author already knows
are there; `contamination` was informed by the known injection rate, which
a real deployment wouldn't have; this is in-sample scoring, not a
generalization test; and the numbers say nothing about real-world
detection accuracy. All four are written down in the report's own
"Limitations" section — know it well enough to summarize unprompted.

### Coding exercise for this phase

Add precision/recall **broken down by ground-truth pattern type**
(currently the report only shows "flagged rate" per pattern, not a true
per-pattern precision/recall — those aren't the same number, and the
difference is the exercise). Specifically:

- For each `groundTruthReason` value (including the implicit "benign"
  bucket), compute how many of the model's **false positives** came from
  benign events that happen to share that reason's characteristics — this
  requires grouping by predicted-vs-actual, not just actual.
- Write a test with a small synthetic set (4-6 events, 2 reasons, known
  TP/FP/FN by hand) asserting your per-pattern numbers match a calculation
  you did with pencil and paper first — not just "the code runs."
- Decide whether this belongs in `build_report()` (recomputed every run)
  or as a separate one-off script — and be ready to justify whichever you
  pick the same way `docs/CODE_WALKTHROUGH.md` justifies every design
  choice in this project: not "it seemed easier" but a specific tradeoff
  named out loud.

## Incident-management extension: the things you were asked to be able to explain

Built after the five required P0 items, as a separate, explicitly
2-day-scoped enhancement. The rubric categories below are the ones this
extension was specifically asked to cover: server-side authorization,
non-atomic writes, idempotency, state transitions, activity history, data
modeling, and real-time synchronization. Full reasoning in
`docs/ARCHITECTURE.md`'s "Incident-management extension" section and the
file-level walkthrough in `docs/CODE_WALKTHROUGH.md`'s matching "Feature"
section — this section is the compressed, interview-ready version.

**1. Data modeling — why extend `cases` instead of a new `incidents`
entity.** A confirmed incident is a `cases` row that crossed a threshold
(an analyst decided it's real), not a different kind of object. Two
additive columns (`severity`, `confirmedIncidentAt`) plus one new child
collection (`caseActivity`) got the same lifecycle as a separate entity
would, with zero migration risk — every existing row stays valid with no
backfill, which is DeepSpace's documented pattern for adding a column.

**2. State transitions — `transitionCase`'s shape.** One generic action,
not four, because `status`/`severity`/`priority`/`assignedTo` share the
identical validate → no-op-check → update → record-activity shape; only
the allowed values differ, which is a dispatch-table difference, not a
reason for four near-identical functions. The no-op guard (reject a
transition whose target value already matches the current one) does two
jobs at once: it keeps the activity log free of meaningless noise, and it
closes off the one obvious "just resend it" recovery path if an activity
write drops — see point 4.

**3. Server-side authorization — the actual boundary, and how to prove
it.** `cases`' `member.writableFields` now excludes every protected field,
so a direct client write to `status` (or `severity`/`priority`/
`assignedTo`/`confirmedIncidentAt`) is refused **by the Durable Object
itself** — not by the UI declining to offer a button. Proven, not assumed:
a raw-WebSocket test sends the literal `core.put` message the SDK would
send, gets back `core.error` with `"cannot modify field 'status'"`, and a
reload confirms the value genuinely didn't change. A second test sends the
same shape of message for `summary` and confirms it IS accepted — proving
the lockdown is field-specific, not a side effect of something else
breaking.

**4. Non-atomic writes — say this before being asked.** RecordRoom has no
cross-collection transaction primitive. Every transition does two writes
in a fixed order (the case field, then the `caseActivity` row) and returns
`activityRecorded: false` alongside `success: true` for the case where the
first write succeeded and the second didn't. This was genuinely induced in
a test (a fake `tools` where `create` fails) and asserted to behave this
way — not a theoretical disclaimer. A further test documents, on purpose,
that resubmitting the identical transition to "recover" a dropped activity
record is rejected by the same no-op guard from point 2 — a real,
named limitation, not something quietly left for someone else to discover.
A reconciliation job (diffing `cases` against `caseActivity` for gaps) was
deliberately not built in this 2-day scope.

**5. Idempotency — how this differs from Day 1's import idempotency.**
Day 1's idempotency was "importing the same 1,000 events twice doesn't
duplicate rows" (an upsert via `tools.create(..., recordId)`). This
feature's idempotency is narrower and stricter: the SAME transition
request submitted twice must have NO effect the second time, which is
exactly the no-op guard — and it's also exactly what makes activity-record
recovery-by-retry impossible (idempotency and recoverability pulled in
opposite directions here, and idempotency won, deliberately).

**6. Activity history — what it promises and what it explicitly doesn't.**
A plain `useQuery('caseActivity', { where: { caseId } })`, live like every
other query in the app — no polling, no refresh button. It is documented,
in the code, in the UI caption, and here, as **best-effort, not
guaranteed-complete or transactional**. Never describe it in an interview
as a complete audit log; describe it as "a record of every change that
was successfully recorded, with an honest, tested gap for the rare case
where it wasn't."

**7. Real-time synchronization — how you'd prove it live, not just
describe it.** Open two signed-in sessions as two different analysts,
neither the case's creator exclusively privileged over the other — have
one (deliberately the NON-owner, to also prove authorization isn't
creator-restricted) change severity and confirm the incident, and watch
the other's already-open page update the severity select, the confirmed
badge, the timestamp, and the activity history, with no reload. This is
exactly what `tests/collab.spec.ts`'s extended two-analyst test does.

### Coding exercises for this extension

**1. Build the reconciliation job this extension deliberately doesn't
have.** An admin-gated `JobRoom` job that diffs `cases` (every row with a
non-default `status`, or a set `confirmedIncidentAt`) against
`caseActivity` and reports — don't auto-repair — cases whose current
field values have no activity entry explaining how they got there. Then
think through (you don't have to build it): once a value has already
changed, you no longer know what it changed *from* — how would a safe
backfill even reconstruct that? This is the same wall `transitionCaseWith`
runs into from the write side; your job hits it from the read side.

**2. Add a sixth transitionable "field": a free-text resolution reason.**
`cases` doesn't currently require a reason when a case moves to
`resolved`/`false_positive`. Extend `transitionCase` so that transitioning
`status` specifically to one of those two values requires a non-empty
`reason` string in `params`, stores it as the `toValue` of a NEW
`eventType` (`resolution_reason`) activity row **in addition to** the
normal `status_change` row (two activity rows from one call — decide
whether that's one `tools.create` call or two, and whether a failure on
the second one should roll back anything, given there's no transaction
primitive to roll back WITH). Write a test proving a case can't be
resolved without a reason, and that reopening it later doesn't require one
(the requirement is directional, not symmetric).

## Day 1 learning session (~20-25 min)

Read this once, then close the laptop and try to explain it to someone
(or to yourself, out loud) without looking. If you get stuck, that's the
spot to re-read.

**1. What got built today, in one sentence each (5 min).**
A shared helper so background jobs can write records the same RBAC-bypassing
way server actions do; three new collections (`authEvents`, `cases`,
`caseNotes`) with their access rules decided up front; one deterministic
script that generates a fake-but-realistic auth log and commits it to the
repo; a background job that loads that log into the live database
idempotently; and an admin page + server-side check so only admins can
trigger that.

**2. The one idea that ties it together (5 min).**
Everything server-side in this app goes through the exact same choke point:
a request either comes from a real, RBAC-checked client write (governed by
the `permissions` block on a schema), or it comes from trusted app-owned
code using `X-App-Action` (a job or, later, a server action) which bypasses
that check entirely because it's not a user acting — it's the system.
Drawing that line clearly is *the* DeepSpace security model. Practice
drawing it for a stranger: "there are exactly two ways data gets written in
this app, and here's how each one is gated."

**3. The bug that's worth retelling (5 min).**
Re-read `docs/DEBUGGING_LOG.md` Incident 1. The interesting part isn't the
fix, it's *how it was found*: not a crash, not a test failure — a human
noticing that generated data looked wrong and checking. Practice saying out
loud: "I didn't trust that the generator was correct just because it ran
without errors, so I looked at the actual output."

**4. What's genuinely not done yet, and why that's fine to say (5 min).**
The import job's full happy path (admin clicks → 1,000 rows land) hasn't
been clicked through in a real browser yet, because the only account that
can prove it is the real app-owner OAuth account, which test accounts can't
impersonate. Saying this plainly, with the reason, is a better answer than
pretending it's been verified.

**5. One thing to go try yourself before Day 2 (5 min).**
Open local dev (`npx deepspace dev start`), sign in with your real account,
visit `/admin`, click "Import synthetic events," and watch it finish. Then
look at the result in the job list. This closes the one honest gap from
today's report — do it before Day 2 starts.

## Incident-management extension — Day 2 learning session (~20-25 min)

**1. What got built today, in one sentence each (5 min).**
A severity selector and a "Confirm as incident" control on the case detail
page, both routed through the server actions built on Day 1; a read-only
activity-history section rendering every `caseActivity` row as a plain
sentence with loading/empty/error states; and a two-analyst Playwright
test extended to prove severity changes, incident confirmation, and the
activity feed all sync live — with the non-owner analyst doing the
confirming, to also prove it isn't creator-restricted.

**2. The one idea that ties it together (5 min).**
Day 1 built the lock (`writableFields`) and the only two keys that still
fit it (`transitionCase`, `confirmIncident`). Day 2 is just giving analysts
a way to actually turn those keys from the UI, and a way to see what's
been turned — no new security decisions were made today, only UI wired
onto yesterday's boundary. Practice saying that distinction out loud: "the
hard decision was yesterday; today was wiring a button to it."

**3. The thing that's easy to get wrong if you don't say it first (5
min).** The activity history looks exactly like a normal audit log — a
list of rows with a timestamp and who did it. It is NOT a guaranteed one.
Say this before being asked: "RecordRoom can't write to two collections
atomically, so this is best-effort, and I have a test that proves what
happens on the rare drop." Saying it unprompted reads as engineering
maturity; waiting to be caught reads as not having thought about it.

**4. What's genuinely still open, and why that's fine to say (5 min).**
No reconciliation job exists to detect or repair a dropped activity
record — it was deliberately left as a coding exercise rather than built,
because building it safely (see exercise 1 above) is a real design
problem, not a quick addition, and this extension was explicitly scoped
to 2 days.

**5. One thing to go try yourself (5 min).**
In local dev, open two browser profiles signed in as two different
analysts. Have one confirm a case as an incident and set its severity;
watch the other's already-open case page update both, live, with no
reload. Then open the activity history and read the sentences out loud —
if any of them don't read as a clear, specific description of what
changed, that's worth fixing before you'd want to show this in an
interview.
