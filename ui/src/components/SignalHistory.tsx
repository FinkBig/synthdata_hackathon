import { useEffect, useState } from 'react'
import { HistoricalSignal, PnlSummary } from '../types'

const STRATEGY_LABELS: Record<string, string> = {
  short_vol: 'Short Vol',
  skew_arb: 'Skew Arb',
  the_pin: 'The Pin',
}

function fmt(v: number | null | undefined, decimals = 1): string {
  if (v == null) return '—'
  return `${v > 0 ? '+' : ''}${(v * 100).toFixed(decimals)}%`
}

function pnlColor(pnl: number | null | undefined): string {
  if (pnl == null) return 'text-slate-400'
  return pnl > 0 ? 'text-green-400' : 'text-red-400'
}

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const h = Math.floor(ms / 3600000)
  const d = Math.floor(h / 24)
  if (d >= 1) return `${d}d ago`
  if (h >= 1) return `${h}h ago`
  return `${Math.floor(ms / 60000)}m ago`
}

export default function SignalHistory() {
  const [history, setHistory] = useState<HistoricalSignal[]>([])
  const [pnl, setPnl] = useState<PnlSummary | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      try {
        const [histRes, pnlRes] = await Promise.all([
          fetch('/api/signals/history?limit=200'),
          fetch('/api/signals/pnl'),
        ])
        if (histRes.ok) {
          const d = await histRes.json()
          setHistory(d.signals ?? [])
        }
        if (pnlRes.ok) {
          setPnl(await pnlRes.json())
        }
      } catch (e) {
        console.error(e)
      } finally {
        setLoading(false)
      }
    }
    load()
    const id = setInterval(load, 60000)
    return () => clearInterval(id)
  }, [])

  if (loading && !history.length) {
    return (
      <div className="flex items-center justify-center h-48 text-slate-400 text-sm">
        Loading history...
      </div>
    )
  }

  const summary = pnl?.summary
  const byStrategy = pnl?.by_strategy ?? {}

  return (
    <div className="space-y-6">
      {/* P&L Summary cards */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <SummaryCard label="Total Signals" value={String(summary.total_signals)} />
          <SummaryCard
            label="Settled"
            value={`${summary.settled_count} / ${summary.total_signals}`}
          />
          <SummaryCard
            label="Win Rate"
            value={
              summary.settled_count
                ? `${Math.round((summary.wins / summary.settled_count) * 100)}%`
                : '—'
            }
            accent={summary.wins > (summary.losses ?? 0) ? 'text-green-400' : undefined}
          />
          <SummaryCard
            label="Total P&L"
            value={fmt(summary.total_pnl)}
            accent={summary.total_pnl != null ? pnlColor(summary.total_pnl) : undefined}
          />
        </div>
      )}

      {/* Per-strategy breakdown */}
      {Object.keys(byStrategy).length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {Object.entries(byStrategy).map(([strat, stats]) => (
            <div key={strat} className="bg-slate-900 border border-slate-800 rounded-xl p-4">
              <p className="text-xs font-semibold text-slate-400 mb-2">
                {STRATEGY_LABELS[strat] ?? strat}
              </p>
              <div className="grid grid-cols-3 gap-2 text-center text-xs">
                <div>
                  <p className="text-slate-500">Signals</p>
                  <p className="font-mono font-bold text-slate-200">{stats.total}</p>
                </div>
                <div>
                  <p className="text-slate-500">Win Rate</p>
                  <p className="font-mono font-bold text-slate-200">
                    {stats.settled ? `${Math.round((stats.wins / stats.settled) * 100)}%` : '—'}
                  </p>
                </div>
                <div>
                  <p className="text-slate-500">Avg P&L</p>
                  <p className={`font-mono font-bold ${pnlColor(stats.avg_pnl)}`}>
                    {fmt(stats.avg_pnl)}
                  </p>
                </div>
              </div>
              {stats.avg_edge != null && (
                <p className="text-xs text-slate-500 mt-2 text-center">
                  Avg edge: <span className="text-yellow-400 font-mono">{fmt(stats.avg_edge)}</span>
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Signal history table */}
      {history.length === 0 ? (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-8 text-center text-slate-500 text-sm">
          No signals recorded yet. Signals are stored automatically when detected.
        </div>
      ) : (
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800">
                  <Th>When</Th>
                  <Th>Strategy</Th>
                  <Th>Asset</Th>
                  <Th>Strike</Th>
                  <Th color="text-yellow-400">Edge</Th>
                  <Th color="text-slate-400">Confidence</Th>
                  <Th>Status</Th>
                  <Th color="text-green-400">P&L</Th>
                  <Th>Market</Th>
                </tr>
              </thead>
              <tbody>
                {history.map((s) => {
                  const isSettled = s.pnl != null
                  return (
                    <tr
                      key={s.id}
                      className={`border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors ${
                        isSettled && s.pnl! > 0 ? 'bg-green-500/3' :
                        isSettled && s.pnl! <= 0 ? 'bg-red-500/3' : ''
                      }`}
                    >
                      <td className="px-4 py-2.5 text-xs text-slate-500 whitespace-nowrap">
                        {relTime(s.detected_at)}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded ${
                          s.strategy === 'short_vol' ? 'bg-red-500/15 text-red-300' :
                          s.strategy === 'skew_arb' ? 'bg-orange-500/15 text-orange-300' :
                          'bg-blue-500/15 text-blue-300'
                        }`}>
                          {STRATEGY_LABELS[s.strategy] ?? s.strategy}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-slate-400">{s.asset}</td>
                      <td className="px-4 py-2.5 font-mono text-slate-200 text-xs">
                        ${(s.strike ?? 0).toLocaleString()}
                      </td>
                      <td className="px-4 py-2.5 font-mono font-bold text-yellow-400 text-xs">
                        +{((s.edge_pct ?? 0) * 100).toFixed(1)}%
                      </td>
                      <td className="px-4 py-2.5 text-xs text-slate-400">{s.confidence}</td>
                      <td className="px-4 py-2.5 text-xs">
                        {isSettled ? (
                          <span className={`px-2 py-0.5 rounded font-semibold ${
                            s.pnl! > 0 ? 'bg-green-500/15 text-green-300' : 'bg-red-500/15 text-red-300'
                          }`}>
                            {s.pnl! > 0 ? 'WIN' : 'LOSS'}
                          </span>
                        ) : (
                          <span className="text-slate-600">Pending</span>
                        )}
                      </td>
                      <td className={`px-4 py-2.5 font-mono font-bold text-xs ${pnlColor(s.pnl)}`}>
                        {isSettled ? fmt(s.pnl) : '—'}
                      </td>
                      <td className="px-4 py-2.5">
                        {s.poly_url ? (
                          <a
                            href={s.poly_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-slate-500 hover:text-blue-400 text-xs transition-colors"
                            title={s.poly_question}
                          >
                            ↗
                          </a>
                        ) : (
                          <span className="text-slate-700">—</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function SummaryCard({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
      <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">{label}</p>
      <p className={`text-xl font-bold ${accent ?? 'text-slate-100'}`}>{value}</p>
    </div>
  )
}

function Th({ children, color = 'text-slate-400' }: { children: React.ReactNode; color?: string }) {
  return (
    <th className={`px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider ${color} bg-slate-800/50`}>
      {children}
    </th>
  )
}
