/**
 * Cases — analyst investigations opened against one or more flagged
 * authEvents rows. Built Day 3 (see docs/ARCHITECTURE.md); the schema is
 * locked in now, alongside authEvents, so the running app never needs a
 * data migration mid-build.
 *
 * This is a small, single shared workspace: every analyst (`member`) can see
 * and work every case, matching the "team of analysts investigating
 * together" brief. There's no per-case collaborator list — that's the
 * `'shared'`/`collaboratorsField` pattern DeepSpace uses for private
 * multi-user docs, and it's more than this app needs.
 *
 * Incident-management extension (post-Phase-4): `severity` and
 * `confirmedIncidentAt` are additive columns — existing rows without them
 * remain perfectly valid, no migration needed (DeepSpace's documented
 * "add a field without losing data" pattern).
 *
 * `writableFields` on `member` is the real security boundary this
 * extension adds: `status`/`severity`/`priority`/`assignedTo`/
 * `confirmedIncidentAt` are deliberately EXCLUDED, so a direct client
 * write to any of them — bypassing the `transitionCase`/`confirmIncident`
 * server actions entirely — is rejected by the Durable Object itself, not
 * just hidden in the UI. Only `title`, `summary`, and `relatedEventIds`
 * remain directly client-writable. See
 * tests/api.spec.ts's "protected fields cannot be changed through a
 * direct write" for the proof, and docs/ARCHITECTURE.md for why this
 * specific set of fields was chosen.
 */

import type { CollectionSchema } from 'deepspace/schema'

export const casesSchema: CollectionSchema = {
  name: 'cases',
  columns: [
    { name: 'title', storage: 'text', interpretation: 'plain', required: true, maxLength: 200 },
    {
      name: 'status',
      storage: 'text',
      interpretation: {
        kind: 'select',
        options: ['open', 'investigating', 'resolved', 'false_positive'],
      },
      default: 'open',
    },
    {
      name: 'priority',
      storage: 'text',
      interpretation: { kind: 'select', options: ['low', 'medium', 'high'] },
      default: 'medium',
    },
    {
      name: 'severity',
      storage: 'text',
      interpretation: { kind: 'select', options: ['low', 'medium', 'high', 'critical'] },
    },
    { name: 'confirmedIncidentAt', storage: 'text', interpretation: 'plain' },
    { name: 'assignedTo', storage: 'text', interpretation: 'plain' },
    { name: 'relatedEventIds', storage: 'text', interpretation: { kind: 'json' } },
    { name: 'summary', storage: 'text', interpretation: 'plain', maxLength: 4000 },
  ],
  permissions: {
    '*': { read: false, create: false, update: false, delete: false },
    viewer: { read: false, create: false, update: false, delete: false },
    member: {
      read: true,
      create: true,
      update: true,
      delete: 'own',
      writableFields: ['title', 'summary', 'relatedEventIds'],
    },
    admin: { read: true, create: true, update: true, delete: true },
  },
}
