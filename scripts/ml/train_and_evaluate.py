"""
Offline Isolation Forest training + evaluation for ThreatLens.

Run (from the repo root, with the venv active — see requirements.txt):
    python scripts/ml/train_and_evaluate.py

Reads the canonical dataset (src/data/synthetic-auth-events.json) — the
SAME file scripts/generate-dataset.mjs produced and the SAME file the
DeepSpace import job loads. There is exactly one dataset; this script
never generates its own.

Writes two committed artifacts:
  - src/data/ml-scores.json        (consumed by src/jobs.ts's
    import-ml-scores job — the only way these scores ever reach the
    deployed app, and only as a one-time admin-triggered import)
  - docs/ML_EVALUATION_REPORT.md   (this run's real numbers, not
    hand-written — see build_report() below)

Ground-truth labels (`groundTruthAnomaly`/`groundTruthReason`) are read
EXACTLY ONCE in this entire file, in the evaluation section below, after
scoring is complete. `engineer_features()` and the model never see them —
enforced structurally, not just by convention; see test_features.py.
"""

import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from sklearn.ensemble import IsolationForest
from sklearn.metrics import confusion_matrix, f1_score, precision_score, recall_score

from features import FEATURE_NAMES, engineer_features

ROOT = Path(__file__).resolve().parents[2]
DATASET_PATH = ROOT / "src" / "data" / "synthetic-auth-events.json"
SCORES_OUTPUT_PATH = ROOT / "src" / "data" / "ml-scores.json"
REPORT_OUTPUT_PATH = ROOT / "docs" / "ML_EVALUATION_REPORT.md"

RANDOM_SEED = 42
N_ESTIMATORS = 200
# Informed by the synthetic generator's own injection rate (~4-5%, see
# scripts/generate-dataset.mjs) rather than discovered from the data. A
# real deployment would not know its true anomaly rate in advance — this
# is a disclosed simplification; see the "Limitations" section of the
# generated report.
CONTAMINATION = 0.05
MODEL_VERSION = "isoforest-v1"
# Right-skewed features (a 7-day sentinel sitting next to 2-minute gaps,
# a handful of >5000 km/h outliers against mostly-zero values) get a
# log1p transform before the forest sees them, so a handful of extreme
# values can't dominate every split.
SKEWED_FEATURES = ("minutes_since_prev_event", "distance_km_from_prev", "implied_speed_kmh")


def transform_features(feature_rows: list[dict]) -> np.ndarray:
    """feature_rows -> model-ready matrix, in FEATURE_NAMES order, with
    the skewed-feature log1p transform applied. Pulled out on its own so
    tests can build a matrix from a handful of synthetic rows without
    touching the real dataset file."""
    X = np.array([[row[name] for name in FEATURE_NAMES] for row in feature_rows])
    X_transformed = X.copy()
    for name in SKEWED_FEATURES:
        idx = FEATURE_NAMES.index(name)
        X_transformed[:, idx] = np.log1p(X_transformed[:, idx])
    return X_transformed


def fit_and_score(X_transformed: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Fits a fresh IsolationForest and returns (normalized_scores in
    [0, 1] where higher = more anomalous, is_outlier as 0/1 ints).
    A fresh RANDOM_SEED-fixed model every call is what makes this
    deterministic across repeated calls — see
    test_scoring.py::test_fit_and_score_is_deterministic."""
    model = IsolationForest(
        n_estimators=N_ESTIMATORS,
        contamination=CONTAMINATION,
        random_state=RANDOM_SEED,
    )
    model.fit(X_transformed)

    # sklearn's decision_function: HIGHER = more normal. Invert and
    # min-max normalize to [0, 1] so higher = more anomalous — matching
    # the statistical detector's statAnomalyScore convention, so the
    # dashboard can display both on the same visual scale.
    raw = model.decision_function(X_transformed)
    inverted = -raw
    denom = inverted.max() - inverted.min()
    normalized = (inverted - inverted.min()) / denom if denom > 0 else np.zeros_like(inverted)
    predictions = model.predict(X_transformed)  # -1 outlier, 1 inlier
    is_outlier = (predictions == -1).astype(int)
    return normalized, is_outlier


def main() -> None:
    with open(DATASET_PATH, encoding="utf-8") as f:
        dataset = json.load(f)
    events = dataset["events"]

    feature_rows = engineer_features(events)
    X_transformed = transform_features(feature_rows)
    normalized, is_outlier = fit_and_score(X_transformed)

    # ---- Evaluation against ground truth — read starting HERE, nowhere above ----
    ground_truth = np.array([int(e.get("groundTruthAnomaly", 0)) for e in events])
    precision = float(precision_score(ground_truth, is_outlier, zero_division=0))
    recall = float(recall_score(ground_truth, is_outlier, zero_division=0))
    f1 = float(f1_score(ground_truth, is_outlier, zero_division=0))
    tn, fp, fn, tp = confusion_matrix(ground_truth, is_outlier).ravel()

    reason_breakdown: dict[str, dict[str, int]] = {}
    for e, flagged in zip(events, is_outlier):
        reason = e.get("groundTruthReason") or "(benign)"
        bucket = reason_breakdown.setdefault(reason, {"total": 0, "flagged": 0})
        bucket["total"] += 1
        if flagged:
            bucket["flagged"] += 1

    # ---- Write src/data/ml-scores.json ----
    scores_out = {
        "modelVersion": MODEL_VERSION,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "datasetVersion": dataset["datasetVersion"],
        "params": {
            "n_estimators": N_ESTIMATORS,
            "contamination": CONTAMINATION,
            "random_state": RANDOM_SEED,
            "features": FEATURE_NAMES,
        },
        "events": [
            {
                "eventId": row["eventId"],
                "mlAnomalyScore": round(float(score), 4),
                "mlIsOutlier": int(outlier),
            }
            for row, score, outlier in zip(feature_rows, normalized, is_outlier)
        ],
    }
    SCORES_OUTPUT_PATH.write_text(json.dumps(scores_out, indent=2), encoding="utf-8")

    report = build_report(
        dataset=dataset,
        events=events,
        precision=precision,
        recall=recall,
        f1=f1,
        tn=int(tn),
        fp=int(fp),
        fn=int(fn),
        tp=int(tp),
        reason_breakdown=reason_breakdown,
        total_flagged=int(is_outlier.sum()),
    )
    REPORT_OUTPUT_PATH.write_text(report, encoding="utf-8")

    print(f"Wrote {len(scores_out['events'])} ML scores to {SCORES_OUTPUT_PATH}")
    print(f"Precision={precision:.3f} Recall={recall:.3f} F1={f1:.3f}")
    print(f"Confusion matrix: TN={tn} FP={fp} FN={fn} TP={tp}")
    print(f"Wrote evaluation report to {REPORT_OUTPUT_PATH}")


def build_report(
    *,
    dataset: dict,
    events: list[dict],
    precision: float,
    recall: float,
    f1: float,
    tn: int,
    fp: int,
    fn: int,
    tp: int,
    reason_breakdown: dict[str, dict[str, int]],
    total_flagged: int,
) -> str:
    total = len(events)
    actual_positive_rate = (tp + fn) / total
    flagged_rate = total_flagged / total

    reason_rows = "\n".join(
        f"| {reason} | {b['total']} | {b['flagged']} | {b['flagged'] / b['total']:.1%} |"
        for reason, b in sorted(reason_breakdown.items(), key=lambda kv: kv[0])
    )

    return f"""# ThreatLens — ML Evaluation Report

**Generated by `scripts/ml/train_and_evaluate.py` — every number below is
this run's actual output, not hand-written.** Re-run the script to
regenerate this file; don't hand-edit the numbers.

- Dataset: `src/data/synthetic-auth-events.json`, version `{dataset['datasetVersion']}`, {total} events
- Model: scikit-learn `IsolationForest`, `n_estimators=200`, `contamination=0.05`, `random_state=42`
- Model version tag: `isoforest-v1`

## 1. How Isolation Forest works (for this report's purposes)

Isolation Forest builds many random decision trees, each splitting the
feature space on random features at random thresholds. A point that's
"normal" (similar to most others) takes many splits to isolate into its
own leaf; a point that's unusual needs far fewer splits, because random
cuts are far more likely to separate an extreme value quickly. The
model's anomaly score is based on *average path length to isolation*
across all trees — short paths mean "this point was easy to isolate,"
i.e. anomalous. Critically, this requires **no labels** — it never sees
`groundTruthAnomaly` during fitting, which is what makes it a legitimate
second, independent detection signal rather than a restatement of the
rules in `src/lib/anomaly-detection.ts`.

## 2. Why offline inference, not a live model in the Worker

Cloudflare Workers run JavaScript/Wasm, not Python — there is no runtime
in the deployed app that could import scikit-learn or execute this
script. So the model is trained and scored **once, here, outside the
app**, and only its *output* (a score and a flag per event, keyed by the
dataset's stable `eventId`) is ever imported into DeepSpace — via the
`import-ml-scores` background job, admin-gated, the same pattern as the
Day 1 synthetic-event import. This is a precomputed enrichment, not a
live inference service, and the app is built to be honest about that
distinction everywhere it displays an ML score (see
docs/ARCHITECTURE.md).

## 3. Features (see `scripts/ml/features.py`)

| Feature | What it measures | Why it's relevant |
|---|---|---|
| `hour_of_day` | 0-23, UTC | Logins cluster around an actor's normal hours; this gives the model that context. |
| `is_weekend` | 0/1 | Weekday vs. weekend login patterns can differ. |
| `is_failed` | 0/1 | A failed attempt is inherently more noteworthy than a success. |
| `minutes_since_prev_event` | Gap since this actor's previous event (capped at 7 days for a first event) | Very short gaps between logins can indicate automation or a burst. |
| `distance_km_from_prev` | Haversine distance from the actor's previous event's city | The core geographic-novelty signal. |
| `implied_speed_kmh` | distance / elapsed time (capped at 5,000 km/h) | Turns raw distance into a travel-plausibility signal. |
| `is_new_device` | 0/1, never flagged on an actor's first event | Device novelty relative to that actor's own history. |
| `failed_logins_last_15min` | Count of this actor's failed logins in the trailing 15 minutes | A numeric, continuous analogue of the rule-based burst detector. |

**Preprocessing**: `minutes_since_prev_event`, `distance_km_from_prev`, and
`implied_speed_kmh` are right-skewed (a handful of extreme values next to
mostly-small ones), so each gets a `log1p` transform before the model
sees it — this keeps a few extreme values from dominating every tree
split. No categorical one-hot encoding was used; geographic and temporal
novelty are already captured numerically, which keeps the feature set
small and the model's behavior easy to explain.

**No data leakage**: `groundTruthAnomaly`/`groundTruthReason` are never
passed to `engineer_features()` or the model — see
`scripts/ml/test_features.py`'s `test_engineer_features_never_reads_ground_truth`,
which proves this structurally (the function works even when those keys
are entirely absent from the input), not just by convention.

## 4. Evaluation methodology

This is an **unsupervised, in-sample** evaluation: the model is fit on
the full dataset and scored on that same dataset — there is no held-out
test split. That's standard practice for scoring a fixed historical
dataset with an unsupervised model (there's no "future" data to predict),
but it means these numbers measure *"how well do the model's own anomaly
scores line up with the three patterns we deliberately injected into this
dataset,"* not generalization to unseen data or to real-world traffic.

`contamination=0.05` was set from the generator's own known injection
rate, not discovered independently — a real deployment would not have
this luxury, and a different assumed contamination rate would shift
precision/recall meaningfully. This is disclosed, not hidden.

## 5. Results

**Precision: {precision:.3f} · Recall: {recall:.3f} · F1: {f1:.3f}**

Confusion matrix (rows = actual, columns = predicted):

| | Predicted normal | Predicted outlier |
|---|---|---|
| **Actually normal** | {tn} (TN) | {fp} (FP) |
| **Actually anomalous** | {fn} (FN) | {tp} (TP) |

- {total_flagged} of {total} events flagged as outliers ({flagged_rate:.1%}) — close to the configured `contamination=0.05` by construction.
- {tp + fn} of {total} events are actually anomalous by the synthetic ground truth ({actual_positive_rate:.1%}).

### By injected pattern type

| Ground-truth pattern | Total events | Flagged by model | Flagged rate |
|---|---|---|---|
{reason_rows}

## 6. Limitations — read before quoting any number above

- **Synthetic, author-designed data.** These three anomaly patterns
  (impossible travel, brute-force burst, new-device-odd-hour) are the
  same patterns the generator explicitly injects — the model is being
  asked to find patterns the dataset's own author already knows are
  there. Real-world account-takeover and fraud patterns are far more
  varied and far less obvious.
- **`contamination` was informed by the known injection rate** — not
  something a real deployment could assume in advance. A blind guess
  (e.g. the sklearn default) would produce different precision/recall.
- **In-sample scoring, not a generalization test.** This says nothing
  about how the model would score a *new*, unseen batch of events, let
  alone real traffic.
- **No adversarial evaluation.** Nothing here tests whether a
  sophisticated attacker could stay under the model's radar.
- **These numbers are not, and must never be presented as, a measure of
  real-world detection accuracy.** They describe how well an unsupervised
  model recovers three known, deliberately-injected synthetic patterns
  from a small, author-designed dataset — nothing more.
"""


if __name__ == "__main__":
    main()
