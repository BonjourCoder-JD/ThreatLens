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
analysts.

## DeepSpace capabilities and integrations used

- **Authentication** (`DeepSpaceAuthProvider`, `<AuthGate>`) — no custom
  auth code; sign-in via Google/GitHub.
- **RecordRoom** — four collections (`users`, `authEvents`, `cases`,
  `caseNotes`) with role-based permissions enforced server-side in the
  Durable Object.
- **JobRoom (background jobs)** — four admin-gated background jobs for
  bulk data operations (synthetic-data import, statistical recompute,
  ML-score import).
- **Server actions** — one, for the one operation that genuinely needed
  multi-collection orchestration (opening a case and its origin note
  together).
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
the case-investigation workflow, the UI, and the automated test suite
(Playwright, Vitest, pytest) were built collaboratively, with me directing
scope, reviewing the approach at each phase, and approving each phase
before the next began. Claude's own reports throughout development
(`docs/DEBUGGING_LOG.md` in particular) document several real bugs it
found and fixed during its own work — a data-quality bug in the synthetic
generator, a layout bug that rendered a chart blank, a file-encoding bug
that corrupted the ML report, and a test-cleanup bug that silently left
junk data in the dev database — each diagnosed and fixed as part of that
collaborative process, not invented after the fact.

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
- [ ] **Not yet done:** personally clicked "Import ML scores" in the
  running app and confirmed the result (Claude verified the underlying
  Python pipeline and the job's logic directly, and confirmed a non-admin
  cannot trigger it, but has not — and structurally cannot — click the
  real admin button itself; that step is reserved for you).
- [ ] **Not yet done:** reviewed the dashboard's filter/summary behavior
  against real, populated data with your own eyes end-to-end as a final
  UX pass (Claude's automated tests cover this functionally, but a human
  product read-through is still worth doing before submission).
- [ ] **Not yet done:** deployed the app (`npx deepspace deploy`) and
  confirmed the live URL loads and behaves correctly for a reviewer
  without your local dev environment.
- [ ] **Not yet done:** a fresh-eyes read-through of this submission note
  and the README before actually submitting.

---

*Fill in or adjust the checked items above to match what you've actually
done by the time you submit — don't leave a checked box that doesn't
reflect something you personally did.*
