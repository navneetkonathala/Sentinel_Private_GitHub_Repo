"""Streaming interface for Sentinel's dependency-free Isolation Forest."""

from __future__ import annotations

from collections import deque
from math import isfinite
from statistics import median

from isolation_forest import IsolationForest, features


class Sentinel:
    """Warm up on initial readings, then score new readings with Isolation Forest.

    Initial readings form the model's training set. After training, predicted
    anomalies are excluded from the rolling feature history.
    """

    def __init__(self, trees: int = 40, sample_size: int = 128,
                 contamination: float = 0.02, min_samples: int = 12,
                 seed: int = 42) -> None:
        if min_samples < 12:
            raise ValueError("min_samples must be at least 12")
        self.trees = trees
        self.sample_size = sample_size
        self.contamination = contamination
        self.min_samples = min_samples
        self.seed = seed
        self.values: deque[float] = deque(maxlen=24)
        self.training_rows: list[tuple[float, ...]] = []
        self.forest: IsolationForest | None = None

    def update(self, value: float) -> dict[str, object]:
        """Train during warm-up, then return the Isolation Forest decision."""
        value = float(value)
        if not isfinite(value):
            raise ValueError("value must be a finite number")

        if self.forest is None:
            vector = features(value, list(self.values))
            self.training_rows.append(vector)
            self.values.append(value)
            samples = len(self.training_rows)
            if samples < self.min_samples:
                return {
                    "status": "warming_up",
                    "value": value,
                    "score": 0.0,
                    "samples": samples,
                    "needed": self.min_samples,
                    "explanation": f"Collecting training readings ({samples}/{self.min_samples}); not scoring yet.",
                }

            self.forest = IsolationForest(
                trees=self.trees,
                sample_size=self.sample_size,
                contamination=self.contamination,
                seed=self.seed,
            ).fit(self.training_rows)
            return {
                "status": "ready",
                "value": value,
                "score": 0.0,
                "samples": samples,
                "needed": self.min_samples,
                "explanation": f"Isolation Forest trained on {samples} readings; scoring starts with the next reading.",
            }

        vector = features(value, list(self.values))
        score = self.forest.score(vector)
        flagged = score >= self.forest.threshold
        center = median(self.values) if self.values else value
        direction = "high" if value > center else "low" if value < center else "within_range"
        if flagged:
            explanation = f"Isolation Forest score {score:.3f} meets or exceeds the anomaly cutoff ({self.forest.threshold:.3f})."
        else:
            explanation = "Isolation Forest score is below the anomaly cutoff."
            self.values.append(value)

        return {
            "status": "anomaly" if flagged else "normal",
            "value": value,
            "direction": direction,
            "deviation": round(value - center, 3),
            "score": round(score, 3),
            "threshold": round(self.forest.threshold, 3),
            "baseline": center,
            "explanation": explanation,
        }


if __name__ == "__main__":
    detector = Sentinel()
    readings = [40.1, 41.2, 39.8, 40.5, 40.9, 41.1, 39.9, 40.4,
                41.0, 40.2, 39.7, 40.6, 41.3, 40.8, 58.0, 40.5]
    for reading in readings:
        print(f"{reading:5.1f} -> {detector.update(reading)}")
