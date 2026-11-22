/**
 * Dashboard — the analyst-facing investigation surface. Reached at
 * /dashboard, visible to every signed-in analyst (not admin-gated — see
 * src/nav.ts). Reads real, persisted `authEvents` rows via `useQuery`; it
 * does not compute anything itself. Scoring happens once, server-side, in
 * the `recompute-stat-scores` background job (src/jobs.ts) using
 * src/lib/anomaly-detection.ts — this page only filters, sorts, and
 * explains what's already stored.
 */

import { useMemo, useState } from 'react'
import { useQuery } from 'deepspace'
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  Modal,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SearchInput,
  Switch,
  Label,
  StatCard,
} from '@/components/ui'
import { ActivityChart, RuleDistributionChart, type DayBucket, type RuleCount } from '@/components/charts'
import { EventReasons, RuleReference } from '@/components/EventReasons'
import { CreateCaseModal } from '@/components/CreateCaseModal'

interface AuthEventRecord {
  timestamp: number
  actorId: string
  sourceIp: string
  country: string
  city: string
  device: string
  eventType: string
  success: number
  statAnomalyScore?: number
  statReasons?: string[]
  mlAnomalyScore?: number
  mlIsOutlier?: number
}

type EventTypeFilter = 'all' | 'login' | 'failed_login' | 'mfa_challenge' | 'password_reset'
type SortMode = 'time' | 'score'

const EVENT_TYPE_LABELS: Record<Exclude<EventTypeFilter, 'all'>, string> = {
  login: 'Login',
  failed_login: 'Failed login',
  mfa_challenge: 'MFA challenge',
  password_reset: 'Password reset',
}

function formatTimestamp(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString()
}

function scoreBadgeVariant(score: number): 'secondary' | 'warning' | 'destructive' {
  if (score <= 0) return 'secondary'
  if (score < 0.6) return 'warning'
  return 'destructive'
}

export default function DashboardPage() {
  const { records, status, error: queryError } = useQuery<AuthEventRecord>('authEvents', {
    limit: 2000,
    orderBy: 'timestamp',
    orderDir: 'desc',
  })

  const [eventType, setEventType] = useState<EventTypeFilter>('all')
  const [flaggedOnly, setFlaggedOnly] = useState(false)
  const [mlOutlierOnly, setMlOutlierOnly] = useState(false)
  const [actorSearch, setActorSearch] = useState('')
  const [sortMode, setSortMode] = useState<SortMode>('time')
  const [selected, setSelected] = useState<(typeof records)[number] | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [creatingCaseFor, setCreatingCaseFor] = useState<string[] | null>(null)

  function toggleSelected(recordId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(recordId)) next.delete(recordId)
      else next.add(recordId)
      return next
    })
  }

  // --- Alert summary: computed over the FULL dataset, independent of the
  // filters below, so it always answers "what's the state of the world"
  // rather than changing meaning every time a filter changes. ---
  const summary = useMemo(() => {
    let flagged = 0
    let burst = 0
    let travel = 0
    let newDevice = 0
    let mlOutliers = 0
    let mlScored = 0
    for (const r of records) {
      const reasons = r.data.statReasons ?? []
      if (reasons.length > 0) flagged += 1
      if (reasons.some((x) => x.startsWith('Failed-login burst'))) burst += 1
      if (reasons.some((x) => x.startsWith('Impossible travel'))) travel += 1
      if (reasons.some((x) => x.startsWith('New device'))) newDevice += 1
      if (r.data.mlAnomalyScore != null) mlScored += 1
      if (r.data.mlIsOutlier === 1) mlOutliers += 1
    }
    return { total: records.length, flagged, burst, travel, newDevice, mlOutliers, mlScored }
  }, [records])

  // --- Charts: both computed from the SAME `records` the table renders —
  // nothing here is invented or sampled separately. ---
  const dayBuckets = useMemo<DayBucket[]>(() => {
    const byDay = new Map<string, { total: number; flagged: number }>()
    for (const r of records) {
      const dayKey = new Date(r.data.timestamp * 1000).toISOString().slice(0, 10)
      const bucket = byDay.get(dayKey) ?? { total: 0, flagged: 0 }
      bucket.total += 1
      if ((r.data.statReasons?.length ?? 0) > 0) bucket.flagged += 1
      byDay.set(dayKey, bucket)
    }
    const sortedDays = [...byDay.keys()].sort()
    const lastDays = sortedDays.slice(-14)
    return lastDays.map((dayKey) => ({
      label: new Date(`${dayKey}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      ...byDay.get(dayKey)!,
    }))
  }, [records])

  const ruleCounts = useMemo<RuleCount[]>(
    () => [
      { label: 'Failed-login burst', count: summary.burst, colorClassName: 'bg-destructive' },
      { label: 'Impossible travel', count: summary.travel, colorClassName: 'bg-warning' },
      { label: 'New device', count: summary.newDevice, colorClassName: 'bg-info' },
    ],
    [summary],
  )

  const filtered = useMemo(() => {
    let rows = records
    if (eventType !== 'all') rows = rows.filter((r) => r.data.eventType === eventType)
    if (flaggedOnly) rows = rows.filter((r) => (r.data.statReasons?.length ?? 0) > 0)
    if (mlOutlierOnly) rows = rows.filter((r) => r.data.mlIsOutlier === 1)
    if (actorSearch.trim()) {
      const needle = actorSearch.trim().toLowerCase()
      rows = rows.filter((r) => r.data.actorId.toLowerCase().includes(needle))
    }
    const sorted = [...rows]
    if (sortMode === 'score') {
      sorted.sort((a, b) => (b.data.statAnomalyScore ?? 0) - (a.data.statAnomalyScore ?? 0))
    } else {
      sorted.sort((a, b) => b.data.timestamp - a.data.timestamp)
    }
    return sorted
  }, [records, eventType, flaggedOnly, mlOutlierOnly, actorSearch, sortMode])

  if (status === 'loading') {
    return <div className="flex h-64 items-center justify-center text-muted-foreground">Loading events…</div>
  }

  if (status === 'error') {
    return (
      <div className="min-h-full text-foreground">
        <div className="mx-auto max-w-2xl px-6 py-20">
          <EmptyState
            title="Could not load events"
            description={queryError ?? 'Something went wrong talking to the server. Try reloading the page.'}
          />
        </div>
      </div>
    )
  }

  if (records.length === 0) {
    return (
      <div className="min-h-full text-foreground">
        <div className="mx-auto max-w-2xl px-6 py-20">
          <EmptyState
            title="No events yet"
            description="No authentication events have been imported into this app yet. An admin can import the synthetic dataset from the Admin page."
          />
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-full text-foreground">
      <div className="mx-auto max-w-6xl px-6 py-12">
        <h1 className="mb-2 text-4xl font-bold tracking-tight text-foreground">Dashboard</h1>
        <p className="mb-8 text-sm text-muted-foreground">
          Live view of imported authentication events. Scores and reasons come from the
          explainable statistical detector — click any row for the full explanation.
        </p>

        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-6" data-testid="alert-summary">
          <StatCard label="Total events" value={summary.total} />
          <StatCard label="Flagged (statistical)" value={summary.flagged} tone="alert" />
          <StatCard label="Failed-login bursts" value={summary.burst} tone="alert" />
          <StatCard label="Impossible travel" value={summary.travel} tone="alert" />
          <StatCard label="New device" value={summary.newDevice} tone="alert" />
          <StatCard label="ML outliers" value={summary.mlOutliers} tone="alert" />
        </div>

        <div className="mb-6 grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-border bg-card p-5 shadow-[0_1px_3px_0_rgba(23,37,84,0.08)]">
            <h2 className="mb-4 text-sm font-semibold text-card-foreground">Event activity (last {dayBuckets.length} days with data)</h2>
            {dayBuckets.length === 0 ? (
              <p className="text-sm text-muted-foreground">No dated activity to chart yet.</p>
            ) : (
              <ActivityChart data={dayBuckets} />
            )}
          </div>
          <div className="rounded-xl border border-border bg-card p-5 shadow-[0_1px_3px_0_rgba(23,37,84,0.08)]">
            <h2 className="mb-4 text-sm font-semibold text-card-foreground">Flagged events by rule</h2>
            {summary.flagged === 0 ? (
              <p className="text-sm text-muted-foreground">No events are currently flagged.</p>
            ) : (
              <RuleDistributionChart rules={ruleCounts} />
            )}
          </div>
        </div>

        <div className="mb-4 flex flex-wrap items-end gap-4 rounded-xl border border-border bg-card p-4 shadow-[0_1px_3px_0_rgba(23,37,84,0.08)]">
          <div className="min-w-[180px]">
            <Label className="mb-1 block text-xs text-muted-foreground">Event type</Label>
            <Select value={eventType} onValueChange={(v) => setEventType(v as EventTypeFilter)}>
              <SelectTrigger data-testid="filter-event-type">
                <SelectValue placeholder="All types" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                {Object.entries(EVENT_TYPE_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="min-w-[180px]">
            <Label className="mb-1 block text-xs text-muted-foreground">Sort by</Label>
            <Select value={sortMode} onValueChange={(v) => setSortMode(v as SortMode)}>
              <SelectTrigger data-testid="filter-sort">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="time">Most recent</SelectItem>
                <SelectItem value="score">Highest score</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="min-w-[220px] flex-1">
            <Label className="mb-1 block text-xs text-muted-foreground">Actor</Label>
            <SearchInput
              data-testid="filter-actor-search"
              placeholder="Search by actor id…"
              value={actorSearch}
              onChange={(e) => setActorSearch(e.target.value)}
              onClear={() => setActorSearch('')}
            />
          </div>

          <div className="flex items-center gap-2 pb-2">
            <Switch
              id="flagged-only"
              checked={flaggedOnly}
              onCheckedChange={setFlaggedOnly}
              data-testid="filter-flagged-only"
            />
            <Label htmlFor="flagged-only" className="text-sm">
              Flagged only
            </Label>
          </div>

          <div className="flex items-center gap-2 pb-2">
            <Switch
              id="ml-outlier-only"
              checked={mlOutlierOnly}
              onCheckedChange={setMlOutlierOnly}
              data-testid="filter-ml-outlier-only"
            />
            <Label htmlFor="ml-outlier-only" className="text-sm">
              ML outliers only
            </Label>
          </div>
        </div>

        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs text-muted-foreground" data-testid="result-count">
            Showing {filtered.length} of {records.length} events
          </p>
          {selectedIds.size > 0 && (
            <Button
              size="sm"
              data-testid="open-case-from-selection"
              onClick={() => setCreatingCaseFor([...selectedIds])}
            >
              Open case from {selectedIds.size} selected
            </Button>
          )}
        </div>

        {filtered.length === 0 ? (
          <EmptyState title="No events match these filters" description="Try widening the filters above." />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border bg-card shadow-[0_1px_3px_0_rgba(23,37,84,0.08)]">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/60 text-xs text-muted-foreground">
                <tr>
                  <th className="w-8 px-3 py-2" aria-label="Select" />
                  <th className="px-3 py-2">Time</th>
                  <th className="px-3 py-2">Actor</th>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Location</th>
                  <th className="px-3 py-2">Device</th>
                  <th className="px-3 py-2">Stat. score</th>
                  <th className="px-3 py-2">ML score</th>
                  <th className="px-3 py-2">Why</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 500).map((r) => {
                  const score = r.data.statAnomalyScore ?? 0
                  const reasons = r.data.statReasons ?? []
                  return (
                    <tr
                      key={r.recordId}
                      data-testid="event-row"
                      data-score={score}
                      onClick={() => setSelected(r)}
                      className="cursor-pointer border-t border-border hover:bg-card/60"
                    >
                      <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          data-testid="event-row-select"
                          checked={selectedIds.has(r.recordId)}
                          onCheckedChange={() => toggleSelected(r.recordId)}
                          aria-label={`Select event from ${r.data.actorId}`}
                        />
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                        {formatTimestamp(r.data.timestamp)}
                      </td>
                      <td className="px-3 py-2 font-medium">{r.data.actorId}</td>
                      <td className="px-3 py-2">
                        <Badge variant={r.data.success ? 'secondary' : 'destructive'} size="sm">
                          {EVENT_TYPE_LABELS[r.data.eventType as keyof typeof EVENT_TYPE_LABELS] ?? r.data.eventType}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {r.data.city}, {r.data.country}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{r.data.device}</td>
                      <td className="px-3 py-2">
                        <Badge variant={scoreBadgeVariant(score)} size="sm">
                          {score.toFixed(2)}
                        </Badge>
                      </td>
                      <td className="px-3 py-2">
                        {r.data.mlAnomalyScore == null ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <Badge
                            variant={r.data.mlIsOutlier === 1 ? 'destructive' : 'secondary'}
                            size="sm"
                            data-testid="ml-score-badge"
                          >
                            {r.data.mlAnomalyScore.toFixed(2)}
                          </Badge>
                        )}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {reasons.length === 0 ? '—' : `${reasons.length} reason${reasons.length === 1 ? '' : 's'}`}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {selected && (
        <Modal open onClose={() => setSelected(null)} size="lg">
          <Modal.Header>
            <Modal.Title>
              {selected.data.actorId} — {formatTimestamp(selected.data.timestamp)}
            </Modal.Title>
            <Modal.Description>
              {EVENT_TYPE_LABELS[selected.data.eventType as keyof typeof EVENT_TYPE_LABELS] ?? selected.data.eventType}
              {' · '}
              {selected.data.success ? 'succeeded' : 'failed'}
            </Modal.Description>
          </Modal.Header>
          <Modal.Body>
            <div className="mb-4 flex justify-end">
              <Button
                size="sm"
                variant="secondary"
                data-testid="open-case-from-event"
                onClick={() => setCreatingCaseFor([selected.recordId])}
              >
                Open case from this event
              </Button>
            </div>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-muted-foreground">Source IP</dt>
                <dd>{selected.data.sourceIp}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Location</dt>
                <dd>
                  {selected.data.city}, {selected.data.country}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Device</dt>
                <dd>{selected.data.device}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Statistical score</dt>
                <dd>
                  <Badge variant={scoreBadgeVariant(selected.data.statAnomalyScore ?? 0)} size="sm">
                    {(selected.data.statAnomalyScore ?? 0).toFixed(2)}
                  </Badge>
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">ML score (offline model)</dt>
                <dd>
                  {selected.data.mlAnomalyScore == null ? (
                    <span className="text-sm text-muted-foreground">Not yet scored</span>
                  ) : (
                    <Badge variant={selected.data.mlIsOutlier === 1 ? 'destructive' : 'secondary'} size="sm">
                      {selected.data.mlAnomalyScore.toFixed(2)}
                      {selected.data.mlIsOutlier === 1 ? ' · outlier' : ''}
                    </Badge>
                  )}
                </dd>
              </div>
            </dl>

            <div className="mt-5">
              <h3 className="mb-2 text-sm font-semibold">Why this was flagged (statistical)</h3>
              <EventReasons reasons={selected.data.statReasons ?? []} />
            </div>

            <div className="mt-5 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
              <strong className="text-foreground">Statistical score</strong> is computed live, inside the
              app, from three named rules you can see above — every flag traces back to an explicit
              threshold. <strong className="text-foreground">ML score</strong> comes from an offline
              Isolation Forest model (scikit-learn), trained once outside the app and imported as a static
              enrichment — it has no rule to point to, only a learned sense of "how unusual is this event's
              combination of features." They can, and sometimes do, disagree; see{' '}
              <code>docs/ML_EVALUATION_REPORT.md</code> for how well they agree on this dataset.
            </div>

            <RuleReference />
          </Modal.Body>
        </Modal>
      )}

      {creatingCaseFor && (
        <CreateCaseModal
          eventIds={creatingCaseFor}
          onClose={() => {
            setCreatingCaseFor(null)
            setSelectedIds(new Set())
          }}
        />
      )}
    </div>
  )
}
