"""FastAPI application for the Synth-Vol Triangulator.

Endpoints:
  GET  /health                → {"status": "ok", "mock_mode": bool}
  GET  /api/snapshot/{asset} → Full triangulation snapshot
  GET  /api/signals           → All active signals (both assets)
  GET  /api/mock/{asset}      → Mock snapshot (always works, no API keys needed)
  GET  /api/stream            → SSE: live update notifications
"""

import asyncio
import json
import logging
import math
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, DefaultDict, Dict, List, Optional

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

# Engine
from engine.prob_calc import (
    build_derive_prob_curve,
    compute_poly_settlement_tte,
    compute_poly_settlement_dt,
    get_primary_tte,
)
from engine.synth_mapper import (
    build_synth_prob_curve, build_synth_pdf, build_derive_pdf,
    compute_synth_implied_vol,
)
from engine.arb_scanner import run_all_strategies, build_strike_table, Signal
from engine.poly_iv import extract_poly_iv, atm_poly_iv, PolyIVPoint
import engine.signal_tracker as signal_tracker

# Clients
from clients.binance import BinanceClient
from clients.derive import DeriveClient
from clients.polymarket import PolymarketClient
from clients.polymarket_clob import PolymarketClobWs
from clients.synthdata import SynthDataClient

logger = logging.getLogger(__name__)

# ── App setup ────────────────────────────────────────────────────────────────

app = FastAPI(title="Synth-Vol Triangulator", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Global state ─────────────────────────────────────────────────────────────

MOCK_MODE = os.environ.get("MOCK_MODE", "0") == "1"
ASSETS = ["BTC", "ETH"]
MOCK_DIR = Path(__file__).parent.parent / "data" / "mock"

binance_client = BinanceClient()
derive_client = DeriveClient()
poly_client = PolymarketClient()
clob_ws = PolymarketClobWs()
synth_client = SynthDataClient()

# Snapshot cache: {asset: snapshot_dict}
_snapshots: Dict[str, Dict] = {}
_snapshot_ts: Dict[str, float] = {}
_snapshot_ttl = 60  # seconds

# Polymarket markets per asset (populated by _fetch_live_snapshot)
from clients.polymarket import PolyMarket as _PolyMarket
_poly_markets: Dict[str, List[_PolyMarket]] = {}

# Background refresh loop
_refresh_running = False


# ── Helpers ──────────────────────────────────────────────────────────────────

def _load_mock(asset: str) -> Dict:
    path = MOCK_DIR / f"{asset.lower()}_snapshot.json"
    if path.exists():
        with open(path) as f:
            data = json.load(f)
        data["mode"] = "demo"
        data["last_updated"] = datetime.now(timezone.utc).isoformat()
        # Inject mock risk fields so demo mode shows the full feature set
        data.setdefault("vol_regime", "expanding")
        data.setdefault("forecast_vol", 0.68)
        data.setdefault("realized_vol", 0.52)
        data.setdefault("synth_poly_edge", 0.16)
        data["synth_status"] = synth_client.get_status()  # always fresh
        return data
    return {"error": f"No mock data for {asset}", "mode": "demo"}


def _build_strike_grid(spot: float, n: int = 20, pct: float = 0.10) -> List[float]:
    """Build a symmetric strike grid around spot (±10% in 1% steps)."""
    step = spot * pct / (n // 2)
    # Round step to nearest $100 for BTC, $10 for ETH
    if spot > 10000:
        step = round(step / 1000) * 1000 or 1000
    else:
        step = round(step / 100) * 100 or 100
    lower = spot * (1 - pct)
    upper = spot * (1 + pct)
    grid = []
    k = lower
    while k <= upper:
        grid.append(round(k / step) * step)
        k += step
    return sorted(set(grid))


async def _fetch_live_snapshot(asset: str) -> Dict:
    """Fetch live data from all three sources and compute snapshot."""
    t_poly = compute_poly_settlement_tte()

    # ── 1. Fetch spot price from Binance (primary) ──
    spot = await binance_client.get_spot_price(asset)

    # ── 2. Fetch options chain from Derive ──
    chain = await derive_client.get_options_chain(asset)

    # Fallback: extract spot from chain if Binance failed
    if not spot or spot <= 0:
        spot = derive_client.get_spot_from_chain(chain)

    if not chain or spot <= 0:
        logger.warning("No live data for %s — falling back to mock", asset)
        return _load_mock(asset)

    # ── 3. Fetch all SynthData endpoints ──
    # Split into two staggered batches to stay within SynthData's rate limit.
    # Batch A: high-priority (short TTL, needed for prob curves + signals)
    # Batch B: risk layer (longer TTL, served from cache on subsequent calls)
    def _ok(v):
        return v if v is not None and not isinstance(v, Exception) else None

    # Fetch sequentially with 1s gaps — SynthData rate-limits burst requests.
    # After the first fetch each endpoint is cached (TTL 10min–2h) so
    # subsequent calls are free (no network, no credit spend).
    percentile_data  = _ok(await synth_client.get_prediction_percentiles(asset))
    await asyncio.sleep(1.0)
    vol_data         = _ok(await synth_client.get_volatility(asset))
    await asyncio.sleep(1.0)
    poly_signal_data = _ok(await synth_client.get_polymarket_signal(asset))
    await asyncio.sleep(1.0)
    lp_probs_data    = _ok(await synth_client.get_lp_probabilities(asset))
    await asyncio.sleep(1.0)
    lp_bounds_data   = _ok(await synth_client.get_lp_bounds(asset))
    await asyncio.sleep(1.0)
    liq_data         = _ok(await synth_client.get_liquidation(asset))
    has_synth = percentile_data is not None

    # Derive vol regime from SynthData volatility
    vol_regime = "stable"
    forecast_vol: Optional[float] = None
    realized_vol: Optional[float] = None
    if vol_data:
        # SynthData returns vol in percentage points (e.g. 56.4 = 56.4% annualised)
        # Divide by 100 for decimal form used in BSM / Kelly calculations
        _fv = vol_data.get("forecast_future", {}).get("average_volatility")
        _rv = vol_data.get("realized", {}).get("average_volatility")
        forecast_vol = _fv / 100.0 if _fv else None
        realized_vol = _rv / 100.0 if _rv else None
        if forecast_vol and realized_vol and realized_vol > 0:
            ratio = forecast_vol / realized_vol
            vol_regime = "expanding" if ratio > 1.5 else "compressing" if ratio < 0.7 else "stable"

    # ── 4. Fetch Polymarket markets — nearest settlement date only ──
    # SynthData gives 24h forecasts; we only compare against the single next
    # settlement (17:00 UTC today or tomorrow). Drop all multi-day markets.
    all_poly = await poly_client.get_all_active_markets()
    settle_dt = compute_poly_settlement_dt()
    settle_date = settle_dt.date()
    poly_markets = [
        m for m in all_poly
        if m.asset == asset
        and m.expiry is not None
        and m.expiry.date() == settle_date
    ]
    _poly_markets[asset] = poly_markets

    # Keep CLOB subscriptions up to date after each fetch
    token_ids = [
        m.clob_token_id
        for markets in _poly_markets.values()
        for m in markets
        if m.clob_token_id
    ]
    if token_ids:
        clob_ws.subscribe(token_ids)

    # ── 5. Build strike grid ──
    strike_grid = _build_strike_grid(spot)

    # ── 6. Build Derive probability curve ──
    derive_curve = build_derive_prob_curve(chain, spot, t_poly, strike_grid)
    primary_tte = get_primary_tte(chain, t_poly)

    # ── 7. Build Synth probability curve ──
    synth_curve = {}
    if has_synth and percentile_data:
        synth_curve = build_synth_prob_curve(percentile_data, spot, t_poly * 365.25 * 24, strike_grid)

    # Fallback: use derive curve if no synth
    if not synth_curve:
        synth_curve = derive_curve

    # ── 8. Build PDF curves for chart ──
    synth_pdf = {}
    if has_synth and percentile_data:
        synth_pdf = build_synth_pdf(percentile_data, spot, t_poly * 365.25 * 24, strike_grid)
    derive_pdf = build_derive_pdf(derive_curve)

    # ── 9. Run arb scanner ──
    signals = run_all_strategies(asset, synth_curve, derive_curve, poly_markets, spot, chain, t_poly)

    # ── 10. Build strike table ──
    strike_table = build_strike_table(
        asset, synth_curve, derive_curve, poly_markets, spot, signals,
        options=chain,
        primary_tte=primary_tte,
        t_poly=t_poly,
    )

    # ── 11. Format poly_points for UI ──
    poly_points = []
    for m in poly_markets:
        mid = (m.yes_bid + m.yes_ask) / 2 if m.yes_ask > 0 else m.yes_price
        poly_points.append({
            "strike": m.strike,
            "lower_bound": m.lower_bound,
            "upper_bound": m.upper_bound,
            "market_type": m.market_type,
            "is_above": m.is_above,
            "yes_price": mid,
            "yes_bid": m.yes_bid,
            "yes_ask": m.yes_ask,
            "question": m.question,
            "volume_24h": m.volume_24h,
            "clob_token_id": m.clob_token_id,
            "polymarket_url": m.polymarket_url,
            "expiry": m.expiry.isoformat() if m.expiry else None,
        })

    snapshot = {
        "asset": asset,
        "spot": spot,
        "last_updated": datetime.now(timezone.utc).isoformat(),
        "mode": "live" if has_synth else "partial",
        "derive_curve": {str(k): v for k, v in derive_curve.items()},
        "synth_curve": {str(k): v for k, v in synth_curve.items()},
        "synth_pdf": {str(k): v for k, v in synth_pdf.items()},
        "derive_pdf": {str(k): v for k, v in derive_pdf.items()},
        "poly_points": poly_points,
        "signals": [_signal_to_dict(s) for s in signals],
        "strike_table": strike_table,
        "vol_regime": vol_regime,
        "forecast_vol": round(forecast_vol, 4) if forecast_vol else None,
        "realized_vol": round(realized_vol, 4) if realized_vol else None,
        "synth_poly_edge": _extract_poly_edge(poly_signal_data),
        "synth_status": synth_client.get_status(),
    }

    # Persist signals to history (fire-and-forget; errors are non-fatal)
    try:
        await signal_tracker.save_signals(snapshot["signals"])
    except Exception as e:
        logger.debug("signal_tracker.save_signals error: %s", e)

    return snapshot


def _signal_to_dict(s: Signal) -> Dict:
    return {
        "strategy": s.strategy,
        "asset": s.asset,
        "strike": s.strike,
        "direction": s.direction,
        "edge_pct": s.edge_pct,
        "synth_prob": s.synth_prob,
        "derive_prob": s.derive_prob,
        "poly_prob": s.poly_prob,
        "reasoning": s.reasoning,
        "confidence": s.confidence,
        "poly_question": s.poly_question,
        "poly_url": s.poly_url,
        "poly_expiry": s.poly_expiry,
        "kelly_fraction": s.kelly_fraction,
        "delta": s.delta,
        "vega": s.vega,
    }


async def _get_snapshot(asset: str) -> Dict:
    """Return snapshot, using cache or computing fresh."""
    if MOCK_MODE:
        return _load_mock(asset)

    now = time.time()
    if asset in _snapshots and (now - _snapshot_ts.get(asset, 0)) < _snapshot_ttl:
        return _snapshots[asset]

    try:
        snapshot = await _fetch_live_snapshot(asset)
    except Exception as e:
        logger.error("Failed to fetch live snapshot for %s: %s", asset, e)
        snapshot = _load_mock(asset)
        snapshot["error"] = str(e)

    if "error" not in snapshot:
        _snapshots[asset] = snapshot
        _snapshot_ts[asset] = now

    return snapshot


# ── Background refresh ────────────────────────────────────────────────────────

async def _refresh_loop():
    global _refresh_running
    _refresh_running = True
    logger.info("Background refresh loop started")
    while True:
        await asyncio.sleep(60)
        if MOCK_MODE:
            continue
        for asset in ASSETS:
            try:
                snapshot = await _fetch_live_snapshot(asset)
                _snapshots[asset] = snapshot
                _snapshot_ts[asset] = time.time()
                logger.info("Refreshed snapshot for %s: %d signals", asset, len(snapshot.get("signals", [])))
            except Exception as e:
                logger.error("Refresh error for %s: %s", asset, e)

        # Update CLOB WS subscriptions from all known poly markets
        token_ids = [
            m.clob_token_id
            for markets in _poly_markets.values()
            for m in markets
            if m.clob_token_id
        ]
        if token_ids:
            clob_ws.subscribe(token_ids)

        # Check for settled Polymarket markets and update signal P&L
        try:
            await _check_settlements()
        except Exception as e:
            logger.debug("Settlement check error: %s", e)


@app.on_event("startup")
async def startup():
    if not MOCK_MODE:
        asyncio.create_task(_refresh_loop())
        asyncio.create_task(clob_ws.run())


@app.on_event("shutdown")
async def shutdown():
    await binance_client.close()
    await derive_client.close()
    await poly_client.close()
    await clob_ws.stop()
    await synth_client.close()


# ── Settlement checker ───────────────────────────────────────────────────────

async def _check_settlements() -> None:
    """Fetch Gamma API for closed markets that match unsettled tracked signals."""
    expired = await signal_tracker.get_unsettled_expiries()
    if not expired:
        return

    session = await poly_client._ensure_session()
    settlements = []
    for item in expired:
        url = item["poly_url"]
        if not url:
            continue
        # Extract slug from URL: .../event/<slug>
        slug = url.rstrip("/").split("/")[-1]
        try:
            api_url = f"https://gamma-api.polymarket.com/markets?slug={slug}&closed=true"
            async with session.get(api_url) as resp:
                if resp.status != 200:
                    continue
                data = await resp.json()
                markets = data if isinstance(data, list) else []
                for m in markets:
                    resolution = m.get("resolution") or m.get("outcome")
                    if resolution in ("YES", "1", 1):
                        settlements.append({"poly_url": url, "settlement_price": 1.0})
                    elif resolution in ("NO", "0", 0):
                        settlements.append({"poly_url": url, "settlement_price": 0.0})
        except Exception as e:
            logger.debug("Settlement fetch error for %s: %s", slug, e)

    if settlements:
        n = await signal_tracker.resolve_settlements(settlements)
        if n:
            logger.info("Resolved %d signal(s) from %d market settlement(s)", n, len(settlements))


# ── Vol surface helper ────────────────────────────────────────────────────────

def _build_vol_surface(chain, spot: float) -> List[Dict]:
    """Extract per-expiry IV smile from the Derive options chain."""
    from collections import defaultdict
    now_ts = datetime.now(timezone.utc).timestamp()

    by_expiry: Dict[Any, List] = defaultdict(list)
    for opt in chain:
        if opt.expiry.timestamp() > now_ts:
            by_expiry[opt.expiry].append(opt)

    surface = []
    for expiry in sorted(by_expiry.keys()):
        opts = by_expiry[expiry]
        tte_hours = (expiry.timestamp() - now_ts) / 3600.0

        call_ivs: Dict[float, float] = {}
        put_ivs: Dict[float, float] = {}
        for opt in opts:
            if opt.implied_volatility <= 0:
                continue
            iv = opt.implied_volatility / 100.0 if opt.implied_volatility > 5 else opt.implied_volatility
            if opt.option_type == "call":
                call_ivs[opt.strike] = iv
            else:
                put_ivs[opt.strike] = iv

        all_strikes = sorted(set(list(call_ivs) + list(put_ivs)))
        points = []
        for k in all_strikes:
            if not (0.75 <= k / spot <= 1.25):
                continue
            c_iv = call_ivs.get(k)
            p_iv = put_ivs.get(k)
            if c_iv is None and p_iv is None:
                continue
            points.append({
                "strike": k,
                "moneyness_pct": round((k / spot - 1) * 100, 1),
                "call_iv": round(c_iv, 4) if c_iv else None,
                "put_iv": round(p_iv, 4) if p_iv else None,
            })

        if points:
            surface.append({
                "expiry": expiry.isoformat(),
                "tte_hours": round(tte_hours, 1),
                "label": f"{expiry.strftime('%b %d')} ({tte_hours:.0f}h)",
                "strikes": points,
            })

    return surface


def _variance_interp_iv(points: List[tuple], t_target: float) -> Optional[float]:
    """Interpolate/extrapolate IV to t_target (years) via linear variance.
    points: sorted list of (tte_years, iv_decimal) pairs."""
    if not points:
        return None
    if t_target <= points[0][0]:
        return points[0][1]
    if t_target >= points[-1][0]:
        return points[-1][1]
    for i in range(len(points) - 1):
        t1, iv1 = points[i]
        t2, iv2 = points[i + 1]
        if t1 <= t_target <= t2:
            var1, var2 = iv1 ** 2 * t1, iv2 ** 2 * t2
            frac = (t_target - t1) / (t2 - t1)
            var_t = var1 + frac * (var2 - var1)
            return (var_t / t_target) ** 0.5 if var_t > 0 else iv1
    return points[-1][1]


def _derive_iv_at_strike_and_tte(
    derive_surface: List[Dict], moneyness_pct: float, t_poly_years: float
) -> Optional[float]:
    """Get Derive IV at a specific moneyness, variance-interpolated to t_poly_years.
    Linearly interpolates IV between adjacent strikes within each expiry,
    then interpolates across expiries using linear variance (σ²T)."""

    def _iv_at_mono(exp: Dict, mono: float) -> Optional[float]:
        strikes = sorted(exp["strikes"], key=lambda s: s["moneyness_pct"])
        if not strikes:
            return None
        below = [s for s in strikes if s["moneyness_pct"] <= mono]
        above = [s for s in strikes if s["moneyness_pct"] > mono]
        s1 = below[-1] if below else above[0]
        s2 = above[0] if above else below[-1]
        iv1 = (s1.get("call_iv") if mono >= 0 else s1.get("put_iv")) or s1.get("call_iv") or s1.get("put_iv")
        iv2 = (s2.get("call_iv") if mono >= 0 else s2.get("put_iv")) or s2.get("call_iv") or s2.get("put_iv")
        if iv1 is None:
            return iv2
        if iv2 is None or s1["moneyness_pct"] == s2["moneyness_pct"]:
            return iv1
        frac = (mono - s1["moneyness_pct"]) / (s2["moneyness_pct"] - s1["moneyness_pct"])
        return max(0.01, iv1 + frac * (iv2 - iv1))

    points = []
    for exp in sorted(derive_surface, key=lambda e: e["tte_hours"]):
        tte_years = exp["tte_hours"] / 8760.0
        iv = _iv_at_mono(exp, moneyness_pct)
        if iv and iv > 0:
            points.append((tte_years, iv))

    return _variance_interp_iv(points, t_poly_years)


def _bsm_digital_above(spot: float, strike: float, sigma: float, tte: float) -> Optional[float]:
    """BSM digital call price P(S_T > K) = N(d2), r=0 lognormal."""
    if sigma <= 0 or tte <= 0 or spot <= 0 or strike <= 0:
        return None
    try:
        from scipy.stats import norm
        d2 = (math.log(spot / strike) - 0.5 * sigma ** 2 * tte) / (sigma * math.sqrt(tte))
        return float(norm.cdf(d2))
    except Exception:
        return None


def _extract_poly_edge(poly_signal_data: Optional[Dict]) -> Optional[float]:
    """Extract edge magnitude from SynthData's polymarket/up-down/daily response."""
    if not poly_signal_data:
        return None
    try:
        synth_p = float(poly_signal_data.get("synth_probability_up", 0))
        poly_p  = float(poly_signal_data.get("polymarket_probability_up", 0))
        return round(abs(synth_p - poly_p), 4) if synth_p and poly_p else None
    except (TypeError, ValueError):
        return None


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    synth_status = synth_client.get_status()
    return {
        "status": "ok",
        "mock_mode": MOCK_MODE,
        "assets": ASSETS,
        "spot_source": "binance",
        "synth_enabled": synth_client.enabled,
        "synth_credits_remaining": synth_status["credits_remaining"],
        "synth_credits_used": synth_status["credits_used"],
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/api/snapshot/{asset}")
async def snapshot(asset: str):
    asset = asset.upper()
    if asset not in ASSETS:
        return JSONResponse({"error": f"Unknown asset: {asset}"}, status_code=400)
    data = await _get_snapshot(asset)
    return data


@app.get("/api/signals")
async def signals():
    all_signals = []
    for asset in ASSETS:
        snap = await _get_snapshot(asset)
        all_signals.extend(snap.get("signals", []))
    # Sort by edge desc
    all_signals.sort(key=lambda s: s.get("edge_pct", 0), reverse=True)
    return {"signals": all_signals, "count": len(all_signals)}


@app.get("/api/mock/{asset}")
async def mock_snapshot(asset: str):
    """Always returns mock data regardless of MOCK_MODE setting."""
    asset = asset.upper()
    if asset not in ASSETS:
        return JSONResponse({"error": f"Unknown asset: {asset}"}, status_code=400)
    return _load_mock(asset)


@app.get("/api/poly/live/{asset}")
async def poly_live(asset: str):
    """Return live CLOB bid/ask prices for all Polymarket tokens of the given asset."""
    asset = asset.upper()
    if asset not in ASSETS:
        return JSONResponse({"error": f"Unknown asset: {asset}"}, status_code=400)

    markets = _poly_markets.get(asset, [])
    prices: Dict[str, Any] = {}
    for m in markets:
        if not m.clob_token_id:
            continue
        result = clob_ws.get_price(m.clob_token_id)
        if result is not None:
            bid, ask = result
            prices[m.clob_token_id] = {
                "bid": round(bid, 4),
                "ask": round(ask, 4),
                "mid": round((bid + ask) / 2, 4),
            }

    return {
        "connected": clob_ws.is_connected(),
        "asset": asset,
        "prices": prices,
    }


@app.get("/api/signals/history")
async def signals_history(limit: int = 200):
    """Return recent signal history with settlement P&L."""
    rows = await signal_tracker.get_history(limit)
    return {"signals": rows, "count": len(rows)}


@app.get("/api/signals/pnl")
async def signals_pnl():
    """Return P&L summary across all tracked signals."""
    return await signal_tracker.get_pnl()


@app.get("/api/vol_surface/{asset}")
async def vol_surface_endpoint(asset: str):
    """Return per-expiry IV smile from Derive, SynthData term structure,
    and Polymarket-implied vol points — the three-way vol comparison."""
    asset = asset.upper()
    if asset not in ASSETS:
        return JSONResponse({"error": f"Unknown asset: {asset}"}, status_code=400)

    chain = await derive_client.get_options_chain(asset)
    spot_price = await binance_client.get_spot_price(asset)
    if not spot_price or spot_price <= 0:
        spot_price = derive_client.get_spot_from_chain(chain)

    derive_surface = _build_vol_surface(chain, spot_price) if chain and spot_price > 0 else []

    # SynthData: IQR-implied vol term structure + direct forecast vol
    synth_term: List[Dict] = []
    percentile_data = synth_client.get_cached_percentiles(asset)
    if percentile_data:
        for hours in [1, 2, 4, 6, 8, 12, 16, 20, 24]:
            iv = compute_synth_implied_vol(percentile_data, hours)
            if iv:
                synth_term.append({"hours_ahead": hours, "atm_iv": round(iv, 4)})

    # SynthData direct forecast vol (from /insights/volatility)
    synth_forecast_iv: Optional[float] = None
    cached_snap = _snapshots.get(asset, {})
    synth_forecast_iv = cached_snap.get("forecast_vol")  # already decimal

    # Time-to-expiry to next Poly settlement (17:00 UTC) — in years
    t_poly_years = compute_poly_settlement_tte()

    # Polymarket-implied vol: invert BSM digital prices
    poly_points_raw = cached_snap.get("poly_points") or [
        {**vars(m), "expiry": m.expiry.isoformat() if m.expiry else None}
        for m in _poly_markets.get(asset, [])
    ]
    poly_iv_pts = extract_poly_iv(poly_points_raw, spot_price) if spot_price > 0 else []

    # Build lookup for enriching poly IV points with metadata from raw poly points
    raw_lookup: Dict[tuple, Dict] = {}
    for rp in poly_points_raw:
        s = rp.get("strike") or ((rp.get("lower_bound", 0) or 0) + (rp.get("upper_bound", 0) or 0)) / 2
        key = (round(float(s), -1), rp.get("market_type", ""), str(rp.get("expiry", ""))[:16])
        raw_lookup[key] = rp

    # Enrich each poly IV point with:
    #   - metadata (question, url, volume, clob_token_id) from raw poly_points
    #   - derive_iv: variance-interpolated to T_poly at same moneyness
    #   - derive_binary: BSM N(d2) using derive_iv + T_poly for direct price comparison
    #   - iv_gap_pts: (poly_iv − derive_iv) × 100
    #   - action: trade implication from price comparison (BUY YES / BUY NO)
    poly_iv_list: List[Dict] = []
    for p in poly_iv_pts:
        key = (round(p.strike, -1), p.market_type, p.expiry[:16])
        raw = raw_lookup.get(key, {})

        # Derive IV at this strike's moneyness, variance-interpolated to T_poly
        d_iv = _derive_iv_at_strike_and_tte(derive_surface, p.moneyness_pct, t_poly_years)

        # BSM binary price comparison (above_below only — range is more complex)
        derive_binary: Optional[float] = None
        action: Optional[str] = None
        if d_iv and p.market_type == "above_below":
            is_above = raw.get("is_above", True)
            db = _bsm_digital_above(spot_price, p.strike, d_iv, t_poly_years)
            if db is not None:
                derive_binary = db if is_above else (1.0 - db)
                price_gap = p.yes_price - derive_binary
                if price_gap > 0.03:
                    action = "BUY NO"
                elif price_gap < -0.03:
                    action = "BUY YES"

        iv_gap_pts = round((p.poly_iv - d_iv) * 100, 1) if d_iv else None

        poly_iv_list.append({
            "strike": p.strike,
            "moneyness_pct": p.moneyness_pct,
            "poly_iv": p.poly_iv,
            "market_type": p.market_type,
            "yes_price": p.yes_price,
            "expiry": p.expiry,
            "question": raw.get("question", ""),
            "polymarket_url": raw.get("polymarket_url", ""),
            "volume_24h": raw.get("volume_24h"),
            "clob_token_id": raw.get("clob_token_id"),
            "derive_iv": round(d_iv, 4) if d_iv else None,
            "iv_gap_pts": iv_gap_pts,
            "derive_binary": round(derive_binary, 4) if derive_binary is not None else None,
            "action": action,
        })

    # ATM IVs for headline comparison
    atm_poly = atm_poly_iv(poly_points_raw, spot_price)

    # Derive ATM IV — variance-interpolated to T_poly (the TTE fix)
    atm_derive = _derive_iv_at_strike_and_tte(derive_surface, 0.0, t_poly_years)

    # SynthData ATM: prefer direct forecast, fall back to IQR at 8h
    atm_synth = synth_forecast_iv
    if not atm_synth and synth_term:
        entry_8h = next((s for s in synth_term if s["hours_ahead"] == 8), None)
        atm_synth = entry_8h["atm_iv"] if entry_8h else synth_term[0]["atm_iv"]

    # Divergence alerts: pairs that differ by ≥ 8 vol points at ATM
    alerts: List[Dict] = []
    _alert_pairs = [
        ("Polymarket", atm_poly, "Derive", atm_derive),
        ("Polymarket", atm_poly, "SynthData", atm_synth),
        ("Derive", atm_derive, "SynthData", atm_synth),
    ]
    for a_name, a_iv, b_name, b_iv in _alert_pairs:
        if a_iv and b_iv:
            gap_pts = abs(a_iv - b_iv) * 100
            if gap_pts >= 8.0:
                higher, lower = (a_name, b_name) if a_iv > b_iv else (b_name, a_name)
                alerts.append({
                    "source_a": a_name,
                    "iv_a": round(a_iv, 4),
                    "source_b": b_name,
                    "iv_b": round(b_iv, 4),
                    "gap_vol_pts": round(gap_pts, 1),
                    "severity": "HIGH" if gap_pts >= 15 else "MEDIUM",
                    "higher_source": higher,
                    "lower_source": lower,
                })

    return {
        "asset": asset,
        "spot": spot_price,
        "t_poly_hours": round(t_poly_years * 8760, 2),
        "derive_surface": derive_surface,
        "synth_term_structure": synth_term,
        "synth_forecast_iv": round(synth_forecast_iv, 4) if synth_forecast_iv else None,
        "poly_iv_points": poly_iv_list,
        "atm_ivs": {
            "derive": round(atm_derive, 4) if atm_derive else None,
            "synth": round(atm_synth, 4) if atm_synth else None,
            "poly": round(atm_poly, 4) if atm_poly else None,
        },
        "divergence_alerts": alerts,
    }


@app.get("/api/risk/{asset}")
async def risk_data(asset: str):
    """Return full SynthData risk dataset for an asset.
    Used by the position sizer for leverage optimisation and CONVICTION scoring.
    All data is served from the client's in-process cache — no extra credits consumed
    if /api/snapshot was fetched recently."""
    asset = asset.upper()
    if asset not in ASSETS:
        return JSONResponse({"error": f"Unknown asset: {asset}"}, status_code=400)

    if MOCK_MODE:
        return _mock_risk_data(asset)

    # Fetch from client — each call returns cached data if within TTL
    vol_data, lp_probs, lp_bounds, liq_data, poly_signal = await asyncio.gather(
        synth_client.get_volatility(asset),
        synth_client.get_lp_probabilities(asset),
        synth_client.get_lp_bounds(asset),
        synth_client.get_liquidation(asset),
        synth_client.get_polymarket_signal(asset),
        return_exceptions=True,
    )
    def _ok(v):
        return v if v is not None and not isinstance(v, Exception) else None

    vol_data    = _ok(vol_data)
    lp_probs    = _ok(lp_probs)
    lp_bounds   = _ok(lp_bounds)
    liq_data    = _ok(liq_data)
    poly_signal = _ok(poly_signal)

    forecast_vol: Optional[float] = None
    realized_vol: Optional[float] = None
    vol_regime = "stable"
    if vol_data:
        # SynthData returns vol in percentage points (e.g. 56.4 = 56.4% annualised)
        # Divide by 100 for decimal form used in BSM / Kelly calculations
        _fv = vol_data.get("forecast_future", {}).get("average_volatility")
        _rv = vol_data.get("realized", {}).get("average_volatility")
        forecast_vol = _fv / 100.0 if _fv else None
        realized_vol = _rv / 100.0 if _rv else None
        if forecast_vol and realized_vol and realized_vol > 0:
            ratio = forecast_vol / realized_vol
            vol_regime = "expanding" if ratio > 1.5 else "compressing" if ratio < 0.7 else "stable"

    return {
        "asset": asset,
        "vol_regime": vol_regime,
        "forecast_vol": round(forecast_vol, 4) if forecast_vol else None,
        "realized_vol": round(realized_vol, 4) if realized_vol else None,
        "lp_bounds": lp_bounds.get("data") if lp_bounds else None,
        "lp_probabilities": lp_probs.get("data") if lp_probs else None,
        "liquidation_table": liq_data.get("data") if liq_data else None,
        "synth_poly_signal": poly_signal,
        "synth_poly_edge": _extract_poly_edge(poly_signal),
        "credits_remaining": synth_client.credits_remaining(),
    }


def _mock_risk_data(asset: str) -> Dict:
    """Realistic mock risk data for demo mode."""
    spot = 95_200 if asset == "BTC" else 3_420
    return {
        "asset": asset,
        "vol_regime": "expanding",
        "forecast_vol": 0.68,
        "realized_vol": 0.52,
        "lp_bounds": [
            {"interval": {"full_width": "2.0%", "lower_bound": round(spot * 0.99), "upper_bound": round(spot * 1.01)},
             "probability_to_stay_in_interval": {"24": 0.32}, "expected_time_in_interval": 7.7, "expected_impermanent_loss": 0.0041},
            {"interval": {"full_width": "4.0%", "lower_bound": round(spot * 0.98), "upper_bound": round(spot * 1.02)},
             "probability_to_stay_in_interval": {"24": 0.54}, "expected_time_in_interval": 13.0, "expected_impermanent_loss": 0.0082},
            {"interval": {"full_width": "6.0%", "lower_bound": round(spot * 0.97), "upper_bound": round(spot * 1.03)},
             "probability_to_stay_in_interval": {"24": 0.71}, "expected_time_in_interval": 17.1, "expected_impermanent_loss": 0.0124},
        ],
        "liquidation_table": [
            {"price_change": 0.02, "long_liquidation_probability": {"24": 0.48}, "short_liquidation_probability": {"24": 0.42}},
            {"price_change": 0.05, "long_liquidation_probability": {"24": 0.22}, "short_liquidation_probability": {"24": 0.18}},
            {"price_change": 0.10, "long_liquidation_probability": {"24": 0.07}, "short_liquidation_probability": {"24": 0.06}},
            {"price_change": 0.14, "long_liquidation_probability": {"24": 0.03}, "short_liquidation_probability": {"24": 0.02}},
            {"price_change": 0.20, "long_liquidation_probability": {"24": 0.01}, "short_liquidation_probability": {"24": 0.009}},
        ],
        "synth_poly_signal": {
            "synth_probability_up": 0.54,
            "polymarket_probability_up": 0.38,
            "synth_outcome": "UP",
            "polymarket_outcome": "DOWN",
        },
        "synth_poly_edge": 0.16,
        "credits_remaining": 18983,
    }


@app.get("/api/stream")
async def stream(request: Request):
    """SSE endpoint: pushes snapshot summaries every 30 seconds."""
    async def event_generator():
        while True:
            if await request.is_disconnected():
                break
            summaries = []
            for asset in ASSETS:
                snap = await _get_snapshot(asset)
                summaries.append({
                    "asset": asset,
                    "spot": snap.get("spot", 0),
                    "signals_count": len(snap.get("signals", [])),
                    "mode": snap.get("mode", "demo"),
                    "last_updated": snap.get("last_updated", ""),
                })
            data = json.dumps(summaries)
            yield f"data: {data}\n\n"
            await asyncio.sleep(30)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
