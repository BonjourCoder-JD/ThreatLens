/**
 * Explainable statistical anomaly detection for authEvents.
 *
 * Pure, deterministic, dependency-free functions: no DB, no network, no
 * randomness. Given the same events, this always returns the same scores
 * and reasons — which is what makes it unit-testable without a Durable
 * Object, and what makes "why was this flagged" answerable by just
 * printing `statReasons` back to the analyst. Contrast with the Day 3
 * offline Isolation Forest: that's a black-box model trained once, outside
 * the app; this runs live, inside the app, and every score traces back to
 * one of exactly three named rules below.
 *
 * Used by src/jobs.ts's `recompute-stat-scores` job (reads authEvents,
 * calls `computeStatScores`, patches `statAnomalyScore`/`statReasons`
 * back). Recomputing is naturally idempotent: identical input always
 * produces identical output, so re-running never drifts.
 */

import { distanceBetweenCities } from './geo'

export interface AuthEventInput {
  recordId: string
  actorId: string
  timestamp: number
  country: string
  city: string
  device: string
  eventType: string
  success: number
}

export interface DetectionResult {
  recordId: string
  statAnomalyScore: number
  statReasons: string[]
}

// ---------------------------------------------------------------------------
// Thresholds — tune here, not inline, so a reviewer (or future me) can find
// every knob in one place and tests can reference the same constants rather
// than re-deriving magic numbers.
// ---------------------------------------------------------------------------

/** A run of this many (or more) failed logins inside the window counts as a burst. */
export const FAILED_LOGIN_BURST_THRESHOLD = 4
/** Window radius, in seconds, the burst detector slides across. */
export const FAILED_LOGIN_BURST_WINDOW_SECONDS = 15 * 60

/** Below this distance, "different city" is treated as noise, not a signal
 *  (e.g. two nearby metro areas) — none of the synthetic cities are this
 *  close together, so in practice this only matters if real city data is
 *  added later. */
export const IMPOSSIBLE_TRAVEL_MIN_DISTANCE_KM = 300
/** Faster than a commercial flight — implausible for one person, two logins. */
export const IMPOSSIBLE_TRAVEL_MIN_KMH = 800

/** Each matched rule adds this many points to an event's score, summed and
 *  capped at 1. The order here is also the canonical display order. */
export const RULE_WEIGHTS: ReadonlyArray<{ label: string; weight: number }> = [
  { label: 'Failed-login burst', weight: 0.5 },
  { label: 'Impossible travel', weight: 0.6 },
  { label: 'New device', weight: 0.3 },
]

function addReason(target: Map<string, string[]>, recordId: string, reason: string): void {
  const list = target.get(recordId)
  if (list) list.push(reason)
  else target.set(recordId, [reason])
}

/**
 * Failed-login bursts, via a sliding window over each actor's failed_login
 * events (sorted ascending). O(n) two-pointer: `left` only ever advances,
 * so the whole pass over one actor's failed logins is linear.
 */
function detectFailedLoginBursts(sortedEvents: AuthEventInput[]): Map<string, string> {
  const failed = sortedEvents.filter((e) => e.eventType === 'failed_login')
  const best = new Map<string, { count: number; spanMinutes: number }>()

  let left = 0
  for (let right = 0; right < failed.length; right++) {
    while (failed[right].timestamp - failed[left].timestamp > FAILED_LOGIN_BURST_WINDOW_SECONDS) {
      left++
    }
    const count = right - left + 1
    if (count >= FAILED_LOGIN_BURST_THRESHOLD) {
      const spanMinutes = Math.max(1, Math.round((failed[right].timestamp - failed[left].timestamp) / 60))
      for (let k = left; k <= right; k++) {
        const recordId = failed[k].recordId
        const prev = best.get(recordId)
        if (!prev || count > prev.count) best.set(recordId, { count, spanMinutes })
      }
    }
  }

  const reasons = new Map<string, string>()
  for (const [recordId, { count, spanMinutes }] of best) {
    reasons.set(
      recordId,
      `Failed-login burst: ${count} failed attempts within ${spanMinutes} minute${spanMinutes === 1 ? '' : 's'}`,
    )
  }
  return reasons
}

/**
 * Impossible travel: compares each event only to the SAME actor's
 * immediately preceding event. "Impossible" here means the implied speed
 * between the two logins' cities exceeds plausible travel — it does not
 * claim the person literally flew; two logins that far apart that close
 * together implies at least one of them isn't really this person.
 */
function detectImpossibleTravel(sortedEvents: AuthEventInput[]): Map<string, string> {
  const reasons = new Map<string, string>()
  for (let i = 1; i < sortedEvents.length; i++) {
    const prev = sortedEvents[i - 1]
    const curr = sortedEvents[i]
    if (prev.city === curr.city) continue

    const distanceKm = distanceBetweenCities(prev.city, curr.city)
    if (distanceKm == null || distanceKm < IMPOSSIBLE_TRAVEL_MIN_DISTANCE_KM) continue

    const elapsedSeconds = curr.timestamp - prev.timestamp
    const elapsedHours = Math.max(elapsedSeconds / 3600, 1 / 3600) // floor at 1 second to avoid /0
    const impliedKmh = distanceKm / elapsedHours
    if (impliedKmh < IMPOSSIBLE_TRAVEL_MIN_KMH) continue

    const elapsedMinutes = Math.max(1, Math.round(elapsedSeconds / 60))
    reasons.set(
      curr.recordId,
      `Impossible travel: ${prev.city} -> ${curr.city} in ${elapsedMinutes} minute${elapsedMinutes === 1 ? '' : 's'} (~${Math.round(impliedKmh)} km/h implied)`,
    )
  }
  return reasons
}

/**
 * New device: an actor's FIRST event ever is their baseline and is never
 * flagged (there's nothing to compare it to yet) — without this, every
 * actor's very first login would be a false positive by construction.
 * Every device, once seen, stays "known" for that actor from then on.
 */
function detectNewDevice(sortedEvents: AuthEventInput[]): Map<string, string> {
  const reasons = new Map<string, string>()
  const seen = new Set<string>()
  for (let i = 0; i < sortedEvents.length; i++) {
    const e = sortedEvents[i]
    if (i > 0 && !seen.has(e.device)) {
      const priorDevices = [...seen].join(', ') || 'none'
      reasons.set(e.recordId, `New device: first use of '${e.device}' for this account (previously ${priorDevices})`)
    }
    seen.add(e.device)
  }
  return reasons
}

/** Score is literally the sum of matched rules' weights, capped at 1 — the
 *  score and the reason list can never disagree, by construction. */
function computeScore(reasons: string[]): number {
  let score = 0
  for (const reason of reasons) {
    const rule = RULE_WEIGHTS.find((r) => reason.startsWith(r.label))
    if (rule) score += rule.weight
  }
  return Math.min(1, Math.round(score * 100) / 100)
}

/** Runs all three rules per actor and returns one result per input event,
 *  in the same order as `events`. */
export function computeStatScores(events: AuthEventInput[]): DetectionResult[] {
  const byActor = new Map<string, AuthEventInput[]>()
  for (const e of events) {
    const list = byActor.get(e.actorId)
    if (list) list.push(e)
    else byActor.set(e.actorId, [e])
  }

  const reasonsByRecordId = new Map<string, string[]>()
  for (const actorEvents of byActor.values()) {
    const sorted = [...actorEvents].sort((a, b) => a.timestamp - b.timestamp)
    for (const [recordId, reason] of detectFailedLoginBursts(sorted)) addReason(reasonsByRecordId, recordId, reason)
    for (const [recordId, reason] of detectImpossibleTravel(sorted)) addReason(reasonsByRecordId, recordId, reason)
    for (const [recordId, reason] of detectNewDevice(sorted)) addReason(reasonsByRecordId, recordId, reason)
  }

  return events.map((e) => {
    const statReasons = reasonsByRecordId.get(e.recordId) ?? []
    return { recordId: e.recordId, statAnomalyScore: computeScore(statReasons), statReasons }
  })
}
