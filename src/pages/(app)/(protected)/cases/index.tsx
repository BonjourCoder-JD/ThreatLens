/**
 * Case list — every analyst sees every case (small shared team, per
 * docs/ARCHITECTURE.md's "single shared workspace" design decision from
 * Day 1). Reads `cases` live via `useQuery`; real-time updates (status
 * changes, new cases) appear for every connected analyst without a
 * refresh.
 */

import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useUserLookup } from 'deepspace'
import { Badge, EmptyState, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Label } from '@/components/ui'

interface CaseRecord {
  title: string
  status: string
  priority: string
  assignedTo?: string
  relatedEventIds?: string[]
  summary?: string
}

const STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  investigating: 'Investigating',
  resolved: 'Resolved',
  false_positive: 'False positive',
}

const STATUS_BADGE: Record<string, 'info' | 'warning' | 'success' | 'secondary'> = {
  open: 'info',
  investigating: 'warning',
  resolved: 'success',
  false_positive: 'secondary',
}

const PRIORITY_BADGE: Record<string, 'secondary' | 'warning' | 'destructive'> = {
  low: 'secondary',
  medium: 'warning',
  high: 'destructive',
}

export default function CasesListPage() {
  const { records, status } = useQuery<CaseRecord>('cases', { limit: 500 })
  const { getName } = useUserLookup()
  const [statusFilter, setStatusFilter] = useState<string>('all')

  const filtered = useMemo(() => {
    const rows = statusFilter === 'all' ? records : records.filter((r) => r.data.status === statusFilter)
    return [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }, [records, statusFilter])

  if (status === 'loading') {
    return <div className="flex h-64 items-center justify-center text-muted-foreground">Loading cases…</div>
  }

  return (
    <div className="min-h-full text-foreground">
      <div className="mx-auto max-w-5xl px-6 py-12">
        <h1 className="mb-2 text-4xl font-bold tracking-tight text-foreground">Cases</h1>
        <p className="mb-8 text-sm text-muted-foreground">
          Investigations opened from flagged authentication events. Every analyst sees and can work every case.
        </p>

        <div className="mb-4 flex items-end gap-4 rounded-xl border border-border bg-card p-4 shadow-[0_1px_3px_0_rgba(23,37,84,0.08)]">
          <div className="min-w-[180px]">
            <Label className="mb-1 block text-xs text-muted-foreground">Status</Label>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger data-testid="case-status-filter">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {Object.entries(STATUS_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {records.length === 0 ? (
          <EmptyState
            title="No cases yet"
            description="Open a case from one or more flagged events on the Dashboard to start an investigation."
          />
        ) : filtered.length === 0 ? (
          <EmptyState title="No cases match this filter" description="Try a different status." />
        ) : (
          <div className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_3px_0_rgba(23,37,84,0.08)]" data-testid="cases-list">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/60 text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2">Title</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Priority</th>
                  <th className="px-4 py-2">Assigned to</th>
                  <th className="px-4 py-2">Events</th>
                  <th className="px-4 py-2">Updated</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => (
                  <tr key={c.recordId} data-testid="case-row" className="border-t border-border hover:bg-card/60">
                    <td className="px-4 py-2">
                      <Link to={`/cases/${c.recordId}`} className="font-medium text-primary hover:underline">
                        {c.data.title}
                      </Link>
                    </td>
                    <td className="px-4 py-2">
                      <Badge variant={STATUS_BADGE[c.data.status] ?? 'secondary'} size="sm">
                        {STATUS_LABELS[c.data.status] ?? c.data.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-2">
                      <Badge variant={PRIORITY_BADGE[c.data.priority] ?? 'secondary'} size="sm">
                        {c.data.priority}
                      </Badge>
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {c.data.assignedTo ? (getName(c.data.assignedTo) ?? 'Unknown') : 'Unassigned'}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">{c.data.relatedEventIds?.length ?? 0}</td>
                    <td className="px-4 py-2 whitespace-nowrap text-muted-foreground">
                      {new Date(c.updatedAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
