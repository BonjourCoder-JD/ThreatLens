# ThreatLens — Draft Submission Note

A draft for you to personalize and submit — not a final document. Replace
anything that doesn't reflect how you actually want to describe your own
process, and fill in the verification items marked **[ ] not yet done**
before submitting, or note honestly that they're still open.

---

## What I built

ThreatLens is a collaborative authentication-anomaly investigation tool:
analysts review a live feed of authentication events, each scored by two
independent detectors — an explainable statistical rule engine and an
offline Isolation Forest ML model — and can open flagged events into
tracked, collaborative case investigations with status, priority,
assignment, and a shared note thread, synced in real time across
analysts. A follow-on incident-management extension adds severity, a
one-way "confirm as incident" step, and a server-attributed activity
history, so a case can move from flagged anomaly to confirmed incident to
tracked response with a real (if honestly best-effort, not transactional)
audit trail.

## DeepSpace capabilities and integrations used

- **Authentication** (`DeepSpaceAuthProvider`, `<AuthGate>`) — no custom
  auth code; sign-in via Google/GitHub.
- **RecordRoom** — five collections (`users`, `authEvents`, `cases`,
  `caseNotes`, `caseActivity`) with role-based AND field-level permissions
  enforced server-side in the Durable Object.
- **JobRoom (background jobs)** — four admin-gated background jobs for
  bulk data operations (synthetic-data import, statistical recompute,
  ML-score import).
- **Server actions** — `createCaseFromEvents` for multi-collection
  orchestration at creation, and `transitionCase`/`confirmIncident` for the
  incident-management extension — the only path that can change a
  protected case field, each pairing the change with a server-attributed
  activity record.
- **Field-level RBAC** (`writableFields`) — `cases` now restricts which
  fields a `member` can write directly, the actual mechanism forcing
  status/severity/priority/assignment/confirmation changes through the
  two actions above instead of a direct client write.
- **Real-time sync** (`useQuery`/`useMutations`) — every live update in
  the app, with no polling or manual refresh.
- No separate backend, database, or inference server — the one offline
  component (the ML training script) runs locally and only its static
  output is ever imported into DeepSpace.

## The main engineering tradeoff

Running real anomaly detection against synthetic data forced an explicit
choice between two kinds of "second opinion": a rule-based detector you
can fully explain to an analyst, versus a model that can find structure
no one wrote a rule for but can't explain itself. Rather than pick one,
ThreatLens ships both, clearly labeled as different things with different
guarantees, and is explicit everywhere (dashboard UI, documentation, the
evaluation report) about what each one is and isn't — including that the
ML evaluation numbers describe agreement with synthetic, author-injected
patterns, not real-world detection accuracy.

## What Claude implemented or assisted with

I worked with Claude (Anthropic's Claude Code) throughout this project's
implementation: schema design, the statistical detection engine, the
offline ML pipeline (feature engineering, model training, evaluation),
the case-investigation workflow, the incident-management extension
(protected-field RBAC, the `transitionCase`/`confirmIncident` server
actions, the activity history), the UI, and the automated test suite
(Playwright, Vitest, pytest) were built collaboratively, with me directing
scope, reviewing the approach at each phase, and approving each phase
before the next began. The incident-management extension specifically
went through its own pre-implementation GO/NO-GO review before any code
was written. Claude's own reports throughout development
(`docs/DEBUGGING_LOG.md` in particular) document several real bugs it
found and fixed during its own work — a data-quality bug in the synthetic
generator, a layout bug that rendered a chart blank, a file-encoding bug
that corrupted the ML report, and a test-cleanup bug that silently left
junk data in the dev database — each diagnosed and fixed as part of that
collaborative process, not invented after the fact. For the
incident-management extension, the same report documents a genuinely
induced (not assumed) partial-failure scenario — a case's protected-field
write succeeding while its paired activity write fails — proven with a
real test, and an honest, named limitation (no reconciliation mechanism
for a dropped activity record) left open rather than glossed over.

**I am not claiming to have independently written the implementation.**
This was AI-assisted development under my direction and review, and I
can explain, modify, and debug the resulting codebase — which is the
actual skill a live coding interview is assessing, not whether every line
was typed by a human.

## What I personally verified or modified

- [x] Ran the Day 1 synthetic-event import against the real app myself
  (as the app owner) and confirmed: 1,000 events imported, a second import
  run left the count at exactly 1,000 (idempotent), and the statistical
  recompute correctly flagged 48 of 1,000 events.
- [x] Personally clicked "Import ML scores" in the running app and
  confirmed the result, as part of a guided manual-verification pass
  after deployment.
- [x] Reviewed the dashboard's filter/summary behavior against real,
  populated data with your own eyes end-to-end, as part of that same
  verification pass.
- [x] Deployed the app (`npx deepspace deploy`) and confirmed the live
  URL (https://threatlens-jd.app.space) loads and behaves correctly for
  a reviewer without your local dev environment — confirmed by you and
  independently by read-only automated checks against the live URL
  (every main route, zero console errors, mobile viewport).
- [x] Personally clicked through the incident-management extension in
  the running app — set a severity, clicked "Confirm as incident," and
  watched the activity history fill in.
- [ ] **Not yet done:** a fresh-eyes read-through of this submission note
  and the README before actually submitting.

---

*Fill in or adjust the checked items above to match what you've actually
done by the time you submit — don't leave a checked box that doesn't
reflect something you personally did.*
