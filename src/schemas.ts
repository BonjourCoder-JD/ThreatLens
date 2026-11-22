/**
 * Collection Schemas
 *
 * All collections with columns and RBAC permissions.
 * Single source of truth — imported by both worker and frontend.
 *
 * Add schemas by creating a file in src/schemas/ and importing it here.
 */

import type { CollectionSchema } from 'deepspace/schema'
import { usersSchema } from './schemas/users-schema'
import { authEventsSchema } from './schemas/auth-events-schema'
import { casesSchema } from './schemas/cases-schema'
import { caseNotesSchema } from './schemas/case-notes-schema'
import { caseActivitySchema } from './schemas/case-activity-schema'

export const schemas: CollectionSchema[] = [
  usersSchema,
  authEventsSchema,
  casesSchema,
  caseNotesSchema,
  caseActivitySchema,
]
