/**
 * Server action for opening a case from one or more flagged authEvents.
 *
 * This is a genuine fit for a server action, not a reflexive wrapper around
 * a single-table insert: a case's creator legitimately could insert a
 * `cases` row directly via `useMutations` (the schema already grants
 * `member: create: true`) — but a case worth opening should also leave an
 * audit-trail note recording which events it was opened from, and that's
 * two collection writes that should either both happen or be visibly
 * reported if one half fails. That's exactly what the server-actions guide
 * means by "orchestrate writes across multiple collections in one
 * round-trip."
 */

import type { ActionHandler } from 'deepspace/worker'
import type { Env } from '../../worker'

const MAX_EVENTS_PER_CASE = 25

export const createCaseFromEvents: ActionHandler<Env> = async ({ params, tools }) => {
  const title = typeof params.title === 'string' ? params.title.trim() : ''
  const summary = typeof params.summary === 'string' ? params.summary.trim() : ''
  const eventIds = Array.isArray(params.eventIds)
    ? params.eventIds.filter((x): x is string => typeof x === 'string' && x.length > 0)
    : []

  if (!title) return { success: false, error: 'A case title is required.' }
  if (title.length > 200) return { success: false, error: 'Case title must be 200 characters or fewer.' }
  if (eventIds.length === 0) return { success: false, error: 'At least one event must be linked to the case.' }
  if (eventIds.length > MAX_EVENTS_PER_CASE) {
    return { success: false, error: `A case can link at most ${MAX_EVENTS_PER_CASE} events at creation time.` }
  }

  const caseResult = await tools.create('cases', {
    title,
    status: 'open',
    priority: 'medium',
    relatedEventIds: eventIds,
    summary,
  })
  if (!caseResult.success) return caseResult

  const caseId = caseResult.data.recordId
  const noteBody = `Case opened from ${eventIds.length} flagged event${eventIds.length === 1 ? '' : 's'}: ${eventIds.join(', ')}`
  const noteResult = await tools.create('caseNotes', { caseId, body: noteBody })

  return {
    success: true,
    data: { caseId, noteCreated: noteResult.success },
  }
}
