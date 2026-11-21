"""
Feature engineering for the offline Isolation Forest anomaly detector.

Pure functions, no I/O, no model, no ground-truth labels anywhere in this
file — that last part is load-bearing, not incidental: engineer_features()
accepts events without a `groundTruthAnomaly`/`groundTruthReason` key at
all and still works, which is what test_features.py's
"engineer_features never needs or reads ground truth" test proves
structurally, rather than just promising it in a comment.

This is an INDEPENDENT reimplementation of similar domain ideas to
src/lib/anomaly-detection.ts (per-actor history, novelty, bursts, travel) —
not a port of it. The TypeScript detector outputs fixed-threshold yes/no
rule matches; this module outputs continuous numeric features for an
unsupervised model to find its own structure in. See
docs/ML_EVALUATION_REPORT.md for why comparing the two is a feature, not
redundant work.
"""

from __future__ import annotations

from datetime import datetime, timezone
from math import asin, cos, radians, sin, sqrt

# Mirrors src/lib/geo.ts's CITY_COORDINATES exactly (same real-world
# cities), but is NOT the same file — this script has no access to the
# TypeScript build, and duplicating eleven lat/lon pairs is simpler and
# more honest than inventing a cross-language shared-config mechanism for
# a one-time offline script. If a city is ever added, update both.
CITY_COORDINATES: dict[str, tuple[float, float]] = {
    "New York": (40.7128, -74.0060),
    "San Francisco": (37.7749, -122.4194),
    "London": (51.5074, -0.1278),
    "Berlin": (52.5200, 13.4050),
    "Toronto": (43.6532, -79.3832),
    "Sydney": (-33.8688, 151.2093),
    "Tokyo": (35.6762, 139.6503),
    "Sao Paulo": (-23.5505, -46.6333),
    "Moscow": (55.7558, 37.6173),
    "Lagos": (6.5244, 3.3792),
    "Hanoi": (21.0278, 105.8342),
}

# Canonical feature order — the model's input columns ARE this list, in
# this order, every time. Keeping it as one exported constant (rather than
# re-deriving column order from a dict) is what makes
# `X = [[row[name] for name in FEATURE_NAMES] for row in feature_rows]`
# unambiguous and testable.
FEATURE_NAMES: list[str] = [
    "hour_of_day",
    "is_weekend",
    "is_failed",
    "minutes_since_prev_event",
    "distance_km_from_prev",
    "implied_speed_kmh",
    "is_new_device",
    "failed_logins_last_15min",
]

# Sentinel for an actor's very first event: there is no "previous event" to
# measure a gap from, so this stands in for "a very long time," which an
# Isolation Forest reads as unremarkable (most real gaps are far smaller),
# not as an extreme outlier signal the way 0 or -1 would be.
MAX_MINUTES_SINCE_PREV = 10_080.0  # 7 days
# Caps implied speed so a near-zero elapsed time next to a real distance
# doesn't produce a near-infinite value that would dominate every split.
MAX_SPEED_KMH = 5_000.0
FAILED_LOGIN_WINDOW_SECONDS = 15 * 60


def haversine_km(city_a: str, city_b: str) -> float | None:
    """Great-circle distance between two known cities, in km. Returns None
    for an unrecognized city rather than guessing."""
    if city_a == city_b:
        return 0.0
    if city_a not in CITY_COORDINATES or city_b not in CITY_COORDINATES:
        return None
    lat1, lon1 = CITY_COORDINATES[city_a]
    lat2, lon2 = CITY_COORDINATES[city_b]
    r_km = 6371.0
    dlat, dlon = radians(lat2 - lat1), radians(lon2 - lon1)
    a = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon / 2) ** 2
    return r_km * 2 * asin(sqrt(a))


def engineer_features(events: list[dict]) -> list[dict]:
    """
    `events`: dicts with at least eventId, actorId, timestamp (unix
    seconds), city, device, success (0/1). Any other keys (including
    groundTruthAnomaly/groundTruthReason) are ignored — never read.

    Returns one feature dict per input event, in the SAME order as the
    input, each `{"eventId": ..., <name>: float, ...}` for every name in
    FEATURE_NAMES.
    """
    by_actor: dict[str, list[dict]] = {}
    for e in events:
        by_actor.setdefault(e["actorId"], []).append(e)

    features_by_id: dict[str, dict] = {}
    for actor_events in by_actor.values():
        sorted_events = sorted(actor_events, key=lambda e: e["timestamp"])
        seen_devices: set[str] = set()
        failed_timestamps: list[float] = []

        for i, e in enumerate(sorted_events):
            ts = e["timestamp"]
            dt = datetime.fromtimestamp(ts, tz=timezone.utc)
            is_failed = 0.0 if e["success"] else 1.0

            if i == 0:
                minutes_since_prev = MAX_MINUTES_SINCE_PREV
                distance_km = 0.0
                implied_speed = 0.0
                is_new_device = 0.0
            else:
                prev = sorted_events[i - 1]
                elapsed_seconds = max(ts - prev["timestamp"], 1)
                minutes_since_prev = min(elapsed_seconds / 60.0, MAX_MINUTES_SINCE_PREV)
                dist = haversine_km(prev["city"], e["city"])
                distance_km = dist if dist is not None else 0.0
                elapsed_hours = max(elapsed_seconds / 3600.0, 1 / 3600)
                implied_speed = min(distance_km / elapsed_hours, MAX_SPEED_KMH)
                is_new_device = 0.0 if e["device"] in seen_devices else 1.0

            seen_devices.add(e["device"])

            if not e["success"]:
                failed_timestamps.append(float(ts))
            window_start = ts - FAILED_LOGIN_WINDOW_SECONDS
            failed_count = sum(1 for t in failed_timestamps if window_start <= t <= ts)

            features_by_id[e["eventId"]] = {
                "eventId": e["eventId"],
                "hour_of_day": float(dt.hour),
                "is_weekend": 1.0 if dt.weekday() >= 5 else 0.0,
                "is_failed": is_failed,
                "minutes_since_prev_event": float(minutes_since_prev),
                "distance_km_from_prev": float(distance_km),
                "implied_speed_kmh": float(implied_speed),
                "is_new_device": is_new_device,
                "failed_logins_last_15min": float(failed_count),
            }

    return [features_by_id[e["eventId"]] for e in events]
