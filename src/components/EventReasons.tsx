/**
 * Shared "why was this flagged" block — the detection reasons for one
 * event, plus the durable rule-threshold reference. Used by the dashboard's
 * event detail modal AND the case detail page's linked-events list, so an
 * analyst sees the identical explanation no matter where they're looking
 * at an event from.
 */

import { RULE_WEIGHTS } from '@/lib/anomaly-detection'

export function EventReasons({ reasons }: { reasons: string[] }) {
  return (
    <div>
      {reasons.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No statistical rule matched this event, or scores haven't been computed yet (an admin runs "Recompute
          statistical scores" from the Admin page).
        </p>
      ) : (
        <ul className="space-y-1.5" data-testid="detail-reasons">
          {reasons.map((reason) => (
            <li key={reason} className="rounded-md border border-border bg-card px-3 py-2 text-sm">
              {reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function RuleReference() {
  return (
    <div className="mt-5 border-t border-border pt-4">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Detection rule reference
      </h3>
      <ul className="space-y-1 text-xs text-muted-foreground" data-testid="rule-reference">
        {RULE_WEIGHTS.map((rule) => (
          <li key={rule.label}>
            <span className="font-medium text-foreground">{rule.label}</span> (+{rule.weight.toFixed(1)}):{' '}
            {rule.threshold}
          </li>
        ))}
      </ul>
    </div>
  )
}
