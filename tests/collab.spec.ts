/**
 * Multi-user collaboration spec — verifies two users sign in into
 * separate browser contexts and the app distinguishes them.
 *
 * `users(2)` takes any two accounts from your pool, so this spec passes on a
 * fresh app with no setup beyond having two test accounts:
 *   npx deepspace test accounts list
 *   npx deepspace test accounts create --email a@deepspace.test --name "A" --password-stdin
 *
 * Ask for accounts *by name* (`users(['Alice', 'Bob'])`) only when the
 * behaviour under test depends on which identity acts — otherwise naming them
 * couples the spec to one machine's pool.
 *
 * The `users` fixture handles sign-in caching (per-account storageState
 * persisted to `~/.deepspace/playwright-states/`), context creation, and
 * cleanup. No need to manage browser contexts manually.
 */
import { test, expect, loadAllTestAccounts } from 'deepspace/testing'

// A machine that has never created test accounts is the normal state of a
// fresh checkout, and there `users()` throws — turning "you have no pool yet"
// into three red tests about the app, which it is not. Skip the file instead
// and say what creates the pool. The count is of accounts usable HERE: the
// pool is global per developer, but passwords live only on the machine that
// created the account.
const usableTestAccounts = loadAllTestAccounts().length
test.skip(
  usableTestAccounts < 2,
  `Needs 2 usable test accounts, found ${usableTestAccounts}. Create them with ` +
    '`npx deepspace test accounts create --email <name>@deepspace.test --name "<name>" ' +
    '--password-stdin`, or fetch existing pool accounts with `npx deepspace test accounts recover --all`.',
)

/**
 * End-to-end case workflow, synchronized between two real signed-in
 * analysts. Covers the thing a mock can't prove: that a write from one
 * browser's WebSocket actually appears in a second, independent browser's
 * `useQuery` subscription without a refresh — real-time sync, not a
 * simulation of it.
 *
 * Cleans up the case it creates (test data convention: a `__test-` prefixed
 * title, deleted in `finally`) so repeated runs don't accumulate junk rows
 * in the shared dev database.
 */
test('two analysts: case creation, status/priority sync, and notes sync in real time', async ({ users }) => {
  const [analystA, analystB] = await users(2)
  const caseTitle = `__test-${Date.now()}__ Collab case`
  let caseId: string | null = null

  try {
    // A opens a case from the first flagged event on the dashboard.
    await analystA.page.goto('/dashboard')
    await analystA.page.getByTestId('filter-flagged-only').click()
    await expect(analystA.page.getByTestId('event-row').first()).toBeVisible({ timeout: 15_000 })
    await analystA.page.getByTestId('event-row-select').first().click()
    await analystA.page.getByTestId('open-case-from-selection').click()
    await analystA.page.getByTestId('case-title-input').fill(caseTitle)
    await analystA.page.getByTestId('create-case-submit').click()

    // Submitting navigates A to the new case's detail page — its URL IS the id.
    await expect(analystA.page).toHaveURL(/\/cases\/.+/, { timeout: 15_000 })
    caseId = analystA.page.url().split('/cases/')[1]
    await expect(analystA.page.getByRole('heading', { name: caseTitle })).toBeVisible()

    // B, independently, sees the new case appear on the list — no refresh.
    await analystB.page.goto('/cases')
    await expect(analystB.page.getByText(caseTitle)).toBeVisible({ timeout: 15_000 })

    // A changes status; B (now on the case detail page) sees it live.
    await analystB.page.goto(`/cases/${caseId}`)
    await expect(analystB.page.getByTestId('case-status-select')).toBeVisible({ timeout: 15_000 })
    await analystA.page.getByTestId('case-status-select').click()
    await analystA.page.getByRole('option', { name: 'Investigating' }).click()
    await expect(analystB.page.getByTestId('case-status-select')).toContainText('Investigating', {
      timeout: 15_000,
    })

    // A adds a note; B sees it appear live, with A's name attributed.
    const noteBody = `Note from A at ${Date.now()}`
    await analystA.page.getByTestId('case-note-input').fill(noteBody)
    await analystA.page.getByTestId('case-note-submit').click()
    await expect(analystB.page.getByTestId('case-notes').getByText(noteBody)).toBeVisible({ timeout: 15_000 })
  } finally {
    // Cleanup must outlive a failed assertion above, but an instant
    // isVisible() check races the page's own data load and silently skips
    // deletion almost every time — wait for a real signal the case page has
    // actually finished loading before looking for the button.
    if (caseId) {
      try {
        await analystA.page.goto(`/cases/${caseId}`)
        await analystA.page.getByTestId('case-status-select').waitFor({ state: 'visible', timeout: 10_000 })
        const deleteButton = analystA.page.getByRole('button', { name: 'Delete case' })
        if (await deleteButton.count()) {
          await deleteButton.click()
          await analystA.page.getByRole('button', { name: 'Delete', exact: true }).click()
        }
      } catch {
        // Best-effort cleanup — never let it mask the test's own result.
      }
    }
  }
})

test('each browser renders its own signed-in account', async ({ users }) => {
  const [a, b] = await users(2)

  // /home is dynamic (under src/pages/(app)/), so it mounts the nav shell;
  // '/' is the static landing and has no navigation.
  await Promise.all([a.page.goto('/home'), b.page.goto('/home')])

  // Email, not name. The page renders the *session's* `name || email`, while
  // `user.name` here comes from the LOCAL account registry — and the two are
  // not the same fact: a display name is optional, and an account recovered on
  // another machine has none stored locally at all. The email is the credential
  // the context signed in with, so it is the one identity both sides agree on,
  // and asserting it proves the page is showing THIS browser's account.
  // The two accounts are distinct, so two exact matches is also the proof that
  // the contexts are not sharing one session.
  for (const user of [a, b]) {
    await expect(user.page.getByTestId('app-navigation')).toBeVisible({ timeout: 15_000 })

    // The identity chip shows `name || email`. Its text is not predictable, but
    // its presence is: something must be there once the profile has loaded.
    // (It is `hidden sm:inline` in some templates, so assert text, not
    // visibility.)
    await expect(user.page.getByTestId('nav-user-name')).toHaveText(/\S/, { timeout: 15_000 })

    await user.page.getByRole('button', { name: 'Account menu' }).click()
    await expect(user.page.getByTestId('nav-user-email')).toHaveText(user.email, {
      timeout: 15_000,
    })
  }
})

test('API status page renders loading success and error states', async ({ users }) => {
  const [user] = await users(1)
  let shouldFail = false
  let requestCount = 0

  await user.page.route('**/api/integrations', async (route) => {
    requestCount += 1
    if (shouldFail) {
      await route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'Catalog unavailable' }),
      })
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { integrations: { openai: {}, wikipedia: {} } } }),
    })
  })

  await user.page.goto('/api-status')
  await expect(user.page.getByText('Loading integration catalog...')).toBeVisible()
  await expect(user.page.getByText('Integration catalog ready')).toBeVisible()
  await expect(user.page.getByText('2 integrations available.')).toBeVisible()

  shouldFail = true
  await user.page.getByRole('button', { name: 'Refresh' }).click()
  await expect(user.page.getByText('Catalog unavailable')).toBeVisible()
  await expect(user.page.getByText('Showing the last loaded catalog')).toBeVisible()
  await expect(user.page.getByText('Integration catalog ready')).toBeVisible()

  const urlAfterFailure = user.page.url()
  const requestsAfterFailure = requestCount
  await user.page.getByRole('button', { name: 'Refresh' }).click()
  await expect.poll(() => requestCount).toBeGreaterThan(requestsAfterFailure)
  expect(user.page.url()).toBe(urlAfterFailure)
})

test('API status page shows local retry after first-load API failure', async ({ users }) => {
  const [user] = await users(1)
  let requestCount = 0

  await user.page.route('**/api/integrations', async (route) => {
    requestCount += 1
    await route.fulfill({
      status: 502,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, error: 'Catalog unavailable' }),
    })
  })

  await user.page.goto('/api-status')
  await expect(user.page.getByText('Loading integration catalog...')).toBeVisible()
  await expect(user.page.getByText('Could not load API data')).toBeVisible()
  await expect(user.page.getByText('Retried 1 time automatically.')).toBeVisible()

  const retryButton = user.page.getByRole('button', { name: 'Retry' })
  await expect(retryButton).toBeVisible()

  const urlAfterFailure = user.page.url()
  const requestsAfterFailure = requestCount
  await retryButton.click()
  await expect.poll(() => requestCount).toBeGreaterThan(requestsAfterFailure)
  expect(user.page.url()).toBe(urlAfterFailure)
})
