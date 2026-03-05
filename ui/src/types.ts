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

export interface VolSurfaceData {
  asset: string
  spot: number
  derive_surface: VolSurfaceExpiry[]
  synth_term_structure: SynthTermPoint[]
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
  question: string
  volume_24h: number
  clob_token_id?: string
  polymarket_url?: string
  expiry?: string
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
