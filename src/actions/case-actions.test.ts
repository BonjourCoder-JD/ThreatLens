/**
 * Unit tests for the incident-management server actions, using a fake
 * `ActionTools` implementation instead of a real Durable Object. This is
 * what makes it possible to test the one scenario that can't be reliably
 * induced against a real backend on demand: the primary write succeeding
 * while the activity write fails. The fake implements the exact
 * `ActionResult` contract the real `tools` returns — these tests exercise
 * the action's own handling of that contract, not a simulation of
 * unrelated behavior.
 */

import { describe, it, expect, vi } from 'vitest'
import type { ActionTools, ActionResult } from 'deepspace/worker'
import { transitionCaseWith, confirmIncidentWith } from './case-actions'

function ok<T>(data: T): ActionResult<T> {
  return { success: true, data }
}
function fail(error: string): ActionResult<never> {
  return { success: false, error }
}

/** A minimal fake covering only what these two actions call. Each test
 *  overrides exactly the behavior it needs to exercise. Typed loosely
 *  (not `Partial<ActionTools>`) because `ActionTools`' methods are
 *  generic, and TypeScript's strict structural checking on generic
 *  methods makes a concretely-typed mock fail to assign even though it's
 *  behaviorally correct — the `as unknown as ActionTools` cast below is
 *  the actual type boundary tests rely on, same as any hand-written fake
 *  of a generic interface. */
function fakeTools(overrides: Record<string, unknown> = {}): ActionTools {
  return {
    create: vi.fn(async () => ok({ recordId: 'fake-activity-id' })),
    update: vi.fn(async () => ok({ recordId: 'case-1' })),
    remove: vi.fn(async () => ok({ recordId: 'case-1' })),
    deleteWhere: vi.fn(async () => ok({ deleted: 0 })),
    get: vi.fn(async () => ok({ record: { recordId: 'case-1', data: {}, createdBy: 'u1', createdAt: '', updatedAt: '' } })),
    query: vi.fn(async () => ok({ records: [], count: 0 })),
    integration: vi.fn(async () => ok({})),
    registerUser: vi.fn(async () => ok({ user: { id: 'u1', name: '', email: '', role: 'member' } })),
    ...overrides,
  } as unknown as ActionTools
}

describe('transitionCaseWith', () => {
  it('rejects a missing caseId', async () => {
    const result = await transitionCaseWith(fakeTools(), { field: 'status', value: 'open' })
    expect(result.success).toBe(false)
  })

  it('rejects an unsupported field', async () => {
    const result = await transitionCaseWith(fakeTools(), { caseId: 'case-1', field: 'title', value: 'x' })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain('Unknown or unsupported field')
  })

  it('rejects an invalid enum value for status', async () => {
    const tools = fakeTools({
      get: vi.fn(async () => ok({ record: { recordId: 'case-1', data: { status: 'open' }, createdBy: 'u1', createdAt: '', updatedAt: '' } })),
    })
    const result = await transitionCaseWith(tools, { caseId: 'case-1', field: 'status', value: 'archived' })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain('Invalid value')
  })

  it('rejects a no-op transition (value unchanged) without writing anything', async () => {
    const update = vi.fn(async () => ok({ recordId: 'case-1' }))
    const create = vi.fn(async () => ok({ recordId: 'activity-1' }))
    const tools = fakeTools({
      get: vi.fn(async () => ok({ record: { recordId: 'case-1', data: { status: 'open' }, createdBy: 'u1', createdAt: '', updatedAt: '' } })),
      update,
      create,
    })
    const result = await transitionCaseWith(tools, { caseId: 'case-1', field: 'status', value: 'open' })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain('No change')
    expect(update).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('rejects assigning to an unknown user id', async () => {
    const tools = fakeTools({
      get: vi.fn(async (collection: string) => (collection === 'users' ? fail('Record not found') : ok({ record: { recordId: 'case-1', data: {}, createdBy: 'u1', createdAt: '', updatedAt: '' } }))),
    })
    const result = await transitionCaseWith(tools, { caseId: 'case-1', field: 'assignedTo', value: 'ghost-user' })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain('Unknown user')
  })

  it('succeeds and records activity on a valid status transition', async () => {
    const tools = fakeTools({
      get: vi.fn(async () => ok({ record: { recordId: 'case-1', data: { status: 'open' }, createdBy: 'u1', createdAt: '', updatedAt: '' } })),
    })
    const result = await transitionCaseWith(tools, { caseId: 'case-1', field: 'status', value: 'investigating' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toMatchObject({ field: 'status', fromValue: 'open', toValue: 'investigating', activityRecorded: true })
    }
    expect(tools.update).toHaveBeenCalledWith('cases', 'case-1', { status: 'investigating' })
    expect(tools.create).toHaveBeenCalledWith(
      'caseActivity',
      expect.objectContaining({ caseId: 'case-1', eventType: 'status_change', fromValue: 'open', toValue: 'investigating' }),
    )
  })

  it('REAL partial-failure case: case update succeeds, activity write fails — surfaced, not thrown or hidden', async () => {
    const tools = fakeTools({
      get: vi.fn(async () => ok({ record: { recordId: 'case-1', data: { priority: 'medium' }, createdBy: 'u1', createdAt: '', updatedAt: '' } })),
      update: vi.fn(async () => ok({ recordId: 'case-1' })),
      create: vi.fn(async () => fail('Durable Object unavailable')),
    })
    const result = await transitionCaseWith(tools, { caseId: 'case-1', field: 'priority', value: 'high' })
    // The primary change still succeeded — the user's requested state change took effect.
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toMatchObject({ activityRecorded: false })
    }
    expect(tools.update).toHaveBeenCalledTimes(1)
    expect(tools.create).toHaveBeenCalledTimes(1)
  })

  it('a retry after a dropped activity record is a known, documented gap (no-op guard blocks recovery)', async () => {
    // This test documents the limitation rather than hiding it: once the
    // case has already moved to the new value, re-submitting the SAME
    // transition to "recover" the missing activity record is rejected as a
    // no-op, exactly like any other no-op. Reliable recovery would need a
    // reconciliation mechanism, which is out of scope — see the module
    // header comment and docs/ARCHITECTURE.md.
    const tools = fakeTools({
      get: vi.fn(async () => ok({ record: { recordId: 'case-1', data: { priority: 'high' }, createdBy: 'u1', createdAt: '', updatedAt: '' } })),
    })
    const retry = await transitionCaseWith(tools, { caseId: 'case-1', field: 'priority', value: 'high' })
    expect(retry.success).toBe(false)
    if (!retry.success) expect(retry.error).toContain('No change')
  })
})

describe('confirmIncidentWith', () => {
  it('generates the confirmation timestamp server-side, never from params', async () => {
    const tools = fakeTools({
      get: vi.fn(async () => ok({ record: { recordId: 'case-1', data: {}, createdBy: 'u1', createdAt: '', updatedAt: '' } })),
    })
    const before = Date.now()
    const result = await confirmIncidentWith(tools, { caseId: 'case-1', confirmedIncidentAt: '2020-01-01T00:00:00.000Z' })
    const after = Date.now()
    expect(result.success).toBe(true)
    if (result.success) {
      const ts = new Date((result.data as { confirmedIncidentAt: string }).confirmedIncidentAt).getTime()
      // Proves the client-supplied 2020 date was ignored entirely.
      expect(ts).toBeGreaterThanOrEqual(before)
      expect(ts).toBeLessThanOrEqual(after)
    }
  })

  it('rejects confirming a case that is already confirmed', async () => {
    const tools = fakeTools({
      get: vi.fn(async () => ok({ record: { recordId: 'case-1', data: { confirmedIncidentAt: '2026-01-01T00:00:00.000Z' }, createdBy: 'u1', createdAt: '', updatedAt: '' } })),
    })
    const result = await confirmIncidentWith(tools, { caseId: 'case-1' })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toContain('already confirmed')
  })

  it('REAL partial-failure case: confirmation succeeds, activity write fails — surfaced, not hidden', async () => {
    const tools = fakeTools({
      get: vi.fn(async () => ok({ record: { recordId: 'case-1', data: {}, createdBy: 'u1', createdAt: '', updatedAt: '' } })),
      create: vi.fn(async () => fail('Durable Object unavailable')),
    })
    const result = await confirmIncidentWith(tools, { caseId: 'case-1' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toMatchObject({ activityRecorded: false })
    }
  })
})
