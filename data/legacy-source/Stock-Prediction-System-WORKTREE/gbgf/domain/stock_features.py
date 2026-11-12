"""
PIT-safe stock feature builder for GBGF validation pipeline — P3-08.

All features are computed using only data at or before the feature date.
No forward-looking data is used in any computation.

Rules enforced:
  - feature at index i uses rows[0..i] only
  - Target return (forward return) is NEVER used in feature computation
  - No random operations — all computations are deterministic

Available features:
  return_5d, return_20d, ma20, ma60, volatility_20d,
  volume_zscore_20d, drawdown_20d, breakout_20d_high,
  universe_relative_strength

NOT a trading system. Research use only.
"""

from __future__ import annotations

import math
import statistics
from typing import Dict, List, Optional


# ── Primitive feature functions ────────────────────────────────────────────────
# Each takes (rows, i, n) and returns the feature value at index i.
# Only rows[0..i] are used — strictly PIT-safe.

def return_nd(rows: List[Dict], i: int, n: int) -> Optional[float]:
    """n-day return ending at index i.

    Uses only rows[i-n] and rows[i] — PIT-safe.
    Returns None if insufficient history.
    """
    if i < n:
        return None
    prev_close = float(rows[i - n]["close"])
    if prev_close == 0:
        return None
    return (float(rows[i]["close"]) - prev_close) / prev_close


def ma_nd(rows: List[Dict], i: int, n: int) -> Optional[float]:
    """n-day simple moving average of close ending at index i.

    Uses rows[i-n+1..i] — PIT-safe.
    Returns None if fewer than n rows available.
    """
    if i < n - 1:
        return None
    closes = [float(rows[j]["close"]) for j in range(i - n + 1, i + 1)]
    return sum(closes) / n


def volatility_nd(rows: List[Dict], i: int, n: int) -> Optional[float]:
    """n-day realized volatility (std of log returns) ending at index i.

    Uses rows[i-n..i] (n+1 prices → n log returns) — PIT-safe.
    Returns None if fewer than 2 log returns can be computed.
    """
    if i < n:
        return None
    log_rets: List[float] = []
    for j in range(i - n + 1, i + 1):
        prev = float(rows[j - 1]["close"])
        curr = float(rows[j]["close"])
        if prev > 0 and curr > 0:
            log_rets.append(math.log(curr / prev))
    if len(log_rets) < 2:
        return None
    return statistics.stdev(log_rets)


def volume_zscore_nd(rows: List[Dict], i: int, n: int) -> Optional[float]:
    """n-day volume z-score at index i.

    Z = (volume[i] - mean(volume[i-n..i-1])) / std(volume[i-n..i-1])
    Uses only historical volume (rows[i-n..i-1] for mean/std, rows[i] for current) — PIT-safe.
    Returns None if fewer than 2 historical volume observations.
    """
    if i < n:
        return None
    hist_vols = [float(rows[j]["volume"]) for j in range(i - n, i)]
    if len(hist_vols) < 2:
        return None
    mean_v = sum(hist_vols) / len(hist_vols)
    std_v = statistics.stdev(hist_vols)
    if std_v == 0:
        return 0.0
    return (float(rows[i]["volume"]) - mean_v) / std_v


def drawdown_nd(rows: List[Dict], i: int, n: int) -> Optional[float]:
    """n-day maximum drawdown ending at index i (≤ 0).

    Uses rows[i-n+1..i] — PIT-safe.
    Returns None if insufficient history.
    """
    if i < n - 1:
        return None
    closes = [float(rows[j]["close"]) for j in range(i - n + 1, i + 1)]
    peak = closes[0]
    max_dd = 0.0
    for c in closes[1:]:
        if c > peak:
            peak = c
        if peak > 0:
            dd = (c - peak) / peak
            if dd < max_dd:
                max_dd = dd
    return max_dd


def breakout_nd_high(rows: List[Dict], i: int, n: int) -> Optional[bool]:
    """True if close[i] breaks above max(high[i-n..i-1]).

    Uses rows[i-n..i-1] for the prior-n-day high range and rows[i] for current close.
    PIT-safe: does not use rows[i+1..].
    Returns None if insufficient history.
    """
    if i < n:
        return None
    prior_highs = [float(rows[j]["high"]) for j in range(i - n, i)]
    if not prior_highs:
        return None
    return float(rows[i]["close"]) > max(prior_highs)


def universe_relative_strength(
    rows: List[Dict],
    i: int,
    n: int,
    universe_median_returns: Optional[Dict[str, float]] = None,
) -> Optional[float]:
    """Symbol n-day return minus universe median n-day return at index i.

    Returns:
        float: positive = symbol outperforming universe, negative = underperforming.
        None: if symbol return cannot be computed or universe median unavailable.

    PIT-safety:
        - universe_median_returns must be pre-computed PIT-safely (no future data)
        - Only the date key is looked up — no future dates are accessed
    """
    sym_ret = return_nd(rows, i, n)
    if sym_ret is None:
        return None
    date = rows[i]["date"]
    if universe_median_returns is None or date not in universe_median_returns:
        return None
    return sym_ret - universe_median_returns[date]


# ── Bulk feature computation ───────────────────────────────────────────────────

_ALL_FEATURES = [
    "return_5d",
    "return_20d",
    "ma20",
    "ma60",
    "volatility_20d",
    "volume_zscore_20d",
    "drawdown_20d",
    "breakout_20d_high",
    "universe_relative_strength",
]


def compute_features_for_rows(
    rows: List[Dict],
    feature_names: Optional[List[str]] = None,
    universe_median_returns: Optional[Dict[str, float]] = None,
) -> List[Dict]:
    """Compute a feature dict for every row, PIT-safe.

    For each index i, only rows[0..i] are used in any computation.
    Features unavailable at early indices are set to None.

    Args:
        rows: OHLCV rows sorted chronologically (ascending date).
        feature_names: subset of features to compute (default: all).
        universe_median_returns: {date: median_return} for universe_relative_strength.

    Returns:
        List of feature dicts indexed 1:1 with rows.
        Each dict has 'date' plus one key per requested feature.
    """
    if feature_names is None:
        feature_names = _ALL_FEATURES

    feature_set = set(feature_names)
    results: List[Dict] = []

    for i, row in enumerate(rows):
        feat: Dict = {"date": row["date"]}

        if "return_5d" in feature_set:
            feat["return_5d"] = return_nd(rows, i, 5)

        if "return_20d" in feature_set:
            feat["return_20d"] = return_nd(rows, i, 20)

        if "ma20" in feature_set:
            feat["ma20"] = ma_nd(rows, i, 20)

        if "ma60" in feature_set:
            feat["ma60"] = ma_nd(rows, i, 60)

        if "volatility_20d" in feature_set:
            feat["volatility_20d"] = volatility_nd(rows, i, 20)

        if "volume_zscore_20d" in feature_set:
            feat["volume_zscore_20d"] = volume_zscore_nd(rows, i, 20)

        if "drawdown_20d" in feature_set:
            feat["drawdown_20d"] = drawdown_nd(rows, i, 20)

        if "breakout_20d_high" in feature_set:
            feat["breakout_20d_high"] = breakout_nd_high(rows, i, 20)

        if "universe_relative_strength" in feature_set:
            feat["universe_relative_strength"] = universe_relative_strength(
                rows, i, 20, universe_median_returns
            )

        results.append(feat)

    return results


# ── Universe median computation (for H007) ────────────────────────────────────

def compute_universe_median_returns(
    all_symbol_rows: Dict[str, List[Dict]],
    lookback: int = 20,
    as_of_date: Optional[str] = None,
) -> Dict[str, float]:
    """Compute the cross-sectional median n-day return per date across all symbols.

    PIT-safety:
        - For each date d, the median is computed from symbol 20d returns that
          use only data up to d (return from price[d-lookback] to price[d]).
        - No future dates are used.
        - Only dates with >= 2 symbols are included (median requires >= 2 points).

    Args:
        all_symbol_rows: {symbol: rows} where rows are sorted ascending by date.
        lookback: lookback window for return computation (default: 20).
        as_of_date: optional upper bound on dates (YYYY-MM-DD). Dates after
            this are excluded even if present in data.

    Returns:
        {date: median_return} for dates with >= 2 symbols having valid returns.
    """
    # symbol → {date: return}
    sym_returns: Dict[str, Dict[str, float]] = {}
    for sym, rows in all_symbol_rows.items():
        sym_returns[sym] = {}
        for i, row in enumerate(rows):
            if i < lookback:
                continue
            d = row["date"]
            if as_of_date and d > as_of_date:
                continue
            prev_close = float(rows[i - lookback]["close"])
            if prev_close > 0:
                ret = (float(row["close"]) - prev_close) / prev_close
                sym_returns[sym][d] = ret

    # Collect all valid dates
    all_dates = sorted(
        {d for sr in sym_returns.values() for d in sr}
    )

    universe_median: Dict[str, float] = {}
    for date in all_dates:
        if as_of_date and date > as_of_date:
            continue
        rets = [sym_returns[sym][date] for sym in sym_returns if date in sym_returns[sym]]
        if len(rets) < 2:
            continue
        rets_sorted = sorted(rets)
        n = len(rets_sorted)
        if n % 2 == 0:
            median = (rets_sorted[n // 2 - 1] + rets_sorted[n // 2]) / 2.0
        else:
            median = rets_sorted[n // 2]
        universe_median[date] = median

    return universe_median
