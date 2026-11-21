/**
 * Auth Events — synthetic authentication log entries.
 *
 * Rows are system-generated only: the `import-synthetic-events` background
 * job (src/jobs.ts) and the `recompute-stat-scores` job write every row via
 * the RBAC-bypassing tools in src/server/record-tools.ts. No role can create
 * or update rows through the client — analysts read and investigate, they
 * don't hand-edit the log.
 *
 * The record's `recordId` IS the synthetic dataset's stable `eventId`
 * (src/data/synthetic-auth-events.json). That makes both the initial import
 * and the later ML-score import idempotent for free: `tools.create(...,
 * eventId)` upserts (merges onto the existing row) instead of duplicating,
 * and `tools.update('authEvents', eventId, patch)` always targets the same
 * row no matter how many times a job reruns.
 */

import type { CollectionSchema } from 'deepspace/schema'

export const authEventsSchema: CollectionSchema = {
  name: 'authEvents',
  columns: [
    { name: 'timestamp', storage: 'number', interpretation: 'plain', required: true },
    { name: 'actorId', storage: 'text', interpretation: 'plain', required: true },
    { name: 'sourceIp', storage: 'text', interpretation: 'plain', required: true },
    { name: 'country', storage: 'text', interpretation: 'plain', required: true },
    { name: 'city', storage: 'text', interpretation: 'plain', required: true },
    { name: 'device', storage: 'text', interpretation: 'plain', required: true },
    {
      name: 'eventType',
      storage: 'text',
      interpretation: {
        kind: 'select',
        options: ['login', 'failed_login', 'mfa_challenge', 'password_reset'],
      },
      required: true,
    },
    { name: 'success', storage: 'number', interpretation: { kind: 'boolean' }, required: true },

    // Explainable statistical detector (src/jobs.ts: recompute-stat-scores).
    // Runs live, in TS, over the imported events — no external ML involved.
    { name: 'statAnomalyScore', storage: 'number', interpretation: 'plain', default: 0 },
    { name: 'statReasons', storage: 'text', interpretation: { kind: 'json' } },

    // Offline Isolation Forest enrichment (scripts/isolation_forest.py, Day
    // 3). Precomputed once against the exported canonical dataset, then
    // patched in by an admin-only import — never trained or run inside the
    // Worker.
    { name: 'mlAnomalyScore', storage: 'number', interpretation: 'plain' },
    { name: 'mlIsOutlier', storage: 'number', interpretation: { kind: 'boolean' } },

    // Synthetic ground truth, injected by the generator for the Day-3/4 ML
    // evaluation report ONLY (precision/recall against a known label). Never
    // surfaced to analysts as if it were a real verdict — it's a property of
    // the synthetic dataset, not a fact about the (fake) event.
    { name: 'groundTruthAnomaly', storage: 'number', interpretation: { kind: 'boolean' } },
    { name: 'groundTruthReason', storage: 'text', interpretation: 'plain' },

    // Which generator run produced this row — lets us tell "regenerated with
    // a bigger count" apart from "stale data from an old run" later.
    { name: 'datasetVersion', storage: 'text', interpretation: 'plain' },
  ],
  permissions: {
    '*': { read: false, create: false, update: false, delete: false },
    viewer: { read: false, create: false, update: false, delete: false },
    member: { read: true, create: false, update: false, delete: false },
    admin: { read: true, create: true, update: true, delete: true },
  },
}
