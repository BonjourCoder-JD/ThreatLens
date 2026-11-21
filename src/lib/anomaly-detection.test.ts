import { describe, it, expect } from 'vitest'
import {
  computeStatScores,
  FAILED_LOGIN_BURST_THRESHOLD,
  FAILED_LOGIN_BURST_WINDOW_SECONDS,
  IMPOSSIBLE_TRAVEL_MIN_KMH,
  IMPOSSIBLE_TRAVEL_MIN_DISTANCE_KM,
  RULE_WEIGHTS,
  type AuthEventInput,
} from './anomaly-detection'
import dataset from '../data/synthetic-auth-events.json'

const BASE_TS = 1_800_000_000

function event(overrides: Partial<AuthEventInput> & { recordId: string }): AuthEventInput {
  return {
    actorId: 'user_001',
    timestamp: BASE_TS,
    country: 'US',
    city: 'New York',
    device: 'Windows-Chrome',
    eventType: 'login',
    success: 1,
    ...overrides,
  }
}

function scoreOf(results: ReturnType<typeof computeStatScores>, recordId: string) {
  const r = results.find((x) => x.recordId === recordId)
  if (!r) throw new Error(`no result for ${recordId}`)
  return r
}

describe('computeStatScores — failed-login burst', () => {
  it('does NOT flag 3 failed logins in a row (below threshold) — false-positive guard', () => {
    expect(FAILED_LOGIN_BURST_THRESHOLD).toBe(4)
    const events = [0, 1, 2].map((i) =>
      event({ recordId: `f${i}`, eventType: 'failed_login', success: 0, timestamp: BASE_TS + i * 10 }),
    )
    const results = computeStatScores(events)
    for (const r of results) {
      expect(r.statReasons).toEqual([])
      expect(r.statAnomalyScore).toBe(0)
    }
  })

  it('flags exactly 4 failed logins within the window', () => {
    const events = [0, 1, 2, 3].map((i) =>
      event({ recordId: `f${i}`, eventType: 'failed_login', success: 0, timestamp: BASE_TS + i * 10 }),
    )
    const results = computeStatScores(events)
    for (const r of results) {
      expect(r.statReasons.some((reason) => reason.startsWith('Failed-login burst'))).toBe(true)
      expect(r.statAnomalyScore).toBeGreaterThan(0)
    }
  })

  it('does NOT flag 4 failed logins spread outside the burst window', () => {
    const spacing = FAILED_LOGIN_BURST_WINDOW_SECONDS * 2 // well outside the window
    const events = [0, 1, 2, 3].map((i) =>
      event({ recordId: `f${i}`, eventType: 'failed_login', success: 0, timestamp: BASE_TS + i * spacing }),
    )
    const results = computeStatScores(events)
    for (const r of results) {
      expect(r.statReasons).toEqual([])
    }
  })

  it('a single incidental typo-failure is not a burst', () => {
    const events = [
      event({ recordId: 'ok1', timestamp: BASE_TS }),
      event({ recordId: 'typo', eventType: 'failed_login', success: 0, timestamp: BASE_TS + 60 }),
      event({ recordId: 'ok2', timestamp: BASE_TS + 120 }),
    ]
    const results = computeStatScores(events)
    expect(scoreOf(results, 'typo').statReasons).toEqual([])
  })
})

describe('computeStatScores — impossible travel', () => {
  it('flags two logins from far-apart cities close together in time', () => {
    const events = [
      event({ recordId: 'a', city: 'New York', country: 'US', timestamp: BASE_TS }),
      event({ recordId: 'b', city: 'Lagos', country: 'NG', timestamp: BASE_TS + 600 }), // 10 min later
    ]
    const results = computeStatScores(events)
    expect(scoreOf(results, 'a').statReasons).toEqual([]) // the earlier event is never the one flagged
    const flagged = scoreOf(results, 'b')
    expect(flagged.statReasons.some((r) => r.startsWith('Impossible travel'))).toBe(true)
    expect(flagged.statAnomalyScore).toBeGreaterThan(0)
  })

  it('does NOT flag far-apart cities with enough elapsed time for real travel', () => {
    const events = [
      event({ recordId: 'a', city: 'New York', timestamp: BASE_TS }),
      event({ recordId: 'b', city: 'London', timestamp: BASE_TS + 20 * 3600 }), // 20 hours later
    ]
    const results = computeStatScores(events)
    expect(scoreOf(results, 'b').statReasons).toEqual([])
  })

  it('does NOT flag a nearby, still-plausible change (same city) — false-positive guard', () => {
    const events = [
      event({ recordId: 'a', city: 'New York', timestamp: BASE_TS }),
      event({ recordId: 'b', city: 'New York', timestamp: BASE_TS + 60 }),
    ]
    const results = computeStatScores(events)
    expect(scoreOf(results, 'b').statReasons).toEqual([])
  })

  it('the implied-speed threshold is the documented constant, not a guess', () => {
    expect(IMPOSSIBLE_TRAVEL_MIN_KMH).toBe(800)
  })
})

describe('computeStatScores — new device', () => {
  it('never flags an actor\'s very first event, regardless of device', () => {
    const events = [event({ recordId: 'first', device: 'iOS-App', timestamp: BASE_TS })]
    const results = computeStatScores(events)
    expect(scoreOf(results, 'first').statReasons).toEqual([])
  })

  it('does NOT flag a repeat of a previously-seen device — false-positive guard', () => {
    const events = [
      event({ recordId: 'a', device: 'Windows-Chrome', timestamp: BASE_TS }),
      event({ recordId: 'b', device: 'Windows-Chrome', timestamp: BASE_TS + 100 }),
    ]
    const results = computeStatScores(events)
    expect(scoreOf(results, 'b').statReasons).toEqual([])
  })

  it('flags a genuinely new device after an established baseline', () => {
    const events = [
      event({ recordId: 'a', device: 'Windows-Chrome', timestamp: BASE_TS }),
      event({ recordId: 'b', device: 'Linux-Firefox', timestamp: BASE_TS + 100 }),
    ]
    const results = computeStatScores(events)
    const flagged = scoreOf(results, 'b')
    expect(flagged.statReasons.some((r) => r.startsWith('New device'))).toBe(true)
  })

  it('does NOT re-flag a device once it has been seen, even after switching away and back', () => {
    const events = [
      event({ recordId: 'a', device: 'Windows-Chrome', timestamp: BASE_TS }),
      event({ recordId: 'b', device: 'Linux-Firefox', timestamp: BASE_TS + 100 }), // flagged, new
      event({ recordId: 'c', device: 'Windows-Chrome', timestamp: BASE_TS + 200 }), // seen before, not flagged
    ]
    const results = computeStatScores(events)
    expect(scoreOf(results, 'c').statReasons).toEqual([])
  })
})

describe('computeStatScores — scoring is explainable and deterministic', () => {
  it('score is exactly the sum of matched rule weights, capped at 1', () => {
    // Stack failed-login burst (0.5) AND new device (0.3) onto one event.
    const events = [
      event({ recordId: 'a', device: 'Windows-Chrome', timestamp: BASE_TS }),
      event({ recordId: 'f0', device: 'Linux-Firefox', eventType: 'failed_login', success: 0, timestamp: BASE_TS + 60 }),
      event({ recordId: 'f1', device: 'Linux-Firefox', eventType: 'failed_login', success: 0, timestamp: BASE_TS + 70 }),
      event({ recordId: 'f2', device: 'Linux-Firefox', eventType: 'failed_login', success: 0, timestamp: BASE_TS + 80 }),
      event({ recordId: 'f3', device: 'Linux-Firefox', eventType: 'failed_login', success: 0, timestamp: BASE_TS + 90 }),
    ]
    const results = computeStatScores(events)
    const f0 = scoreOf(results, 'f0')
    expect(f0.statReasons).toHaveLength(2)
    expect(f0.statAnomalyScore).toBeCloseTo(0.8, 5) // 0.5 (burst) + 0.3 (new device)
  })

  it('is a pure function: calling it twice on the same input gives identical output', () => {
    const events = [
      event({ recordId: 'a', timestamp: BASE_TS }),
      event({ recordId: 'b', device: 'Linux-Firefox', timestamp: BASE_TS + 100 }),
    ]
    expect(computeStatScores(events)).toEqual(computeStatScores(events))
  })

  it('an event with no matched rule has an empty reason list and a zero score', () => {
    const events = [event({ recordId: 'a', timestamp: BASE_TS })]
    const r = scoreOf(computeStatScores(events), 'a')
    expect(r.statReasons).toEqual([])
    expect(r.statAnomalyScore).toBe(0)
  })
})

describe('explanations: threshold text matches the actual scoring logic', () => {
  it('rule reference thresholds are generated from the real exported constants, not retyped', () => {
    // These assertions would fail if someone changed a threshold constant
    // and forgot to update RULE_WEIGHTS' description — which is the whole
    // point: the displayed explanation can't silently drift from the logic.
    const burst = RULE_WEIGHTS.find((r) => r.label === 'Failed-login burst')!
    expect(burst.threshold).toContain(String(FAILED_LOGIN_BURST_THRESHOLD))
    expect(burst.threshold).toContain(String(FAILED_LOGIN_BURST_WINDOW_SECONDS / 60))

    const travel = RULE_WEIGHTS.find((r) => r.label === 'Impossible travel')!
    expect(travel.threshold).toContain(String(IMPOSSIBLE_TRAVEL_MIN_KMH))
    expect(travel.threshold).toContain(String(IMPOSSIBLE_TRAVEL_MIN_DISTANCE_KM))
  })

  it('a burst reason states both the observed count and the configured threshold', () => {
    const events = [0, 1, 2, 3, 4].map((i) =>
      event({ recordId: `f${i}`, eventType: 'failed_login', success: 0, timestamp: BASE_TS + i * 10 }),
    )
    const reason = scoreOf(computeStatScores(events), 'f0').statReasons[0]
    expect(reason).toContain('5 failed attempts') // observed evidence
    expect(reason).toContain(`${FAILED_LOGIN_BURST_THRESHOLD}+`) // the actual threshold
    expect(reason).toContain(`${FAILED_LOGIN_BURST_WINDOW_SECONDS / 60} min`)
  })

  it('a travel reason states the observed speed and the configured threshold', () => {
    const events = [
      event({ recordId: 'a', city: 'New York', timestamp: BASE_TS }),
      event({ recordId: 'b', city: 'Lagos', timestamp: BASE_TS + 600 }),
    ]
    const reason = scoreOf(computeStatScores(events), 'b').statReasons[0]
    expect(reason).toMatch(/~\d+ km\/h implied/) // observed evidence
    expect(reason).toContain(`${IMPOSSIBLE_TRAVEL_MIN_KMH}+ km/h`) // the actual threshold
    expect(reason).toContain(`${IMPOSSIBLE_TRAVEL_MIN_DISTANCE_KM}+ km`)
  })

  it('a new-device reason names both the new and prior device(s)', () => {
    const events = [
      event({ recordId: 'a', device: 'Windows-Chrome', timestamp: BASE_TS }),
      event({ recordId: 'b', device: 'Linux-Firefox', timestamp: BASE_TS + 100 }),
    ]
    const reason = scoreOf(computeStatScores(events), 'b').statReasons[0]
    expect(reason).toContain("'Linux-Firefox'")
    expect(reason).toContain('Windows-Chrome')
  })
})

describe('computeStatScores — against the real canonical dataset', () => {
  const asInputs: AuthEventInput[] = dataset.events.map((e) => ({
    recordId: e.eventId,
    actorId: e.actorId,
    timestamp: e.timestamp,
    country: e.country,
    city: e.city,
    device: e.device,
    eventType: e.eventType,
    success: e.success,
  }))
  const results = computeStatScores(asInputs)
  const byId = new Map(results.map((r) => [r.recordId, r]))

  it('catches every injected impossible_travel event', () => {
    const injected = dataset.events.filter((e) => e.groundTruthReason === 'impossible_travel')
    expect(injected.length).toBeGreaterThan(0)
    for (const e of injected) {
      const r = byId.get(e.eventId)
      expect(r?.statReasons.some((reason) => reason.startsWith('Impossible travel'))).toBe(true)
    }
  })

  it('catches every injected brute_force_burst event', () => {
    const injected = dataset.events.filter((e) => e.groundTruthReason === 'brute_force_burst')
    expect(injected.length).toBeGreaterThan(0)
    for (const e of injected) {
      const r = byId.get(e.eventId)
      expect(r?.statReasons.some((reason) => reason.startsWith('Failed-login burst'))).toBe(true)
    }
  })

  it('catches every injected new_device_odd_hour event via the new-device rule', () => {
    // The detector has no "odd hour" rule by design (out of scope for Day 2's
    // three named rules) — it should still catch the device-change half.
    const injected = dataset.events.filter((e) => e.groundTruthReason === 'new_device_odd_hour')
    expect(injected.length).toBeGreaterThan(0)
    for (const e of injected) {
      const r = byId.get(e.eventId)
      expect(r?.statReasons.some((reason) => reason.startsWith('New device'))).toBe(true)
    }
  })

  it('keeps the false-positive rate on known-benign events low', () => {
    const benign = dataset.events.filter((e) => e.groundTruthAnomaly === 0)
    const falsePositives = benign.filter((e) => (byId.get(e.eventId)?.statReasons.length ?? 0) > 0)
    const rate = falsePositives.length / benign.length
    // Not a claim of ML-grade precision — a regression guard so a future
    // change to the rules can't silently make the detector noisy without a
    // test failing. See docs/CODE_WALKTHROUGH.md for why this isn't the
    // same thing as the Day 3/4 precision/recall evaluation report.
    expect(rate).toBeLessThan(0.05)
  })
})
