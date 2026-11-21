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
