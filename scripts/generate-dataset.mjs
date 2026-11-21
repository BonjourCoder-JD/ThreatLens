#!/usr/bin/env node
/**
 * Canonical synthetic auth-log dataset generator.
 *
 * This is the ONLY place event data is generated. Per the approved design,
 * we do not maintain a second (Python) generator: this script writes one
 * JSON file, and both the DeepSpace import job (src/jobs.ts) and the Day-3
 * offline Isolation Forest script read it. That keeps the two sides
 * trivially in sync — there is no feature/field drift to debug, and no risk
 * of the two "versions" of an event disagreeing.
 *
 * Determinism: a seeded PRNG means the same (seed, count) always produces
 * byte-identical output. That's what makes the import idempotent across
 * reruns (same eventIds, same data) and what makes "grow the dataset"
 * non-disruptive: raising COUNT with the same SEED only appends new events
 * after index 999 — events 0..999 are untouched, so re-running the import
 * job just re-applies identical rows for those and inserts the new ones.
 *
 * Usage:
 *   node scripts/generate-dataset.mjs [count] [seed]
 *   node scripts/generate-dataset.mjs 1000 1337      (defaults)
 *   node scripts/generate-dataset.mjs 5000 1337       (grow later, same seed)
 *
 * Output: src/data/synthetic-auth-events.json
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const COUNT = Number(process.argv[2] ?? 1000)
const SEED = Number(process.argv[3] ?? 1337)
const DATASET_VERSION = `v1-${COUNT}-${SEED}`

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) — tiny, fast, good enough for synthetic
// fixture data. Not cryptographic; that's fine, nothing here is a secret.
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed
  return function rand() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = mulberry32(SEED)
const pick = (arr) => arr[Math.floor(rand() * arr.length)]
const int = (min, max) => Math.floor(min + rand() * (max - min + 1))

// ---------------------------------------------------------------------------
// A small population of synthetic actors, each with a "home" profile.
// Anomalies are framed as departures from an actor's own home profile,
// which is what both the stat detector and the Isolation Forest features
// (recency/velocity/novelty relative to the actor) will key off of.
// ---------------------------------------------------------------------------
const LOCATIONS = [
  { country: 'US', city: 'New York', ipPrefix: '73.12' },
  { country: 'US', city: 'San Francisco', ipPrefix: '98.44' },
  { country: 'GB', city: 'London', ipPrefix: '81.2' },
  { country: 'DE', city: 'Berlin', ipPrefix: '85.214' },
  { country: 'CA', city: 'Toronto', ipPrefix: '99.7' },
  { country: 'AU', city: 'Sydney', ipPrefix: '101.0' },
  { country: 'JP', city: 'Tokyo', ipPrefix: '126.0' },
  { country: 'BR', city: 'Sao Paulo', ipPrefix: '177.0' },
]
// A couple of locations that are never anyone's home — used only to inject
// "impossible travel" / "new location" anomalies, so a flag always means a
// genuine departure from the actor's own history, not just a rare-but-normal
// home base.
const FAR_LOCATIONS = [
  { country: 'RU', city: 'Moscow', ipPrefix: '5.44' },
  { country: 'NG', city: 'Lagos', ipPrefix: '41.58' },
  { country: 'VN', city: 'Hanoi', ipPrefix: '14.160' },
]
const DEVICES = ['Windows-Chrome', 'macOS-Safari', 'Linux-Firefox', 'iOS-App', 'Android-App']

const ACTOR_COUNT = 50
const actors = Array.from({ length: ACTOR_COUNT }, (_, i) => ({
  actorId: `user_${String(i + 1).padStart(3, '0')}`,
  home: pick(LOCATIONS),
  device: pick(DEVICES),
  // Typical login hour (local-ish), used to flag "odd hour" departures.
  typicalHour: int(7, 19),
}))

const NOW = Date.UTC(2026, 10, 21, 12, 0, 0) / 1000 // fixed anchor, not Date.now() — reproducible
const WINDOW_SECONDS = 14 * 24 * 3600
const ipSuffix = () => `${int(1, 254)}.${int(1, 254)}`

function baseEvent(actor, { timestamp, eventType = 'login', success = 1 } = {}) {
  return {
    timestamp: timestamp ?? NOW - int(0, WINDOW_SECONDS),
    actorId: actor.actorId,
    sourceIp: `${actor.home.ipPrefix}.${ipSuffix()}`,
    country: actor.home.country,
    city: actor.home.city,
    device: actor.device,
    eventType,
    success,
    groundTruthAnomaly: 0,
    groundTruthReason: '',
  }
}

const events = []
let cursor = 0
function addEvent(e) {
  events.push({ eventId: `evt_${String(cursor).padStart(6, '0')}`, datasetVersion: DATASET_VERSION, ...e })
  cursor += 1
}

// Target ~5% of all EVENTS to be anomalous — real auth-anomaly base rates
// are low single digits, and an evaluation report built against a dataset
// where a third of events are anomalous would overstate how good any
// detector looks. Each pattern emits a different number of events per
// injection (impossible travel: 2, brute force: ~7, new device: 1), so we
// size the iteration counts to that, not to a flat "N anomalies" budget.
const TARGET_ANOMALY_EVENTS = Math.round(COUNT * 0.05)
const PER_PATTERN_EVENTS = Math.max(1, Math.round(TARGET_ANOMALY_EVENTS / 3))
const IMPOSSIBLE_TRAVEL_ITERS = Math.max(1, Math.round(PER_PATTERN_EVENTS / 2))
const BRUTE_FORCE_ITERS = Math.max(1, Math.round(PER_PATTERN_EVENTS / 7))
const NEW_DEVICE_ITERS = Math.max(1, Math.round(PER_PATTERN_EVENTS / 1))

// Pattern 1: impossible travel — two logins for the same actor, far apart
// geographically, too close together in time to be a real trip.
for (let i = 0; i < IMPOSSIBLE_TRAVEL_ITERS && events.length < COUNT; i++) {
  const actor = pick(actors)
  const t1 = NOW - int(0, WINDOW_SECONDS)
  addEvent(baseEvent(actor, { timestamp: t1 }))
  const far = pick(FAR_LOCATIONS)
  addEvent({
    ...baseEvent(actor, { timestamp: t1 + int(300, 1800) }), // 5-30 min later
    country: far.country,
    city: far.city,
    sourceIp: `${far.ipPrefix}.${ipSuffix()}`,
    groundTruthAnomaly: 1,
    groundTruthReason: 'impossible_travel',
  })
}

// Pattern 2: brute-force burst — a run of failed logins for one actor in a
// short window, from one IP, sometimes followed by a success.
for (let i = 0; i < BRUTE_FORCE_ITERS && events.length < COUNT; i++) {
  const actor = pick(actors)
  const start = NOW - int(0, WINDOW_SECONDS)
  const far = pick(FAR_LOCATIONS)
  const ip = `${far.ipPrefix}.${ipSuffix()}`
  const burstSize = int(5, 9)
  for (let j = 0; j < burstSize && events.length < COUNT; j++) {
    addEvent({
      ...baseEvent(actor, { timestamp: start + j * int(5, 20), eventType: 'failed_login', success: 0 }),
      sourceIp: ip,
      country: far.country,
      city: far.city,
      groundTruthAnomaly: 1,
      groundTruthReason: 'brute_force_burst',
    })
  }
}

// Pattern 3: new device + odd hour — a successful login from a device the
// actor has never used, at an hour far outside their typical pattern.
for (let i = 0; i < NEW_DEVICE_ITERS && events.length < COUNT; i++) {
  const actor = pick(actors)
  const day = int(0, 13)
  const oddHour = (actor.typicalHour + 12) % 24 // opposite side of the clock
  const timestamp = NOW - day * 86400 - int(0, 86400) + oddHour * 3600
  const otherDevices = DEVICES.filter((d) => d !== actor.device)
  addEvent({
    ...baseEvent(actor, { timestamp }),
    device: pick(otherDevices),
    groundTruthAnomaly: 1,
    groundTruthReason: 'new_device_odd_hour',
  })
}

// Fill the rest with ordinary, benign logins (occasional incidental failed
// login — a typo — is normal and NOT labeled anomalous).
while (events.length < COUNT) {
  const actor = pick(actors)
  const day = int(0, 13)
  const hour = Math.max(0, Math.min(23, actor.typicalHour + int(-2, 2)))
  const timestamp = NOW - day * 86400 - int(0, 86400) + hour * 3600
  const isTypo = rand() < 0.03
  addEvent(baseEvent(actor, { timestamp, eventType: isTypo ? 'failed_login' : 'login', success: isTypo ? 0 : 1 }))
}

events.sort((a, b) => a.timestamp - b.timestamp)

const out = {
  datasetVersion: DATASET_VERSION,
  generatedAt: new Date().toISOString(),
  seed: SEED,
  count: events.length,
  anomalyCount: events.filter((e) => e.groundTruthAnomaly === 1).length,
  events,
}

const outPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'synthetic-auth-events.json')
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify(out, null, 2))

console.log(`Wrote ${events.length} events (${out.anomalyCount} ground-truth anomalies) to ${outPath}`)
console.log(`datasetVersion=${DATASET_VERSION}`)
