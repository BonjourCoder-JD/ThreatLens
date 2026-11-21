/**
 * Minimal city-coordinate lookup and great-circle distance, used only by
 * the statistical anomaly detector (src/lib/anomaly-detection.ts) to turn
 * "country/city changed" into an actual implied travel speed.
 *
 * Deliberately NOT shared with scripts/generate-dataset.mjs. The generator
 * only needs to know "this location is the actor's home" vs "this is a
 * deliberately far location" — it never computes a distance. The detector's
 * job is the opposite: measure real geographic distance between ANY two
 * cities a given actor used, so it would also catch impossible travel in
 * data nobody deliberately injected. Forcing them to share one file would
 * couple two genuinely different concerns for no benefit — see
 * docs/CODE_WALKTHROUGH.md for the fuller rationale.
 */

export interface Coordinates {
  lat: number
  lon: number
}

/** Approximate coordinates for every city the synthetic generator uses. */
export const CITY_COORDINATES: Record<string, Coordinates> = {
  'New York': { lat: 40.7128, lon: -74.006 },
  'San Francisco': { lat: 37.7749, lon: -122.4194 },
  London: { lat: 51.5074, lon: -0.1278 },
  Berlin: { lat: 52.52, lon: 13.405 },
  Toronto: { lat: 43.6532, lon: -79.3832 },
  Sydney: { lat: -33.8688, lon: 151.2093 },
  Tokyo: { lat: 35.6762, lon: 139.6503 },
  'Sao Paulo': { lat: -23.5505, lon: -46.6333 },
  Moscow: { lat: 55.7558, lon: 37.6173 },
  Lagos: { lat: 6.5244, lon: 3.3792 },
  Hanoi: { lat: 21.0278, lon: 105.8342 },
}

const EARTH_RADIUS_KM = 6371

/** Great-circle (haversine) distance between two cities, in kilometers.
 *  Returns `null` for an unrecognized city rather than silently guessing. */
export function distanceBetweenCities(cityA: string, cityB: string): number | null {
  const a = CITY_COORDINATES[cityA]
  const b = CITY_COORDINATES[cityB]
  if (!a || !b) return null
  if (cityA === cityB) return 0

  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const sinLat = Math.sin(dLat / 2)
  const sinLon = Math.sin(dLon / 2)
  const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLon * sinLon
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
  return EARTH_RADIUS_KM * c
}
