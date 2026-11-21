/**
 * Guards the committed canonical dataset (scripts/generate-dataset.mjs ->
 * src/data/synthetic-auth-events.json) against the two bug classes we hit
 * while building the generator: a country paired with a city from a
 * different country (two independent random picks that should have been
 * one), and an anomaly injection rate so high it would make any detector
 * look artificially good. See docs/DEBUGGING_LOG.md for the incident this
 * test was written for.
 */

import { describe, expect, it } from 'vitest'
import dataset from './synthetic-auth-events.json'

const KNOWN_CITY_BY_COUNTRY: Record<string, string[]> = {
  US: ['New York', 'San Francisco'],
  GB: ['London'],
  DE: ['Berlin'],
  CA: ['Toronto'],
  AU: ['Sydney'],
  JP: ['Tokyo'],
  BR: ['Sao Paulo'],
  RU: ['Moscow'],
  NG: ['Lagos'],
  VN: ['Hanoi'],
}
const ALLOWED_EVENT_TYPES = ['login', 'failed_login', 'mfa_challenge', 'password_reset']

describe('synthetic-auth-events.json (canonical dataset)', () => {
  it('has the expected row count and every eventId unique', () => {
    expect(dataset.events.length).toBe(dataset.count)
    const ids = new Set(dataset.events.map((e) => e.eventId))
    expect(ids.size).toBe(dataset.events.length)
  })

  it('never pairs a country with a city that belongs to a different country', () => {
    const mismatched = dataset.events.filter(
      (e) => !KNOWN_CITY_BY_COUNTRY[e.country]?.includes(e.city),
    )
    expect(mismatched).toEqual([])
  })

  it('only uses declared eventType values', () => {
    const bad = dataset.events.filter((e) => !ALLOWED_EVENT_TYPES.includes(e.eventType))
    expect(bad).toEqual([])
  })

  it('keeps the ground-truth anomaly rate realistic (1%-10%)', () => {
    const rate = dataset.anomalyCount / dataset.count
    expect(rate).toBeGreaterThan(0.01)
    expect(rate).toBeLessThan(0.1)
  })

  it('every anomalous event carries a reason, every normal event does not', () => {
    const inconsistent = dataset.events.filter(
      (e) => Boolean(e.groundTruthAnomaly) !== Boolean(e.groundTruthReason),
    )
    expect(inconsistent).toEqual([])
  })
})
