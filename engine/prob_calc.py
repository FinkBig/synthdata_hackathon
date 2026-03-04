"""Discrete Vertical Mapping for 0DTE/24h options chains.

Why not Breeden-Litzenberger for 0DTE:
  BL requires a continuous, smooth options surface. For 0DTE/24h expiries,
  the chain is sparse (wide strike spacing relative to remaining variance) and
  bid-ask spreads are wide, making the second derivative estimate extremely noisy.

Discrete Vertical Mapping (Finite Difference) Formula:
  For calls above spot:
    P(K1 < S_T < K2) = (C(K1).mid - C(K2).mid) / (K2 - K1)

  For puts below spot (direct CDF form):
    (P(K2).mid - P(K1).mid) / (K2 - K1) ≈ dP/dK ≈ CDF(K1) = P(S_T < K1)
    So: P(S_T > K1) = 1 - (P(K2).mid - P(K1).mid) / (K2 - K1)

  Building the full P(S > K) curve:
    1. Filter options to target expiry (nearest to 24h)
    2. Sort calls: K1 < K2 < ... < Kn (all above spot)
    3. range_prob[i] = (C(Ki).mid - C(Ki+1).mid) / (Ki+1 - Ki)
    4. P(S > Ki) = sum(range_prob[j] for j >= i)  [calls: accumulate down]
    5. For puts: P(S > Ki) = 1 - (P(Ki+1) - P(Ki)) / dK  [direct, no accumulation]
    6. Stitch at spot: P(S > spot) ≈ 0.5
"""

import math
import logging
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)


def _mid(bid: float, ask: float, mark: float) -> float:
    """Compute mid price, falling back to mark if bid/ask spread is zero."""
    if bid > 0 and ask > 0:
        return (bid + ask) / 2.0
    if mark > 0:
        return mark
    return 0.0


def interpolate_variance_to_poly(
    iv1: float, t1: float,
    iv2: float, t2: float,
    t_poly: float,
) -> float:
    """Interpolate IV to the Polymarket settlement horizon using total variance.

    Derive options expire at 08:00 UTC; Polymarket settles at 17:00 UTC.
    Variance scales linearly with time, so we interpolate total variance
    (not raw IV) between two bracket expiries.

    Formula:
      σ²_poly * T_poly = σ²_1 * T_1 + frac * (σ²_2 * T_2 - σ²_1 * T_1)
      where frac = (T_poly - T_1) / (T_2 - T_1)

    Args:
        iv1: Same-day expiry IV (decimal, e.g. 0.65 for 65%)
        t1:  Same-day expiry TTE in years
        iv2: Next-day expiry IV (decimal)
        t2:  Next-day expiry TTE in years
        t_poly: Polymarket settlement TTE in years

    Returns:
        IV to use for Polymarket probability calculations
    """
    if t_poly <= 0:
        return 0.0
    if t1 <= 0:
        # Past 08:00 UTC today — use next-day expiry only
        return iv2
    var1 = iv1 ** 2 * t1
    var2 = iv2 ** 2 * t2
    frac = (t_poly - t1) / (t2 - t1) if (t2 - t1) > 0 else 0.0
    frac = max(0.0, min(1.0, frac))
    var_poly = var1 + frac * (var2 - var1)
    return math.sqrt(max(var_poly / t_poly, 0.0))


def _select_expiry(options, spot: float, target_hours: float = 24.0):
    """Find the nearest expiry to target_hours from now.

    Returns (expiry_datetime, tte_years) for the best match.
    """
    now = datetime.now(timezone.utc)
    now_ts = now.timestamp()
    target_ts = now_ts + target_hours * 3600

    expiries = {}
    for opt in options:
        exp_ts = opt.expiry.timestamp()
        if exp_ts <= now_ts:
            continue
        expiries[opt.expiry] = abs(exp_ts - target_ts)

    if not expiries:
        return None, 0.0

    best_exp = min(expiries, key=expiries.get)
    tte_sec = best_exp.timestamp() - now_ts
    tte_years = tte_sec / (365.25 * 24 * 3600)
    return best_exp, tte_years


def _get_two_bracket_expiries(options, t_poly: float):
    """Find the two expiries that bracket the Polymarket settlement time.

    Returns:
        (exp1, t1, exp2, t2) where T_1 <= T_poly <= T_2 (all in years from now)
    """
    now_ts = datetime.now(timezone.utc).timestamp()

    expiry_ttes = {}
    for opt in options:
        exp_ts = opt.expiry.timestamp()
        if exp_ts <= now_ts:
            continue
        tte = (exp_ts - now_ts) / (365.25 * 24 * 3600)
        expiry_ttes[opt.expiry] = tte

    if not expiry_ttes:
        return None, 0.0, None, 0.0

    sorted_expiries = sorted(expiry_ttes.items(), key=lambda x: x[1])

    # Find bracket
    exp1, t1, exp2, t2 = None, 0.0, None, 0.0
    for exp, tte in sorted_expiries:
        if tte <= t_poly:
            exp1, t1 = exp, tte
        else:
            exp2, t2 = exp, tte
            break

    # Fallback: if no exp before t_poly, use nearest after
    if exp1 is None and sorted_expiries:
        exp2, t2 = sorted_expiries[0]
    if exp2 is None and sorted_expiries:
        exp1, t1 = sorted_expiries[-1]

    return exp1, t1, exp2, t2


def get_primary_tte(options, t_poly: float) -> float:
    """Return the TTE (years) of the single nearest Derive expiry to t_poly."""
    _, tte = _select_expiry(options, spot=0, target_hours=t_poly * 365.25 * 24)
    return tte if tte > 0 else t_poly


def derive_binary_for_strike(
    options,
    strike: float,
    spot: float,
    primary_tte: float,
) -> Optional[Dict]:
    """Compute BSM N(d2) binary price for a given strike from the live options chain.

    Uses the nearest OTM option at the primary expiry:
      - call when strike > spot (OTM call)
      - put  when strike <= spot (OTM put)

    Returns None if no option is within 5% of the requested strike.

    Returns:
        {binary, iv, bid, ask, option_strike, option_type}
    """
    if not options or spot <= 0 or primary_tte <= 0:
        return None

    now_ts = datetime.now(timezone.utc).timestamp()

    # Find the expiry whose TTE is closest to primary_tte
    best_expiry = None
    best_diff = float("inf")
    for opt in options:
        exp_ts = opt.expiry.timestamp()
        if exp_ts <= now_ts:
            continue
        tte = (exp_ts - now_ts) / (365.25 * 24 * 3600)
        diff = abs(tte - primary_tte)
        if diff < best_diff:
            best_diff = diff
            best_expiry = opt.expiry

    if best_expiry is None:
        return None

    opt_type = "call" if strike > spot else "put"
    candidates = [o for o in options if o.expiry == best_expiry and o.option_type == opt_type]
    if not candidates:
        return None

    nearest = min(candidates, key=lambda o: abs(o.strike - strike))

    # Reject if more than 5% away from requested strike
    if abs(nearest.strike - strike) / max(strike, 1) > 0.05:
        return None

    iv = nearest.implied_volatility
    if iv <= 0:
        return None
    if iv > 5:
        iv /= 100.0

    from scipy.stats import norm as _norm
    d2 = (math.log(spot / strike) - 0.5 * iv ** 2 * primary_tte) / (iv * math.sqrt(primary_tte))
    binary = float(_norm.cdf(d2))

    return {
        "binary": binary,
        "iv": iv,
        "bid": nearest.bid if nearest.bid > 0 else 0.0,
        "ask": nearest.ask if nearest.ask > 0 else 0.0,
        "option_strike": nearest.strike,
        "option_type": opt_type,
    }


def _filter_by_expiry(options, expiry) -> list:
    """Filter options to a single expiry."""
    if expiry is None:
        return []
    return [o for o in options if o.expiry == expiry]


def _atm_iv_for_expiry(options, expiry, spot: float) -> float:
    """Get ATM IV from an expiry's options chain."""
    filtered = _filter_by_expiry(options, expiry)
    if not filtered:
        return 0.0

    atm_iv = 0.0
    min_dist = float("inf")
    for opt in filtered:
        if opt.implied_volatility <= 0:
            continue
        dist = abs(opt.strike - spot)
        if dist < min_dist:
            min_dist = dist
            atm_iv = opt.implied_volatility

    # SynthData / Derive may return IV as percentage (e.g. 65.0 = 65%)
    if atm_iv > 5:
        atm_iv = atm_iv / 100.0
    return atm_iv


def build_derive_prob_curve(
    options,
    spot: float,
    t_poly: float,
    strike_grid: Optional[List[float]] = None,
) -> Dict[float, float]:
    """Returns {strike: P(S_T > strike)} using Discrete Vertical Mapping.

    Uses the single nearest Derive expiry to t_poly (always 0DTE or nearest 0DTE).
    We only compare against the nearest Polymarket settlement and SynthData's 24h
    forecast, so there is no reason to interpolate across multiple expiries.

    Args:
        options:      Full options chain (all expiries)
        spot:         Current underlying price
        t_poly:       Polymarket settlement TTE in years (used to pick nearest expiry)
        strike_grid:  If provided, interpolate to this grid

    Returns:
        Dict mapping strike → P(S_T > strike)
    """
    if not options or spot <= 0:
        return {}

    # Single nearest expiry to the Polymarket settlement horizon
    primary_exp, primary_tte = _select_expiry(options, spot, target_hours=t_poly * 365.25 * 24)
    if primary_exp is None:
        return {}

    chain = _filter_by_expiry(options, primary_exp)
    if not chain:
        return {}

    # ATM IV for BSM boundary conditions (no cross-expiry interpolation needed)
    iv_atm = _atm_iv_for_expiry(options, primary_exp, spot)

    # ── Build curve for calls (above spot) ──
    calls = sorted(
        [o for o in chain if o.option_type == "call" and o.strike > spot * 0.95],
        key=lambda o: o.strike
    )

    # ── Build curve for puts (below spot) ──
    puts = sorted(
        [o for o in chain if o.option_type == "put" and o.strike < spot * 1.05],
        key=lambda o: o.strike
    )

    prob_above: Dict[float, float] = {}

    # --- Calls: P(S > K) from call spreads ---
    if len(calls) >= 2:
        call_mids = [(o.strike, _mid(o.bid, o.ask, o.mark_price)) for o in calls]
        call_mids = [(k, m) for k, m in call_mids if m > 0]

        if len(call_mids) >= 2:
            # Boundary: BSM N(d2) for the highest call strike
            k_last, m_last = call_mids[-1]
            if primary_tte > 0 and iv_atm > 0:
                d2 = (math.log(spot / k_last) - 0.5 * iv_atm ** 2 * primary_tte) / (iv_atm * math.sqrt(primary_tte))
                from scipy.stats import norm as _norm
                p_above_last = float(_norm.cdf(d2))
            else:
                p_above_last = m_last / spot

            p_above_last = max(0.0, min(1.0, p_above_last))
            prob_above[k_last] = p_above_last

            # Work backwards: P(S > K_i) = P(S > K_{i+1}) + range_prob
            for i in range(len(call_mids) - 2, -1, -1):
                k_lo, m_lo = call_mids[i]
                k_hi, m_hi = call_mids[i + 1]
                dK = k_hi - k_lo
                if dK <= 0:
                    continue
                range_prob = max(0.0, min(1.0, (m_lo - m_hi) / dK))
                p_above_lo = min(1.0, prob_above.get(k_hi, 0.0) + range_prob)
                prob_above[k_lo] = p_above_lo

    # --- Puts: P(S > K) from put spreads ---
    if len(puts) >= 2:
        put_mids = [(o.strike, _mid(o.bid, o.ask, o.mark_price)) for o in puts]
        put_mids = [(k, m) for k, m in put_mids if m > 0]

        if len(put_mids) >= 2:
            # Boundary: BSM N(-d2) for the lowest put strike
            k_first, m_first = put_mids[0]
            if primary_tte > 0 and iv_atm > 0:
                d2 = (math.log(spot / k_first) - 0.5 * iv_atm ** 2 * primary_tte) / (iv_atm * math.sqrt(primary_tte))
                from scipy.stats import norm as _norm
                p_below_first = float(_norm.cdf(-d2))
            else:
                p_below_first = m_first / spot

            p_below_first = max(0.0, min(1.0, p_below_first))
            prob_above[k_first] = 1.0 - p_below_first

            # Direct DVM: each spread gives P(S > K_lo) = 1 - CDF(K_lo)
            for i in range(len(put_mids) - 1):
                k_lo, m_lo = put_mids[i]
                k_hi, m_hi = put_mids[i + 1]
                dK = k_hi - k_lo
                if dK <= 0:
                    continue
                cdf_k_lo = max(0.0, min(1.0, (m_hi - m_lo) / dK))
                prob_above[k_lo] = 1.0 - cdf_k_lo

    # Anchor at spot: P(S > spot) ≈ 0.5
    if spot not in prob_above:
        prob_above[spot] = 0.5

    if not strike_grid:
        return prob_above

    return _interpolate_to_grid(prob_above, strike_grid)


def _interpolate_to_grid(prob_above: Dict[float, float], grid: List[float]) -> Dict[float, float]:
    """Linear interpolation of prob_above curve onto a strike grid."""
    if not prob_above:
        return {}
    sorted_strikes = sorted(prob_above.keys())
    sorted_probs = [prob_above[k] for k in sorted_strikes]

    result = {}
    for target_k in grid:
        if target_k <= sorted_strikes[0]:
            result[target_k] = sorted_probs[0]
        elif target_k >= sorted_strikes[-1]:
            result[target_k] = sorted_probs[-1]
        else:
            for i in range(len(sorted_strikes) - 1):
                k_lo = sorted_strikes[i]
                k_hi = sorted_strikes[i + 1]
                if k_lo <= target_k <= k_hi:
                    frac = (target_k - k_lo) / (k_hi - k_lo)
                    p = sorted_probs[i] + frac * (sorted_probs[i + 1] - sorted_probs[i])
                    result[target_k] = max(0.0, min(1.0, p))
                    break
    return result


def range_probability(
    lower: float,
    upper: float,
    options,
    spot: float,
    t_poly: float,
) -> Optional[float]:
    """P(K1 < S_T < K2) for a specific Polymarket range market.

    Uses the correct option type depending on position relative to spot:
      - Both below spot → PUT spread: P = (P(K2).mid - P(K1).mid) / (K2 - K1)
      - Both above spot → CALL spread: P = (C(K1).mid - C(K2).mid) / (K2 - K1)
      - Straddles spot → fallback to P(S>K1) - P(S>K2) from the full curve

    Calling the wrong type (e.g. ITM call spread for below-spot range) gives
    DVM ≈ 1.0 because intrinsic value = K2-K1 dominates the spread price.
    """
    exp, tte = _select_expiry(options, spot, target_hours=t_poly * 365.25 * 24)
    if exp is None:
        return None

    chain = _filter_by_expiry(options, exp)

    dK = upper - lower
    if dK <= 0:
        return None

    if upper <= spot:
        # Both bounds below spot → use OTM put spread
        puts = {o.strike: o for o in chain if o.option_type == "put"}
        k1_opt = _nearest_strike_option(puts, lower)
        k2_opt = _nearest_strike_option(puts, upper)
        if k1_opt is None or k2_opt is None:
            return None
        k1_mid = _mid(k1_opt.bid, k1_opt.ask, k1_opt.mark_price)
        k2_mid = _mid(k2_opt.bid, k2_opt.ask, k2_opt.mark_price)
        actual_dK = k2_opt.strike - k1_opt.strike
        if actual_dK <= 0:
            return None
        p = (k2_mid - k1_mid) / actual_dK   # P(K2).put - P(K1).put
    elif lower >= spot:
        # Both bounds above spot → use OTM call spread
        calls = {o.strike: o for o in chain if o.option_type == "call"}
        k1_opt = _nearest_strike_option(calls, lower)
        k2_opt = _nearest_strike_option(calls, upper)
        if k1_opt is None or k2_opt is None:
            return None
        k1_mid = _mid(k1_opt.bid, k1_opt.ask, k1_opt.mark_price)
        k2_mid = _mid(k2_opt.bid, k2_opt.ask, k2_opt.mark_price)
        actual_dK = k2_opt.strike - k1_opt.strike
        if actual_dK <= 0:
            return None
        p = (k1_mid - k2_mid) / actual_dK   # C(K1).call - C(K2).call
    else:
        # Range straddles spot — return None, let caller fall back to curve difference
        return None

    return max(0.0, min(1.0, p))


def point_probability_above(
    strike: float,
    options,
    spot: float,
    t_poly: float,
) -> Optional[float]:
    """P(S_T > strike) via nearest call or put spread pair."""
    curve = build_derive_prob_curve(options, spot, t_poly)
    if not curve:
        return None

    sorted_ks = sorted(curve.keys())
    if not sorted_ks:
        return None

    if strike in curve:
        return curve[strike]

    # Linear interpolation
    for i in range(len(sorted_ks) - 1):
        k_lo = sorted_ks[i]
        k_hi = sorted_ks[i + 1]
        if k_lo <= strike <= k_hi:
            frac = (strike - k_lo) / (k_hi - k_lo)
            return curve[k_lo] + frac * (curve[k_hi] - curve[k_lo])

    if strike < sorted_ks[0]:
        return curve[sorted_ks[0]]
    return curve[sorted_ks[-1]]


def _nearest_strike_option(options_dict: Dict, target_strike: float):
    """Find the option with the nearest strike to target."""
    if not options_dict:
        return None
    best_k = min(options_dict.keys(), key=lambda k: abs(k - target_strike))
    if abs(best_k - target_strike) / max(target_strike, 1) > 0.05:
        return None  # Too far from target
    return options_dict[best_k]


def compute_poly_settlement_dt() -> datetime:
    """Return the next Polymarket settlement datetime (17:00 UTC today or tomorrow)."""
    from datetime import timedelta
    now = datetime.now(timezone.utc)
    today_settle = now.replace(hour=17, minute=0, second=0, microsecond=0)
    if now >= today_settle:
        today_settle += timedelta(days=1)
    return today_settle


def compute_poly_settlement_tte() -> float:
    """Compute TTE in years from now to next Polymarket settlement (17:00 UTC)."""
    now = datetime.now(timezone.utc)
    settle = compute_poly_settlement_dt()
    return (settle - now).total_seconds() / (365.25 * 24 * 3600)
