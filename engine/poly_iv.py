"""Polymarket Implied Volatility extractor.

Inverts BSM digital option pricing to back out implied vol from Polymarket
above/below and daily-range market prices.

BSM formulas (r = 0, lognormal price model):
  d2(S, K, σ, T) = [ln(S/K) − 0.5σ²T] / (σ√T)

  Above/below YES  = N(d2)             [digital call: P(S_T > K)]
  Above/below NO   = N(−d2)            [digital put:  P(S_T < K)]
  Range YES        = N(d2_low) − N(d2_high)  where d2_low > d2_high

The inversion is done with scipy brentq on [σ_min, σ_max] = [1%, 500%].

Prices outside (0.02, 0.98) are filtered — deep OTM/ITM markets carry
essentially no IV information (tiny sensitivity to vol).
"""

import logging
import math
from dataclasses import dataclass
from typing import List, Optional

from scipy.optimize import brentq
from scipy.stats import norm

logger = logging.getLogger(__name__)

_MIN_PRICE = 0.03   # below this → too far OTM, no IV signal
_MAX_PRICE = 0.97   # above this → too far ITM, no IV signal
_IV_LO     = 0.01   # 1% — lower bound for brentq search
_IV_HI     = 5.00   # 500% — upper bound for brentq search


@dataclass
class PolyIVPoint:
    strike: float          # K (or midpoint for range markets)
    moneyness_pct: float   # (K / spot − 1) × 100
    poly_iv: float         # annualised implied vol, decimal (e.g. 0.56 = 56%)
    market_type: str       # "above_below" | "daily_range"
    yes_price: float       # raw Poly YES price used
    expiry: str            # ISO string


def _d2(spot: float, strike: float, sigma: float, tte: float) -> float:
    return (math.log(spot / strike) - 0.5 * sigma ** 2 * tte) / (sigma * math.sqrt(tte))


def _iv_above_below(yes_price: float, spot: float, strike: float,
                    tte: float, is_above: bool) -> Optional[float]:
    """Invert a digital call/put price to get implied vol."""
    if not (_MIN_PRICE < yes_price < _MAX_PRICE):
        return None
    if tte <= 0 or spot <= 0 or strike <= 0:
        return None

    # For "is_above" markets: YES = N(d2)  → target_nd2 = yes_price
    # For "is_below" markets: YES = N(−d2) → target_nd2 = 1 − yes_price
    target_nd2 = yes_price if is_above else 1.0 - yes_price
    d2_target = float(norm.ppf(target_nd2))

    def objective(sigma: float) -> float:
        return _d2(spot, strike, sigma, tte) - d2_target

    try:
        lo_val = objective(_IV_LO)
        hi_val = objective(_IV_HI)
        if lo_val * hi_val > 0:
            return None  # no root in bracket
        iv = brentq(objective, _IV_LO, _IV_HI, xtol=1e-6, maxiter=100)
        return float(iv)
    except Exception:
        return None


def _iv_range(yes_price: float, spot: float, lower: float, upper: float,
              tte: float) -> Optional[float]:
    """Invert a range YES price: P(lower < S < upper) = N(d2_lo) − N(d2_hi)."""
    if not (_MIN_PRICE < yes_price < _MAX_PRICE):
        return None
    if tte <= 0 or lower <= 0 or upper <= lower:
        return None

    def objective(sigma: float) -> float:
        # d2 for lower bound (higher probability of being above lower)
        d2_lo = _d2(spot, lower, sigma, tte)
        # d2 for upper bound
        d2_hi = _d2(spot, upper, sigma, tte)
        model_price = float(norm.cdf(d2_lo) - norm.cdf(d2_hi))
        return model_price - yes_price

    try:
        lo_val = objective(_IV_LO)
        hi_val = objective(_IV_HI)
        if lo_val * hi_val > 0:
            return None
        iv = brentq(objective, _IV_LO, _IV_HI, xtol=1e-6, maxiter=100)
        return float(iv)
    except Exception:
        return None


def extract_poly_iv(poly_points: List[dict], spot: float) -> List[PolyIVPoint]:
    """Extract implied vol from all Polymarket above/below and range markets.

    Args:
        poly_points: list of poly_point dicts from the snapshot
        spot: current BTC/ETH spot price

    Returns:
        Sorted list of PolyIVPoint by moneyness
    """
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc)
    results: List[PolyIVPoint] = []
    seen: set = set()  # deduplicate (strike, market_type, expiry)

    for p in poly_points:
        expiry_str = p.get("expiry") or ""
        yes_price  = p.get("yes_price", 0.0)
        mtype      = p.get("market_type", "")

        # Parse TTE
        try:
            expiry_dt = datetime.fromisoformat(expiry_str)
            if expiry_dt.tzinfo is None:
                expiry_dt = expiry_dt.replace(tzinfo=timezone.utc)
            tte_years = (expiry_dt - now).total_seconds() / (365.25 * 24 * 3600)
        except Exception:
            continue

        if tte_years <= 0:
            continue

        iv: Optional[float] = None
        strike: Optional[float] = None

        if mtype == "above_below":
            strike = p.get("strike")
            if not strike:
                continue
            is_above = p.get("is_above", True)
            iv = _iv_above_below(yes_price, spot, strike, tte_years, is_above)

        elif mtype == "daily_range":
            lower = p.get("lower_bound")
            upper = p.get("upper_bound")
            if not lower or not upper:
                continue
            strike = (lower + upper) / 2.0  # use midpoint as the representative strike
            iv = _iv_range(yes_price, spot, lower, upper, tte_years)

        if iv is None or strike is None:
            continue

        # Sanity-check: IV must be positive and below 500%
        if not (0.01 < iv < 5.0):
            continue

        dedup_key = (round(strike, -1), mtype, expiry_str[:16])
        if dedup_key in seen:
            continue
        seen.add(dedup_key)

        moneyness = round((strike / spot - 1.0) * 100.0, 1)
        results.append(PolyIVPoint(
            strike=strike,
            moneyness_pct=moneyness,
            poly_iv=round(iv, 4),
            market_type=mtype,
            yes_price=yes_price,
            expiry=expiry_str,
        ))

    results.sort(key=lambda x: x.moneyness_pct)
    return results


def atm_poly_iv(poly_points: List[dict], spot: float) -> Optional[float]:
    """Return the single best ATM implied vol from Polymarket above/below markets.
    Picks the above_below market whose strike is nearest to spot."""
    points = [p for p in extract_poly_iv(poly_points, spot)
              if p.market_type == "above_below"]
    if not points:
        return None
    atm = min(points, key=lambda p: abs(p.moneyness_pct))
    return atm.poly_iv
