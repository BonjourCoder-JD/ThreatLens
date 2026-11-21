/**
 * Case Notes — the collaborative timeline on a case. Built Day 3 alongside
 * the cases UI; schema locked in now with authEvents/cases (see
 * docs/ARCHITECTURE.md for why).
 */

import type { CollectionSchema } from 'deepspace/schema'

export const caseNotesSchema: CollectionSchema = {
  name: 'caseNotes',
  columns: [
    {
      name: 'caseId',
      storage: 'text',
      interpretation: { kind: 'reference', targetTable: 'cases', displayColumn: 'title' },
      required: true,
    },
    { name: 'body', storage: 'text', interpretation: 'plain', required: true, maxLength: 4000 },
  ],
  permissions: {
    '*': { read: false, create: false, update: false, delete: false },
    viewer: { read: false, create: false, update: false, delete: false },
    member: { read: true, create: true, update: 'own', delete: 'own' },
    admin: { read: true, create: true, update: true, delete: true },
  },
}
