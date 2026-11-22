/**
 * Server actions for the case workflow: opening a case, and the
 * incident-management extension (transitioning protected fields and
 * confirming an incident), both of which pair a primary write with an
 * activity/audit write.
 *
 * ## Non-atomicity — read this before changing anything here
 *
 * RecordRoom has no multi-collection transaction primitive. Every action
 * below does its writes in a fixed order (the primary case write, then the
 * `caseActivity` write) and returns an explicit `activityRecorded: boolean`
 * alongside `success: true` when the primary write succeeded but the
 * activity write didn't. **This is deliberately not advertised as atomic,
 * and `caseActivity` is accurately documented as best-effort, not
 * guaranteed-complete** — see docs/ARCHITECTURE.md's "Audit consistency"
 * section and docs/DEBUGGING_LOG.md for the real, induced test proving
 * this exact scenario.
 *
 * A reliable retry/reconciliation mechanism (detecting and backfilling a
 * dropped activity record after the fact) was deliberately NOT built: the
 * no-op guard below (rejecting a transition that doesn't actually change
 * the value) is what keeps the activity log free of meaningless noise, but
 * it also means a naive "just retry the same call" can't recover a
 * genuinely dropped activity record — the retry would see the value
 * already matches and reject as a no-op. Building real reconciliation
 * (e.g. a scheduled job diffing `cases` against `caseActivity` for gaps)
 * is a real, identifiable piece of further work, not something papered
 * over here — see the "Known limitations" note in `README.md`.
 */

import type { ActionHandler, ActionTools } from 'deepspace/worker'
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

// ---------------------------------------------------------------------------
// Incident-management extension
// ---------------------------------------------------------------------------

const TRANSITIONABLE_FIELDS = ['status', 'severity', 'priority', 'assignedTo'] as const
type TransitionableField = (typeof TRANSITIONABLE_FIELDS)[number]

const FIELD_ENUMS: Record<'status' | 'severity' | 'priority', readonly string[]> = {
  status: ['open', 'investigating', 'resolved', 'false_positive'],
  severity: ['low', 'medium', 'high', 'critical'],
  priority: ['low', 'medium', 'high'],
}

function isTransitionableField(value: unknown): value is TransitionableField {
  return typeof value === 'string' && (TRANSITIONABLE_FIELDS as readonly string[]).includes(value)
}

/**
 * Changes exactly one protected field on a case (`status`, `severity`,
 * `priority`, or `assignedTo`) and records an activity entry for it.
 *
 * This is the ONLY path that can change these fields in normal operation —
 * `cases`' schema restricts `member.writableFields` to exclude all four
 * (src/schemas/cases-schema.ts), so a direct client write to any of them is
 * rejected by the Durable Object itself. This action bypasses that via the
 * standard `X-App-Action` RBAC-off path, the same mechanism every other
 * action/job in this app uses — it isn't a loophole, it's the documented
 * escalation path, and it's the only one.
 *
 * `tools` is accepted as a parameter (not just destructured from the
 * handler's own `ctx.tools`) so tests can inject a fake implementation and
 * exercise the "primary write succeeds, activity write fails" branch for
 * real — see src/actions/case-actions.test.ts.
 */
export async function transitionCaseWith(
  tools: ActionTools,
  params: Record<string, unknown>,
): Promise<ReturnType<ActionHandler>> {
  const caseId = typeof params.caseId === 'string' ? params.caseId : ''
  const field = params.field
  const value = typeof params.value === 'string' ? params.value : ''

  if (!caseId) return { success: false, error: 'caseId is required.' }
  if (!isTransitionableField(field)) {
    return { success: false, error: `Unknown or unsupported field '${String(field)}'.` }
  }

  if (field !== 'assignedTo') {
    const allowed = FIELD_ENUMS[field]
    if (!allowed.includes(value)) {
      return { success: false, error: `Invalid value '${value}' for ${field}. Allowed: ${allowed.join(', ')}.` }
    }
  } else if (value) {
    const userCheck = await tools.get('users', value)
    if (!userCheck.success) return { success: false, error: 'Unknown user id for assignment.' }
  }

  const current = await tools.get<Record<string, unknown>>('cases', caseId)
  if (!current.success) return current
  const fromValue = typeof current.data.record.data[field] === 'string' ? (current.data.record.data[field] as string) : ''

  if (fromValue === value) {
    return { success: false, error: `No change: ${field} is already set to '${value || '(none)'}'.` }
  }

  const updateResult = await tools.update('cases', caseId, { [field]: value })
  if (!updateResult.success) return updateResult

  const activityResult = await tools.create('caseActivity', {
    caseId,
    eventType: `${field}_change`,
    fromValue,
    toValue: value,
  })

  return {
    success: true,
    data: { caseId, field, fromValue, toValue: value, activityRecorded: activityResult.success },
  }
}

export const transitionCase: ActionHandler<Env> = async ({ params, tools }) => transitionCaseWith(tools, params)

/**
 * Confirms a case as a real security incident. The timestamp is generated
 * HERE, server-side (`new Date().toISOString()`) — never accepted from the
 * client — which is the actual answer to "do not trust client-supplied
 * timestamps": there is no `confirmedAt` field the client can pass at all.
 */
export async function confirmIncidentWith(
  tools: ActionTools,
  params: Record<string, unknown>,
): Promise<ReturnType<ActionHandler>> {
  const caseId = typeof params.caseId === 'string' ? params.caseId : ''
  if (!caseId) return { success: false, error: 'caseId is required.' }

  const current = await tools.get<{ confirmedIncidentAt?: string }>('cases', caseId)
  if (!current.success) return current
  if (current.data.record.data.confirmedIncidentAt) {
    return { success: false, error: 'This case is already confirmed as an incident.' }
  }

  const confirmedAt = new Date().toISOString()
  const updateResult = await tools.update('cases', caseId, { confirmedIncidentAt: confirmedAt })
  if (!updateResult.success) return updateResult

  const activityResult = await tools.create('caseActivity', {
    caseId,
    eventType: 'incident_confirmed',
    fromValue: '',
    toValue: confirmedAt,
  })

  return {
    success: true,
    data: { caseId, confirmedIncidentAt: confirmedAt, activityRecorded: activityResult.success },
  }
}

export const confirmIncident: ActionHandler<Env> = async ({ params, tools }) => confirmIncidentWith(tools, params)
