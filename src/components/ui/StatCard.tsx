import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface StatCardProps extends Omit<ComponentProps<'div'>, 'children'> {
  label: string
  value: ReactNode
  /** 'alert' colors the value destructive-red when truthy and non-zero — for
   *  counts where a nonzero value is bad news (flagged events, failures). */
  tone?: 'default' | 'alert'
  icon?: ReactNode
}

/**
 * A single KPI tile: white card, subtle shadow, rounded corners, a big
 * number and a small label. Shared by the dashboard and admin pages so a
 * "how many of X" readout always looks the same across the app — per the
 * design brief's "shared design tokens and reusable components" requirement.
 *
 * Uses a literal `shadow-[...]` value rather than the `shadow-card` utility
 * class, matching the other starter components (see the comment in
 * src/styles.css) — the token-based utility doesn't reliably update across
 * a runtime theme switch; the literal form sidesteps that.
 */
export function StatCard({ label, value, tone = 'default', icon, className, ...props }: StatCardProps) {
  return (
    <div
      className={cn(
        'rounded-xl border border-border bg-card p-4 shadow-[0_1px_3px_0_rgba(23,37,84,0.08)]',
        className,
      )}
      {...props}
    >
      <div className="flex items-center justify-between">
        <div
          className={cn(
            'text-2xl font-bold tabular-nums',
            tone === 'alert' && value !== 0 && value !== '0' ? 'text-destructive' : 'text-card-foreground',
          )}
        >
          {value}
        </div>
        {icon && <div className="text-muted-foreground [&_svg]:size-5">{icon}</div>}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">{label}</div>
    </div>
  )
}
