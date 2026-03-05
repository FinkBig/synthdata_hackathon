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

    # ── 3. Fetch SynthData percentiles ──
    percentile_data = await synth_client.get_prediction_percentiles(asset)
    has_synth = percentile_data is not None

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


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "mock_mode": MOCK_MODE,
        "assets": ASSETS,
        "spot_source": "binance",
        "synth_enabled": synth_client.enabled,
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
    """Return per-expiry IV smile from Derive + SynthData ATM implied vol term structure."""
    asset = asset.upper()
    if asset not in ASSETS:
        return JSONResponse({"error": f"Unknown asset: {asset}"}, status_code=400)

    chain = await derive_client.get_options_chain(asset)
    spot_price = await binance_client.get_spot_price(asset)
    if not spot_price or spot_price <= 0:
        spot_price = derive_client.get_spot_from_chain(chain)

    derive_surface = _build_vol_surface(chain, spot_price) if chain and spot_price > 0 else []

    # SynthData implied vol at key horizons (uses 30-min cached data)
    synth_term: List[Dict] = []
    percentile_data = synth_client.get_cached_percentiles(asset)
    if percentile_data:
        for hours in [1, 2, 4, 6, 8, 12, 16, 20, 24]:
            iv = compute_synth_implied_vol(percentile_data, hours)
            if iv:
                synth_term.append({"hours_ahead": hours, "atm_iv": round(iv, 4)})

    return {
        "asset": asset,
        "spot": spot_price,
        "derive_surface": derive_surface,
        "synth_term_structure": synth_term,
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
