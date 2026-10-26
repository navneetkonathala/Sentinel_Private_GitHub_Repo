"""Lightweight streaming detector using a permitted sliding-window threshold.

The window uses a rolling median and MAD to produce an interpretable robust score.
"""

from __future__ import annotations

from collections import deque
from statistics import median


class Sentinel:
    """Flag observations using an adaptive rolling median/MAD threshold.

    Feed clean numeric observations to ``update`` one at a time. Flagged
    observations are excluded from the training window so a sharp event cannot
    immediately move the baseline toward itself.
    """

    def __init__(self, window: int = 51, threshold: float = 3.5,
                 min_samples: int = 12) -> None:
        if window < 3:
            raise ValueError("window must be at least 3")
        if min_samples < 3 or min_samples > window:
            raise ValueError("min_samples must be between 3 and window")
        if threshold <= 0:
            raise ValueError("threshold must be positive")
        self.values: deque[float] = deque(maxlen=window)
        self.threshold = threshold
        self.min_samples = min_samples

    def update(self, value: float) -> dict[str, object]:
        """Score a sample and update the baseline only when it is clean."""
        value = float(value)
        if len(self.values) < self.min_samples:
            self.values.append(value)
            return {
                "status": "warming_up",
                "value": value,
                "score": 0.0,
                "samples": len(self.values),
                "needed": self.min_samples,
                "explanation": f"Collecting normal readings ({len(self.values)}/{self.min_samples}); not scoring yet.",
            }

        center = median(self.values)
        mad = median(abs(item - center) for item in self.values)
        spread = max(1.4826 * mad, 1e-9)
        score = (value - center) / spread
        upper = center + self.threshold * spread
        lower = center - self.threshold * spread
        flagged = abs(score) > self.threshold
        direction = "high" if value > upper else "low" if value < lower else "within_range"
        deviation = value - center
        if direction == "high":
            explanation = f"Reading is {value - upper:.2f} above the upper limit ({upper:.2f})."
        elif direction == "low":
            explanation = f"Reading is {lower - value:.2f} below the lower limit ({lower:.2f})."
        else:
            explanation = "Reading is within the expected range."

        if not flagged:
            self.values.append(value)

        return {
            "status": "anomaly" if flagged else "normal",
            "value": value,
            "direction": direction,
            "deviation": round(deviation, 3),
            "score": round(score, 3),
            "baseline": center,
            "upper": upper,
            "lower": lower,
            "explanation": explanation,
        }


if __name__ == "__main__":
    detector = Sentinel()
    readings = [40.1, 41.2, 39.8, 40.5, 40.9, 41.1, 39.9, 40.4,
                41.0, 40.2, 39.7, 40.6, 41.3, 40.8, 58.0, 40.5]
    for reading in readings:
        print(f"{reading:5.1f} -> {detector.update(reading)}")
