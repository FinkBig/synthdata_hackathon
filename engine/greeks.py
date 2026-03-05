"""BSM option Greeks (r=0 approximation, suitable for short-dated crypto).

All functions:
  spot   — current underlying price
  strike — option strike
  iv     — implied volatility (decimal, e.g. 0.65 for 65%)
  t      — time to expiry in years
"""

import math
from typing import Dict, Optional

from scipy.stats import norm


def _d1_d2(spot: float, strike: float, iv: float, t: float):
    if t <= 0 or iv <= 0 or spot <= 0 or strike <= 0:
        return 0.0, 0.0
    d1 = (math.log(spot / strike) + 0.5 * iv ** 2 * t) / (iv * math.sqrt(t))
    return d1, d1 - iv * math.sqrt(t)


def delta(spot: float, strike: float, iv: float, t: float, option_type: str = "call") -> float:
    """BSM delta: dV/dS."""
    d1, _ = _d1_d2(spot, strike, iv, t)
    return float(norm.cdf(d1)) if option_type == "call" else float(norm.cdf(d1) - 1)


def vega_per_vol_point(spot: float, strike: float, iv: float, t: float) -> float:
    """Vega per 1 percentage-point move in IV (i.e. per 0.01 change in iv decimal)."""
    if t <= 0 or iv <= 0:
        return 0.0
    d1, _ = _d1_d2(spot, strike, iv, t)
    return float(spot * norm.pdf(d1) * math.sqrt(t)) * 0.01


def binary_delta(spot: float, strike: float, iv: float, t: float) -> float:
    """Delta of a BSM digital call: dN(d2)/dS."""
    if t <= 0 or iv <= 0:
        return 0.0
    _, d2 = _d1_d2(spot, strike, iv, t)
    return float(norm.pdf(d2) / (spot * iv * math.sqrt(t)))


def greeks_for_signal(
    strategy: str,
    strike: float,
    spot: float,
    iv: float,
    t: float,
) -> Dict[str, float]:
    """
    Return {delta, vega} for the Derive options leg of a signal.

    short_vol  → short ATM call (negative delta, negative vega)
    skew_arb   → short OTM put (positive delta, negative vega)
    the_pin    → flat delta (straddle-like range); approximated as 0
    """
    if iv <= 0 or t <= 0 or spot <= 0:
        return {"delta": 0.0, "vega": 0.0}

    if strategy == "short_vol":
        # Short call at strike
        d = -delta(spot, strike, iv, t, "call")
        v = -vega_per_vol_point(spot, strike, iv, t)
    elif strategy == "skew_arb":
        # Short put at strike
        d = -delta(spot, strike, iv, t, "put")
        v = -vega_per_vol_point(spot, strike, iv, t)
    else:
        # the_pin: range trade — delta and vega approximately cancel
        d, v = 0.0, 0.0

    return {"delta": round(d, 4), "vega": round(v, 6)}


def get_atm_iv_from_chain(options, spot: float, t_poly: float) -> float:
    """Find the nearest-expiry ATM IV from the Derive options chain."""
    if not options or spot <= 0 or t_poly <= 0:
        return 0.0

    from datetime import datetime, timezone
    now_ts = datetime.now(timezone.utc).timestamp()
    target_ts = now_ts + t_poly * 365.25 * 24 * 3600

    # Find nearest expiry to t_poly
    best_exp = None
    best_diff = float("inf")
    for opt in options:
        exp_ts = opt.expiry.timestamp()
        if exp_ts <= now_ts:
            continue
        diff = abs(exp_ts - target_ts)
        if diff < best_diff:
            best_diff = diff
            best_exp = opt.expiry

    if best_exp is None:
        return 0.0

    # ATM option at that expiry
    atm_iv = 0.0
    min_dist = float("inf")
    for opt in options:
        if opt.expiry != best_exp or opt.implied_volatility <= 0:
            continue
        dist = abs(opt.strike - spot)
        if dist < min_dist:
            min_dist = dist
            atm_iv = opt.implied_volatility

    if atm_iv > 5:
        atm_iv /= 100.0
    return atm_iv
