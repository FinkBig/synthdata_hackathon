import { useState, useEffect } from 'react'
import { Signal, PolyPoint, OrderBook } from '../types'

interface Props {
  signal: Signal
  polyPoints?: PolyPoint[]
  spot?: number
}

const STRATEGY_LABELS: Record<string, string> = {
  short_vol: 'Short Vol',
  skew_arb: 'Skew Arb',
  the_pin: 'The Pin',
}

const CONFIDENCE_COLORS: Record<string, string> = {
  HIGH: 'text-green-400 bg-green-400/10 border-green-400/30',
  MEDIUM: 'text-yellow-400 bg-yellow-400/10 border-yellow-400/30',
  LOW: 'text-slate-400 bg-slate-400/10 border-slate-400/30',
}

const STRATEGY_COLORS: Record<string, string> = {
  short_vol: 'border-l-red-500',
  skew_arb: 'border-l-orange-500',
  the_pin: 'border-l-blue-500',
}

function useNow() {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  return now
}

function formatCountdown(isoExpiry: string, now: number): string {
  if (!isoExpiry) return ''
  const ms = new Date(isoExpiry).getTime() - now
  if (ms <= 0) return 'Expired'
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`
  if (h >= 1) return `${h}h ${m}m`
  return `${m}m ${s}s`
}

export default function SignalCard({ signal, polyPoints = [], spot }: Props) {
  const now = useNow()
  const countdown = formatCountdown(signal.poly_expiry, now)
  const msLeft = signal.poly_expiry ? new Date(signal.poly_expiry).getTime() - now : 0
  const isExpired = msLeft <= 0 && !!signal.poly_expiry
  const urgency = msLeft > 0 && msLeft < 3_600_000

  // Find matching poly market (by question first, then by strike)
  const matchedPoint = polyPoints.find(p =>
    p.question === signal.poly_question ||
    (p.strike != null && p.strike === signal.strike && p.market_type === 'above_below')
  )
  const tokenId = matchedPoint?.clob_token_id

  const isBuyYes = signal.direction.toUpperCase().includes('BUY POLY YES') ||
                   signal.direction.toUpperCase().startsWith('BUY YES')
  const isBuyNo  = signal.direction.toUpperCase().includes('BUY POLY NO') ||
                   signal.direction.toUpperCase().startsWith('BUY NO')

  // Entry price: for YES buy use yes_ask; for NO buy use (1 − yes_bid) = NO ask
  const yesAsk = matchedPoint?.yes_ask ?? null
  const yesBid = matchedPoint?.yes_bid ?? null
  const entryPrice = isBuyYes
    ? yesAsk
    : isBuyNo && yesBid != null
    ? 1 - yesBid
    : null

  const payoutPer1 = entryPrice != null && entryPrice > 0 ? 1 - entryPrice : null
  const oddsRatio  = entryPrice != null && entryPrice > 0 ? payoutPer1! / entryPrice : null

  // Moneyness: how far is the strike from current spot
  const moneyness = spot != null && spot > 0
    ? ((signal.strike / spot) - 1) * 100
    : null

  const borderColor = STRATEGY_COLORS[signal.strategy] ?? 'border-l-slate-500'
  const maxProb = Math.max(signal.synth_prob, signal.derive_prob, signal.poly_prob)

  // Order book
  const [orderBook, setOrderBook] = useState<OrderBook | null>(null)
  useEffect(() => {
    if (!tokenId) return
    let cancelled = false
    fetch(`/api/poly/orderbook/${tokenId}`)
      .then(r => r.json())
      .then(data => { if (!cancelled) setOrderBook(data) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [tokenId])

  return (
    <div className={`bg-slate-900 border border-slate-800 border-l-4 ${borderColor} rounded-xl overflow-hidden flex flex-col`}>

      {/* ── Header: strategy + timer ── */}
      <div className="px-4 pt-3.5 pb-3 border-b border-slate-800/70">
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">
              {STRATEGY_LABELS[signal.strategy] ?? signal.strategy}
            </span>
            <span className={`text-xs font-medium px-1.5 py-0.5 rounded-full border ${CONFIDENCE_COLORS[signal.confidence]}`}>
              {signal.confidence}
            </span>
          </div>
          {countdown && (
            <span className={`text-xs font-mono font-semibold tabular-nums ${
              isExpired ? 'text-red-400'
              : urgency  ? 'text-yellow-400 animate-pulse'
              :            'text-slate-400'
            }`}>
              ⏱ {countdown}
            </span>
          )}
        </div>

        {/* Settlement question — the most important thing */}
        <p className="text-sm font-semibold text-slate-100 leading-snug">
          {signal.poly_question || signal.direction}
        </p>

        {/* Strike + moneyness context */}
        <p className="text-xs text-slate-500 mt-1">
          Strike <span className="font-mono text-slate-300">${signal.strike.toLocaleString()}</span>
          {moneyness != null && (
            <span className={`ml-1.5 font-medium ${
              Math.abs(moneyness) < 0.5 ? 'text-slate-400'
              : moneyness > 0 ? 'text-orange-400'
              : 'text-blue-400'
            }`}>
              ({moneyness > 0 ? '+' : ''}{moneyness.toFixed(1)}% from spot)
            </span>
          )}
        </p>
      </div>

      {/* ── Trade specs: entry / payout / edge ── */}
      <div className="grid grid-cols-3 divide-x divide-slate-800/70 border-b border-slate-800/70">
        <SpecCell
          label={isBuyYes ? 'YES ask' : isBuyNo ? 'NO ask' : 'Entry'}
          value={entryPrice != null ? `${(entryPrice * 100).toFixed(0)}¢` : '—'}
          sub={entryPrice != null ? `per contract` : undefined}
          valueClass="text-slate-100"
        />
        <SpecCell
          label="Win / Lose"
          value={payoutPer1 != null && entryPrice != null
            ? `${(payoutPer1 * 100).toFixed(0)}¢ / ${(entryPrice * 100).toFixed(0)}¢`
            : '—'}
          sub={oddsRatio != null ? `${oddsRatio.toFixed(0)}:1 return` : undefined}
          valueClass="text-green-400"
        />
        <SpecCell
          label="Edge · Kelly"
          value={`+${(signal.edge_pct * 100).toFixed(1)}%`}
          sub={signal.kelly_fraction != null && signal.kelly_fraction > 0
            ? `${(signal.kelly_fraction * 100).toFixed(1)}% bankroll`
            : undefined}
          valueClass="text-yellow-400"
        />
      </div>

      {/* ── Three-source comparison ── */}
      <div className="px-4 py-3 border-b border-slate-800/70 space-y-2.5">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">
          Probability disagreement
        </p>
        <SourceBar label="Derive"     prob={signal.derive_prob} color="bg-orange-500" maxProb={maxProb} note="options market" />
        <SourceBar label="SynthData"  prob={signal.synth_prob}  color="bg-slate-300"  maxProb={maxProb} note="AI forecast" />
        <SourceBar label="Polymarket" prob={signal.poly_prob}   color="bg-blue-500"   maxProb={maxProb} note="← priced here" highlight />
        <p className="text-xs text-slate-400 pt-0.5">
          <span className="text-yellow-400 font-bold">+{(signal.edge_pct * 100).toFixed(1)}%</span>
          {' '}edge —{' '}
          {signal.poly_prob < Math.min(signal.derive_prob, signal.synth_prob)
            ? 'Poly underprices vs AI + options'
            : signal.poly_prob > Math.max(signal.derive_prob, signal.synth_prob)
            ? 'Poly overprices vs AI + options'
            : signal.poly_prob < signal.derive_prob
            ? 'Poly underprices vs options'
            : 'Poly overprices vs AI forecast'}
        </p>
      </div>

      {/* ── Order book depth ── */}
      {orderBook && !orderBook.error && (orderBook.bids.length > 0 || orderBook.asks.length > 0) && (
        <div className="border-b border-slate-800/70">
          <div className="grid grid-cols-2 divide-x divide-slate-800/70">
            <div>
              <p className="text-xs text-green-400 text-center py-1 bg-green-400/5 font-medium tracking-wide">Bids</p>
              {orderBook.bids.slice(0, 3).map((b, i) => (
                <div key={i} className="flex justify-between px-3 py-0.5 text-xs font-mono">
                  <span className="text-green-300">{(b.price * 100).toFixed(1)}¢</span>
                  <span className="text-slate-500">{b.size.toFixed(0)}</span>
                </div>
              ))}
            </div>
            <div>
              <p className="text-xs text-red-400 text-center py-1 bg-red-400/5 font-medium tracking-wide">Asks</p>
              {orderBook.asks.slice(0, 3).map((a, i) => (
                <div key={i} className="flex justify-between px-3 py-0.5 text-xs font-mono">
                  <span className="text-red-300">{(a.price * 100).toFixed(1)}¢</span>
                  <span className="text-slate-500">{a.size.toFixed(0)}</span>
                </div>
              ))}
            </div>
          </div>
          {orderBook.spread != null && (
            <p className="text-center text-xs text-slate-600 py-1 border-t border-slate-800/50">
              spread <span className="font-mono">{(orderBook.spread * 100).toFixed(1)}¢</span>
              {orderBook.midpoint != null && (
                <> · mid <span className="font-mono text-slate-400">{(orderBook.midpoint * 100).toFixed(1)}¢</span></>
              )}
            </p>
          )}
        </div>
      )}

      {/* ── Polymarket link ── */}
      {signal.poly_url && (
        <div className="px-4 py-2.5">
          <a
            href={signal.poly_url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-blue-300 transition-colors"
          >
            <svg className="shrink-0" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
              <polyline points="15 3 21 3 21 9"/>
              <line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
            View on Polymarket
          </a>
        </div>
      )}
    </div>
  )
}

function SpecCell({ label, value, sub, valueClass }: {
  label: string; value: string; sub?: string; valueClass: string
}) {
  return (
    <div className="px-3 py-3 text-center">
      <p className="text-xs text-slate-500 mb-1">{label}</p>
      <p className={`font-mono font-bold text-sm ${valueClass}`}>{value}</p>
      {sub && <p className="text-xs text-slate-600 mt-0.5">{sub}</p>}
    </div>
  )
}

function SourceBar({ label, prob, color, maxProb, note, highlight }: {
  label: string; prob: number; color: string; maxProb: number; note: string; highlight?: boolean
}) {
  const barWidth = maxProb > 0 ? Math.max(2, (prob / maxProb) * 100) : 2
  return (
    <div className="flex items-center gap-2">
      <span className={`text-xs w-20 shrink-0 ${highlight ? 'text-slate-200 font-medium' : 'text-slate-500'}`}>
        {label}
      </span>
      <div className="flex-1 bg-slate-800 rounded-full h-1.5 overflow-hidden">
        <div
          className={`h-full rounded-full ${color} transition-all ${highlight ? 'opacity-90' : 'opacity-40'}`}
          style={{ width: `${barWidth}%` }}
        />
      </div>
      <span className={`text-xs font-mono w-10 text-right tabular-nums ${highlight ? 'text-blue-300 font-semibold' : 'text-slate-400'}`}>
        {(prob * 100).toFixed(1)}%
      </span>
      <span className="text-xs text-slate-600 w-28 truncate hidden sm:block">{note}</span>
    </div>
  )
}
