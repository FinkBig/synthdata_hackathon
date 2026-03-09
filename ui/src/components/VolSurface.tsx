import { useEffect, useState } from 'react'
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
import { VolSurfaceData, VolSurfaceExpiry, PolyIVPoint, DivergenceAlert } from '../types'

interface Props {
  asset: string
}

// Colour ramp: short TTE → red-orange, long TTE → blue-purple
const EXPIRY_COLOURS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#06b6d4', '#6366f1', '#a855f7', '#ec4899',
]

type SmileView = 'iv_compare' | 'smile' | 'term'

// Build combined dataset: derive IVs + poly IV dots, indexed by moneyness
function buildCombinedSmileData(surface: VolSurfaceExpiry[], polyPoints: PolyIVPoint[]) {
  const moneySet = new Set<number>()
  surface.forEach(exp => exp.strikes.forEach(s => moneySet.add(s.moneyness_pct)))
  // Round poly moneyness to nearest 0.5 to avoid float jitter
  polyPoints.forEach(p => moneySet.add(Math.round(p.moneyness_pct * 2) / 2))
  const moneyKeys = Array.from(moneySet).sort((a, b) => a - b)

  return moneyKeys.map(m => {
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

// Derive-only smile data (for the standalone Vol Smile view)
function buildSmileData(surface: VolSurfaceExpiry[]) {
  const moneySet = new Set<number>()
  surface.forEach(exp => exp.strikes.forEach(s => moneySet.add(s.moneyness_pct)))
  const moneyKeys = Array.from(moneySet).sort((a, b) => a - b)
  return moneyKeys.map(m => {
    const point: Record<string, number | null> = { moneyness: m }
    surface.forEach((exp, i) => {
      const s = exp.strikes.find(x => x.moneyness_pct === m)
      const iv = m >= 0 ? s?.call_iv : s?.put_iv
      point[`exp_${i}`] = iv != null ? +(iv * 100).toFixed(1) : null
    })
    return point
  })
}

const SmileTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null
  const visible = payload.filter((p: any) => p.value != null)
  if (!visible.length) return null
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-lg p-3 text-xs shadow-xl">
      <p className="font-semibold text-slate-200 mb-1">
        {Number(label) >= 0 ? '+' : ''}{label}% OTM
      </p>
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

export default function VolSurface({ asset }: Props) {
  const [data, setData] = useState<VolSurfaceData | null>(null)
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<SmileView>('iv_compare')

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      try {
        const res = await fetch(`/api/vol_surface/${asset}`)
        if (res.ok) setData(await res.json())
      } catch (e) {
        console.error(e)
      } finally {
        setLoading(false)
      }
    }
    load()
    const id = setInterval(load, 60000)
    return () => clearInterval(id)
  }, [asset])

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center h-64 text-slate-400 text-sm">
        Loading vol surface...
      </div>
    )
  }

  if (!data || (!data.derive_surface.length && !data.synth_term_structure.length)) {
    return (
      <div className="flex items-center justify-center h-48 text-slate-500 text-sm">
        No vol surface data available (requires live mode)
      </div>
    )
  }

  const surface = data.derive_surface
  const polyPoints = data.poly_iv_points ?? []
  const atmIVs = data.atm_ivs
  const alerts: DivergenceAlert[] = data.divergence_alerts ?? []
  const synthForecastIV = data.synth_forecast_iv ?? null

  const combinedSmileData = buildCombinedSmileData(surface, polyPoints)
  const smileData = buildSmileData(surface)

  // Term structure
  const deriveTermData = surface.map(exp => {
    const atmStrike = exp.strikes.reduce((best, s) =>
      Math.abs(s.moneyness_pct) < Math.abs(best.moneyness_pct) ? s : best,
      exp.strikes[0]
    )
    const iv = atmStrike ? ((atmStrike.call_iv ?? atmStrike.put_iv ?? 0) * 100) : null
    return { tte_hours: exp.tte_hours, derive_iv: iv != null ? +iv.toFixed(1) : null }
  })
  const synthTermData = data.synth_term_structure.map(p => ({
    tte_hours: p.hours_ahead,
    synth_iv: +(p.atm_iv * 100).toFixed(1),
  }))
  const termMap: Record<number, { tte_hours: number; derive_iv?: number; synth_iv?: number }> = {}
  deriveTermData.forEach(d => { termMap[d.tte_hours] = { tte_hours: d.tte_hours, derive_iv: d.derive_iv ?? undefined } })
  synthTermData.forEach(d => {
    if (!termMap[d.tte_hours]) termMap[d.tte_hours] = { tte_hours: d.tte_hours }
    termMap[d.tte_hours].synth_iv = d.synth_iv
  })
  const termData = Object.values(termMap).sort((a, b) => a.tte_hours - b.tte_hours)

  return (
    <div className="space-y-6">

      {/* ATM IV Comparison — top stat row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Spot</p>
          <p className="text-xl font-bold text-slate-100">${data.spot.toLocaleString()}</p>
        </div>
        <ATMCard
          label="Derive ATM IV"
          value={atmIVs?.derive ?? null}
          color="text-orange-400"
          subtitle="Options market"
        />
        <ATMCard
          label="SynthData IV"
          value={atmIVs?.synth ?? null}
          color="text-slate-100"
          subtitle="AI forecast"
        />
        <ATMCard
          label="Poly ATM IV"
          value={atmIVs?.poly ?? null}
          color="text-purple-400"
          subtitle="Prediction market"
        />
      </div>

      {/* Divergence Alerts */}
      {alerts.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
            Vol Divergence Alerts
          </p>
          {alerts.map((alert, i) => (
            <div
              key={i}
              className={`flex items-center gap-3 px-4 py-3 rounded-xl border text-sm ${
                alert.severity === 'HIGH'
                  ? 'bg-red-500/10 border-red-500/30'
                  : 'bg-yellow-500/10 border-yellow-500/30'
              }`}
            >
              <span className={`text-xs font-bold px-2 py-0.5 rounded-full shrink-0 ${
                alert.severity === 'HIGH'
                  ? 'bg-red-500/30 text-red-300'
                  : 'bg-yellow-500/30 text-yellow-300'
              }`}>
                {alert.severity}
              </span>
              <div className={`flex-1 ${alert.severity === 'HIGH' ? 'text-red-200' : 'text-yellow-200'}`}>
                <span className="font-semibold">{alert.source_a}</span>
                <span className="font-mono ml-1 text-white">{(alert.iv_a * 100).toFixed(1)}%</span>
                <span className="text-slate-400 mx-2">vs</span>
                <span className="font-semibold">{alert.source_b}</span>
                <span className="font-mono ml-1 text-white">{(alert.iv_b * 100).toFixed(1)}%</span>
                <span className="ml-3 text-slate-400">
                  — <span className="font-bold text-white">{alert.gap_vol_pts.toFixed(1)} vol pts</span> divergence
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* View toggle */}
      <div className="flex items-center gap-1">
        <ViewBtn active={view === 'iv_compare'} onClick={() => setView('iv_compare')}>IV Comparison</ViewBtn>
        <ViewBtn active={view === 'smile'} onClick={() => setView('smile')}>Vol Smile</ViewBtn>
        <ViewBtn active={view === 'term'} onClick={() => setView('term')}>Term Structure</ViewBtn>
      </div>

      {/* IV Comparison — three sources on one chart */}
      {view === 'iv_compare' && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-slate-300 mb-1">
            Three-Way Implied Volatility — {asset}
          </h3>
          <p className="text-xs text-slate-500 mb-3">
            Derive option smile (colored lines) · SynthData forecast (white dashed) · Polymarket-implied IV (purple dots)
          </p>
          <div className="flex flex-wrap gap-4 mb-4 text-xs">
            {surface.slice(0, 4).map((exp, i) => (
              <div key={exp.expiry} className="flex items-center gap-1.5">
                <span className="w-5 h-0.5 rounded inline-block" style={{ background: EXPIRY_COLOURS[i] }} />
                <span className="text-slate-400">{exp.label}</span>
              </div>
            ))}
            {synthForecastIV != null && (
              <div className="flex items-center gap-1.5">
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
              <XAxis
                dataKey="moneyness"
                type="number"
                tickFormatter={(v) => `${v > 0 ? '+' : ''}${v}%`}
                tick={{ fill: '#64748b', fontSize: 11 }}
                axisLine={{ stroke: '#334155' }}
                tickLine={false}
              />
              <YAxis
                tickFormatter={(v) => `${v}%`}
                tick={{ fill: '#64748b', fontSize: 11 }}
                axisLine={{ stroke: '#334155' }}
                tickLine={false}
                width={40}
                label={{ value: 'IV', angle: -90, position: 'insideLeft', fill: '#475569', fontSize: 10, dx: -4 }}
              />
              <Tooltip content={<SmileTooltip />} />
              <ReferenceLine x={0} stroke="#475569" strokeDasharray="6 3" />
              {synthForecastIV != null && (
                <ReferenceLine
                  y={+(synthForecastIV * 100).toFixed(1)}
                  stroke="#e2e8f0"
                  strokeDasharray="8 4"
                  strokeWidth={1.5}
                  label={{
                    value: `SynthData ${(synthForecastIV * 100).toFixed(0)}%`,
                    fill: '#94a3b8',
                    fontSize: 10,
                    position: 'insideTopRight',
                  }}
                />
              )}
              {surface.map((exp, i) => (
                <Line
                  key={exp.expiry}
                  type="monotone"
                  dataKey={`exp_${i}`}
                  name={exp.label}
                  stroke={EXPIRY_COLOURS[i % EXPIRY_COLOURS.length]}
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                />
              ))}
              {polyPoints.length > 0 && (
                <Line
                  type="linear"
                  dataKey="poly_iv"
                  name="Poly IV"
                  stroke="#a855f7"
                  strokeWidth={0}
                  dot={{ r: 5, fill: '#a855f7', stroke: '#c084fc', strokeWidth: 1.5 }}
                  activeDot={{ r: 7, fill: '#c084fc' }}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Vol Smile — Derive only */}
      {view === 'smile' && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-slate-300 mb-3">
            IV Smile — {asset} · by expiry · OTM calls (right) / puts (left)
          </h3>
          <div className="flex flex-wrap gap-3 mb-4">
            {surface.map((exp, i) => (
              <div key={exp.expiry} className="flex items-center gap-1.5 text-xs">
                <span className="w-3 h-0.5 rounded inline-block" style={{ background: EXPIRY_COLOURS[i % EXPIRY_COLOURS.length] }} />
                <span className="text-slate-400">{exp.label}</span>
              </div>
            ))}
          </div>
          <ResponsiveContainer width="100%" height={320}>
            <ComposedChart data={smileData} margin={{ top: 10, right: 20, left: 10, bottom: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis
                dataKey="moneyness"
                type="number"
                tickFormatter={(v) => `${v > 0 ? '+' : ''}${v}%`}
                tick={{ fill: '#64748b', fontSize: 11 }}
                axisLine={{ stroke: '#334155' }}
                tickLine={false}
              />
              <YAxis
                tickFormatter={(v) => `${v}%`}
                tick={{ fill: '#64748b', fontSize: 11 }}
                axisLine={{ stroke: '#334155' }}
                tickLine={false}
                width={40}
                label={{ value: 'IV', angle: -90, position: 'insideLeft', fill: '#475569', fontSize: 10, dx: -4 }}
              />
              <Tooltip content={<SmileTooltip />} />
              <ReferenceLine x={0} stroke="#475569" strokeDasharray="6 3" label={{ value: 'ATM', fill: '#64748b', fontSize: 10 }} />
              {surface.map((exp, i) => (
                <Line
                  key={exp.expiry}
                  type="monotone"
                  dataKey={`exp_${i}`}
                  name={exp.label}
                  stroke={EXPIRY_COLOURS[i % EXPIRY_COLOURS.length]}
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Term Structure */}
      {view === 'term' && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-slate-300 mb-1">
            ATM IV Term Structure — {asset}
          </h3>
          <p className="text-xs text-slate-500 mb-4">
            Orange = Derive (options market) · White = SynthData AI (IQR-implied vol)
          </p>
          <ResponsiveContainer width="100%" height={300}>
            <ComposedChart data={termData} margin={{ top: 10, right: 20, left: 10, bottom: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis
                dataKey="tte_hours"
                tickFormatter={(v) => `${v}h`}
                tick={{ fill: '#64748b', fontSize: 11 }}
                axisLine={{ stroke: '#334155' }}
                tickLine={false}
                label={{ value: 'Time to expiry', position: 'insideBottom', offset: -5, fill: '#475569', fontSize: 10 }}
              />
              <YAxis
                tickFormatter={(v) => `${v}%`}
                tick={{ fill: '#64748b', fontSize: 11 }}
                axisLine={{ stroke: '#334155' }}
                tickLine={false}
                width={40}
                label={{ value: 'ATM IV', angle: -90, position: 'insideLeft', fill: '#475569', fontSize: 10, dx: -4 }}
              />
              <Tooltip content={<TermTooltip />} />
              <Line
                type="monotone"
                dataKey="derive_iv"
                name="Derive ATM IV"
                stroke="#f97316"
                strokeWidth={2.5}
                dot={{ fill: '#f97316', r: 4 }}
                connectNulls
              />
              <Line
                type="monotone"
                dataKey="synth_iv"
                name="SynthData implied IV"
                stroke="#e2e8f0"
                strokeWidth={2}
                strokeDasharray="5 3"
                dot={{ fill: '#e2e8f0', r: 3 }}
                connectNulls
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Skew table: ATM, +5%, -5% IVs per expiry */}
      {surface.length > 0 && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800">
            <p className="text-sm font-semibold text-slate-300">Skew Snapshot</p>
            <p className="text-xs text-slate-500">Call IV at ATM / +5% / +10% for each expiry</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-800">
                  <th className="px-4 py-2 text-left text-slate-400 bg-slate-800/50">Expiry</th>
                  <th className="px-4 py-2 text-right text-slate-400 bg-slate-800/50">TTE</th>
                  <th className="px-4 py-2 text-right text-orange-400 bg-slate-800/50">−5% put</th>
                  <th className="px-4 py-2 text-right text-yellow-400 bg-slate-800/50">ATM</th>
                  <th className="px-4 py-2 text-right text-green-400 bg-slate-800/50">+5% call</th>
                  <th className="px-4 py-2 text-right text-cyan-400 bg-slate-800/50">+10% call</th>
                </tr>
              </thead>
              <tbody>
                {surface.map(exp => {
                  const atmS = exp.strikes.find(s => Math.abs(s.moneyness_pct) <= 1)
                  const p5 = exp.strikes.find(s => Math.abs(s.moneyness_pct + 5) <= 1)
                  const c5 = exp.strikes.find(s => Math.abs(s.moneyness_pct - 5) <= 1)
                  const c10 = exp.strikes.find(s => Math.abs(s.moneyness_pct - 10) <= 2)
                  const iv = (s: typeof atmS, k: 'call_iv' | 'put_iv') =>
                    s?.[k] != null ? `${(s[k]! * 100).toFixed(0)}%` : '—'
                  return (
                    <tr key={exp.expiry} className="border-b border-slate-800/50 hover:bg-slate-800/20">
                      <td className="px-4 py-2 font-mono text-slate-300">{exp.label}</td>
                      <td className="px-4 py-2 text-right text-slate-500">{exp.tte_hours.toFixed(1)}h</td>
                      <td className="px-4 py-2 text-right font-mono text-orange-400">{iv(p5, 'put_iv')}</td>
                      <td className="px-4 py-2 text-right font-mono text-yellow-400">
                        {atmS?.call_iv != null ? `${(atmS.call_iv * 100).toFixed(0)}%` : '—'}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-green-400">{iv(c5, 'call_iv')}</td>
                      <td className="px-4 py-2 text-right font-mono text-cyan-400">{iv(c10, 'call_iv')}</td>
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

function ATMCard({ label, value, color, subtitle }: {
  label: string
  value: number | null
  color: string
  subtitle: string
}) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
      <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">{label}</p>
      <p className={`text-2xl font-bold font-mono ${color}`}>
        {value != null ? `${(value * 100).toFixed(1)}%` : '—'}
      </p>
      <p className="text-xs text-slate-600 mt-0.5">{subtitle}</p>
    </div>
  )
}

function ViewBtn({ children, active, onClick }: { children: React.ReactNode; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`text-xs px-3 py-1 rounded-full border transition-colors ${
        active
          ? 'bg-slate-700 border-slate-500 text-slate-100'
          : 'border-slate-700 text-slate-500 hover:text-slate-300'
      }`}
    >
      {children}
    </button>
  )
}
