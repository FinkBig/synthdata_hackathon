# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Backend
```bash
# Install dependencies
pip install -r requirements.txt

# Run in demo mode (no API keys needed)
MOCK_MODE=1 python run.py          # serves on :8000

# Run in live mode
SYNTHDATA_API_KEY=your_key python run.py
```

### Frontend
```bash
cd ui
npm install
npm run dev      # dev server on :5173
npm run build    # tsc + vite build
```

The frontend proxies `/api/*` and `/health` to `localhost:8000` via Vite's `server.proxy`.

### Environment
Copy `.env.example` to `.env` — `python-dotenv` loads it automatically. Only `SYNTHDATA_API_KEY` is required for live mode; Binance, Derive, and Polymarket are all public APIs.

## Architecture

### Data Flow
```
Binance (spot) ──┐
Derive (options) ─┼──▶ _fetch_live_snapshot() ──▶ arb_scanner ──▶ /api/snapshot/{asset}
SynthData (CDF) ─┤
Polymarket ───────┘
                      polymarket_clob (WS) ──▶ /api/poly/live/{asset}
```

`api/main.py` caches snapshots for 60 seconds and refreshes them in a background loop. In `MOCK_MODE=1` it skips all live fetches and serves `data/mock/{btc,eth}_snapshot.json`.

### Engine Layer (`engine/`)

**`prob_calc.py`** — Builds the Derive `P(S_T > K)` curve using Discrete Vertical Mapping (DVM), not Breeden-Litzenberger. Key exports:
- `build_derive_prob_curve(options, spot, t_poly, strike_grid)` — the main DVM curve builder
- `compute_poly_settlement_tte()` — TTE in years to the next Polymarket 17:00 UTC settlement
- `derive_binary_for_strike()` — BSM N(d2) binary price for a single strike (used in strike table)
- `range_probability()` — DVM for range markets (The Pin strategy)

DVM boundary condition: the outermost call/put uses BSM N(d2) anchored at ATM IV; all inner strikes are computed by finite-differencing adjacent mid prices.

**`synth_mapper.py`** — Reconstructs `P(S_T > K)` from SynthData percentile data. Uses `PchipInterpolator` (monotone cubic spline) on the 9 quantile-price pairs. Extrapolation is disabled; prices outside the 0.5th–99.5th percentile bounds are clamped.

**`arb_scanner.py`** — Runs three strategies against the three probability curves:
1. `scan_short_vol`: `synth < derive < poly` → Poly overpriced → BUY POLY NO
2. `scan_skew_arb`: OTM puts where `derive_below >> poly_below` → SELL PUT SPREAD
3. `scan_the_pin`: Range market where `derive_range > poly_range` → BUY POLY YES

`EDGE_THRESHOLD = 3%`, `MAX_STRIKE_DISTANCE = 20%`. Signals are deduplicated by `(strategy, strike)`.

### Clients (`clients/`)
All clients are standalone with no cross-dependencies. Each uses `aiohttp` for async HTTP.
- `binance.py` — spot price via public REST
- `derive.py` — full options chain from Lyra Finance public API
- `polymarket.py` — Gamma REST API: market discovery, question parsing, strike/expiry extraction
- `polymarket_clob.py` — CLOB WebSocket with batching (50 token IDs/subscription) and exponential backoff reconnect
- `synthdata.py` — `/prediction-percentiles` with 402 rate-limit handling and backoff

### UI (`ui/src/`)
- `App.tsx` — Asset tabs (BTC/ETH), polls `/api/snapshot/{asset}` every 60s, `/api/poly/live/{asset}` every 5s
- `Dashboard.tsx` — Assembles the three sections: chart, signal cards, strike table
- `ProbChart.tsx` — Three overlaid curves (Recharts `LineChart`); live Poly CLOB mid prices shown as dots; pulsing green dot in legend when WS is connected
- `SignalCard.tsx` — Per-signal display with confidence badge (HIGH/MEDIUM/LOW at 10%/6%/3%)
- `StrikeTable.tsx` — Per-strike comparison; rows with `edge >= 3%` are highlighted yellow

### Key Constants
- `config.py` — `EDGE_THRESHOLD_PCT = 0.03`, `ASSETS = ["BTC", "ETH"]`, all base URLs
- `arb_scanner.py` — `EDGE_THRESHOLD = 0.03`, `MAX_STRIKE_DISTANCE = 0.20`
- `api/main.py` — `_snapshot_ttl = 60` seconds, background refresh every 60s, SSE every 30s

### Snapshot Response Shape
```json
{
  "asset": "BTC", "spot": 69453.29, "mode": "live|partial|demo",
  "derive_curve":  {"68000": 0.71, ...},
  "synth_curve":   {"68000": 0.68, ...},
  "synth_pdf":     {"68000": 0.0003, ...},
  "derive_pdf":    {"68000": 0.0004, ...},
  "poly_points":   [{"strike": 70000, "yes_price": 0.38, "clob_token_id": "...", ...}],
  "signals":       [{"strategy": "short_vol", "edge_pct": 0.11, ...}],
  "strike_table":  [{"strike": 69000, "synth_prob": 0.50, "derive_binary": 0.48, ...}]
}
```
`mode` is `"live"` when SynthData key is present, `"partial"` when only Binance+Derive work, `"demo"` in MOCK_MODE.
