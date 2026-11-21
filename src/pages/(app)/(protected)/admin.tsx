/**
 * Admin — data-management console. Reached at /admin (gated by
 * (protected)/_layout.tsx's <AuthGate>; the nav link is additionally hidden
 * from non-admins via src/nav.ts's `roles: ['admin']`).
 *
 * The UI-level role check below is convenience, NOT the security boundary —
 * see worker.ts's `AppJobRoom.authorizeWrite`, which is what actually
 * refuses the enqueue server-side for a non-admin. See
 * docs/ARCHITECTURE.md ("Admin-only enforcement") for how to verify that.
 */

import { useJobs, useUser } from 'deepspace'
import { useQuery } from 'deepspace'
import { Button, Badge, EmptyState } from '@/components/ui'
import { SCOPE_ID } from '../../../constants'

interface ImportResult {
  datasetVersion: string
  totalInDataset: number
  imported: number
  failed: number
  errors: string[]
}

export default function AdminPage() {
  const { user } = useUser()
  const isAdmin = user?.role === 'admin'
  const { jobs, enqueue } = useJobs<{ limit?: number }, ImportResult>(SCOPE_ID)
  const { records: authEvents, status } = useQuery('authEvents', { limit: 2000 })

  const importJobs = jobs.filter((j) => j.type === 'import-synthetic-events')
  const latestImport = importJobs[0]
  const importRunning = latestImport?.status === 'queued' || latestImport?.status === 'running'

  if (!isAdmin) {
    return (
      <div className="min-h-full text-foreground">
        <div className="mx-auto max-w-2xl px-6 py-20">
          <EmptyState
            title="Admins only"
            description="This page manages app-wide synthetic data and detection runs. Ask an admin to grant you the admin role to use it."
          />
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-full text-foreground">
      <div className="mx-auto max-w-3xl px-6 py-20">
        <h1 className="mb-2 text-4xl font-bold tracking-tight">Admin</h1>
        <p className="mb-12 text-sm text-muted-foreground">
          Data-management operations for ThreatLens. Every action here is enforced server-side
          for the admin role, not just hidden in this UI.
        </p>

        <section className="rounded-lg border border-border bg-card p-6">
          <h2 className="mb-1 text-lg font-semibold">Synthetic auth log dataset</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Loads the canonical dataset (<code>scripts/generate-dataset.mjs</code>) into the{' '}
            <code>authEvents</code> collection. Safe to re-run — each row upserts by its stable
            event id, so re-running never creates duplicates.
          </p>

          <div className="mb-4 flex items-center gap-3">
            <Button
              disabled={importRunning}
              onClick={() => enqueue('import-synthetic-events', {})}
            >
              {importRunning ? 'Importing…' : 'Import synthetic events'}
            </Button>
            <span className="text-sm text-muted-foreground">
              {status === 'loading' ? 'Loading…' : `${authEvents.length} events in authEvents`}
            </span>
          </div>

          {importJobs.length > 0 && (
            <ul className="space-y-2 text-sm">
              {importJobs.slice(0, 5).map((job) => (
                <li
                  key={job.id}
                  data-testid="import-job-row"
                  data-status={job.status}
                  className="flex items-center justify-between rounded-md border border-border px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <Badge
                      variant={
                        job.status === 'succeeded'
                          ? 'success'
                          : job.status === 'failed'
                            ? 'destructive'
                            : 'secondary'
                      }
                    >
                      {job.status}
                    </Badge>
                    <span className="text-muted-foreground">
                      {job.progressMessage ?? (job.progress != null ? `${Math.round(job.progress * 100)}%` : '')}
                    </span>
                  </div>
                  {job.result && (
                    <span className="text-muted-foreground">
                      {job.result.imported} imported
                      {job.result.failed > 0 ? `, ${job.result.failed} failed` : ''}
                    </span>
                  )}
                  {job.error && <span className="text-destructive">{job.error}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
