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
}

export interface StrikeRow {
  strike: number
  synth_prob: number | null
  derive_prob: number | null
  poly_prob: number | null
  edge: number
  action: string
  highlight: boolean
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
