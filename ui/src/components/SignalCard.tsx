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

const DIRECTION_COLORS: Record<string, string> = {
  SELL: 'bg-red-500/20 text-red-300',
  BUY: 'bg-green-500/20 text-green-300',
}

function directionColor(direction: string): string {
  if (direction.toUpperCase().startsWith('SELL')) return DIRECTION_COLORS.SELL
  return DIRECTION_COLORS.BUY
}

export default function SignalCard({ signal }: Props) {
  const edgePct = (signal.edge_pct * 100).toFixed(1)
  const borderColor = STRATEGY_COLORS[signal.strategy] ?? 'border-l-slate-500'

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
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${CONFIDENCE_COLORS[signal.confidence]}`}>
          {signal.confidence}
        </span>
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
        <ProbCell label="SynthData" prob={signal.synth_prob} color="text-blue-400" />
        <ProbCell label="Derive" prob={signal.derive_prob} color="text-orange-400" />
        <ProbCell label="Polymarket" prob={signal.poly_prob} color="text-green-400" />
      </div>

      {/* Direction action badge */}
      <div className={`text-xs font-semibold px-3 py-1.5 rounded-lg text-center ${directionColor(signal.direction)}`}>
        {signal.direction}
      </div>

      {/* Reasoning (truncated) */}
      <p className="text-xs text-slate-500 leading-relaxed line-clamp-3">
        {signal.reasoning}
      </p>

      {/* Poly question */}
      {signal.poly_question && (
        <p className="text-xs text-slate-600 italic truncate" title={signal.poly_question}>
          {signal.poly_question}
        </p>
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
