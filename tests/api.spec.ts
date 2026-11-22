import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '@playwright/test'
import { test as dsTest, expect as dsExpect } from 'deepspace/testing'

const here = dirname(fileURLToPath(import.meta.url))

test.describe('API tests', () => {
  test('auth proxy forwards to auth worker', async ({ request }) => {
    const res = await request.get('/api/auth/ok')
    expect(res.ok()).toBeTruthy()
  })

  test('WebSocket endpoint exists', async ({ page }) => {
    // /home is a dynamic page (under src/pages/(app)/), so mounting it boots
    // the providers and auto-connects the records WebSocket. The static
    // landing at '/' deliberately does neither — see smoke.spec.ts.
    await page.goto('/home')
    // Wait for the app to connect its WebSocket (it auto-connects on mount)
    await page.waitForSelector('[data-testid="app-navigation"]', { timeout: 15000 })
    // If the app loaded and connected, the WS endpoint works
  })
})

/** Reads the immutable app id from wrangler.toml rather than hardcoding it,
 *  so this test can't silently drift from the real room id. */
function jobRoomId(): string {
  const toml = readFileSync(join(here, '..', 'wrangler.toml'), 'utf8')
  const match = toml.match(/DEEPSPACE_APP_ID\s*=\s*"([^"]+)"/)
  if (!match) throw new Error('DEEPSPACE_APP_ID not found in wrangler.toml')
  return `app:${match[1]}`
}

/**
 * Direct-API proof that a non-admin cannot enqueue an admin-only job —
 * not "the button is hidden," but "the server itself refuses the write."
 * This bypasses the UI (and the `useJobs` hook) entirely: it opens the raw
 * WebSocket the client SDK would open and sends the exact wire message
 * `useJobs().enqueue(...)` sends, read directly from the SDK's own compiled
 * source (`node_modules/deepspace/dist/{index,worker}.js` — `MSG.JOB_ENQUEUE`
 * = `'job.enqueue'`, the server's rejection is `MSG.ERROR` = `'core.error'`
 * with `"Write access denied: job queue requires member access"`). See
 * worker.ts's `AppJobRoom.authorizeWrite` for the server-side check this
 * proves, and docs/ARCHITECTURE.md ("Admin-only enforcement").
 */
/**
 * Shared helper: signs in a non-admin, opens a raw WebSocket to the jobs
 * room, attempts to enqueue the given job type, and returns every message
 * received. Used to prove server-side rejection for EVERY admin-only job
 * type, not just the first one — same wire message
 * (`MSG.JOB_ENQUEUE` = `'job.enqueue'`) regardless of which job type is
 * named in the payload.
 */
async function attemptJobEnqueue(
  page: import('@playwright/test').Page,
  jobType: string,
): Promise<Array<{ type: string; payload?: { kind?: string; error?: string } }>> {
  await page.goto('/home')
  const tokenRes = await page.request.post('/api/auth/token')
  const { token } = (await tokenRes.json()) as { token?: string }

  return page.evaluate(
    async ({ token, roomId, jobType }) => {
      return await new Promise<unknown[]>((resolve) => {
        const seen: unknown[] = []
        const wsUrl = `${location.origin.replace(/^http/, 'ws')}/ws/jobs/${roomId}?token=${token}`
        const ws = new WebSocket(wsUrl)
        const finish = () => {
          ws.close()
          resolve(seen)
        }
        ws.onmessage = (ev) => {
          const msg = JSON.parse(ev.data as string) as { type: string; payload?: { kind?: string } }
          seen.push(msg)
          if (msg.type === 'core.error') finish()
          if (msg.type === 'job.update' && msg.payload?.kind === 'enqueued') finish()
        }
        ws.onopen = () => {
          ws.send(
            JSON.stringify({
              type: 'job.enqueue',
              payload: { requestId: 'direct-api-test-1', type: jobType, payload: {} },
            }),
          )
        }
        ws.onerror = () => finish()
        setTimeout(finish, 8000)
      })
    },
    { token, roomId: jobRoomId(), jobType },
  ) as Promise<Array<{ type: string; payload?: { kind?: string; error?: string } }>>
}

dsTest.describe('Job room direct-API authorization', () => {
  dsTest(
    'non-admin enqueue of import-synthetic-events is refused over the raw WebSocket',
    async ({ users }) => {
      const [analyst] = await users(1)
      const messages = await attemptJobEnqueue(analyst.page, 'import-synthetic-events')

      const enqueued = messages.find((m) => m.type === 'job.update' && m.payload?.kind === 'enqueued')
      const rejected = messages.find((m) => m.type === 'core.error')

      dsExpect(enqueued).toBeUndefined()
      dsExpect(rejected).toBeTruthy()
      dsExpect(rejected?.payload?.error).toContain('Write access denied')
    },
  )

  dsTest(
    'non-admin enqueue of import-ml-scores is refused over the raw WebSocket',
    async ({ users }) => {
      const [analyst] = await users(1)
      const messages = await attemptJobEnqueue(analyst.page, 'import-ml-scores')

      const enqueued = messages.find((m) => m.type === 'job.update' && m.payload?.kind === 'enqueued')
      const rejected = messages.find((m) => m.type === 'core.error')

      dsExpect(enqueued).toBeUndefined()
      dsExpect(rejected).toBeTruthy()
      dsExpect(rejected?.payload?.error).toContain('Write access denied')
    },
  )

  // Completes the set: `authorizeWrite` (worker.ts) admin-gates all three
  // job types identically, but only two had a direct-API test proving it —
  // this closes that coverage gap rather than relying on "same code path"
  // as an unverified assumption.
  dsTest(
    'non-admin enqueue of recompute-stat-scores is refused over the raw WebSocket',
    async ({ users }) => {
      const [analyst] = await users(1)
      const messages = await attemptJobEnqueue(analyst.page, 'recompute-stat-scores')

      const enqueued = messages.find((m) => m.type === 'job.update' && m.payload?.kind === 'enqueued')
      const rejected = messages.find((m) => m.type === 'core.error')

      dsExpect(enqueued).toBeUndefined()
      dsExpect(rejected).toBeTruthy()
      dsExpect(rejected?.payload?.error).toContain('Write access denied')
    },
  )
})

/**
 * Role self-promotion is blocked, verified by actual behavior, not just
 * read from the SDK's source. `src/schemas/users-schema.ts` has no
 * `writableFields` restricting `role` — the only thing stopping a member
 * from writing `{ role: 'admin' }` on their own row (which `update: 'own'`
 * otherwise permits) is a hardcoded guard in the compiled SDK
 * (`node_modules/deepspace/dist/worker.js`'s `SYSTEM_ASSIGNED_COLUMNS`
 * check), not anything this app's own schema declares. That's a real but
 * previously untested dependency on an SDK guarantee — this closes the gap
 * with a direct-API proof, same pattern as the protected-case-field tests
 * above, plus an independent behavioral check (the admin-gated page still
 * refuses them) rather than trusting the write's error message alone.
 */
dsTest.describe('User role RBAC (SDK-level system-managed-column guard)', () => {
  dsTest('a member cannot self-promote to admin via a direct write to their own user row', async ({ users }) => {
    const [analyst] = await users(1)

    await analyst.page.goto('/home')
    const tokenRes = await analyst.page.request.post('/api/auth/token')
    const { token } = (await tokenRes.json()) as { token?: string }

    const messages = await analyst.page.evaluate(
      async ({ token, roomId }) => {
        // The JWT's `sub` claim is the caller's own userId (see
        // node_modules/deepspace/dist/worker.js's auth verification) —
        // decoding it client-side is the only way this test can target
        // "my own user row" without a dedicated endpoint for it.
        const payload = JSON.parse(atob(token!.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { sub: string }
        const myUserId = payload.sub

        return await new Promise<unknown[]>((resolve) => {
          const seen: unknown[] = []
          const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws/${roomId}?token=${token}`)
          const finish = () => {
            ws.close()
            resolve(seen)
          }
          ws.onopen = () => {
            ws.send(
              JSON.stringify({
                type: 'core.put',
                payload: { collection: 'users', recordId: myUserId, data: { role: 'admin' } },
              }),
            )
          }
          ws.onmessage = (ev) => {
            // First message is always the proactive MSG.USER_INFO — keep
            // listening past it for the actual error, same as the
            // protected-case-field tests above.
            const msg = JSON.parse(ev.data as string) as { type: string }
            seen.push(msg)
            if (msg.type === 'core.error') finish()
          }
          ws.onerror = () => finish()
          setTimeout(finish, 6000)
        })
      },
      { token, roomId: jobRoomId() },
    )

    const rejected = (messages as Array<{ type: string; payload?: { error?: string } }>).find(
      (m) => m.type === 'core.error',
    )
    dsExpect(rejected).toBeTruthy()
    dsExpect(rejected?.payload?.error).toContain("'role' is system-managed")

    // Independent behavioral proof, not just the write's own error message:
    // an admin-gated page still refuses them, meaning their role is
    // genuinely unchanged server-side, not just "no success message arrived."
    await analyst.page.goto('/admin')
    await dsExpect(analyst.page.getByText('Admins only')).toBeVisible({ timeout: 15_000 })
  })
})

/**
 * Case RBAC, verified by real behavior rather than an assumed error
 * message: a non-owner analyst's raw WebSocket delete attempt is sent
 * directly (bypassing the UI, which doesn't even show a delete button to
 * a non-owner), and the proof is that the case still exists afterward — an
 * independent re-query, not just "no success message arrived." A second,
 * separate check confirms an anonymous visitor's `useQuery('cases')` never
 * receives a case that's known to exist, which is the schema's `'*': {
 * read: false }` rule (src/schemas/cases-schema.ts) being enforced in the
 * Durable Object before data ever reaches the socket — see
 * docs/concepts/permissions in the DeepSpace docs for why that's a
 * stronger guarantee than a client-side filter.
 */
/**
 * Proves the incident-management extension's actual security boundary:
 * a direct client write to a protected case field is refused by the
 * Durable Object itself (`member.writableFields` in
 * src/schemas/cases-schema.ts), not merely hidden by the UI calling the
 * `transitionCase` action instead. This bypasses the UI and the action
 * entirely — a raw `core.put` over the WebSocket, the exact wire message
 * `useMutations('cases').put(...)` would send.
 */
dsTest.describe('Protected case fields (incident-management extension)', () => {
  dsTest('a direct write to a protected field (status) is rejected, and the value is unchanged', async ({ users }) => {
    const [analyst] = await users(1)
    const title = `__test-${Date.now()}__ protected-field lockdown`

    await analyst.page.goto('/dashboard')
    await analyst.page.getByTestId('filter-flagged-only').click()
    await dsExpect(analyst.page.getByTestId('event-row').first()).toBeVisible({ timeout: 15_000 })
    await analyst.page.getByTestId('event-row-select').first().click()
    await analyst.page.getByTestId('open-case-from-selection').click()
    await analyst.page.getByTestId('case-title-input').fill(title)
    await analyst.page.getByTestId('create-case-submit').click()
    await dsExpect(analyst.page).toHaveURL(/\/cases\/.+/, { timeout: 15_000 })
    const caseId = analyst.page.url().split('/cases/')[1]

    try {
      const tokenRes = await analyst.page.request.post('/api/auth/token')
      const { token } = (await tokenRes.json()) as { token?: string }

      const messages = await analyst.page.evaluate(
        async ({ token, roomId, caseId }) => {
          return await new Promise<unknown[]>((resolve) => {
            const seen: unknown[] = []
            const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws/${roomId}?token=${token}`)
            const finish = () => {
              ws.close()
              resolve(seen)
            }
            ws.onopen = () => {
              ws.send(
                JSON.stringify({
                  type: 'core.put',
                  payload: { collection: 'cases', recordId: caseId, data: { status: 'resolved' } },
                }),
              )
            }
            ws.onmessage = (ev) => {
              // The connection's very first message is always MSG.USER_INFO
              // (sent proactively on connect, before any reply to our PUT) —
              // keep listening past it for the actual error, rather than
              // resolving on whatever arrives first.
              const msg = JSON.parse(ev.data as string) as { type: string }
              seen.push(msg)
              if (msg.type === 'core.error') finish()
            }
            ws.onerror = () => finish()
            setTimeout(finish, 6000)
          })
        },
        { token, roomId: jobRoomId(), caseId },
      )

      const rejected = (messages as Array<{ type: string; payload?: { error?: string } }>).find(
        (m) => m.type === 'core.error',
      )
      dsExpect(rejected).toBeTruthy()
      dsExpect(rejected?.payload?.error).toContain("cannot modify field 'status'")

      // Independent re-query: the case's status is genuinely unchanged —
      // not just "no success message arrived."
      await analyst.page.reload()
      await dsExpect(analyst.page.getByTestId('case-status-select')).toContainText('Open', { timeout: 15_000 })
    } finally {
      await analyst.page.goto(`/cases/${caseId}`).catch(() => {})
      await analyst.page.getByTestId('case-status-select').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
      const deleteButton = analyst.page.getByRole('button', { name: 'Delete case' })
      if (await deleteButton.count()) {
        await deleteButton.click()
        await analyst.page.getByRole('button', { name: 'Delete', exact: true }).click()
      }
    }
  })

  dsTest('summary remains directly client-writable — the lockdown is field-specific, not blanket', async ({ users }) => {
    const [analyst] = await users(1)
    const title = `__test-${Date.now()}__ summary still writable`

    await analyst.page.goto('/dashboard')
    await analyst.page.getByTestId('filter-flagged-only').click()
    await dsExpect(analyst.page.getByTestId('event-row').first()).toBeVisible({ timeout: 15_000 })
    await analyst.page.getByTestId('event-row-select').first().click()
    await analyst.page.getByTestId('open-case-from-selection').click()
    await analyst.page.getByTestId('case-title-input').fill(title)
    await analyst.page.getByTestId('create-case-submit').click()
    await dsExpect(analyst.page).toHaveURL(/\/cases\/.+/, { timeout: 15_000 })
    const caseId = analyst.page.url().split('/cases/')[1]

    try {
      const tokenRes = await analyst.page.request.post('/api/auth/token')
      const { token } = (await tokenRes.json()) as { token?: string }

      const messages = await analyst.page.evaluate(
        async ({ token, roomId, caseId }) => {
          return await new Promise<unknown[]>((resolve) => {
            const seen: unknown[] = []
            const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws/${roomId}?token=${token}`)
            const finish = () => {
              ws.close()
              resolve(seen)
            }
            ws.onopen = () => {
              ws.send(
                JSON.stringify({
                  type: 'core.put',
                  payload: { collection: 'cases', recordId: caseId, data: { summary: 'direct write of an unprotected field' } },
                }),
              )
            }
            // A permitted fire-and-forget write has no explicit "success"
            // ack to an unsubscribed socket — proving it wasn't rejected
            // means waiting out the full window and confirming no
            // core.error ever arrived, not finishing on the first message
            // (which is always the connection's proactive MSG.USER_INFO).
            ws.onmessage = (ev) => {
              seen.push(JSON.parse(ev.data as string))
            }
            ws.onerror = () => finish()
            setTimeout(finish, 3000)
          })
        },
        { token, roomId: jobRoomId(), caseId },
      )

      const rejected = (messages as Array<{ type: string }>).find((m) => m.type === 'core.error')
      dsExpect(rejected).toBeUndefined()

      // Positive confirmation, not just "no error arrived": the write
      // actually took effect.
      await analyst.page.reload()
      await dsExpect(analyst.page.getByText('direct write of an unprotected field')).toBeVisible({ timeout: 15_000 })
    } finally {
      await analyst.page.goto(`/cases/${caseId}`).catch(() => {})
      await analyst.page.getByTestId('case-status-select').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
      const deleteButton = analyst.page.getByRole('button', { name: 'Delete case' })
      if (await deleteButton.count()) {
        await deleteButton.click()
        await analyst.page.getByRole('button', { name: 'Delete', exact: true }).click()
      }
    }
  })
})

dsTest.describe('Case RBAC', () => {
  dsTest('a non-owner analyst cannot delete another analyst\'s case over the raw WebSocket', async ({ users }) => {
    const [owner, other] = await users(2)
    const title = `__test-${Date.now()}__ RBAC delete target`

    await owner.page.goto('/dashboard')
    await owner.page.getByTestId('filter-flagged-only').click()
    await dsExpect(owner.page.getByTestId('event-row').first()).toBeVisible({ timeout: 15_000 })
    await owner.page.getByTestId('event-row-select').first().click()
    await owner.page.getByTestId('open-case-from-selection').click()
    await owner.page.getByTestId('case-title-input').fill(title)
    await owner.page.getByTestId('create-case-submit').click()
    await dsExpect(owner.page).toHaveURL(/\/cases\/.+/, { timeout: 15_000 })
    const caseId = owner.page.url().split('/cases/')[1]

    try {
      await other.page.goto('/home')
      const tokenRes = await other.page.request.post('/api/auth/token')
      const { token } = (await tokenRes.json()) as { token?: string }

      await other.page.evaluate(
        async ({ token, roomId, caseId }) => {
          await new Promise<void>((resolve) => {
            const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws/${roomId}?token=${token}`)
            ws.onopen = () => {
              ws.send(JSON.stringify({ type: 'core.delete', payload: { collection: 'cases', recordId: caseId } }))
              setTimeout(() => {
                ws.close()
                resolve()
              }, 1500)
            }
            ws.onerror = () => resolve()
          })
        },
        { token, roomId: jobRoomId(), caseId },
      )

      // Independent re-query: reload the owner's case list and confirm the
      // case is still there. This is the actual behavior, not a message guess.
      await owner.page.reload()
      await dsExpect(owner.page.getByText(title)).toBeVisible({ timeout: 15_000 })
    } finally {
      // See the comment on the equivalent cleanup in collab.spec.ts — an
      // instant isVisible() check races the page's data load and silently
      // skips deletion; wait for a real loaded-page signal first.
      try {
        await owner.page.goto(`/cases/${caseId}`)
        await owner.page.getByTestId('case-status-select').waitFor({ state: 'visible', timeout: 10_000 })
        const deleteButton = owner.page.getByRole('button', { name: 'Delete case' })
        if (await deleteButton.count()) {
          await deleteButton.click()
          await owner.page.getByRole('button', { name: 'Delete', exact: true }).click()
        }
      } catch {
        // Best-effort cleanup — never let it mask the test's own result.
      }
    }
  })

  dsTest('an anonymous visitor never receives a case that exists', async ({ users, browser }) => {
    const [owner] = await users(1)
    const title = `__test-${Date.now()}__ RBAC anon target`

    await owner.page.goto('/dashboard')
    await owner.page.getByTestId('filter-flagged-only').click()
    await dsExpect(owner.page.getByTestId('event-row').first()).toBeVisible({ timeout: 15_000 })
    await owner.page.getByTestId('event-row-select').first().click()
    await owner.page.getByTestId('open-case-from-selection').click()
    await owner.page.getByTestId('case-title-input').fill(title)
    await owner.page.getByTestId('create-case-submit').click()
    await dsExpect(owner.page).toHaveURL(/\/cases\/.+/, { timeout: 15_000 })
    const caseId = owner.page.url().split('/cases/')[1]

    try {
      const anonContext = await browser.newContext()
      const anonPage = await anonContext.newPage()
      await anonPage.goto('/cases')
      await anonPage.waitForTimeout(2000) // let any subscription settle
      await dsExpect(anonPage.getByText(title)).toHaveCount(0)
      await anonContext.close()
    } finally {
      try {
        await owner.page.goto(`/cases/${caseId}`)
        await owner.page.getByTestId('case-status-select').waitFor({ state: 'visible', timeout: 10_000 })
        const deleteButton = owner.page.getByRole('button', { name: 'Delete case' })
        if (await deleteButton.count()) {
          await deleteButton.click()
          await owner.page.getByRole('button', { name: 'Delete', exact: true }).click()
        }
      } catch {
        // Best-effort cleanup — never let it mask the test's own result.
      }
    }
  })
})

/**
 * Integration-level tests against the REAL server action (not the fake
 * `tools` in src/actions/case-actions.test.ts) — these prove the action is
 * actually wired up and reachable end to end, complementing the unit
 * tests' coverage of its internal logic.
 */
dsTest.describe('Incident-management actions (real server)', () => {
  dsTest('transitionCase rejects an invalid enum value and a no-op, end to end', async ({ users }) => {
    const [analyst] = await users(1)
    const title = `__test-${Date.now()}__ transitionCase integration`

    await analyst.page.goto('/dashboard')
    await analyst.page.getByTestId('filter-flagged-only').click()
    await dsExpect(analyst.page.getByTestId('event-row').first()).toBeVisible({ timeout: 15_000 })
    await analyst.page.getByTestId('event-row-select').first().click()
    await analyst.page.getByTestId('open-case-from-selection').click()
    await analyst.page.getByTestId('case-title-input').fill(title)
    await analyst.page.getByTestId('create-case-submit').click()
    await dsExpect(analyst.page).toHaveURL(/\/cases\/.+/, { timeout: 15_000 })
    const caseId = analyst.page.url().split('/cases/')[1]

    try {
      const invalid = await analyst.page.evaluate(
        async ({ caseId }) => {
          const tokenRes = await fetch('/api/auth/token', { method: 'POST' })
          const { token } = (await tokenRes.json()) as { token: string }
          const res = await fetch('/api/actions/transitionCase', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ caseId, field: 'status', value: 'bogus_status' }),
          })
          return res.json()
        },
        { caseId },
      )
      dsExpect((invalid as { success: boolean }).success).toBe(false)
      dsExpect((invalid as { error: string }).error).toContain('Invalid value')

      // A genuine, valid transition first...
      const first = await analyst.page.evaluate(
        async ({ caseId }) => {
          const tokenRes = await fetch('/api/auth/token', { method: 'POST' })
          const { token } = (await tokenRes.json()) as { token: string }
          const res = await fetch('/api/actions/transitionCase', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ caseId, field: 'priority', value: 'high' }),
          })
          return res.json()
        },
        { caseId },
      )
      dsExpect((first as { success: boolean }).success).toBe(true)
      dsExpect((first as { data: { activityRecorded: boolean } }).data.activityRecorded).toBe(true)

      // ...then the identical transition again, which must be rejected as a no-op.
      const noop = await analyst.page.evaluate(
        async ({ caseId }) => {
          const tokenRes = await fetch('/api/auth/token', { method: 'POST' })
          const { token } = (await tokenRes.json()) as { token: string }
          const res = await fetch('/api/actions/transitionCase', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ caseId, field: 'priority', value: 'high' }),
          })
          return res.json()
        },
        { caseId },
      )
      dsExpect((noop as { success: boolean }).success).toBe(false)
      dsExpect((noop as { error: string }).error).toContain('No change')
    } finally {
      await analyst.page.goto(`/cases/${caseId}`).catch(() => {})
      await analyst.page.getByTestId('case-status-select').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
      const deleteButton = analyst.page.getByRole('button', { name: 'Delete case' })
      if (await deleteButton.count()) {
        await deleteButton.click()
        await analyst.page.getByRole('button', { name: 'Delete', exact: true }).click()
      }
    }
  })

  dsTest('confirmIncident sets a server timestamp and refuses a second confirmation', async ({ users }) => {
    const [analyst] = await users(1)
    const title = `__test-${Date.now()}__ confirmIncident integration`

    await analyst.page.goto('/dashboard')
    await analyst.page.getByTestId('filter-flagged-only').click()
    await dsExpect(analyst.page.getByTestId('event-row').first()).toBeVisible({ timeout: 15_000 })
    await analyst.page.getByTestId('event-row-select').first().click()
    await analyst.page.getByTestId('open-case-from-selection').click()
    await analyst.page.getByTestId('case-title-input').fill(title)
    await analyst.page.getByTestId('create-case-submit').click()
    await dsExpect(analyst.page).toHaveURL(/\/cases\/.+/, { timeout: 15_000 })
    const caseId = analyst.page.url().split('/cases/')[1]

    try {
      const before = Date.now()
      const first = await analyst.page.evaluate(
        async ({ caseId }) => {
          const tokenRes = await fetch('/api/auth/token', { method: 'POST' })
          const { token } = (await tokenRes.json()) as { token: string }
          const res = await fetch('/api/actions/confirmIncident', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ caseId }),
          })
          return res.json()
        },
        { caseId },
      )
      const after = Date.now()
      dsExpect((first as { success: boolean }).success).toBe(true)
      const data = (first as { data: { confirmedIncidentAt: string; activityRecorded: boolean } }).data
      const ts = new Date(data.confirmedIncidentAt).getTime()
      dsExpect(ts).toBeGreaterThanOrEqual(before - 2000)
      dsExpect(ts).toBeLessThanOrEqual(after + 2000)
      dsExpect(data.activityRecorded).toBe(true)

      const second = await analyst.page.evaluate(
        async ({ caseId }) => {
          const tokenRes = await fetch('/api/auth/token', { method: 'POST' })
          const { token } = (await tokenRes.json()) as { token: string }
          const res = await fetch('/api/actions/confirmIncident', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ caseId }),
          })
          return res.json()
        },
        { caseId },
      )
      dsExpect((second as { success: boolean }).success).toBe(false)
      dsExpect((second as { error: string }).error).toContain('already confirmed')
    } finally {
      await analyst.page.goto(`/cases/${caseId}`).catch(() => {})
      await analyst.page.getByTestId('case-status-select').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
      const deleteButton = analyst.page.getByRole('button', { name: 'Delete case' })
      if (await deleteButton.count()) {
        await deleteButton.click()
        await analyst.page.getByRole('button', { name: 'Delete', exact: true }).click()
      }
    }
  })
})
