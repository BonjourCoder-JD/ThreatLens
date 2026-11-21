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
dsTest.describe('Job room direct-API authorization', () => {
  dsTest(
    'non-admin enqueue of import-synthetic-events is refused over the raw WebSocket',
    async ({ users }) => {
      const [analyst] = await users(1)
      await analyst.page.goto('/home')

      const tokenRes = await analyst.page.request.post('/api/auth/token')
      dsExpect(tokenRes.ok()).toBeTruthy()
      const { token } = (await tokenRes.json()) as { token?: string }
      dsExpect(token).toBeTruthy()

      const messages = await analyst.page.evaluate(
        async ({ token, roomId }) => {
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
                  payload: {
                    requestId: 'direct-api-test-1',
                    type: 'import-synthetic-events',
                    payload: {},
                  },
                }),
              )
            }
            ws.onerror = () => finish()
            setTimeout(finish, 8000)
          })
        },
        { token, roomId: jobRoomId() },
      )

      const enqueued = (messages as Array<{ type: string; payload?: { kind?: string } }>).find(
        (m) => m.type === 'job.update' && m.payload?.kind === 'enqueued',
      )
      const rejected = (messages as Array<{ type: string; payload?: { error?: string } }>).find(
        (m) => m.type === 'core.error',
      )

      dsExpect(enqueued).toBeUndefined()
      dsExpect(rejected).toBeTruthy()
      dsExpect(rejected?.payload?.error).toContain('Write access denied')
    },
  )
})
