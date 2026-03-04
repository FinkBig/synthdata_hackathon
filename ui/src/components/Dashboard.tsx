import { Snapshot } from '../types'
import ProbChart from './ProbChart'
import SignalCard from './SignalCard'
import StrikeTable from './StrikeTable'

interface LivePolyPrice { bid: number; ask: number; mid: number }

interface Props {
  snapshot: Snapshot
  asset: string
  livePolyPrices?: Record<string, LivePolyPrice>
  clobConnected?: boolean
}

export default function Dashboard({ snapshot, asset, livePolyPrices = {}, clobConnected = false }: Props) {
  const { signals, strike_table } = snapshot

  return (
    <div className="space-y-6">
      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Spot Price" value={`$${snapshot.spot.toLocaleString()}`} />
        <StatCard
          label="Active Signals"
          value={signals.length.toString()}
          accent={signals.length > 0 ? 'text-yellow-400' : undefined}
        />
        <StatCard
          label="Best Edge"
          value={signals.length > 0
            ? `${(Math.max(...signals.map(s => s.edge_pct)) * 100).toFixed(1)}%`
            : 'None'}
          accent={signals.length > 0 ? 'text-green-400' : undefined}
        />
        <StatCard
          label="Data Sources"
          value={snapshot.mode === 'live' ? '3/3' : snapshot.mode === 'partial' ? '2/3' : '3/3 (mock)'}
        />
      </div>

      {/* Probability Chart */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <h2 className="text-sm font-semibold text-slate-300 mb-4 flex items-center gap-2">
          <span>Probability</span>
          <span className="text-xs font-normal text-slate-500">{asset} · nearest settlement · 0DTE options</span>
        </h2>
        <div className="flex gap-4 text-xs text-slate-400 mb-3">
          <LegendItem color="bg-slate-200" label="SynthData AI" />
          <LegendItem color="bg-orange-500" label="Derive (DVM)" />
          <LegendItem color="bg-blue-500" label="Polymarket" live={clobConnected} />
        </div>
        <ProbChart snapshot={snapshot} livePolyPrices={livePolyPrices} clobConnected={clobConnected} />
      </div>

      {/* Signals */}
      {signals.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-slate-300 mb-3 flex items-center gap-2">
            <span className="w-2 h-2 bg-yellow-400 rounded-full animate-pulse" />
            Arbitrage Signals
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {signals.map((signal, i) => (
              <SignalCard key={i} signal={signal} />
            ))}
          </div>
        </div>
      )}

      {/* Strike Table */}
      <div>
        <h2 className="text-sm font-semibold text-slate-300 mb-3">Strike-by-Strike Comparison</h2>
        <StrikeTable rows={strike_table} />
      </div>

      {/* Math note */}
      <div className="bg-slate-900/50 border border-slate-800 rounded-lg p-4 text-xs text-slate-500">
        <p className="font-semibold text-slate-400 mb-1">Method: Discrete Vertical Mapping (DVM)</p>
        <p>
          P(K₁ &lt; S_T &lt; K₂) = (C(K₁).mid − C(K₂).mid) / (K₂ − K₁)
          &nbsp;|&nbsp; Uses two bracket expiries + total variance interpolation
          to align with Polymarket 17:00 UTC settlement (not BL — too noisy for 0DTE sparse chains).
        </p>
      </div>
    </div>
  )
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
      <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">{label}</p>
      <p className={`text-xl font-bold ${accent ?? 'text-slate-100'}`}>{value}</p>
    </div>
  )
}

function LegendItem({ color, label, live }: { color: string; label: string; live?: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`w-3 h-0.5 ${color} rounded`} />
      {label}
      {live && <span className="text-green-400 animate-pulse">●</span>}
    </div>
  )
}
