export interface Signal {
  strategy: 'short_vol' | 'skew_arb' | 'the_pin'
  asset: string
  strike: number
  direction: string
  edge_pct: number
  synth_prob: number
  derive_prob: number
  poly_prob: number
  reasoning: string
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  poly_question: string
  poly_url: string
  poly_expiry: string
  kelly_fraction?: number
  delta?: number
  vega?: number
}

export interface HistoricalSignal extends Signal {
  id: number
  detected_at: string
  settled_at?: string
  settlement_price?: number
  pnl?: number
}

export interface PnlSummary {
  summary: {
    total_signals: number
    settled_count: number
    wins: number
    losses: number
    avg_pnl: number | null
    total_pnl: number | null
    avg_edge_pct: number | null
  }
  by_strategy: Record<string, {
    total: number
    settled: number
    wins: number
    avg_pnl: number | null
    total_pnl: number | null
    avg_edge: number | null
  }>
}

export interface VolSurfacePoint {
  strike: number
  moneyness_pct: number
  call_iv: number | null
  put_iv: number | null
}

export interface VolSurfaceExpiry {
  expiry: string
  tte_hours: number
  label: string
  strikes: VolSurfacePoint[]
}

export interface SynthTermPoint {
  hours_ahead: number
  atm_iv: number
}

export interface PolyIVPoint {
  strike: number
  moneyness_pct: number
  poly_iv: number
  market_type: string
  yes_price: number
  expiry: string
  // enriched fields from backend
  question?: string
  polymarket_url?: string
  volume_24h?: number
  clob_token_id?: string
  derive_iv?: number | null        // variance-interpolated Derive IV at same moneyness + T_poly
  iv_gap_pts?: number | null       // (poly_iv − derive_iv) × 100 vol points
  derive_binary?: number | null    // BSM N(d2) using derive_iv + T_poly
  action?: string | null           // "BUY YES" | "BUY NO" | null
}

export interface DivergenceAlert {
  source_a: string
  source_b: string
  iv_a: number
  iv_b: number
  gap_vol_pts: number
  severity: 'HIGH' | 'MEDIUM'
  higher_source?: string
  lower_source?: string
}

export interface VolSurfaceData {
  asset: string
  spot: number
  t_poly_hours?: number            // hours until next Poly 17:00 UTC settlement
  derive_surface: VolSurfaceExpiry[]
  synth_term_structure: SynthTermPoint[]
  poly_iv_points?: PolyIVPoint[]
  atm_ivs?: { derive: number | null; synth: number | null; poly: number | null }
  divergence_alerts?: DivergenceAlert[]
  synth_forecast_iv?: number | null
}

export interface PolyPoint {
  strike?: number
  lower_bound?: number
  upper_bound?: number
  market_type: string
  is_above?: boolean
  yes_price: number
  yes_bid: number
  yes_ask: number
  no_bid?: number
  no_ask?: number
  question: string
  volume_24h: number
  clob_token_id?: string
  polymarket_url?: string
  expiry?: string
}

export interface OrderBookLevel {
  price: number
  size: number
}

export interface OrderBook {
  token_id: string
  bids: OrderBookLevel[]
  asks: OrderBookLevel[]
  spread: number | null
  midpoint: number | null
  tick_size: string | null
  timestamp: string | null
  error?: string
}

export interface OptionsChainRow {
  strike: number
  moneyness_pct: number
  call_bid: number | null
  call_ask: number | null
  call_iv: number | null
  put_bid: number | null
  put_ask: number | null
  put_iv: number | null
  synth_prob: number | null
  derive_prob: number | null
  derive_binary: number | null
  poly_yes_price: number | null
  poly_yes_bid: number | null
  poly_yes_ask: number | null
  poly_question: string | null
  poly_url: string | null
  poly_strike: number | null
  edge_vs_synth: number | null
  edge_vs_derive: number | null
  action: string | null
}

export interface OptionsChainExpiry {
  expiry: string
  tte_hours: number
  label: string
  poly_settle: string
  poly_settle_label: string
  rows: OptionsChainRow[]
}

export interface OptionsChainData {
  asset: string
  spot: number
  expiries: OptionsChainExpiry[]
}

export interface StrikeRow {
  strike: number
  synth_prob: number | null
  derive_prob: number | null
  poly_prob: number | null
  edge: number
  action: string
  highlight: boolean
  derive_binary: number | null
  derive_iv: number | null
  derive_bid: number | null
  derive_ask: number | null
  derive_option_strike: number | null
  poly_question: string
  poly_url: string
}

export interface Snapshot {
  asset: string
  spot: number
  last_updated: string
  mode: 'live' | 'partial' | 'demo'
  derive_curve: Record<string, number>
  synth_curve: Record<string, number>
  synth_pdf?: Record<string, number>
  derive_pdf?: Record<string, number>
  poly_points: PolyPoint[]
  signals: Signal[]
  strike_table: StrikeRow[]
  error?: string
}
