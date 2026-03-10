import { useEffect, useState, useMemo } from 'react'
import {
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts'
import { VolSurfaceData, VolSurfaceExpiry, PolyIVPoint, DivergenceAlert, OrderBook } from '../types'

interface Props { asset: string }

const EXPIRY_COLOURS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#6366f1', '#a855f7', '#ec4899']

type TopTab = 'visualizations' | 'markets'
type ChartView = 'iv_compare' | 'smile' | 'term'
type SortKey = 'moneyness_pct' | 'poly_iv' | 'derive_iv' | 'iv_gap_pts' | 'yes_price' | 'volume_24h'
type MarketSubTab = 'above_below' | 'daily_range'

// ── Data helpers ──────────────────────────────────────────────────────────────

function buildCombinedSmileData(surface: VolSurfaceExpiry[], polyPoints: PolyIVPoint[]) {
  const moneySet = new Set<number>()
  surface.forEach(exp => exp.strikes.forEach(s => moneySet.add(s.moneyness_pct)))
  polyPoints.forEach(p => moneySet.add(Math.round(p.moneyness_pct * 2) / 2))
  return Array.from(moneySet).sort((a, b) => a - b).map(m => {
    const point: Record<string, number | null> = { moneyness: m }
    surface.forEach((exp, i) => {
      const s = exp.strikes.find(x => x.moneyness_pct === m)
      const iv = m >= 0 ? s?.call_iv : s?.put_iv
      point[`exp_${i}`] = iv != null ? +(iv * 100).toFixed(1) : null
    })
    const pp = polyPoints.find(p => Math.abs(Math.round(p.moneyness_pct * 2) / 2 - m) < 0.01)
    point.poly_iv = pp != null ? +(pp.poly_iv * 100).toFixed(1) : null
    return point
  })
}

function buildSmileData(surface: VolSurfaceExpiry[]) {
  const moneySet = new Set<number>()
  surface.forEach(exp => exp.strikes.forEach(s => moneySet.add(s.moneyness_pct)))
  return Array.from(moneySet).sort((a, b) => a - b).map(m => {
    const point: Record<string, number | null> = { moneyness: m }
    surface.forEach((exp, i) => {
      const s = exp.strikes.find(x => x.moneyness_pct === m)
      const iv = m >= 0 ? s?.call_iv : s?.put_iv
      point[`exp_${i}`] = iv != null ? +(iv * 100).toFixed(1) : null
    })
    return point
  })
}

// ── Tooltips ──────────────────────────────────────────────────────────────────

const SmileTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null
  const visible = payload.filter((p: any) => p.value != null)
  if (!visible.length) return null
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-lg p-3 text-xs shadow-xl">
      <p className="font-semibold text-slate-200 mb-1">{Number(label) >= 0 ? '+' : ''}{label}% OTM</p>
      {visible.map((p: any) => (
        <div key={p.dataKey} className="flex justify-between gap-4" style={{ color: p.color }}>
          <span>{p.name}</span>
          <span className="font-mono font-semibold">{p.value?.toFixed(1)}%</span>
        </div>
      ))}
    </div>
  )
}

const TermTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-lg p-3 text-xs shadow-xl">
      <p className="font-semibold text-slate-200 mb-1">{label}h until expiry</p>
      {payload.filter((p: any) => p.value != null).map((p: any) => (
        <div key={p.dataKey} className="flex justify-between gap-4" style={{ color: p.color }}>
          <span>{p.name}</span>
          <span className="font-mono font-semibold">{p.value?.toFixed(1)}%</span>
        </div>
      ))}
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ATMCard({ label, value, color, subtitle }: { label: string; value: number | null; color: string; subtitle: string }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
      <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">{label}</p>
      <p className={`text-2xl font-bold font-mono ${color}`}>{value != null ? `${(value * 100).toFixed(1)}%` : '—'}</p>
      <p className="text-xs text-slate-600 mt-0.5">{subtitle}</p>
    </div>
  )
}

function Pill({ children, active, onClick }: { children: React.ReactNode; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`text-xs px-3 py-1 rounded-full border transition-colors ${active ? 'bg-slate-700 border-slate-500 text-slate-100' : 'border-slate-700 text-slate-500 hover:text-slate-300'}`}>
      {children}
    </button>
  )
}

function GapBadge({ gap }: { gap: number | null | undefined }) {
  if (gap == null) return <span className="text-slate-600">—</span>
  const abs = Math.abs(gap)
  const color = abs >= 15 ? (gap > 0 ? 'text-red-400' : 'text-blue-400')
    : abs >= 8 ? (gap > 0 ? 'text-yellow-400' : 'text-cyan-400')
    : 'text-slate-400'
  return <span className={`font-mono font-semibold ${color}`}>{gap > 0 ? '+' : ''}{gap.toFixed(1)}</span>
}

function ActionBadge({ action }: { action: string | null | undefined }) {
  if (!action) return <span className="text-slate-600 text-xs">—</span>
  const isBuyYes = action === 'BUY YES'
  return (
    <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${isBuyYes ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
      {action}
    </span>
  )
}

// ── Visualizations Tab ────────────────────────────────────────────────────────

function VisualizationsTab({ data }: { data: VolSurfaceData }) {
  const [chartView, setChartView] = useState<ChartView>('iv_compare')
  const [selectedExpiries, setSelectedExpiries] = useState<Set<number>>(
    () => new Set(data.derive_surface.map((_, i) => i))
  )

  // Reset selection when asset/surface changes
  useEffect(() => {
    setSelectedExpiries(new Set(data.derive_surface.map((_, i) => i)))
  }, [data.asset, data.derive_surface.length])

  function toggleExpiry(i: number) {
    setSelectedExpiries(prev => {
      const next = new Set(prev)
      next.has(i) ? next.delete(i) : next.add(i)
      return next
    })
  }

  const surface = data.derive_surface
  const polyPoints = data.poly_iv_points ?? []
  const atmIVs = data.atm_ivs
  const alerts: DivergenceAlert[] = data.divergence_alerts ?? []
  const synthForecastIV = data.synth_forecast_iv ?? null
  const tPolyHours = data.t_poly_hours

  const combinedSmileData = useMemo(() => buildCombinedSmileData(surface, polyPoints), [surface, polyPoints])
  const smileData = useMemo(() => buildSmileData(surface), [surface])

  // Term structure
  const termData = useMemo(() => {
    const map: Record<number, { tte_hours: number; derive_iv?: number; synth_iv?: number }> = {}
    surface.forEach(exp => {
      const atm = exp.strikes.reduce((b, s) => Math.abs(s.moneyness_pct) < Math.abs(b.moneyness_pct) ? s : b, exp.strikes[0])
      const iv = atm ? ((atm.call_iv ?? atm.put_iv ?? 0) * 100) : null
      map[exp.tte_hours] = { tte_hours: exp.tte_hours, derive_iv: iv != null ? +iv.toFixed(1) : undefined }
    })
    data.synth_term_structure.forEach(p => {
      if (!map[p.hours_ahead]) map[p.hours_ahead] = { tte_hours: p.hours_ahead }
      map[p.hours_ahead].synth_iv = +(p.atm_iv * 100).toFixed(1)
    })
    return Object.values(map).sort((a, b) => a.tte_hours - b.tte_hours)
  }, [surface, data.synth_term_structure])

  return (
    <div className="space-y-5">
      {/* ATM IV comparison cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Spot</p>
          <p className="text-2xl font-bold text-slate-100">${data.spot.toLocaleString()}</p>
          {tPolyHours != null && <p className="text-xs text-slate-600 mt-0.5">Poly settles in {tPolyHours.toFixed(1)}h</p>}
        </div>
        <ATMCard label="Derive ATM IV" value={atmIVs?.derive ?? null} color="text-orange-400" subtitle="Options market · TTE-adjusted" />
        <ATMCard label="SynthData IV"  value={atmIVs?.synth ?? null} color="text-slate-100" subtitle="AI forecast" />
        <ATMCard label="Poly ATM IV"   value={atmIVs?.poly ?? null}  color="text-purple-400" subtitle="Prediction market" />
      </div>

      {/* Divergence alerts */}
      {alerts.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Vol Divergence Alerts</p>
          {alerts.map((alert, i) => {
            const polyIsHigher = alert.higher_source === 'Polymarket'
            const implication = alert.source_a === 'Polymarket' || alert.source_b === 'Polymarket'
              ? polyIsHigher
                ? 'Poly overpriced → favor BUY NO'
                : 'Poly underpriced → favor BUY YES'
              : alert.higher_source === 'SynthData'
                ? 'AI model above options mkt → Derive underpriced'
                : 'Options mkt above AI model → Derive overpriced'
            return (
              <div key={i} className={`flex items-center gap-3 px-4 py-3 rounded-xl border text-sm ${alert.severity === 'HIGH' ? 'bg-red-500/10 border-red-500/30' : 'bg-yellow-500/10 border-yellow-500/30'}`}>
                <span className={`text-xs font-bold px-2 py-0.5 rounded-full shrink-0 ${alert.severity === 'HIGH' ? 'bg-red-500/30 text-red-300' : 'bg-yellow-500/30 text-yellow-300'}`}>
                  {alert.severity}
                </span>
                <div className="flex-1 min-w-0">
                  <span className={`font-semibold ${alert.severity === 'HIGH' ? 'text-red-200' : 'text-yellow-200'}`}>{alert.source_a}</span>
                  <span className="font-mono text-white ml-1">{(alert.iv_a * 100).toFixed(1)}%</span>
                  <span className="text-slate-500 mx-2">vs</span>
                  <span className={`font-semibold ${alert.severity === 'HIGH' ? 'text-red-200' : 'text-yellow-200'}`}>{alert.source_b}</span>
                  <span className="font-mono text-white ml-1">{(alert.iv_b * 100).toFixed(1)}%</span>
                  <span className="ml-2 text-slate-400">— <span className="font-bold text-white">{alert.gap_vol_pts.toFixed(1)} vol pts</span></span>
                  <span className="ml-2 text-slate-500 text-xs">{implication}</span>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Chart view selector */}
      <div className="flex items-center gap-1">
        <Pill active={chartView === 'iv_compare'} onClick={() => setChartView('iv_compare')}>IV Comparison</Pill>
        <Pill active={chartView === 'smile'} onClick={() => setChartView('smile')}>Vol Smile</Pill>
        <Pill active={chartView === 'term'} onClick={() => setChartView('term')}>Term Structure</Pill>
      </div>

      {/* IV Comparison */}
      {chartView === 'iv_compare' && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-slate-300 mb-1">Three-Way Implied Volatility — {data.asset}</h3>
          <p className="text-xs text-slate-500 mb-3">Derive smile (colored lines) · SynthData forecast (white dashed) · Poly-implied IV (purple dots) · Derive IV variance-adjusted to T_poly</p>
          <div className="flex flex-wrap gap-2 mb-4 text-xs items-center">
            {surface.map((exp, i) => {
              const on = selectedExpiries.has(i)
              return (
                <button key={exp.expiry} onClick={() => toggleExpiry(i)}
                  className={`flex items-center gap-1.5 px-2 py-1 rounded-md border transition-all ${on ? 'border-slate-600 opacity-100' : 'border-slate-800 opacity-35'}`}>
                  <span className="w-4 h-0.5 rounded inline-block" style={{ background: EXPIRY_COLOURS[i % EXPIRY_COLOURS.length] }} />
                  <span className={on ? 'text-slate-300' : 'text-slate-600'}>{exp.label}</span>
                </button>
              )
            })}
            <button onClick={() => setSelectedExpiries(new Set(surface.map((_, i) => i)))}
              className="text-slate-600 hover:text-slate-400 px-1 transition-colors">all</button>
            <button onClick={() => setSelectedExpiries(new Set())}
              className="text-slate-600 hover:text-slate-400 px-1 transition-colors">none</button>
            {synthForecastIV != null && (
              <div className="flex items-center gap-1.5 ml-2">
                <span className="inline-block w-5 border-t-2 border-dashed border-slate-300" style={{ marginTop: 1 }} />
                <span className="text-slate-300">SynthData {(synthForecastIV * 100).toFixed(0)}%</span>
              </div>
            )}
            {polyPoints.length > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-purple-500 inline-block" />
                <span className="text-purple-300">Poly IV ({polyPoints.length} pts)</span>
              </div>
            )}
          </div>
          <ResponsiveContainer width="100%" height={340}>
            <ComposedChart data={combinedSmileData} margin={{ top: 10, right: 20, left: 10, bottom: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="moneyness" type="number" tickFormatter={(v) => `${v > 0 ? '+' : ''}${v}%`} tick={{ fill: '#64748b', fontSize: 11 }} axisLine={{ stroke: '#334155' }} tickLine={false} />
              <YAxis tickFormatter={(v) => `${v}%`} tick={{ fill: '#64748b', fontSize: 11 }} axisLine={{ stroke: '#334155' }} tickLine={false} width={40} label={{ value: 'IV', angle: -90, position: 'insideLeft', fill: '#475569', fontSize: 10, dx: -4 }} />
              <Tooltip content={<SmileTooltip />} />
              <ReferenceLine x={0} stroke="#475569" strokeDasharray="6 3" />
              {synthForecastIV != null && (
                <ReferenceLine y={+(synthForecastIV * 100).toFixed(1)} stroke="#e2e8f0" strokeDasharray="8 4" strokeWidth={1.5} label={{ value: `SynthData ${(synthForecastIV * 100).toFixed(0)}%`, fill: '#94a3b8', fontSize: 10, position: 'insideTopRight' }} />
              )}
              {surface.map((exp, i) => selectedExpiries.has(i) && (
                <Line key={exp.expiry} type="monotone" dataKey={`exp_${i}`} name={exp.label} stroke={EXPIRY_COLOURS[i % EXPIRY_COLOURS.length]} strokeWidth={2} dot={false} connectNulls />
              ))}
              {polyPoints.length > 0 && (
                <Line type="linear" dataKey="poly_iv" name="Poly IV" stroke="#a855f7" strokeWidth={0} dot={{ r: 5, fill: '#a855f7', stroke: '#c084fc', strokeWidth: 1.5 }} activeDot={{ r: 7, fill: '#c084fc' }} connectNulls={false} isAnimationActive={false} />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Vol Smile */}
      {chartView === 'smile' && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-slate-300 mb-3">IV Smile — {data.asset} · OTM calls (right) / puts (left)</h3>
          <div className="flex flex-wrap gap-2 mb-4 items-center">
            {surface.map((exp, i) => {
              const on = selectedExpiries.has(i)
              return (
                <button key={exp.expiry} onClick={() => toggleExpiry(i)}
                  className={`flex items-center gap-1.5 px-2 py-1 rounded-md border text-xs transition-all ${on ? 'border-slate-600 opacity-100' : 'border-slate-800 opacity-35'}`}>
                  <span className="w-4 h-0.5 rounded inline-block" style={{ background: EXPIRY_COLOURS[i % EXPIRY_COLOURS.length] }} />
                  <span className={on ? 'text-slate-300' : 'text-slate-600'}>{exp.label}</span>
                </button>
              )
            })}
            <button onClick={() => setSelectedExpiries(new Set(surface.map((_, i) => i)))}
              className="text-xs text-slate-600 hover:text-slate-400 px-1 transition-colors">all</button>
            <button onClick={() => setSelectedExpiries(new Set())}
              className="text-xs text-slate-600 hover:text-slate-400 px-1 transition-colors">none</button>
          </div>
          <ResponsiveContainer width="100%" height={320}>
            <ComposedChart data={smileData} margin={{ top: 10, right: 20, left: 10, bottom: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="moneyness" type="number" tickFormatter={(v) => `${v > 0 ? '+' : ''}${v}%`} tick={{ fill: '#64748b', fontSize: 11 }} axisLine={{ stroke: '#334155' }} tickLine={false} />
              <YAxis tickFormatter={(v) => `${v}%`} tick={{ fill: '#64748b', fontSize: 11 }} axisLine={{ stroke: '#334155' }} tickLine={false} width={40} />
              <Tooltip content={<SmileTooltip />} />
              <ReferenceLine x={0} stroke="#475569" strokeDasharray="6 3" label={{ value: 'ATM', fill: '#64748b', fontSize: 10 }} />
              {surface.map((exp, i) => selectedExpiries.has(i) && (
                <Line key={exp.expiry} type="monotone" dataKey={`exp_${i}`} name={exp.label} stroke={EXPIRY_COLOURS[i % EXPIRY_COLOURS.length]} strokeWidth={2} dot={false} connectNulls />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Term Structure */}
      {chartView === 'term' && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-slate-300 mb-1">ATM IV Term Structure — {data.asset}</h3>
          <p className="text-xs text-slate-500 mb-4">Orange = Derive · White dashed = SynthData AI</p>
          <ResponsiveContainer width="100%" height={300}>
            <ComposedChart data={termData} margin={{ top: 10, right: 20, left: 10, bottom: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="tte_hours" tickFormatter={(v) => `${v}h`} tick={{ fill: '#64748b', fontSize: 11 }} axisLine={{ stroke: '#334155' }} tickLine={false} />
              <YAxis tickFormatter={(v) => `${v}%`} tick={{ fill: '#64748b', fontSize: 11 }} axisLine={{ stroke: '#334155' }} tickLine={false} width={40} />
              <Tooltip content={<TermTooltip />} />
              <Line type="monotone" dataKey="derive_iv" name="Derive ATM IV" stroke="#f97316" strokeWidth={2.5} dot={{ fill: '#f97316', r: 4 }} connectNulls />
              <Line type="monotone" dataKey="synth_iv" name="SynthData implied IV" stroke="#e2e8f0" strokeWidth={2} strokeDasharray="5 3" dot={{ fill: '#e2e8f0', r: 3 }} connectNulls />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Skew snapshot table */}
      {surface.length > 0 && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800">
            <p className="text-sm font-semibold text-slate-300">Skew Snapshot</p>
            <p className="text-xs text-slate-500">Call IV at ATM / ±5% / +10% per expiry</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-800/50">
                  <th className="px-4 py-2 text-left text-slate-400">Expiry</th>
                  <th className="px-4 py-2 text-right text-slate-400">TTE</th>
                  <th className="px-4 py-2 text-right text-orange-400">−5% put</th>
                  <th className="px-4 py-2 text-right text-yellow-400">ATM</th>
                  <th className="px-4 py-2 text-right text-green-400">+5% call</th>
                  <th className="px-4 py-2 text-right text-cyan-400">+10% call</th>
                </tr>
              </thead>
              <tbody>
                {surface.map(exp => {
                  const atmS = exp.strikes.find(s => Math.abs(s.moneyness_pct) <= 1)
                  const p5 = exp.strikes.find(s => Math.abs(s.moneyness_pct + 5) <= 1)
                  const c5 = exp.strikes.find(s => Math.abs(s.moneyness_pct - 5) <= 1)
                  const c10 = exp.strikes.find(s => Math.abs(s.moneyness_pct - 10) <= 2)
                  const ivFmt = (s: typeof atmS, k: 'call_iv' | 'put_iv') => s?.[k] != null ? `${(s[k]! * 100).toFixed(0)}%` : '—'
                  return (
                    <tr key={exp.expiry} className="border-b border-slate-800/50 hover:bg-slate-800/20">
                      <td className="px-4 py-2 font-mono text-slate-300">{exp.label}</td>
                      <td className="px-4 py-2 text-right text-slate-500">{exp.tte_hours.toFixed(1)}h</td>
                      <td className="px-4 py-2 text-right font-mono text-orange-400">{ivFmt(p5, 'put_iv')}</td>
                      <td className="px-4 py-2 text-right font-mono text-yellow-400">{atmS?.call_iv != null ? `${(atmS.call_iv * 100).toFixed(0)}%` : '—'}</td>
                      <td className="px-4 py-2 text-right font-mono text-green-400">{ivFmt(c5, 'call_iv')}</td>
                      <td className="px-4 py-2 text-right font-mono text-cyan-400">{ivFmt(c10, 'call_iv')}</td>
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

// ── Order Book Panel ──────────────────────────────────────────────────────────

function OrderBookPanel({ tokenId, onClose }: { tokenId: string; onClose: () => void }) {
  const [book, setBook] = useState<OrderBook | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetch(`/api/poly/orderbook/${tokenId}`)
      .then(r => r.json())
      .then(d => { setBook(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [tokenId])

  const maxSize = book
    ? Math.max(...[...book.bids, ...book.asks].map(l => l.size), 0.01)
    : 1

  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-slate-200">Order Book</p>
          {book?.midpoint != null && (
            <p className="text-xs text-slate-400 font-mono">
              Mid: <span className="text-white">{(book.midpoint * 100).toFixed(1)}¢</span>
              {book.spread != null && <span className="text-slate-500 ml-2">Spread: {(book.spread * 100).toFixed(1)}¢</span>}
            </p>
          )}
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-300 text-lg leading-none">×</button>
      </div>

      {loading ? (
        <p className="text-xs text-slate-500 py-2">Loading…</p>
      ) : book?.error ? (
        <p className="text-xs text-red-400">Error: {book.error}</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 text-xs">
          {/* Bids */}
          <div>
            <p className="text-green-400 font-semibold mb-1.5">Bids (YES)</p>
            {book!.bids.length === 0 ? <p className="text-slate-600">—</p> : book!.bids.map((lvl, i) => (
              <div key={i} className="flex items-center gap-2 mb-0.5">
                <div className="h-3 bg-green-500/20 rounded-sm" style={{ width: `${(lvl.size / maxSize) * 80}px` }} />
                <span className="font-mono text-green-300 w-10 text-right">{(lvl.price * 100).toFixed(1)}¢</span>
                <span className="font-mono text-slate-500 w-12 text-right">{lvl.size.toFixed(0)}</span>
              </div>
            ))}
          </div>
          {/* Asks */}
          <div>
            <p className="text-red-400 font-semibold mb-1.5">Asks (YES)</p>
            {book!.asks.length === 0 ? <p className="text-slate-600">—</p> : book!.asks.map((lvl, i) => (
              <div key={i} className="flex items-center gap-2 mb-0.5">
                <div className="h-3 bg-red-500/20 rounded-sm" style={{ width: `${(lvl.size / maxSize) * 80}px` }} />
                <span className="font-mono text-red-300 w-10 text-right">{(lvl.price * 100).toFixed(1)}¢</span>
                <span className="font-mono text-slate-500 w-12 text-right">{lvl.size.toFixed(0)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {book?.tick_size && <p className="text-xs text-slate-600">Tick size: {book.tick_size}</p>}
    </div>
  )
}

// ── Markets Tab ───────────────────────────────────────────────────────────────

function MarketsTab({ data }: { data: VolSurfaceData }) {
  const [search, setSearch] = useState('')
  const [marketSubTab, setMarketSubTab] = useState<MarketSubTab>('above_below')
  const [gapFilter, setGapFilter] = useState<'all' | '5' | '10' | '15'>('all')
  const [sortKey, setSortKey] = useState<SortKey>('iv_gap_pts')
  const [sortAsc, setSortAsc] = useState(false)
  const [selectedToken, setSelectedToken] = useState<string | null>(null)

  const polyPoints = data.poly_iv_points ?? []

  const aboveBelow = polyPoints.filter(p => p.market_type === 'above_below')
  const ranges = polyPoints.filter(p => p.market_type === 'daily_range')

  const filtered = useMemo(() => {
    let rows = marketSubTab === 'above_below' ? aboveBelow : ranges
    if (search) {
      const q = search.toLowerCase()
      rows = rows.filter(p => (p.question ?? '').toLowerCase().includes(q) || String(p.strike).includes(q))
    }
    if (gapFilter !== 'all') {
      const threshold = Number(gapFilter)
      rows = rows.filter(p => p.iv_gap_pts != null && Math.abs(p.iv_gap_pts) >= threshold)
    }
    return [...rows].sort((a, b) => {
      const av = a[sortKey] ?? -Infinity
      const bv = b[sortKey] ?? -Infinity
      const diff = (av as number) - (bv as number)
      return sortAsc ? diff : -diff
    })
  }, [polyPoints, search, marketSubTab, gapFilter, sortKey, sortAsc, aboveBelow, ranges])

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc(p => !p)
    else { setSortKey(key); setSortAsc(false) }
  }

  function SortTh({ label, k }: { label: string; k: SortKey }) {
    const active = sortKey === k
    return (
      <th onClick={() => toggleSort(k)} className="px-4 py-2 text-right text-slate-400 cursor-pointer hover:text-slate-200 select-none bg-slate-800/50">
        {label}{active ? (sortAsc ? ' ↑' : ' ↓') : ''}
      </th>
    )
  }

  const formatStrike = (p: PolyIVPoint) => {
    if (p.market_type === 'daily_range' && p.strike) {
      const lo = Math.round(p.strike * 0.98) // rough bounds for display
      return `~$${p.strike.toLocaleString()}`
    }
    return p.strike ? `$${p.strike.toLocaleString()}` : '—'
  }

  return (
    <div className="space-y-4">
      {/* Market type sub-tabs */}
      <div className="flex items-center gap-2 border-b border-slate-800 pb-3">
        <button onClick={() => setMarketSubTab('above_below')}
          className={`text-sm px-4 py-1.5 rounded-lg font-medium transition-colors ${marketSubTab === 'above_below' ? 'bg-blue-600/30 text-blue-300 border border-blue-500/30' : 'text-slate-500 hover:text-slate-300'}`}>
          Above / Below <span className="ml-1 text-xs opacity-70">({aboveBelow.length})</span>
        </button>
        <button onClick={() => setMarketSubTab('daily_range')}
          className={`text-sm px-4 py-1.5 rounded-lg font-medium transition-colors ${marketSubTab === 'daily_range' ? 'bg-violet-600/30 text-violet-300 border border-violet-500/30' : 'text-slate-500 hover:text-slate-300'}`}>
          Range <span className="ml-1 text-xs opacity-70">({ranges.length})</span>
        </button>
      </div>

      {/* Search + filters */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          placeholder="Search markets…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="flex-1 min-w-48 bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-slate-500"
        />
        <div className="flex gap-1">
          <Pill active={gapFilter === 'all'} onClick={() => setGapFilter('all')}>All gaps</Pill>
          <Pill active={gapFilter === '5'} onClick={() => setGapFilter('5')}>&gt;5 pts</Pill>
          <Pill active={gapFilter === '10'} onClick={() => setGapFilter('10')}>&gt;10 pts</Pill>
          <Pill active={gapFilter === '15'} onClick={() => setGapFilter('15')}>&gt;15 pts</Pill>
        </div>
        <span className="text-xs text-slate-500">{filtered.length} markets</span>
      </div>

      {/* Order book panel */}
      {selectedToken && (
        <OrderBookPanel tokenId={selectedToken} onClose={() => setSelectedToken(null)} />
      )}

      {/* Markets table */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-800">
                <th className="px-4 py-2 text-left text-slate-400 bg-slate-800/50 min-w-64">Market</th>
                <th className="px-4 py-2 text-left text-slate-400 bg-slate-800/50">Type</th>
                <SortTh label="Strike" k="moneyness_pct" />
                <SortTh label="Yes Price" k="yes_price" />
                <SortTh label="Poly IV" k="poly_iv" />
                <SortTh label="Derive IV†" k="derive_iv" />
                <SortTh label="Gap (pts)" k="iv_gap_pts" />
                <th className="px-4 py-2 text-right text-slate-400 bg-slate-800/50">Action</th>
                <SortTh label="Vol 24h" k="volume_24h" />
                <th className="px-4 py-2 bg-slate-800/50" />
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-4 py-8 text-center text-slate-500">No markets match your filters</td>
                </tr>
              ) : filtered.map((p, i) => {
                const gapAbs = p.iv_gap_pts != null ? Math.abs(p.iv_gap_pts) : 0
                const rowHighlight = gapAbs >= 15 ? 'border-l-2 border-red-500/50' : gapAbs >= 8 ? 'border-l-2 border-yellow-500/50' : ''
                return (
                  <tr key={i}
                    className={`border-b border-slate-800/50 hover:bg-slate-800/30 cursor-pointer ${rowHighlight} ${p.clob_token_id && selectedToken === p.clob_token_id ? 'bg-slate-800/50' : ''}`}
                    onClick={() => p.clob_token_id && setSelectedToken(prev => prev === p.clob_token_id ? null : p.clob_token_id!)}
                  >
                    <td className="px-4 py-2.5">
                      <p className="text-slate-200 leading-tight truncate max-w-xs" title={p.question}>{p.question || '—'}</p>
                      <p className="text-slate-500 font-mono mt-0.5">{p.moneyness_pct >= 0 ? '+' : ''}{p.moneyness_pct.toFixed(1)}% OTM</p>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${p.market_type === 'above_below' ? 'bg-blue-500/20 text-blue-300' : 'bg-violet-500/20 text-violet-300'}`}>
                        {p.market_type === 'above_below' ? 'A/B' : 'RANGE'}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-slate-300">{formatStrike(p)}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-slate-300">{(p.yes_price * 100).toFixed(1)}¢</td>
                    <td className="px-4 py-2.5 text-right font-mono text-purple-300 font-semibold">{(p.poly_iv * 100).toFixed(1)}%</td>
                    <td className="px-4 py-2.5 text-right font-mono text-orange-300">
                      {p.derive_iv != null ? `${(p.derive_iv * 100).toFixed(1)}%` : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right"><GapBadge gap={p.iv_gap_pts} /></td>
                    <td className="px-4 py-2.5 text-right"><ActionBadge action={p.action} /></td>
                    <td className="px-4 py-2.5 text-right text-slate-500">
                      {p.volume_24h != null ? `$${(p.volume_24h / 1000).toFixed(0)}k` : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      {p.polymarket_url ? (
                        <a href={p.polymarket_url} target="_blank" rel="noopener noreferrer" className="text-slate-600 hover:text-slate-300 transition-colors">↗</a>
                      ) : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-2 border-t border-slate-800 text-xs text-slate-600">
          † Derive IV variance-interpolated to Poly settlement TTE · Gap = Poly IV − Derive IV in vol points · BUY NO when YES overpriced vs BSM
        </div>
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function VolSurface({ asset }: Props) {
  const [data, setData] = useState<VolSurfaceData | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<TopTab>('visualizations')

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      try {
        const res = await fetch(`/api/vol_surface/${asset}`)
        if (res.ok) setData(await res.json())
      } catch (e) { console.error(e) }
      finally { setLoading(false) }
    }
    load()
    const id = setInterval(load, 60000)
    return () => clearInterval(id)
  }, [asset])

  if (loading && !data) {
    return <div className="flex items-center justify-center h-64 text-slate-400 text-sm">Loading vol surface…</div>
  }
  if (!data || (!data.derive_surface.length && !data.synth_term_structure.length)) {
    return <div className="flex items-center justify-center h-48 text-slate-500 text-sm">No vol surface data available (requires live mode)</div>
  }

  return (
    <div className="space-y-5">
      {/* Top-level tabs */}
      <div className="flex items-center gap-2 border-b border-slate-800 pb-3">
        {(['visualizations', 'markets'] as TopTab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`text-sm px-4 py-1.5 rounded-lg font-medium transition-colors ${tab === t ? 'bg-slate-700 text-slate-100' : 'text-slate-500 hover:text-slate-300'}`}
          >
            {t === 'visualizations' ? 'Visualizations' : `Markets${data.poly_iv_points?.length ? ` (${data.poly_iv_points.length})` : ''}`}
          </button>
        ))}
      </div>

      {tab === 'visualizations' ? <VisualizationsTab data={data} /> : <MarketsTab data={data} />}
    </div>
  )
}
