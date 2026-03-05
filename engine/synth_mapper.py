"""SynthData percentile → PDF / vol surface reconstruction.

SynthData /prediction-percentiles returns 289 time steps (5-min intervals),
each with 9 quantile-price pairs:
  {"0.005": 84200, "0.05": 85100, ..., "0.995": 98500}

This is a discrete inverse CDF: Q(p) = price, so P(S < price) = p.

Algorithm:
  1. Select time step closest to target horizon (hours_ahead * 12 steps)
  2. Extract 9 (probability, price) pairs → discrete CDF points
  3. Fit monotone cubic spline (PchipInterpolator) to (price, prob) pairs
  4. Evaluate at uniform strike grid → P(S < K) for all K
  5. P(S > K) = 1 - P(S < K)
  6. PDF = numerical derivative: f(K) ≈ ΔP/ΔK
"""

import logging
import math
from typing import Dict, List, Optional

import numpy as np
from scipy.interpolate import PchipInterpolator

logger = logging.getLogger(__name__)

# Percentile CDF keys in the API response, sorted by probability
_PERCENTILE_KEYS = ["0.005", "0.05", "0.2", "0.35", "0.5", "0.65", "0.8", "0.95", "0.995"]


def _extract_cdf_points(percentile_data: Dict, hours_ahead: float):
    """Extract (price, probability) CDF points for a given time horizon.

    Args:
        percentile_data: Raw response from /prediction-percentiles
        hours_ahead:     Target horizon in hours (max 24)

    Returns:
        (prices, probs) as numpy arrays, or (None, None) on failure
    """
    ff = percentile_data.get("forecast_future") if isinstance(percentile_data, dict) else None
    if not isinstance(ff, dict):
        return None, None
    predictions = ff.get("percentiles")
    if not predictions or not isinstance(predictions, list):
        return None, None

    if hours_ahead > 24:
        hours_ahead = 24.0

    # 289 steps over 24h = ~12 steps per hour (5 min each)
    target_step = int(round(hours_ahead * 12))
    target_step = max(0, min(target_step, len(predictions) - 1))

    step_data = predictions[target_step]
    if not isinstance(step_data, dict):
        return None, None

    probs = []
    prices = []
    for key in _PERCENTILE_KEYS:
        if key in step_data:
            probs.append(float(key))
            prices.append(float(step_data[key]))

    if len(probs) < 3:
        return None, None

    prices_arr = np.array(prices, dtype=float)
    probs_arr = np.array(probs, dtype=float)

    # Enforce monotonicity (prices should be strictly increasing for CDF)
    valid = np.diff(prices_arr) > 0
    if not all(valid):
        # Remove non-monotone points
        keep = np.concatenate([[True], valid])
        prices_arr = prices_arr[keep]
        probs_arr = probs_arr[keep]

    if len(probs_arr) < 3:
        return None, None

    return prices_arr, probs_arr


def build_synth_prob_curve(
    percentile_data: Dict,
    spot: float,
    hours_ahead: float,
    strike_grid: List[float],
) -> Dict[float, float]:
    """Returns {strike: P(S > strike)} from percentile CDF interpolation.

    Args:
        percentile_data:  Raw response from /prediction-percentiles
        spot:             Current underlying price
        hours_ahead:      Target horizon in hours
        strike_grid:      List of strikes to evaluate at

    Returns:
        Dict mapping strike → P(S_T > strike)
    """
    prices, probs = _extract_cdf_points(percentile_data, hours_ahead)
    if prices is None or len(prices) < 3:
        return {}

    try:
        # PchipInterpolator: monotone cubic spline, no overshoot within data range.
        # Do NOT extrapolate outside the known percentile range — cubic extrapolation
        # inverts outside the boundary and gives nonsense values (e.g. P(S>1400)=0%).
        # Instead clamp: any price below the 0.5th percentile → p_below≈0 (P(S>K)≈1)
        #                 any price above the 99.5th percentile → p_below≈1 (P(S>K)≈0)
        cdf_interp = PchipInterpolator(prices, probs, extrapolate=False)

        result = {}
        for k in strike_grid:
            if k <= prices[0]:
                p_below = probs[0]      # At or below 0.5th percentile → nearly certain above
            elif k >= prices[-1]:
                p_below = probs[-1]     # At or above 99.5th percentile → nearly certain below
            else:
                p_below = float(cdf_interp(k))
            p_below = max(0.0, min(1.0, p_below))
            result[k] = 1.0 - p_below  # P(S > K)
        return result
    except Exception as e:
        logger.warning("Synth prob curve interpolation failed: %s", e)
        return {}


def build_synth_pdf(
    percentile_data: Dict,
    spot: float,
    hours_ahead: float,
    strike_grid: List[float],
) -> Dict[float, float]:
    """Returns {strike: pdf_value} for bell curve visualization.

    PDF is the numerical derivative of the CDF: f(K) ≈ ΔP(S < K) / ΔK

    Args:
        percentile_data:  Raw response from /prediction-percentiles
        spot:             Current underlying price
        hours_ahead:      Target horizon in hours
        strike_grid:      List of strikes to evaluate at

    Returns:
        Dict mapping strike → pdf density
    """
    prices, probs = _extract_cdf_points(percentile_data, hours_ahead)
    if prices is None or len(prices) < 3:
        return {}

    try:
        cdf_interp = PchipInterpolator(prices, probs, extrapolate=False)
        grid = np.array(sorted(strike_grid), dtype=float)

        # Evaluate CDF on a fine grid for smoother derivative.
        # Clamp extrapolation at boundaries: below p_min → 0, above p_max → 1.
        fine_grid = np.linspace(grid[0], grid[-1], max(len(grid) * 4, 200))
        raw_vals = cdf_interp(fine_grid)
        # Replace NaN (outside interpolation range) with boundary values
        raw_vals = np.where(fine_grid < prices[0], probs[0], raw_vals)
        raw_vals = np.where(fine_grid > prices[-1], probs[-1], raw_vals)
        cdf_vals = np.clip(raw_vals, 0.0, 1.0)

        # Numerical derivative: dCDF/dK = pdf
        pdf_fine = np.gradient(cdf_vals, fine_grid)
        pdf_fine = np.maximum(pdf_fine, 0.0)

        # Interpolate back to requested grid
        from scipy.interpolate import interp1d
        pdf_interp = interp1d(fine_grid, pdf_fine, kind='linear', bounds_error=False, fill_value=0.0)

        result = {}
        for k in strike_grid:
            val = float(pdf_interp(k))
            result[k] = max(0.0, val)
        return result
    except Exception as e:
        logger.warning("Synth PDF computation failed: %s", e)
        return {}


def build_derive_pdf(
    prob_curve: Dict[float, float],
) -> Dict[float, float]:
    """Derive PDF from a P(S > K) probability curve using finite differences.

    f(K) ≈ -d/dK P(S > K) = -ΔP/ΔK (should be positive for a valid density)

    Args:
        prob_curve: {strike: P(S > strike)} from build_derive_prob_curve

    Returns:
        Dict mapping strike → pdf density
    """
    if len(prob_curve) < 2:
        return {}

    sorted_ks = sorted(prob_curve.keys())
    pdf = {}
    for i in range(len(sorted_ks) - 1):
        k_lo = sorted_ks[i]
        k_hi = sorted_ks[i + 1]
        dK = k_hi - k_lo
        if dK <= 0:
            continue
        # -d/dK P(S > K) = (P(K_lo) - P(K_hi)) / dK
        density = (prob_curve[k_lo] - prob_curve[k_hi]) / dK
        mid_k = (k_lo + k_hi) / 2.0
        pdf[mid_k] = max(0.0, density)

    return pdf


def compute_synth_implied_vol(percentile_data: Dict, hours_ahead: float) -> Optional[float]:
    """Back out an ATM implied vol from the SynthData CDF at a given horizon.

    Uses the interquartile range (Q25–Q75) of the predicted price distribution:
        σ_implied = log(Q75 / Q25) / (2 × N_inv(0.75) × sqrt(T))
    where N_inv(0.75) = 0.6745 (z-score at the 75th percentile).
    """
    prices, probs = _extract_cdf_points(percentile_data, hours_ahead)
    if prices is None or len(prices) < 3:
        return None

    t_years = hours_ahead / (365.25 * 24)
    if t_years <= 0:
        return None

    try:
        inv_cdf = PchipInterpolator(probs, prices)
        q25 = float(inv_cdf(0.25))
        q75 = float(inv_cdf(0.75))
        if q25 <= 0 or q75 <= q25:
            return None
        N_INV_75 = 0.6745
        iv = math.log(q75 / q25) / (2.0 * N_INV_75 * math.sqrt(t_years))
        return float(np.clip(iv, 0.05, 5.0))
    except Exception:
        return None


def get_synth_spot_estimate(percentile_data: Dict, hours_ahead: float) -> Optional[float]:
    """Extract the median (0.5 quantile) price as the AI's central forecast."""
    prices, probs = _extract_cdf_points(percentile_data, hours_ahead)
    if prices is None:
        return None
    # Find price at P = 0.5
    idx_50 = None
    for i, p in enumerate(probs):
        if abs(p - 0.5) < 0.05:
            idx_50 = i
            break
    if idx_50 is not None:
        return float(prices[idx_50])
    # Interpolate
    try:
        inv_cdf = PchipInterpolator(probs, prices)
        return float(inv_cdf(0.5))
    except Exception:
        return None
