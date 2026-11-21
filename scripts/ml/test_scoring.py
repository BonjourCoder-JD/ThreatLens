"""
Tests for the model-scoring layer: determinism (the Python-side half of
"idempotency" — see tests/api.spec.ts for the TS-side half, importing the
same scores twice into authEvents), and event matching against the real
canonical dataset.
"""

import json
from pathlib import Path

from features import FEATURE_NAMES, engineer_features
from train_and_evaluate import DATASET_PATH, fit_and_score, transform_features


def _toy_events():
    base_ts = 1_800_000_000
    return [
        {
            "eventId": f"e{i}",
            "actorId": "user_001" if i % 2 == 0 else "user_002",
            "timestamp": base_ts + i * 300,
            "city": "New York",
            "device": "Windows-Chrome",
            "success": 1,
        }
        for i in range(20)
    ]


def test_fit_and_score_is_deterministic():
    """Fixed random_state means re-fitting on the same features always
    gives the same scores and outlier flags — this is what makes
    re-running the whole pipeline (and therefore re-importing
    ml-scores.json) safe to repeat."""
    events = _toy_events()
    feature_rows = engineer_features(events)
    X = transform_features(feature_rows)

    scores_a, outliers_a = fit_and_score(X)
    scores_b, outliers_b = fit_and_score(X)

    assert (scores_a == scores_b).all()
    assert (outliers_a == outliers_b).all()


def test_scores_are_normalized_into_zero_one_range():
    events = _toy_events()
    feature_rows = engineer_features(events)
    X = transform_features(feature_rows)
    scores, _ = fit_and_score(X)
    assert scores.min() >= 0.0
    assert scores.max() <= 1.0


def test_outlier_flag_is_binary():
    events = _toy_events()
    feature_rows = engineer_features(events)
    X = transform_features(feature_rows)
    _, outliers = fit_and_score(X)
    assert set(outliers.tolist()).issubset({0, 1})


def test_event_matching_against_the_real_canonical_dataset():
    """Every event in the real dataset gets exactly one feature row, keyed
    by its own eventId, with no extras and no omissions — the thing
    src/jobs.ts's import-ml-scores job depends on to match scores back to
    the right authEvents row."""
    with open(DATASET_PATH, encoding="utf-8") as f:
        dataset = json.load(f)
    events = dataset["events"]
    feature_rows = engineer_features(events)

    input_ids = [e["eventId"] for e in events]
    output_ids = [r["eventId"] for r in feature_rows]
    assert input_ids == output_ids  # same ids, same order, no duplicates, no drops
    assert len(set(output_ids)) == len(output_ids)  # belt-and-suspenders: definitely unique

    for row in feature_rows:
        assert set(FEATURE_NAMES).issubset(row.keys())


def test_ml_scores_json_matches_the_dataset_one_to_one():
    """Guards the actual committed artifact (src/data/ml-scores.json, the
    file the DeepSpace import job reads) against ever drifting from the
    dataset it was scored from — e.g. if the dataset were regenerated with
    a different count and this file weren't regenerated too."""
    scores_path = Path(__file__).resolve().parents[2] / "src" / "data" / "ml-scores.json"
    with open(DATASET_PATH, encoding="utf-8") as f:
        dataset = json.load(f)
    with open(scores_path, encoding="utf-8") as f:
        scores_doc = json.load(f)

    dataset_ids = {e["eventId"] for e in dataset["events"]}
    scored_ids = {e["eventId"] for e in scores_doc["events"]}
    assert dataset_ids == scored_ids
    assert scores_doc["datasetVersion"] == dataset["datasetVersion"]

    for row in scores_doc["events"]:
        assert 0.0 <= row["mlAnomalyScore"] <= 1.0
        assert row["mlIsOutlier"] in (0, 1)
