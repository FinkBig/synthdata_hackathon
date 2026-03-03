# Synth-Vol Triangulator

**Three-way BTC/ETH volatility arbitrage dashboard** — triangulates real-time probability estimates from three independent sources to surface 0DTE/24h mispricing signals.

```
SynthData AI  ──┐
                ├──▶  DVM Triangulator  ──▶  Arb Signals  ──▶  React Dashboard
Derive Options ─┤
                │
Polymarket ─────┘  (live CLOB bid/ask via WebSocket)
```

Built for the [SynthData AI](https://synthdata.co) hackathon.

---

## What it does

The three probability sources each model P(S_T > K) independently. When they disagree by more than 3%, that's a tradeable edge:

| Source | Method | Latency |
|---|---|---|
| **SynthData AI** | Monotone cubic spline on 9 percentile-price pairs from `/prediction-percentiles` | Per-request |
| **Derive / Lyra Finance** | Discrete Vertical Mapping on the live options chain | Per-request |
| **Polymarket** | Binary prediction market mid prices (live CLOB WebSocket) | 5s refresh |

---

## Quickstart

### Demo mode — no API keys needed

```bash
# Backend (port 8000)
MOCK_MODE=1 python run.py

# Frontend (port 5173, separate terminal)
cd ui && npm install && npm run dev
```

Open **http://localhost:5173** — pre-computed BTC short-vol and ETH skew-arb scenarios with signal cards.

### Live mode

Only one key is needed — Binance and Polymarket are fully public APIs.

```bash
export SYNTHDATA_API_KEY=your_key_here

python run.py          # backend :8000
cd ui && npm run dev   # frontend :5173
```

On startup the backend will log:
```
CLOB WS: connected
CLOB WS: subscribed to N token IDs
Binance BTC spot: 69,xxx
Derive BTC: 208 options fetched
Found N crypto price markets from Polymarket
```

---

## Architecture

```
hackathon/
├── config.py                    # Standalone constants, no parent deps
├── run.py                       # Uvicorn entry point
├── requirements.txt
│
├── clients/
│   ├── binance.py               # Spot price (BTCUSDT / ETHUSDT)
│   ├── derive.py                # Lyra Finance options chain (all expiries)
│   ├── polymarket.py            # Gamma REST API — market discovery & parsing
│   ├── polymarket_clob.py       # CLOB WebSocket — live bid/ask prices
│   └── synthdata.py             # /prediction-percentiles (289 steps × 9 quantiles)
│
├── engine/
│   ├── prob_calc.py             # Discrete Vertical Mapping (DVM) + variance interp
│   ├── synth_mapper.py          # Percentile CDF → P(S>K) via PchipInterpolator
│   └── arb_scanner.py           # Three strategies: short_vol, skew_arb, the_pin
│
├── api/
│   └── main.py                  # FastAPI: snapshot, signals, SSE, poly live
│
├── ui/
│   └── src/
│       ├── App.tsx              # Asset tabs, 60s snapshot poll, 5s CLOB poll
│       └── components/
│           ├── Dashboard.tsx    # Stats, legend (● LIVE), chart, signals, table
│           ├── ProbChart.tsx    # Three overlaid curves + live Poly dots
│           ├── SignalCard.tsx   # Signal display with confidence badge
│           └── StrikeTable.tsx  # Per-strike comparison table
│
└── data/mock/
    ├── btc_snapshot.json        # BTC $95,200 short-vol scenario
    └── eth_snapshot.json        # ETH $3,420 skew-arb scenario
```

---

## Core Math

### Discrete Vertical Mapping (DVM)

Breeden-Litzenberger requires a **continuous, smooth options surface**. For 0DTE/24h expiries:
- Strike spacing is wide relative to remaining variance
- Wide bid-ask spreads make the second derivative of call prices extremely noisy
- BL produces negative or nonsensical probabilities at many strikes

**DVM** uses adjacent call (or put) spreads directly — the exact finite-difference analogue of BL, but numerically stable for sparse chains:

```
For calls above spot:
  P(K₁ < S_T < K₂) = (C(K₁).mid − C(K₂).mid) / (K₂ − K₁)

For puts below spot:
  P(K₁ < S_T < K₂) = (P(K₂).mid − P(K₁).mid) / (K₂ − K₁)
```

The full `P(S > K)` curve is built by summing range probabilities from the outer strikes inward, anchored at `P(S > spot) ≈ 0.5`.

### Variance Interpolation (Expiry Gap Adjustment)

Derive options expire at **08:00 UTC**; Polymarket settles at **17:00 UTC**. Raw 08:00 option prices underestimate the variance for a 17:00 comparison. We interpolate **total variance** (not raw IV) across two bracket expiries:

```
σ²_poly × T_poly = σ²_1 × T_1 + frac × (σ²_2 × T_2 − σ²_1 × T_1)

where frac = (T_poly − T_1) / (T_2 − T_1)
```

This correctly scales the DVM probabilities to the Polymarket settlement time, rather than naively using the nearest expiry.

### SynthData Percentile Reconstruction

`/prediction-percentiles` returns **289 time steps** (5-min intervals over 24h), each with **9 quantile-price pairs**:

```json
{"0.005": 84200, "0.05": 85100, "0.2": 86400, ..., "0.995": 98500}
```

This is a discrete inverse CDF: `Q(p) = price`, so `P(S < price) = p`.

Algorithm:
1. Select the time step closest to the Polymarket settlement horizon
2. Extract the 9 `(probability, price)` pairs
3. Fit a **monotone cubic spline** (`PchipInterpolator`) — no overshoot, well-behaved between nodes
4. Evaluate `P(S < K)` at each strike in the grid; return `P(S > K) = 1 − P(S < K)`
5. Clamp extrapolation at the 0.5th and 99.5th percentile boundaries (cubic extrapolation inverts outside the data range)

---

## Three Arbitrage Strategies

### Strategy 1 — Short Vol

```
Condition: synth_prob < derive_prob < poly_prob
           AND (poly_prob − synth_prob) > 3%

Action:    SELL POLY YES / SELL CALL SPREAD
```

Both AI and options price the event lower than Polymarket. Polymarket is overpriced. Sell the Poly YES binary and hedge with a short call spread on Derive.

### Strategy 2 — Skew Arb

```
Condition: OTM put (strike < spot × 0.97)
           derive_prob_below > poly_prob_below
           AND (derive_prob_below − poly_prob_below) > 3%

Action:    SELL PUT SPREAD / BUY POLY NO
```

The options market prices more downside risk (negative skew) than the prediction market. Sell the over-priced put spread or buy the cheap Poly NO.

### Strategy 3 — The Pin

```
Condition: Range market [K₁, K₂] where spot is inside or near the range
           derive_range_prob > poly_range_prob
           AND (derive_range_prob − poly_range_prob) > 3%

Action:    BUY POLY YES (range)
```

Options pricing (via a call or put spread spanning the range) implies higher probability of the price finishing inside the range than Polymarket prices. Buy the cheap Poly range YES.

All three strategies use a configurable `EDGE_THRESHOLD = 3%` and skip markets with strikes more than 20% from spot (near-certain outcomes are not real arbitrage).

---

## Live CLOB WebSocket

Polymarket's Gamma REST API refreshes every 60s. The CLOB WebSocket gives live bid/ask at sub-second latency.

```
URL:  wss://ws-subscriptions-clob.polymarket.com/ws/market

Subscribe:
  {"type": "market", "assets_ids": ["token_id_1", ...], "custom_feature_enabled": true}

Events:
  book         — full order book snapshot on subscribe (bids[] / asks[])
  price_change — incremental update, carries best_bid/best_ask directly
  best_bid_ask — fired on any spread change (custom_feature_enabled=true)
```

The client (`clients/polymarket_clob.py`) subscribes in batches of 50 token IDs and reconnects with exponential backoff (5s → 10s → 20s → 60s max). The frontend polls `/api/poly/live/{asset}` every 5s and overlays the live mid prices on the probability chart. A pulsing green **●** in the Polymarket legend indicates the WebSocket is live.

---

## API Reference

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Status, mode, `synth_enabled` flag |
| `GET` | `/api/snapshot/{asset}` | Full triangulation snapshot (BTC or ETH) |
| `GET` | `/api/signals` | All active signals, sorted by edge descending |
| `GET` | `/api/mock/{asset}` | Demo snapshot — always works, no keys needed |
| `GET` | `/api/poly/live/{asset}` | Live CLOB prices `{token_id: {bid, ask, mid}}` |
| `GET` | `/api/stream` | SSE: 30s push of spot + signal count |

### Snapshot response shape

```json
{
  "asset": "BTC",
  "spot": 69453.29,
  "mode": "live",
  "derive_curve":  {"68000": 0.71, "69000": 0.53, ...},
  "synth_curve":   {"68000": 0.68, "69000": 0.50, ...},
  "poly_points":   [{"strike": 70000, "yes_price": 0.38, "clob_token_id": "...", ...}],
  "signals":       [{"strategy": "short_vol", "edge_pct": 0.11, ...}],
  "strike_table":  [{"strike": 69000, "synth_prob": 0.50, "derive_prob": 0.53, ...}]
}
```

---

## Data Sources

| Source | Endpoint | Auth |
|---|---|---|
| **Binance** | `GET /api/v3/ticker/price` | None (public) |
| **Derive / Lyra Finance** | `public/get_instruments` + `public/get_ticker` | None (public) |
| **Polymarket Gamma API** | `GET /markets?volume_num_min=50` | None (public) |
| **Polymarket CLOB WS** | `wss://ws-subscriptions-clob.polymarket.com/ws/market` | None (public) |
| **SynthData AI** | `POST /prediction-percentiles` | `SYNTHDATA_API_KEY` |

---

## Requirements

**Python 3.10+**

```
fastapi>=0.111.0
uvicorn[standard]>=0.29.0
aiohttp>=3.9.0
numpy>=1.26.0
scipy>=1.13.0
python-dotenv>=1.0.0
```

**Node 18+**

```
react 18, recharts 2, tailwindcss 3, vite 5, typescript 5
```

Install everything:

```bash
pip install -r requirements.txt
cd ui && npm install
```

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `SYNTHDATA_API_KEY` | — | Required for live AI curve (get one at synthdata.co) |
| `MOCK_MODE` | `0` | Set to `1` to serve pre-computed demo data |

The backend logs clearly indicate which mode is active:
```
Mode: LIVE (real API data)     ← all three sources
Mode: PARTIAL                  ← Binance + Derive working, no SynthData key
Mode: DEMO                     ← MOCK_MODE=1
```

---

## UI Overview

The dashboard has three main sections:

**Probability Curves Chart** — three overlaid curves showing `P(S_T > K)` at the Polymarket 17:00 UTC settlement horizon:
- Blue line — SynthData AI (PchipInterpolator on percentile data)
- Orange line — Derive DVM (call/put spreads)
- Green dots — Polymarket (live CLOB mid when WebSocket is connected, snapshot otherwise)

**Arbitrage Signal Cards** — one card per detected signal, showing strategy type, strike, edge %, all three probability estimates, and a confidence badge (HIGH / MEDIUM / LOW based on edge size).

**Strike-by-Strike Table** — every strike in the grid with all three probabilities side by side, edge highlighted in yellow for actionable rows.

---

## Project Structure Notes

- `config.py` has no parent dependencies — safe to import anywhere
- All `clients/` are standalone and can be used independently
- `engine/prob_calc.py` exports `build_derive_prob_curve` and `compute_poly_settlement_tte` — the two functions everything else depends on
- The frontend proxies `/api/*` to `localhost:8000` via Vite's `server.proxy` config
