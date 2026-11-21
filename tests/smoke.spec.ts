import { test, expect } from '@playwright/test'
import { test as dsTest, expect as dsExpect } from 'deepspace/testing'
import { captureConsoleErrors } from './helpers/errors'

/**
 * Smoke tests covering both page kinds this template ships:
 *   - '/'      → the static landing (top level of src/pages/): no providers,
 *                so no auth fetch and no records WebSocket on load.
 *   - '/home'  → a dynamic page (under src/pages/(app)/): the providers mount,
 *                the nav shell renders, and the records WebSocket connects.
 *
 * The "static contract" test is the guardrail for the per-page opt-out: if
 * someone moves the providers back up into _app.tsx, it fails.
 */

/** Wait for the React app shell (present on every page). */
async function waitForApp(page: import('@playwright/test').Page) {
  await page.waitForSelector('[data-testid="app-root"]', { timeout: 15000 })
}

test.describe('Smoke tests', () => {
  test('static landing loads without JS errors', async ({ page }) => {
    const errors = captureConsoleErrors(page)
    await page.goto('/')
    await waitForApp(page)
    await expect(page.getByTestId('static-landing')).toBeVisible()
    expect(errors).toEqual([])
  })

  test('landing carries one title, one description, one canonical', async ({ page }) => {
    // <Seo> (src/pages/index.tsx, values from src/seo.ts) hoists these into
    // <head>. Exactly one of each: index.html ships no static description or
    // canonical, because React 19 would not dedupe against them on mount.
    await page.goto('/')
    await expect(page.getByTestId('static-landing')).toBeVisible()
    await expect(page).toHaveTitle(/\S/)
    expect(await page.locator('head meta[name="description"]').count()).toBe(1)
    expect(await page.locator('head link[rel="canonical"]').count()).toBe(1)
  })

  test('static contract: landing fires no auth request, opens no websocket', async ({ page }) => {
    const offenders: string[] = []
    page.on('request', (req) => {
      if (req.url().includes('/api/auth/')) offenders.push(req.url())
    })
    // Only the DO room route counts — vite's own HMR socket is a dev artifact.
    page.on('websocket', (ws) => {
      if (new URL(ws.url()).pathname.startsWith('/ws/')) offenders.push(`ws: ${ws.url()}`)
    })
    await page.goto('/')
    await expect(page.getByTestId('static-landing')).toBeVisible()
    await page.waitForTimeout(1500)
    expect(offenders).toEqual([])
  })

  test('dynamic app boundary mounts on /home', async ({ page }) => {
    await page.goto('/home')
    await expect(page.getByTestId('app-navigation')).toBeVisible({ timeout: 15000 })
  })

  test('sign-in button visible when logged out', async ({ page }) => {
    await page.goto('/home')
    await expect(page.getByTestId('nav-sign-in-button')).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId('nav-user-name')).toHaveCount(0)
  })

  test('unknown route shows 404', async ({ page }) => {
    await page.goto('/nonexistent-page-xyz')
    await waitForApp(page)
    await expect(page.locator('text=404')).toBeVisible()
  })
})

/**
 * Dashboard — visible to every signed-in analyst (unlike /admin, this is
 * NOT role-gated; src/nav.ts has no `roles` on it). Only the empty-state
 * path is testable against this dev database right now: it is genuinely
 * empty until the admin import happy path has been run (see
 * docs/DEBUGGING_LOG.md / the Day 2 report — that verification is reserved
 * for the user, not simulated here). The filter bar and summary cards only
 * render once there's at least one event, so testing them is a follow-up
 * once real data exists — tracked, not silently skipped.
 */
test.describe('Dashboard', () => {
  dsTest('non-admin analyst can reach the dashboard and sees the nav link', async ({ users }) => {
    const [analyst] = await users(1)
    await analyst.page.goto('/home')
    await dsExpect(analyst.page.getByRole('link', { name: 'Dashboard' })).toBeVisible({ timeout: 15_000 })
  })

  dsTest('dashboard shows an empty state when no events are imported yet', async ({ users }) => {
    const [analyst] = await users(1)
    await analyst.page.goto('/dashboard')
    await dsExpect(analyst.page.getByText(/No events yet|Loading events/)).toBeVisible({ timeout: 15_000 })
  })
})

/**
 * Admin page gating — a signed-in, non-admin analyst must never see the
 * data-management controls. This is the UI half of the requirement that
 * admin-only operations are enforced server-side (worker.ts's
 * `AppJobRoom.authorizeWrite`), not merely hidden: the point of this test is
 * that the UI doesn't even render the trigger for them, so there's nothing
 * to "hide" in the first place. See docs/ARCHITECTURE.md ("Admin-only
 * enforcement") for the full chain, including the server-side half that
 * still needs an owner session to exercise directly.
 */
test.describe('Admin page', () => {
  dsTest('non-admin analyst sees "Admins only", not the import controls', async ({ users }) => {
    const [analyst] = await users(1)
    await analyst.page.goto('/admin')
    await dsExpect(analyst.page.getByText('Admins only')).toBeVisible({ timeout: 15_000 })
    await dsExpect(analyst.page.getByRole('button', { name: 'Import synthetic events' })).toHaveCount(0)
    // The nav link itself is admin-only (src/nav.ts), so it must not render either.
    await dsExpect(analyst.page.getByRole('link', { name: 'Admin' })).toHaveCount(0)
  })
})
