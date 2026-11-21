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
