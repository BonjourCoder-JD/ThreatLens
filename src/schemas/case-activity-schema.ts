/**
 * Case Activity — the server-generated, tamper-resistant audit trail for
 * protected case-field changes (status, severity, priority, assignment,
 * incident confirmation). Built alongside the incident-management
 * extension to `cases` (see docs/ARCHITECTURE.md).
 *
 * `create: false` for EVERY role, including admin. This is deliberate and
 * is the actual mechanism behind "clients cannot directly create or modify
 * activity records" — not a convention, a server-enforced rule: the only
 * way a row reaches this collection is through `src/actions/case-
 * actions.ts`'s `transitionCase`/`confirmIncident`, which write via the
 * RBAC-bypassing `X-App-Action` path specifically because this schema's
 * own permissions block would otherwise refuse every client, including an
 * admin's own browser.
 *
 * Read-only, once written: `update`/`delete` are `false` for every role
 * too — an activity record, once created, cannot be edited or deleted by
 * anyone through the client. (The actions above don't need to update or
 * delete one either — every transition creates a new record.)
 *
 * Actor attribution comes from the envelope's `createdBy`, set
 * automatically from the verified caller's JWT subject when the action
 * calls `tools.create` — never from a client-supplied field. There is no
 * "actor" column on this schema; `createdBy` already is one, and a second,
 * client-settable one would just be a way to lie about it.
 */

import type { CollectionSchema } from 'deepspace/schema'

export const caseActivitySchema: CollectionSchema = {
  name: 'caseActivity',
  columns: [
    {
      name: 'caseId',
      storage: 'text',
      interpretation: { kind: 'reference', targetTable: 'cases', displayColumn: 'title' },
      required: true,
    },
    {
      name: 'eventType',
      storage: 'text',
      interpretation: {
        kind: 'select',
        options: ['status_change', 'severity_change', 'priority_change', 'assignedTo_change', 'incident_confirmed'],
      },
      required: true,
    },
    { name: 'fromValue', storage: 'text', interpretation: 'plain' },
    { name: 'toValue', storage: 'text', interpretation: 'plain', required: true },
  ],
  permissions: {
    '*': { read: false, create: false, update: false, delete: false },
    viewer: { read: false, create: false, update: false, delete: false },
    member: { read: true, create: false, update: false, delete: false },
    admin: { read: true, create: false, update: false, delete: false },
  },
}
