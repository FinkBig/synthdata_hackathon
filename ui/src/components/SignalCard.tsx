import { useState, useEffect } from 'react'
import { Signal } from '../types'

interface Props {
  signal: Signal
}

const STRATEGY_LABELS: Record<string, string> = {
  short_vol: 'Short Vol',
  skew_arb: 'Skew Arb',
  the_pin: 'The Pin',
}

const STRATEGY_DESCRIPTIONS: Record<string, string> = {
  short_vol: 'AI + Options cheaper than Poly',
  skew_arb: 'Options skew > Poly put pricing',
  the_pin: 'Options range > Poly range price',
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
  if (h >= 1) return `${h}h ${m}m ${s}s`
  return `${m}m ${s}s`
}

export default function SignalCard({ signal }: Props) {
  const now = useNow()
  const edgePct = (signal.edge_pct * 100).toFixed(1)
  const borderColor = STRATEGY_COLORS[signal.strategy] ?? 'border-l-slate-500'
  const countdown = formatCountdown(signal.poly_expiry, now)
  const isExpired = signal.poly_expiry && new Date(signal.poly_expiry).getTime() <= now

  // Direction badge: green for BUY, red for SELL (as primary action)
  const isBuy = signal.direction.toUpperCase().startsWith('BUY')
  const directionClass = isBuy ? 'bg-green-500/20 text-green-300' : 'bg-red-500/20 text-red-300'

  return (
    <div className={`bg-slate-900 border border-slate-800 border-l-4 ${borderColor} rounded-xl p-4 space-y-3`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-slate-100">
              {STRATEGY_LABELS[signal.strategy] ?? signal.strategy}
            </span>
            <span className="text-xs text-slate-500">#{signal.asset}</span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            {STRATEGY_DESCRIPTIONS[signal.strategy]}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${CONFIDENCE_COLORS[signal.confidence]}`}>
            {signal.confidence}
          </span>
          {countdown && (
            <span className={`text-xs font-mono px-1.5 py-0.5 rounded ${
              isExpired
                ? 'text-red-400 bg-red-400/10'
                : 'text-yellow-400 bg-yellow-400/10'
            }`}>
              ⏱ {countdown}
            </span>
          )}
        </div>
      </div>

      {/* Strike + Edge */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-slate-500">Strike</p>
          <p className="font-mono font-bold text-slate-100">
            ${signal.strike.toLocaleString()}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs text-slate-500">Edge</p>
          <p className="font-mono font-bold text-yellow-400 text-lg">+{edgePct}%</p>
        </div>
      </div>

      {/* Probability comparison */}
      <div className="grid grid-cols-3 gap-2 text-center">
        <ProbCell label="SynthData" prob={signal.synth_prob} color="text-slate-200" />
        <ProbCell label="Derive" prob={signal.derive_prob} color="text-orange-400" />
        <ProbCell label="Polymarket" prob={signal.poly_prob} color="text-blue-400" />
      </div>

      {/* Direction action badge */}
      <div className={`text-xs font-semibold px-3 py-1.5 rounded-lg text-center ${directionClass}`}>
        {signal.direction}
      </div>

      {/* Reasoning (truncated) */}
      <p className="text-xs text-slate-500 leading-relaxed line-clamp-3">
        {signal.reasoning}
      </p>

      {/* Poly market link */}
      {signal.poly_question && (
        signal.poly_url ? (
          <a
            href={signal.poly_url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-start gap-1.5 text-xs text-slate-400 hover:text-blue-300 transition-colors group"
            title={signal.poly_question}
          >
            <svg className="shrink-0 mt-px text-slate-500 group-hover:text-blue-400" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
              <polyline points="15 3 21 3 21 9"/>
              <line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
            <span className="line-clamp-2 leading-relaxed">{signal.poly_question}</span>
          </a>
        ) : (
          <p className="text-xs text-slate-500 line-clamp-2 leading-relaxed" title={signal.poly_question}>
            {signal.poly_question}
          </p>
        )
      )}
    </div>
  )
}

function ProbCell({ label, prob, color }: { label: string; prob: number; color: string }) {
  return (
    <div className="bg-slate-800/50 rounded-lg py-2">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`font-mono font-bold text-sm ${color}`}>
        {(prob * 100).toFixed(0)}%
      </p>
    </div>
  )
}
