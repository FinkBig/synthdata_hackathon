import {
  ComposedChart,
  Line,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts'
import { Snapshot } from '../types'

interface LivePolyPrice { bid: number; ask: number; mid: number }

interface Props {
  snapshot: Snapshot
  livePolyPrices?: Record<string, LivePolyPrice>
  clobConnected?: boolean
}

interface ChartPoint {
  strike: number
  synth?: number
  derive?: number
  poly?: number
}

function buildChartData(
  snapshot: Snapshot,
  livePolyPrices: Record<string, LivePolyPrice>,
): ChartPoint[] {
  const { derive_curve, synth_curve, poly_points } = snapshot

  // Collect all strikes
  const strikes = new Set<number>()
  Object.keys(derive_curve).forEach(k => strikes.add(Number(k)))
  Object.keys(synth_curve).forEach(k => strikes.add(Number(k)))

  // Build poly lookup by strike
  const polyByStrike: Record<number, number> = {}
  for (const pt of poly_points) {
    const k = pt.strike
    if (k != null) {
      // Use live CLOB mid price when available, fall back to snapshot price
      let mid: number
      if (pt.clob_token_id && livePolyPrices[pt.clob_token_id]) {
        mid = livePolyPrices[pt.clob_token_id].mid
      } else {
        mid = pt.yes_bid && pt.yes_ask
          ? (pt.yes_bid + pt.yes_ask) / 2
          : pt.yes_price
      }
      // For "above" markets, poly YES = P(S > K)
      // For "below" markets, poly NO = P(S > K) = 1 - YES
      polyByStrike[k] = pt.is_above !== false ? mid : 1 - mid
    }
  }

  // Add poly strikes too
  Object.keys(polyByStrike).forEach(k => strikes.add(Number(k)))

  const sorted = Array.from(strikes).sort((a, b) => a - b)

  return sorted.map(k => {
    const point: ChartPoint = { strike: k }
    if (derive_curve[k] !== undefined) point.derive = +(derive_curve[k] * 100).toFixed(1)
    if (synth_curve[k] !== undefined) point.synth = +(synth_curve[k] * 100).toFixed(1)
    if (polyByStrike[k] !== undefined) point.poly = +(polyByStrike[k] * 100).toFixed(1)
    return point
  })
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-lg p-3 text-xs shadow-xl">
      <p className="font-semibold text-slate-200 mb-2">Strike ${Number(label).toLocaleString()}</p>
      {payload.map((p: any) => (
        <div key={p.name} className="flex justify-between gap-4" style={{ color: p.color }}>
          <span>{p.name}</span>
          <span className="font-mono font-semibold">{p.value?.toFixed(1)}%</span>
        </div>
      ))}
    </div>
  )
}

export default function ProbChart({ snapshot, livePolyPrices = {}, clobConnected: _clobConnected }: Props) {
  const data = buildChartData(snapshot, livePolyPrices)
  const { spot } = snapshot

  if (!data.length) {
    return (
      <div className="h-64 flex items-center justify-center text-slate-500 text-sm">
        No curve data available
      </div>
    )
  }

  // Determine X axis domain — focus around spot ±15%
  const lo = spot * 0.85
  const hi = spot * 1.15
  const visibleData = data.filter(d => d.strike >= lo && d.strike <= hi)

  return (
    <ResponsiveContainer width="100%" height={320}>
      <ComposedChart data={visibleData} margin={{ top: 10, right: 20, left: 10, bottom: 10 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
        <XAxis
          dataKey="strike"
          type="number"
          domain={['dataMin', 'dataMax']}
          tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
          tick={{ fill: '#64748b', fontSize: 11 }}
          axisLine={{ stroke: '#334155' }}
          tickLine={false}
        />
        <YAxis
          domain={[0, 100]}
          tickFormatter={(v) => `${v}%`}
          tick={{ fill: '#64748b', fontSize: 11 }}
          axisLine={{ stroke: '#334155' }}
          tickLine={false}
          width={40}
        />
        <Tooltip content={<CustomTooltip />} />

        {/* Spot reference line */}
        <ReferenceLine
          x={spot}
          stroke="#475569"
          strokeDasharray="6 3"
          label={{ value: 'Spot', position: 'insideTopLeft', fill: '#64748b', fontSize: 10 }}
        />

        {/* Synth AI curve (blue) */}
        <Line
          type="monotone"
          dataKey="synth"
          name="SynthData AI"
          stroke="#3b82f6"
          strokeWidth={2.5}
          dot={false}
          connectNulls
        />

        {/* Derive DVM curve (orange) */}
        <Line
          type="monotone"
          dataKey="derive"
          name="Derive (DVM)"
          stroke="#f97316"
          strokeWidth={2.5}
          dot={false}
          connectNulls
        />

        {/* Polymarket dots (green) */}
        <Scatter
          dataKey="poly"
          name="Polymarket"
          fill="#22c55e"
          shape={(props: any) => {
            const { cx, cy, fill } = props
            if (cy == null) return <g />
            return (
              <circle
                cx={cx}
                cy={cy}
                r={6}
                fill={fill}
                stroke="#166534"
                strokeWidth={1.5}
              />
            )
          }}
        />
      </ComposedChart>
    </ResponsiveContainer>
  )
}
