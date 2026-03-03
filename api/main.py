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
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

# Engine
from engine.prob_calc import (
    build_derive_prob_curve,
    compute_poly_settlement_tte,
)
from engine.synth_mapper import build_synth_prob_curve, build_synth_pdf, build_derive_pdf
from engine.arb_scanner import run_all_strategies, build_strike_table, Signal

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

    # ── 4. Fetch Polymarket markets ──
    all_poly = await poly_client.get_all_active_markets()
    poly_markets = [m for m in all_poly if m.asset == asset]
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
    strike_table = build_strike_table(asset, synth_curve, derive_curve, poly_markets, spot, signals)

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
        })

    return {
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
