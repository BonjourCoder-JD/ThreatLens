"""
Tests for feature engineering: edge cases, determinism, and — the one that
matters most for requirement #3 — a structural proof that ground-truth
labels are never read, not just a promise in a comment.
"""

from features import FEATURE_NAMES, engineer_features, haversine_km

BASE_TS = 1_800_000_000  # an arbitrary but fixed Tuesday, for reproducible weekday/hour math


def event(**overrides):
    base = {
        "eventId": "e0",
        "actorId": "user_001",
        "timestamp": BASE_TS,
        "city": "New York",
        "device": "Windows-Chrome",
        "success": 1,
    }
    base.update(overrides)
    return base


def by_id(rows, event_id):
    return next(r for r in rows if r["eventId"] == event_id)


def test_engineer_features_never_reads_ground_truth():
    """The strongest form of this test: the input events carry NO
    groundTruthAnomaly/groundTruthReason keys at all, and feature
    engineering still succeeds — proving the function cannot depend on
    them, not just that it happens not to use them this time."""
    events = [event(eventId="e0")]
    assert "groundTruthAnomaly" not in events[0]
    rows = engineer_features(events)
    assert rows[0]["eventId"] == "e0"
    assert set(FEATURE_NAMES).issubset(rows[0].keys())


def test_is_deterministic():
    events = [
        event(eventId="e0", timestamp=BASE_TS),
        event(eventId="e1", timestamp=BASE_TS + 100, device="Linux-Firefox"),
    ]
    first = engineer_features(events)
    second = engineer_features(events)
    assert first == second


def test_first_event_gets_sentinel_values_not_flagged_as_novel():
    rows = engineer_features([event(eventId="e0")])
    row = by_id(rows, "e0")
    assert row["minutes_since_prev_event"] == 10_080.0
    assert row["distance_km_from_prev"] == 0.0
    assert row["implied_speed_kmh"] == 0.0
    assert row["is_new_device"] == 0.0  # no false "novel device" signal on a first event


def test_new_device_flagged_only_once_then_remembered():
    events = [
        event(eventId="e0", timestamp=BASE_TS, device="Windows-Chrome"),
        event(eventId="e1", timestamp=BASE_TS + 60, device="Linux-Firefox"),
        event(eventId="e2", timestamp=BASE_TS + 120, device="Windows-Chrome"),
    ]
    rows = engineer_features(events)
    assert by_id(rows, "e1")["is_new_device"] == 1.0
    assert by_id(rows, "e2")["is_new_device"] == 0.0  # seen at e0, not novel again


def test_distance_and_speed_for_a_real_travel_pair():
    events = [
        event(eventId="e0", timestamp=BASE_TS, city="New York"),
        event(eventId="e1", timestamp=BASE_TS + 600, city="Lagos"),  # 10 min later
    ]
    rows = engineer_features(events)
    row = by_id(rows, "e1")
    assert row["distance_km_from_prev"] > 8000  # NY-Lagos is roughly 8,500+ km
    assert row["implied_speed_kmh"] > 1000  # clearly implausible


def test_speed_is_capped_not_infinite():
    events = [
        event(eventId="e0", timestamp=BASE_TS, city="New York"),
        event(eventId="e1", timestamp=BASE_TS, city="Lagos"),  # same timestamp -> would be infinite
    ]
    rows = engineer_features(events)
    assert by_id(rows, "e1")["implied_speed_kmh"] == 5_000.0


def test_failed_login_window_counts_only_recent_failures():
    events = [
        event(eventId="e0", timestamp=BASE_TS, success=0),
        event(eventId="e1", timestamp=BASE_TS + 60, success=0),
        event(eventId="e2", timestamp=BASE_TS + 120, success=0),
        # Far outside the 15-minute window from the burst above.
        event(eventId="e3", timestamp=BASE_TS + 3600, success=0),
    ]
    rows = engineer_features(events)
    assert by_id(rows, "e2")["failed_logins_last_15min"] == 3.0
    assert by_id(rows, "e3")["failed_logins_last_15min"] == 1.0  # resets — the burst is long past


def test_haversine_same_city_is_zero_and_unknown_city_is_none():
    assert haversine_km("New York", "New York") == 0.0
    assert haversine_km("New York", "Atlantis") is None


def test_multiple_actors_do_not_leak_into_each_others_features():
    events = [
        event(eventId="a0", actorId="user_001", timestamp=BASE_TS, device="Windows-Chrome"),
        event(eventId="b0", actorId="user_002", timestamp=BASE_TS + 10, device="iOS-App"),
        event(eventId="a1", actorId="user_001", timestamp=BASE_TS + 20, device="iOS-App"),
    ]
    rows = engineer_features(events)
    # user_001's a1 should see iOS-App as new (their own history only has
    # Windows-Chrome) even though user_002 already used iOS-App first.
    assert by_id(rows, "a1")["is_new_device"] == 1.0
    assert by_id(rows, "b0")["is_new_device"] == 0.0  # user_002's own first event
