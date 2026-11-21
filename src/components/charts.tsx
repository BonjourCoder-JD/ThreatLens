/**
 * Two small, dependency-free charts for the dashboard. Built in plain CSS
 * (flex columns sized by percentage height) rather than pulling in a
 * charting library — the design brief asked for charts "where supported
 * by actual data" without new dependencies, and these two shapes (a
 * stacked bar-over-time, a labeled categorical bar list) don't need one.
 *
 * Follows the project's chart conventions: thin marks, rounded data-ends,
 * a visible gap between stacked segments, direct labels instead of a
 * floating tooltip library, and colors drawn from the app's existing
 * semantic tokens (destructive/warning/info) rather than a new ad-hoc
 * palette — the same red/orange/blue already mean the same thing
 * elsewhere in the app (score badges, status indicators).
 */

import { cn } from '@/lib/utils'

function LegendDot({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className={cn('inline-block size-2.5 rounded-full', className)} aria-hidden />
      {label}
    </span>
  )
}

export interface DayBucket {
  /** Short display label, e.g. "Nov 18". */
  label: string
  total: number
  flagged: number
}

/**
 * Stacked bar chart: total event volume per day, with the flagged portion
 * highlighted. Two series (flagged / clean) → a legend, per the dataviz
 * convention that identity is never color-alone.
 */
export function ActivityChart({ data }: { data: DayBucket[] }) {
  const max = Math.max(1, ...data.map((d) => d.total))
  const rowHeightPx = 160

  return (
    <div>
      <div
        className="flex items-stretch gap-1.5"
        style={{ height: rowHeightPx }}
        role="img"
        aria-label={`Event volume for the last ${data.length} days, with flagged events highlighted`}
      >
        {data.map((d) => {
          const totalPct = (d.total / max) * 100
          const flaggedShare = d.total > 0 ? d.flagged / d.total : 0
          return (
            <div
              key={d.label}
              className="group relative flex flex-1 flex-col justify-end"
              title={`${d.label}: ${d.total} event${d.total === 1 ? '' : 's'}, ${d.flagged} flagged`}
            >
              <div className="flex flex-col justify-end overflow-hidden rounded-t-sm" style={{ height: `${totalPct}%` }}>
                {d.flagged > 0 && (
                  <div className="w-full bg-destructive" style={{ height: `${flaggedShare * 100}%` }} />
                )}
                <div
                  className="w-full bg-primary/35"
                  style={{ height: `${(1 - flaggedShare) * 100}%` }}
                />
              </div>
            </div>
          )
        })}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
        <span>{data[0]?.label}</span>
        <span>{data[data.length - 1]?.label}</span>
      </div>
      <div className="mt-3 flex gap-4">
        <LegendDot className="bg-primary/35" label="Clean" />
        <LegendDot className="bg-destructive" label="Flagged" />
      </div>
    </div>
  )
}

export interface RuleCount {
  label: string
  count: number
  colorClassName: string
}

/**
 * Horizontal bar list for a small set of named categories — each bar is
 * directly labeled, so (per the dataviz convention) no separate legend box
 * is needed; the category name IS the label.
 */
export function RuleDistributionChart({ rules }: { rules: RuleCount[] }) {
  const max = Math.max(1, ...rules.map((r) => r.count))
  return (
    <div className="space-y-3" role="img" aria-label="Flagged events by detection rule">
      {rules.map((r) => (
        <div key={r.label} className="flex items-center gap-3 text-sm">
          <div className="w-36 shrink-0 truncate text-muted-foreground">{r.label}</div>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className={cn('h-full rounded-full', r.colorClassName)}
              style={{ width: `${(r.count / max) * 100}%` }}
            />
          </div>
          <div className="w-8 shrink-0 text-right font-medium tabular-nums">{r.count}</div>
        </div>
      ))}
    </div>
  )
}
