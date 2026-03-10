import { Snapshot, PolyPoint } from '../types'
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

  const regimeColor = snapshot.vol_regime === 'expanding'
    ? 'bg-red-500/20 text-red-300 border-red-500/30'
    : snapshot.vol_regime === 'compressing'
    ? 'bg-blue-500/20 text-blue-300 border-blue-500/30'
    : 'bg-slate-700/40 text-slate-300 border-slate-600/30'

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

      {/* Vol Regime + SynthData intelligence bar */}
      {(snapshot.vol_regime || snapshot.forecast_vol != null) && (
        <div className="flex flex-wrap items-center gap-3 bg-slate-900 border border-slate-800 rounded-xl px-4 py-3">
          <span className="text-xs text-slate-500 uppercase tracking-wider mr-1">SynthData AI</span>

          {snapshot.vol_regime && (
            <span className={`text-xs font-semibold px-2.5 py-1 rounded border ${regimeColor}`}>
              {snapshot.vol_regime.toUpperCase()} VOL
            </span>
          )}

          {snapshot.forecast_vol != null && (
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-slate-500">Forecast IV</span>
              <span className="text-xs font-mono font-semibold text-slate-200">
                {(snapshot.forecast_vol * 100).toFixed(1)}%
              </span>
            </div>
          )}

          {snapshot.realized_vol != null && (
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-slate-500">Realized Vol</span>
              <span className="text-xs font-mono font-semibold text-slate-200">
                {(snapshot.realized_vol * 100).toFixed(1)}%
              </span>
            </div>
          )}

          {snapshot.forecast_vol != null && snapshot.realized_vol != null && snapshot.realized_vol > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-slate-500">Fcast/Rlzd</span>
              <span className={`text-xs font-mono font-semibold ${
                (snapshot.forecast_vol / snapshot.realized_vol) > 1.5 ? 'text-red-300'
                : (snapshot.forecast_vol / snapshot.realized_vol) < 0.7 ? 'text-blue-300'
                : 'text-slate-300'
              }`}>
                {(snapshot.forecast_vol / snapshot.realized_vol).toFixed(2)}×
              </span>
            </div>
          )}

          {snapshot.synth_poly_edge != null && (
            <div className="flex items-center gap-1.5 ml-auto">
              <span className="text-xs text-slate-500">Synth→Poly Edge</span>
              <span className={`text-xs font-mono font-semibold ${snapshot.synth_poly_edge > 0 ? 'text-green-400' : 'text-red-400'}`}>
                {snapshot.synth_poly_edge > 0 ? '+' : ''}{(snapshot.synth_poly_edge * 100).toFixed(1)}%
              </span>
            </div>
          )}
        </div>
      )}

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
              <SignalCard key={i} signal={signal} polyPoints={snapshot.poly_points} />
            ))}
          </div>
        </div>
      )}

      {/* Strike Table */}
      <div>
        <h2 className="text-sm font-semibold text-slate-300 mb-3">Strike-by-Strike Comparison</h2>
        <StrikeTable rows={strike_table} />
      </div>

      {/* Poly Markets */}
      {snapshot.poly_points?.length > 0 && (
        <PolyMarketsPanel points={snapshot.poly_points} />
      )}

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

function PolyMarketsPanel({ points }: { points: PolyPoint[] }) {
  const now = Date.now()

  function formatTTE(expiry?: string) {
    if (!expiry) return '—'
    const ms = new Date(expiry).getTime() - now
    if (ms <= 0) return 'expired'
    const h = ms / 3_600_000
    if (h < 1) return `${Math.round(h * 60)}m`
    if (h < 24) return `${h.toFixed(1)}h`
    return `${(h / 24).toFixed(1)}d`
  }

  function formatStrike(p: PolyPoint) {
    if (p.market_type === 'daily_range' && p.lower_bound != null && p.upper_bound != null) {
      return `$${p.lower_bound.toLocaleString()} – $${p.upper_bound.toLocaleString()}`
    }
    return p.strike ? `$${p.strike.toLocaleString()}` : '—'
  }

  const sorted = [...points].sort((a, b) => {
    // sort: above_below first, then by strike asc
    if (a.market_type !== b.market_type) return a.market_type === 'above_below' ? -1 : 1
    return (a.strike ?? 0) - (b.strike ?? 0)
  })

  return (
    <div>
      <h2 className="text-sm font-semibold text-slate-300 mb-3">
        Polymarket Prediction Markets
        <span className="ml-2 text-xs font-normal text-slate-500">{points.length} active markets · today's settlement</span>
      </h2>
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-800/50 text-slate-400">
                <th className="px-4 py-2 text-left min-w-60">Market</th>
                <th className="px-4 py-2 text-left">Type</th>
                <th className="px-4 py-2 text-right">Strike / Range</th>
                <th className="px-4 py-2 text-right">TTE</th>
                <th className="px-4 py-2 text-right text-green-400">YES Bid</th>
                <th className="px-4 py-2 text-right text-green-400">YES Ask</th>
                <th className="px-4 py-2 text-right text-red-400">NO Bid</th>
                <th className="px-4 py-2 text-right text-red-400">NO Ask</th>
                <th className="px-4 py-2 text-right">Vol 24h</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((p, i) => {
                const yesMid = p.yes_price
                const noBid = p.no_bid ?? (1 - p.yes_ask)
                const noAsk = p.no_ask ?? (1 - p.yes_bid)
                return (
                  <tr key={i} className="border-b border-slate-800/50 hover:bg-slate-800/20">
                    <td className="px-4 py-2.5">
                      <p className="text-slate-200 leading-tight">{p.question}</p>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                        p.market_type === 'above_below' ? 'bg-blue-500/20 text-blue-300' : 'bg-violet-500/20 text-violet-300'
                      }`}>
                        {p.market_type === 'above_below' ? 'A/B' : 'RANGE'}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-slate-300">{formatStrike(p)}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-slate-400">{formatTTE(p.expiry)}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-green-300">{(p.yes_bid * 100).toFixed(1)}¢</td>
                    <td className="px-4 py-2.5 text-right font-mono text-green-200">{(p.yes_ask * 100).toFixed(1)}¢</td>
                    <td className="px-4 py-2.5 text-right font-mono text-red-300">{(noBid * 100).toFixed(1)}¢</td>
                    <td className="px-4 py-2.5 text-right font-mono text-red-200">{(noAsk * 100).toFixed(1)}¢</td>
                    <td className="px-4 py-2.5 text-right text-slate-500">
                      {p.volume_24h ? `$${(p.volume_24h / 1000).toFixed(0)}k` : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      {p.polymarket_url ? (
                        <a href={p.polymarket_url} target="_blank" rel="noopener noreferrer"
                          className="text-slate-600 hover:text-slate-300 transition-colors">↗</a>
                      ) : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-2 border-t border-slate-800 text-xs text-slate-600">
          YES mid = CLOB mid · NO bid/ask derived from YES ask/bid · A/B = above/below markets · Poly settles 17:00 UTC
        </div>
      </div>
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
