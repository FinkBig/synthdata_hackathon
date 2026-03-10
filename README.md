# Synth-Vol Triangulator

**Three-way implied volatility comparison across SynthData AI, Derive options, and Polymarket prediction markets — with live arbitrage signal detection.**

Built for the [SynthData Predictive Intelligence Hackathon](https://synthdata.co/hackathon) — targeting Best Options Tool and Best Prediction Markets Tool categories.

```
SynthData AI  ──┐
                ├──▶  Three-Way IV Engine  ──▶  Arb Signals  ──▶  React Dashboard
Derive Options ─┤
Polymarket ─────┘  (live CLOB WebSocket + REST order book depth)
```

---

## The Novel Contribution

**Polymarket → Implied Volatility** has not been done before.

Polymarket YES prices are digital option prices: `P(S_T > K)` for above/below markets, `P(K_lo < S_T < K_hi)` for range markets. By inverting the Black-Scholes digital option formula, we extract the crowd's *implied volatility* at each strike via `scipy.optimize.brentq`. This makes Polymarket prices directly comparable to options market IVs — on the same axis, in the same units.

When three independent markets (AI forecast + options + prediction market) price the same event differently, the divergence is a tradeable edge.

---

## What It Does

### Three probability sources

| Source | What it represents | How we extract IV |
|---|---|---|
| **SynthData** | AI probabilistic price forecast | IQR-implied vol from `/prediction-percentiles` percentile CDF |
| **Derive (Lyra Finance)** | Options market consensus | IV smile from full options chain, variance-interpolated to Poly TTE |
| **Polymarket** | Crowd-priced binary predictions | BSM inversion — convert YES/NO prices to implied vol via `brentq` |

### Four views

**Dashboard** — Core arb scanner:
- Probability curves: SynthData AI (white) vs Derive DVM (orange) vs Polymarket CLOB (blue), live-updated via WebSocket
- Arbitrage signal cards: confidence badge (HIGH ≥10% / MEDIUM ≥6% / LOW ≥3%), Kelly fraction, BSM delta, vega
- Strike-by-strike comparison table (highlighted rows = actionable edge ≥ 3%)
- Full Polymarket markets panel: question title, strike/range, TTE, YES/NO bid/ask spread, 24h volume

**Vol Surface** — IV comparison across expiries:
- *Visualizations tab*: ATM IV cards for all three sources + divergence alerts + IV smile chart (Poly IV dots overlaid on Derive lines) + term structure + skew snapshot. Expiry toggles isolate individual Derive expiries.
- *Markets tab*: per-market table split into Above/Below vs Range sub-views, sortable by IV gap, volume, moneyness. Click any row → live order book depth panel (top-10 bid/ask levels via py-clob-client REST).

**Options Chain** — Multi-expiry Derive bid/ask vs AI vs Polymarket:
- Real bid/ask prices (not mids) for every Derive strike across all expiries
- Correctly matched to the corresponding Polymarket settlement: for Derive expiry date D, Poly settlement = **(D−1) at 17:00 UTC** (Derive expires 08:00 UTC, Poly settles the evening before)
- Per-strike: Call/Put bid|ask|IV · SynthData P(S>K) · Derive BSM N(d2) · Polymarket YES price · Edge
- BUY YES / BUY NO action labels, highlighted rows when |edge| ≥ 4%

**Signal History** — SQLite-backed signal log with settlement tracking and P&L by strategy.

---

## Quickstart

```bash
# 1. Clone
git clone https://github.com/FinkBig/synthdata_hackathon
cd synthdata_hackathon

# 2. Backend dependencies
pip install -r requirements.txt

# 3. Add your SynthData key
cp .env.example .env
# Edit .env: SYNTHDATA_API_KEY=your_key

# 4. Start backend  →  http://localhost:8000
python run.py

# 5. Start frontend  →  http://localhost:5173  (separate terminal)
cd ui && npm install && npm run dev

# Demo mode — no API keys needed
MOCK_MODE=1 python run.py
```

Only `SYNTHDATA_API_KEY` is required. Binance, Derive, and Polymarket are all public APIs.

---

## Architecture

```
Binance REST ──────────────────────────────────────────────────┐
Derive REST (Lyra Finance) ────────────────────────────────────┤
SynthData API (6 endpoints) ───────────────────────────────────┼──▶ _fetch_live_snapshot()
Polymarket Gamma REST (settlement window query) ───────────────┤         │
Polymarket CLOB WebSocket (live bid/ask streaming) ────────────┘         ▼
py-clob-client REST (order book depth) ──────────────────────────▶  FastAPI endpoints
```

### Engine (`engine/`)

**Discrete Vertical Mapping (DVM)** — not Breeden-Litzenberger:

```
P(K₁ < S_T < K₂) = (C(K₁).mid − C(K₂).mid) / (K₂ − K₁)
```

BL requires a dense, smooth surface. 0DTE chains are too sparse — DVM finite-differencing between adjacent mid prices is more robust and produces no negative probabilities.

**Variance interpolation for TTE alignment** — Derive expires 08:00 UTC, Poly settles 17:00 UTC. We compute σ at exactly T_poly:

```
σ²(T_poly) × T_poly = σ²(T₁)×T₁ + frac × (σ²(T₂)×T₂ − σ²(T₁)×T₁)
```

**SynthData percentile reconstruction** — `/prediction-percentiles` returns 9 quantile-price pairs at 289 time steps. We select the step matching T_poly, fit a `PchipInterpolator` (monotone cubic spline), and evaluate P(S>K) across the strike grid. IQR-implied vol:

```
σ_synth = log(Q75/Q25) / (2 × 0.6745 × √T)
```

**BSM digital inversion** for Poly IV (`engine/poly_iv.py`):
- Above/below: solve `N(d2) = YES_price` for σ via `brentq`
- Range: solve `N(d2_lo) − N(d2_hi) = YES_price` for σ via `brentq`

**Three arbitrage strategies** (`engine/arb_scanner.py`):

| Strategy | Condition | Action |
|---|---|---|
| **Short Vol** | `synth < derive < poly` AND edge > 3% | BUY POLY NO |
| **Skew Arb** | OTM put: `derive_below >> poly_below` AND edge > 3% | SELL PUT SPREAD |
| **The Pin** | Range market: `derive_range > poly_range` AND edge > 3% | BUY POLY YES |

Kelly fraction, BSM delta, and vega computed per signal.

### Clients (`clients/`)

| Client | Source | Notes |
|---|---|---|
| `binance.py` | Binance public REST | Spot price |
| `derive.py` | Lyra Finance public API | Full options chain, per-expiry batch fetch with bid/ask |
| `polymarket.py` | Gamma REST API | Settlement window query (±1h around 17:00 UTC) — guarantees all daily strikes, not just high-volume ones |
| `polymarket_clob.py` | Polymarket CLOB WebSocket | Batched subscriptions (50 token IDs/batch), exponential backoff reconnect |
| `poly_clob_rest.py` | py-clob-client SDK | Order book depth (top-10 levels), batch midpoints — read-only, no auth |
| `synthdata.py` | SynthData API | All 6 endpoints with 10min–2h TTL cache; serialised calls (1s gap) to avoid burst 429s |

### SynthData API Usage

All six endpoints are used:

| Endpoint | Used for | Cache TTL |
|---|---|---|
| `/prediction-percentiles` | Synth probability curve, IQR-implied vol | 10 min |
| `/insights/volatility` | Forecast vol, realized vol, vol regime (expanding / compressing / stable) | 30 min |
| `/insights/lp-bounds` | Risk layer | 2 h |
| `/insights/lp-probabilities` | Direct P(S>K) probabilities | 60 min |
| `/insights/liquidation` | Leverage safety table | 2 h |
| `/insights/polymarket/up-down/daily` | SynthData vs Polymarket up/down edge | 10 min |

### API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Status, mode, SynthData credits remaining |
| `GET` | `/api/snapshot/{asset}` | Full triangulation snapshot (BTC or ETH) |
| `GET` | `/api/vol_surface/{asset}` | Per-expiry IV smile + Poly IV points + divergence alerts |
| `GET` | `/api/options_chain/{asset}` | Multi-expiry Derive bid/ask + SynthData + matched Poly markets |
| `GET` | `/api/signals` | All active signals sorted by edge |
| `GET` | `/api/signals/history` | Historical signals with P&L |
| `GET` | `/api/signals/pnl` | P&L summary by strategy |
| `GET` | `/api/risk/{asset}` | Full SynthData risk dataset (vol regime, lp-bounds, liq table) |
| `GET` | `/api/poly/live/{asset}` | Live CLOB prices `{token_id: {bid, ask, mid}}` |
| `GET` | `/api/poly/orderbook/{token_id}` | Full order book depth via py-clob-client REST |
| `GET` | `/api/poly/midpoints/{asset}` | Batch REST midpoints for all asset tokens |
| `GET` | `/api/mock/{asset}` | Demo snapshot — always works, no keys needed |
| `GET` | `/api/stream` | SSE: 30s push of spot + signal count |

---

## Stack

| Layer | Tech |
|---|---|
| Backend | Python 3.12, FastAPI, uvicorn, aiohttp |
| Math | scipy (BSM inversion, `norm.cdf`, `brentq`), numpy, `scipy.interpolate.PchipInterpolator` |
| Poly SDK | py-clob-client (read-only order book depth, batch midpoints) |
| Frontend | React 18, TypeScript, Vite, Tailwind CSS, Recharts |
| Storage | SQLite via `engine/signal_tracker.py` (signal history + P&L settlement) |
| Data sources | SynthData API · Derive/Lyra Finance · Polymarket Gamma + CLOB · Binance |

---

## Repository Structure

```
api/
  main.py              FastAPI app — all endpoints, snapshot cache, background refresh loop
clients/
  binance.py           Binance spot price
  derive.py            Derive/Lyra options chain (full bid/ask per strike)
  polymarket.py        Polymarket Gamma REST (market discovery, settlement window query)
  polymarket_clob.py   Polymarket CLOB WebSocket (live prices, batched subscriptions)
  poly_clob_rest.py    py-clob-client REST (order book depth, batch midpoints)
  synthdata.py         SynthData API (all 6 endpoints, TTL cache, serialised calls)
engine/
  prob_calc.py         DVM curve builder, variance interpolation, TTE utilities
  synth_mapper.py      SynthData CDF → probability curve + IQR-implied vol
  arb_scanner.py       Three-strategy arbitrage scanner + Kelly/Greeks per signal
  poly_iv.py           BSM digital option inversion (Polymarket → implied vol)
  greeks.py            BSM delta, vega, binary delta
  signal_tracker.py    SQLite signal history + P&L settlement resolver
ui/src/
  App.tsx              Top-level routing (Dashboard / Vol Surface / Options Chain / History)
  components/
    Dashboard.tsx      Prob chart + signals + strike table + Poly markets panel
    VolSurface.tsx     IV comparison charts + Markets table with order book depth
    OptionsChain.tsx   Multi-expiry Derive bid/ask vs SynthData vs Polymarket
    ProbChart.tsx      Recharts probability curves + live CLOB dots
    SignalCard.tsx     Signal display with Greeks and Kelly fraction
    StrikeTable.tsx    Per-strike edge table
    SignalHistory.tsx  Historical signals + P&L
data/mock/             Pre-computed snapshots for demo mode (no API keys needed)
```

---

## Key Design Decisions

**Why DVM instead of Breeden-Litzenberger?** BL requires a dense, smooth options chain. 0DTE Derive chains are sparse — DVM finite-differencing between adjacent mid prices is numerically stable and produces no negative probabilities.

**Why variance interpolation for TTE alignment?** Derive expires 08:00 UTC, Poly settles 17:00 UTC. Linear IV interpolation would misprice the time dimension. σ²×T interpolation correctly handles the square-root-of-time scaling.

**Why settlement window query for Polymarket?** Sorting markets by volume returns this week's multi-day markets ("Will BTC reach $150k in March?"). Querying by `end_date_min/max` (±1h around 17:00 UTC) guarantees all daily strikes — including low-volume ones that are often the most mispriced.

**Why serialise SynthData calls?** 6 parallel asyncio.gather requests causes burst 429s. 1s gaps between calls plus per-endpoint backoff keeps credit burn predictable (~500 credits/day across both assets).

**Why (D−1) for Poly/Derive expiry matching?** Derive expires 08:00 UTC on date D, Polymarket settles 17:00 UTC on D−1. The closest Poly settlement before any given Derive expiry is always the previous day's 17:00 UTC.

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `SYNTHDATA_API_KEY` | — | Required for live mode (get one at synthdata.co) |
| `MOCK_MODE` | `0` | Set to `1` to serve pre-computed demo data without any API keys |
