"""Three-way volatility arbitrage scanner.

Triangulates probability estimates from:
  - SynthData AI (percentile forecasts)
  - Derive/Lyra Finance (options chain via Discrete Vertical Mapping)
  - Polymarket (binary prediction market prices)

Three strategies:
  1. Short Vol:  synth < derive < poly → Poly overpriced → SELL POLY YES
  2. Skew Arb:  OTM puts: derive >> poly below → options price more downside → PUT SPREAD
  3. The Pin:   Range market: poly < derive range → BUY POLY YES (range)
"""

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

EDGE_THRESHOLD = 0.03  # 3% minimum edge
MAX_STRIKE_DISTANCE = 0.20  # skip markets with strike > 20% from spot (deep ITM/OTM are near-certain)


@dataclass
class Signal:
    """A detected mispricing signal across the three probability sources."""
    strategy: str        # "short_vol" | "skew_arb" | "the_pin"
    asset: str           # "BTC" | "ETH"
    strike: float        # Mispriced strike
    direction: str       # e.g. "BUY POLY NO" | "BUY PUT SPREAD" | "BUY POLY YES"
    edge_pct: float      # Discrepancy magnitude (min 3%)
    synth_prob: float    # AI probability at this strike
    derive_prob: float   # Options-implied probability
    poly_prob: float     # Polymarket price
    reasoning: str       # Human-readable explanation
    confidence: str      # "HIGH" | "MEDIUM" | "LOW"
    poly_question: str = ""      # Matched Polymarket question
    poly_url: str = ""           # Polymarket market URL
    poly_expiry: str = ""        # ISO expiry datetime string
    kelly_fraction: float = 0.0  # Approximate Kelly bet size (fraction of bankroll)
    delta: float = 0.0           # Options delta of the suggested Derive hedge leg
    vega: float = 0.0            # Options vega per 1% vol move of the suggested hedge leg


def _confidence_from_edge(edge: float) -> str:
    if edge >= 0.10:
        return "HIGH"
    if edge >= 0.06:
        return "MEDIUM"
    return "LOW"


def scan_short_vol(
    asset: str,
    synth_curve: Dict[float, float],
    derive_curve: Dict[float, float],
    poly_markets,
    spot: float,
) -> List[Signal]:
    """Strategy 1 — Short Vol.

    Condition:
        synth_prob < derive_prob AND derive_prob < poly_prob
        AND (poly_prob - synth_prob) > EDGE_THRESHOLD

    Action: SELL POLY YES / SELL CALL SPREAD
    Logic:  AI + options both cheaper than Poly → Poly is overpriced
    """
    signals = []

    for market in poly_markets:
        if market.asset != asset:
            continue
        if market.market_type not in ("above_below",):
            continue
        if not market.strike or not market.is_above:
            continue

        strike = market.strike
        # Skip deep ITM/OTM markets — near-certain outcomes aren't real arb
        if spot > 0 and abs(strike - spot) / spot > MAX_STRIKE_DISTANCE:
            continue

        poly_prob = (market.yes_bid + market.yes_ask) / 2.0 if market.yes_ask > 0 else market.yes_price

        synth_prob = _lookup_prob(synth_curve, strike)
        derive_prob = _lookup_prob(derive_curve, strike)

        if synth_prob is None or derive_prob is None:
            continue

        edge = poly_prob - synth_prob  # How much poly overprices vs AI
        if edge < EDGE_THRESHOLD:
            continue

        if not (synth_prob < derive_prob < poly_prob):
            continue

        # Kelly fraction: buying NO at (1-poly_prob), estimated win prob = 1-synth_prob
        kelly = min((poly_prob - synth_prob) / max(poly_prob, 0.01), 0.25)

        signals.append(Signal(
            strategy="short_vol",
            asset=asset,
            strike=strike,
            direction="BUY POLY NO / SELL CALL SPREAD",
            edge_pct=round(edge, 4),
            synth_prob=round(synth_prob, 4),
            derive_prob=round(derive_prob, 4),
            poly_prob=round(poly_prob, 4),
            reasoning=(
                f"AI ({synth_prob:.0%}) and options ({derive_prob:.0%}) both price "
                f"lower than Polymarket ({poly_prob:.0%}) for {asset} > ${strike:,.0f}. "
                f"Edge: {edge:.1%}. Buy Poly NO and hedge with short call spread."
            ),
            confidence=_confidence_from_edge(edge),
            poly_question=market.question,
            poly_url=getattr(market, "polymarket_url", ""),
            poly_expiry=market.expiry.isoformat() if market.expiry else "",
            kelly_fraction=round(kelly, 4),
        ))

    # Sort by edge descending
    signals.sort(key=lambda s: s.edge_pct, reverse=True)
    return signals


def scan_skew_arb(
    asset: str,
    synth_curve: Dict[float, float],
    derive_curve: Dict[float, float],
    poly_markets,
    spot: float,
) -> List[Signal]:
    """Strategy 2 — Skew Arb.

    Condition (OTM puts, strike < spot * 0.97):
        derive_prob significantly > poly "below" price (put skew > poly skew)
        AND (derive_prob - poly_prob) > EDGE_THRESHOLD

    Action: SELL PUT SPREAD / BUY POLY NO
    Logic:  Options market prices more downside risk than prediction market
    """
    signals = []

    for market in poly_markets:
        if market.asset != asset:
            continue
        if market.market_type not in ("above_below",):
            continue
        if not market.strike:
            continue

        # "Below" markets: is_above=False means YES = S < strike
        # We want put-equivalent: P(S < K) from options
        if market.is_above:
            # "above" market: poly_prob is P(S > strike)
            # For skew arb, we want OTM puts → "below" markets
            continue

        strike = market.strike
        if spot > 0 and abs(strike - spot) / spot > MAX_STRIKE_DISTANCE:
            continue  # Skip deep ITM/OTM
        if strike >= spot * 0.97:
            continue  # Not OTM enough for put skew to dominate

        # poly_prob here = P(S < strike) = YES price for "below" market
        poly_prob_below = (market.yes_bid + market.yes_ask) / 2.0 if market.yes_ask > 0 else market.yes_price

        # derive: P(S > K) → P(S < K) = 1 - P(S > K)
        derive_prob_above = _lookup_prob(derive_curve, strike)
        if derive_prob_above is None:
            continue
        derive_prob_below = 1.0 - derive_prob_above

        synth_prob_above = _lookup_prob(synth_curve, strike)
        synth_prob_below = (1.0 - synth_prob_above) if synth_prob_above is not None else None

        edge = derive_prob_below - poly_prob_below
        if edge < EDGE_THRESHOLD:
            continue

        # Kelly fraction: selling the put spread (risk = derive_prob_below per unit)
        kelly = min(edge / max(derive_prob_below, 0.01), 0.25)

        signals.append(Signal(
            strategy="skew_arb",
            asset=asset,
            strike=strike,
            direction="BUY POLY NO / SELL PUT SPREAD",
            edge_pct=round(edge, 4),
            synth_prob=round(synth_prob_below, 4) if synth_prob_below is not None else round(derive_prob_below, 4),
            derive_prob=round(derive_prob_below, 4),
            poly_prob=round(poly_prob_below, 4),
            reasoning=(
                f"Options put skew at ${strike:,.0f} implies {derive_prob_below:.0%} chance of downside, "
                f"but Polymarket only prices {poly_prob_below:.0%}. "
                f"Edge: {edge:.1%}. Sell put spread (collect rich premium) or buy Poly NO."
            ),
            confidence=_confidence_from_edge(edge),
            poly_question=market.question,
            poly_url=getattr(market, "polymarket_url", ""),
            poly_expiry=market.expiry.isoformat() if market.expiry else "",
            kelly_fraction=round(kelly, 4),
        ))

    signals.sort(key=lambda s: s.edge_pct, reverse=True)
    return signals


def scan_the_pin(
    asset: str,
    synth_curve: Dict[float, float],
    derive_curve: Dict[float, float],
    poly_markets,
    spot: float,
    options,
    t_poly: float,
) -> List[Signal]:
    """Strategy 3 — The Pin.

    Condition (range market [K1, K2]):
        poly_range_prob < derive_range_prob (from $100-wide vertical)
        AND (derive_range_prob - poly_range_prob) > EDGE_THRESHOLD

    Action: BUY POLY YES (range)
    Logic:  Prediction market underpricing the pin/range outcome vs options
    """
    from engine.prob_calc import range_probability
    signals = []

    for market in poly_markets:
        if market.asset != asset:
            continue
        if market.market_type not in ("daily_range",):
            continue
        if not market.lower_bound or not market.upper_bound:
            continue

        K1, K2 = market.lower_bound, market.upper_bound

        # The Pin is only valid when spot is inside or very near the range.
        # DVM gives spurious ~100% for deep ITM call spreads (intrinsic dominates).
        # Require: spot within 5% of range bounds.
        if spot > 0 and not (K1 * 0.95 <= spot <= K2 * 1.05):
            continue

        poly_prob = (market.yes_bid + market.yes_ask) / 2.0 if market.yes_ask > 0 else market.yes_price

        # Use this market's actual expiry TTE (not the global 17:00 UTC proxy)
        now = datetime.now(timezone.utc)
        if market.expiry and market.expiry > now:
            t_market = (market.expiry - now).total_seconds() / (365.25 * 24 * 3600)
        else:
            t_market = t_poly

        # Derive range probability from options chain using per-market TTE
        derive_range = range_probability(K1, K2, options, spot, t_market)
        if derive_range is None:
            # Fallback: compute from the prob curve
            p_above_k1 = _lookup_prob(derive_curve, K1)
            p_above_k2 = _lookup_prob(derive_curve, K2)
            if p_above_k1 is not None and p_above_k2 is not None:
                derive_range = p_above_k1 - p_above_k2
            else:
                continue

        synth_range = None
        p_above_k1_s = _lookup_prob(synth_curve, K1)
        p_above_k2_s = _lookup_prob(synth_curve, K2)
        if p_above_k1_s is not None and p_above_k2_s is not None:
            synth_range = p_above_k1_s - p_above_k2_s

        edge = derive_range - poly_prob
        if edge < EDGE_THRESHOLD:
            continue

        # Kelly fraction: buying YES at poly_prob, estimated win prob = derive_range
        kelly = min((derive_range - poly_prob) / max(1 - poly_prob, 0.01), 0.25)

        signals.append(Signal(
            strategy="the_pin",
            asset=asset,
            strike=(K1 + K2) / 2.0,
            direction="BUY POLY YES (range)",
            edge_pct=round(edge, 4),
            synth_prob=round(synth_range, 4) if synth_range is not None else round(derive_range, 4),
            derive_prob=round(derive_range, 4),
            poly_prob=round(poly_prob, 4),
            reasoning=(
                f"Options ${K2-K1:,.0f}-wide vertical at ${K1:,.0f}–${K2:,.0f} implies {derive_range:.0%} "
                f"range probability, but Polymarket only prices {poly_prob:.0%}. "
                f"Edge: {edge:.1%}. Buy Poly YES (range) — options pricing more pin risk."
            ),
            confidence=_confidence_from_edge(edge),
            poly_question=market.question,
            poly_url=getattr(market, "polymarket_url", ""),
            poly_expiry=market.expiry.isoformat() if market.expiry else "",
            kelly_fraction=round(kelly, 4),
        ))

    signals.sort(key=lambda s: s.edge_pct, reverse=True)
    return signals


def run_all_strategies(
    asset: str,
    synth_curve: Dict[float, float],
    derive_curve: Dict[float, float],
    poly_markets,
    spot: float,
    options=None,
    t_poly: float = 0.0,
) -> List[Signal]:
    """Run all three strategies and return combined, deduplicated signals."""
    signals = []

    signals.extend(scan_short_vol(asset, synth_curve, derive_curve, poly_markets, spot))
    signals.extend(scan_skew_arb(asset, synth_curve, derive_curve, poly_markets, spot))

    if options and t_poly > 0:
        signals.extend(scan_the_pin(asset, synth_curve, derive_curve, poly_markets, spot, options, t_poly))

    # Sort by edge descending, deduplicate by (strategy, strike)
    seen = set()
    unique = []
    for s in sorted(signals, key=lambda x: x.edge_pct, reverse=True):
        key = (s.strategy, s.strike)
        if key not in seen:
            seen.add(key)
            unique.append(s)

    # Enrich with BSM Greeks using the nearest-expiry ATM IV
    if options and t_poly > 0:
        from engine.greeks import get_atm_iv_from_chain, greeks_for_signal
        iv = get_atm_iv_from_chain(options, spot, t_poly)
        if iv > 0:
            for sig in unique:
                g = greeks_for_signal(sig.strategy, sig.strike, spot, iv, t_poly)
                sig.delta = g["delta"]
                sig.vega = g["vega"]

    return unique


def build_strike_table(
    asset: str,
    synth_curve: Dict[float, float],
    derive_curve: Dict[float, float],
    poly_markets,
    spot: float,
    signals: List[Signal],
    options=None,
    primary_tte: float = 0.0,
    t_poly: float = 0.0,
) -> List[Dict]:
    """Build the per-strike comparison table for the UI.

    Returns list of dicts:
    [{strike, synth_prob, derive_prob, poly_prob, edge, action, highlight}]
    """
    # Collect all strikes that have at least two data sources
    strikes = set()
    for k in synth_curve:
        if k in derive_curve:
            strikes.add(k)

    # Add Polymarket strikes
    for market in poly_markets:
        if market.asset == asset and market.strike:
            strikes.add(market.strike)

    # Build a lookup for Polymarket prices, questions, and URLs by strike
    poly_by_strike: Dict[float, float] = {}
    poly_question_by_strike: Dict[float, str] = {}
    poly_url_by_strike: Dict[float, str] = {}
    for market in poly_markets:
        if market.asset != asset or not market.strike:
            continue
        if market.market_type != "above_below" or not market.is_above:
            continue
        mid = (market.yes_bid + market.yes_ask) / 2.0 if market.yes_ask > 0 else market.yes_price
        poly_by_strike[market.strike] = mid
        poly_question_by_strike[market.strike] = market.question
        poly_url_by_strike[market.strike] = getattr(market, "polymarket_url", "")

    # Per-market TTE: use the actual Polymarket market expiry, not the global 17:00 proxy
    now = datetime.now(timezone.utc)
    poly_market_ttes: Dict[float, float] = {}
    for m in poly_markets:
        if m.asset == asset and m.strike and m.expiry and m.expiry > now:
            poly_market_ttes[m.strike] = (m.expiry - now).total_seconds() / (365.25 * 24 * 3600)

    # Pre-compute derive binary data for all Polymarket above_below strikes
    from engine.prob_calc import derive_binary_for_strike as _derive_binary
    derive_bin_by_strike: Dict[float, Optional[Dict]] = {}
    if options and primary_tte > 0:
        for strike in poly_by_strike:
            t_market = poly_market_ttes.get(strike) or (t_poly if t_poly > 0 else None)
            derive_bin_by_strike[strike] = _derive_binary(options, strike, spot, primary_tte, t_market)

    # Build signal lookup for actions
    signal_by_strike: Dict[float, Signal] = {}
    for sig in signals:
        if sig.strike not in signal_by_strike:
            signal_by_strike[sig.strike] = sig

    rows = []
    for strike in sorted(strikes):
        synth_p = synth_curve.get(strike)
        derive_p = derive_curve.get(strike)
        poly_p = poly_by_strike.get(strike)

        if synth_p is None and derive_p is None:
            continue

        # Use derive_binary when available, else fall back to DVM curve
        bin_result = derive_bin_by_strike.get(strike)
        derive_bin = bin_result["binary"] if bin_result else None
        derive_for_edge = derive_bin if derive_bin is not None else derive_p

        edge = 0.0
        action = ""
        if poly_p is not None and derive_for_edge is not None:
            edge = abs(poly_p - derive_for_edge)
        if strike in signal_by_strike:
            sig = signal_by_strike[strike]
            edge = sig.edge_pct
            action = sig.direction

        rows.append({
            "strike": float(strike),
            "synth_prob": round(float(synth_p), 4) if synth_p is not None else None,
            "derive_prob": round(float(derive_p), 4) if derive_p is not None else None,
            "poly_prob": round(float(poly_p), 4) if poly_p is not None else None,
            "edge": round(float(edge), 4),
            "action": action,
            "highlight": bool(edge >= EDGE_THRESHOLD),
            "derive_binary": round(bin_result["binary"], 4) if bin_result else None,
            "derive_iv": round(bin_result["iv"], 4) if bin_result else None,
            "derive_bid": round(bin_result["bid"], 2) if bin_result else None,
            "derive_ask": round(bin_result["ask"], 2) if bin_result else None,
            "derive_option_strike": bin_result["option_strike"] if bin_result else None,
            "poly_question": poly_question_by_strike.get(strike, ""),
            "poly_url": poly_url_by_strike.get(strike, ""),
        })

    return rows


def _lookup_prob(curve: Dict[float, float], strike: float) -> Optional[float]:
    """Look up probability at a strike, with linear interpolation."""
    if not curve:
        return None

    if strike in curve:
        return curve[strike]

    sorted_ks = sorted(curve.keys())
    if strike < sorted_ks[0]:
        return curve[sorted_ks[0]]
    if strike > sorted_ks[-1]:
        return curve[sorted_ks[-1]]

    for i in range(len(sorted_ks) - 1):
        k_lo = sorted_ks[i]
        k_hi = sorted_ks[i + 1]
        if k_lo <= strike <= k_hi:
            frac = (strike - k_lo) / (k_hi - k_lo)
            return curve[k_lo] + frac * (curve[k_hi] - curve[k_lo])

    return None
