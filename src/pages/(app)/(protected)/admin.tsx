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
import type { JobView } from 'deepspace'
import type { ReactNode } from 'react'
import { Button, Badge, EmptyState, StatCard } from '@/components/ui'
import { SCOPE_ID } from '../../../constants'

interface ImportResult {
  datasetVersion: string
  totalInDataset: number
  imported: number
  failed: number
  errors: string[]
}

interface RecomputeResult {
  totalEvents: number
  updated: number
  failed: number
  flagged: number
  errors: string[]
}

type AnyJobResult = ImportResult | RecomputeResult

function isRecomputeResult(r: AnyJobResult): r is RecomputeResult {
  return 'flagged' in r
}

export default function AdminPage() {
  const { user } = useUser()
  const isAdmin = user?.role === 'admin'
  const { jobs, enqueue } = useJobs<Record<string, unknown>, AnyJobResult>(SCOPE_ID)
  const { records: authEvents, status } = useQuery('authEvents', { limit: 2000 })

  const importJobs = jobs.filter((j) => j.type === 'import-synthetic-events')
  const recomputeJobs = jobs.filter((j) => j.type === 'recompute-stat-scores')
  const latestImport = importJobs[0]
  const latestRecompute = recomputeJobs[0]
  const importRunning = latestImport?.status === 'queued' || latestImport?.status === 'running'
  const recomputeRunning = latestRecompute?.status === 'queued' || latestRecompute?.status === 'running'
  const flaggedCount = authEvents.filter(
    (r) => Array.isArray((r.data as { statReasons?: unknown[] }).statReasons) && (r.data as { statReasons: unknown[] }).statReasons.length > 0,
  ).length

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
        <h1 className="mb-2 text-4xl font-bold tracking-tight text-foreground">Admin</h1>
        <p className="mb-8 text-sm text-muted-foreground">
          Data-management operations for ThreatLens. Every action here is enforced server-side
          for the admin role, not just hidden in this UI.
        </p>

        <div className="mb-8 grid grid-cols-2 gap-3">
          <StatCard label="Events in authEvents" value={authEvents.length} />
          <StatCard label="Currently flagged" value={flaggedCount} tone="alert" />
        </div>

        <section className="mb-6 rounded-xl border border-border bg-card p-6 shadow-[0_1px_3px_0_rgba(23,37,84,0.08)]">
          <h2 className="mb-1 text-lg font-semibold text-card-foreground">Synthetic auth log dataset</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Loads the canonical dataset (<code>scripts/generate-dataset.mjs</code>) into the{' '}
            <code>authEvents</code> collection. Safe to re-run — each row upserts by its stable
            event id, so re-running never creates duplicates.
          </p>

          <div className="mb-4 flex items-center gap-3">
            <Button disabled={importRunning} onClick={() => enqueue('import-synthetic-events', {})}>
              {importRunning ? 'Importing…' : 'Import synthetic events'}
            </Button>
            <span className="text-sm text-muted-foreground">
              {status === 'loading' ? 'Loading…' : `${authEvents.length} events in authEvents`}
            </span>
          </div>

          <JobList jobs={importJobs} testId="import-job-row" renderResult={renderImportResult} />
        </section>

        <section className="rounded-xl border border-border bg-card p-6 shadow-[0_1px_3px_0_rgba(23,37,84,0.08)]">
          <h2 className="mb-1 text-lg font-semibold text-card-foreground">Statistical anomaly detection</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Recomputes <code>statAnomalyScore</code>/<code>statReasons</code> on every row using
            the explainable rules in <code>src/lib/anomaly-detection.ts</code> (failed-login
            bursts, impossible travel, new device). Pure and deterministic — safe to re-run
            anytime after an import.
          </p>

          <div className="mb-4 flex items-center gap-3">
            <Button disabled={recomputeRunning} onClick={() => enqueue('recompute-stat-scores', {})}>
              {recomputeRunning ? 'Scoring…' : 'Recompute statistical scores'}
            </Button>
            <span className="text-sm text-muted-foreground">
              {status === 'loading' ? 'Loading…' : `${flaggedCount} of ${authEvents.length} currently flagged`}
            </span>
          </div>

          <JobList jobs={recomputeJobs} testId="recompute-job-row" renderResult={renderRecomputeResult} />
        </section>
      </div>
    </div>
  )
}

function renderImportResult(result: AnyJobResult): ReactNode {
  if (isRecomputeResult(result)) return null
  return (
    <span className="text-muted-foreground">
      {result.imported} imported
      {result.failed > 0 ? `, ${result.failed} failed` : ''}
    </span>
  )
}

function renderRecomputeResult(result: AnyJobResult): ReactNode {
  if (!isRecomputeResult(result)) return null
  return (
    <span className="text-muted-foreground">
      {result.flagged} flagged of {result.totalEvents}
      {result.failed > 0 ? `, ${result.failed} failed` : ''}
    </span>
  )
}

function JobList({
  jobs,
  testId,
  renderResult,
}: {
  jobs: JobView<Record<string, unknown>, AnyJobResult>[]
  testId: string
  renderResult: (result: AnyJobResult) => ReactNode
}) {
  if (jobs.length === 0) return null
  return (
    <ul className="space-y-2 text-sm">
      {jobs.slice(0, 5).map((job) => (
        <li
          key={job.id}
          data-testid={testId}
          data-status={job.status}
          className="flex items-center justify-between rounded-md border border-border px-3 py-2"
        >
          <div className="flex items-center gap-2">
            <Badge
              variant={
                job.status === 'succeeded' ? 'success' : job.status === 'failed' ? 'destructive' : 'secondary'
              }
            >
              {job.status}
            </Badge>
            <span className="text-muted-foreground">
              {job.progressMessage ?? (job.progress != null ? `${Math.round(job.progress * 100)}%` : '')}
            </span>
          </div>
          {job.result && renderResult(job.result)}
          {job.error && <span className="text-destructive">{job.error}</span>}
        </li>
      ))}
    </ul>
  )
}
