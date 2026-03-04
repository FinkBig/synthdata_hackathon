import { useState } from 'react'
import {
  ComposedChart,
  Line,
  Scatter,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts'
import { Snapshot, PolyPoint } from '../types'

interface LivePolyPrice { bid: number; ask: number; mid: number }

interface Props {
  snapshot: Snapshot
  livePolyPrices?: Record<string, LivePolyPrice>
  clobConnected?: boolean
}

// CDF view: P(S > K) for all three sources
interface CdfPoint {
  strike: number
  synth?: number
  derive?: number
  poly?: number
  polyQuestion?: string
  polyUrl?: string
  polyEmbedUrl?: string
  polyVolume?: number
  polyExpiry?: string
  polyBid?: number
  polyAsk?: number
}

// PDF view: probability density (bell curves)
interface PdfPoint {
  strike: number
  synthPdf?: number   // scaled: density × 1e5 ≈ "% per $1k bucket"
  derivePdf?: number
  polyDensity?: number // density implied from adjacent Poly YES prices
}

type View = 'cdf' | 'pdf'

function toEmbedUrl(url: string): string {
  if (!url) return ''
  return url.replace('polymarket.com/event/', 'polymarket.com/embed/event/')
}

function formatExpiry(iso: string): string {
  if (!iso) return ''
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return 'Expired'
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

// Scale factor: density (prob/$) → "% per $1k bucket"
const PDF_SCALE = 1e5

function buildCdfData(
  snapshot: Snapshot,
  livePolyPrices: Record<string, LivePolyPrice>,
): CdfPoint[] {
  const { derive_curve, synth_curve, poly_points } = snapshot
  const strikes = new Set<number>()
  Object.keys(derive_curve).forEach(k => strikes.add(Number(k)))
  Object.keys(synth_curve).forEach(k => strikes.add(Number(k)))

  const polyByStrike: Record<number, { price: number; pt: PolyPoint }> = {}
  for (const pt of poly_points) {
    const k = pt.strike
    if (k != null && pt.market_type === 'above_below' && pt.is_above !== false) {
      let mid: number
      if (pt.clob_token_id && livePolyPrices[pt.clob_token_id]) {
        mid = livePolyPrices[pt.clob_token_id].mid
      } else {
        mid = pt.yes_bid && pt.yes_ask ? (pt.yes_bid + pt.yes_ask) / 2 : pt.yes_price
      }
      polyByStrike[k] = { price: mid, pt }
      strikes.add(k)
    }
  }

  return Array.from(strikes).sort((a, b) => a - b).map(k => {
    const point: CdfPoint = { strike: k }
    if (derive_curve[k] !== undefined) point.derive = +(derive_curve[k] * 100).toFixed(1)
    if (synth_curve[k] !== undefined) point.synth = +(synth_curve[k] * 100).toFixed(1)
    const entry = polyByStrike[k]
    if (entry) {
      point.poly = +(entry.price * 100).toFixed(1)
      const pt = entry.pt
      point.polyQuestion = pt.question
      point.polyUrl = pt.polymarket_url ?? ''
      point.polyEmbedUrl = toEmbedUrl(pt.polymarket_url ?? '')
      point.polyVolume = pt.volume_24h
      point.polyExpiry = pt.expiry ?? ''
      point.polyBid = pt.yes_bid
      point.polyAsk = pt.yes_ask
    }
    return point
  })
}

function buildPdfData(snapshot: Snapshot): PdfPoint[] {
  const { synth_pdf, derive_pdf, poly_points } = snapshot

  // Use a Map keyed by numeric strike to avoid "60500" vs "60500.0" mismatch
  const pointsMap = new Map<number, PdfPoint>()

  const getOrCreate = (k: number): PdfPoint => {
    if (!pointsMap.has(k)) pointsMap.set(k, { strike: k })
    return pointsMap.get(k)!
  }

  if (synth_pdf) {
    for (const [keyStr, val] of Object.entries(synth_pdf)) {
      const k = Number(keyStr)
      getOrCreate(k).synthPdf = +(val * PDF_SCALE).toFixed(2)
    }
  }

  if (derive_pdf) {
    for (const [keyStr, val] of Object.entries(derive_pdf)) {
      const k = Number(keyStr)
      getOrCreate(k).derivePdf = +(val * PDF_SCALE).toFixed(2)
    }
  }

  // Polymarket implied density from adjacent YES prices (above_below markets only)
  const polyAbove = poly_points
    .filter(p => p.strike != null && p.market_type === 'above_below' && p.is_above !== false)
    .map(p => {
      const mid = p.yes_bid && p.yes_ask ? (p.yes_bid + p.yes_ask) / 2 : p.yes_price
      return { k: p.strike as number, p: mid }
    })
    .sort((a, b) => a.k - b.k)

  for (let i = 0; i < polyAbove.length - 1; i++) {
    const { k: k1, p: p1 } = polyAbove[i]
    const { k: k2, p: p2 } = polyAbove[i + 1]
    const dK = k2 - k1
    if (dK > 0) {
      const density = Math.max(0, (p1 - p2) / dK)
      const midK = (k1 + k2) / 2
      getOrCreate(midK).polyDensity = +(density * PDF_SCALE).toFixed(2)
    }
  }

  return Array.from(pointsMap.values()).sort((a, b) => a.strike - b.strike)
}

const CdfTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null
  const polyPayload = payload.find((p: any) => p.name === 'Polymarket')
  const polyData: CdfPoint | null = polyPayload?.payload ?? null
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-lg p-3 text-xs shadow-xl max-w-xs">
      <p className="font-semibold text-slate-200 mb-2">Strike ${Number(label).toLocaleString()}</p>
      {payload.map((p: any) =>
        p.value != null ? (
          <div key={p.name} className="flex justify-between gap-4" style={{ color: p.color }}>
            <span>{p.name}</span>
            <span className="font-mono font-semibold">{p.value?.toFixed(1)}%</span>
          </div>
        ) : null
      )}
      {polyData?.polyQuestion && (
        <div className="mt-2 pt-2 border-t border-slate-700 space-y-1">
          <p className="text-slate-300 leading-relaxed line-clamp-3">{polyData.polyQuestion}</p>
          {polyData.polyBid != null && polyData.polyAsk != null && (
            <p className="text-slate-400">
              Bid <span className="text-blue-400 font-mono">{(polyData.polyBid * 100).toFixed(0)}¢</span>
              {' / '}
              Ask <span className="text-blue-400 font-mono">{(polyData.polyAsk * 100).toFixed(0)}¢</span>
            </p>
          )}
          {polyData.polyVolume != null && polyData.polyVolume > 0 && (
            <p className="text-slate-400">
              Vol <span className="text-slate-300 font-mono">${polyData.polyVolume.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
            </p>
          )}
          {polyData.polyExpiry && (
            <p className="text-slate-400">
              Expires <span className="text-yellow-400 font-mono">{formatExpiry(polyData.polyExpiry)}</span>
            </p>
          )}
          {polyData.polyUrl && <p className="text-blue-400 mt-1">Click dot to embed ↓</p>}
        </div>
      )}
    </div>
  )
}

const PdfTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-lg p-3 text-xs shadow-xl">
      <p className="font-semibold text-slate-200 mb-2">Strike ${Number(label).toLocaleString()}</p>
      {payload.map((p: any) =>
        p.value != null && p.value > 0 ? (
          <div key={p.name} className="flex justify-between gap-4" style={{ color: p.color }}>
            <span>{p.name}</span>
            <span className="font-mono font-semibold">{p.value?.toFixed(1)}%<span className="text-slate-500 font-normal">/1k</span></span>
          </div>
        ) : null
      )}
    </div>
  )
}

export default function ProbChart({ snapshot, livePolyPrices = {}, clobConnected: _clobConnected }: Props) {
  const [embedUrl, setEmbedUrl] = useState<string | null>(null)
  const [embedTitle, setEmbedTitle] = useState<string>('')
  const [view, setView] = useState<View>('pdf')

  const { spot } = snapshot
  const lo = spot * 0.85
  const hi = spot * 1.15

  const cdfData = buildCdfData(snapshot, livePolyPrices).filter(d => d.strike >= lo && d.strike <= hi)
  const pdfData = buildPdfData(snapshot).filter(d => d.strike >= lo && d.strike <= hi)

  const hasPdf = (snapshot.synth_pdf && Object.keys(snapshot.synth_pdf).length > 0) ||
                 (snapshot.derive_pdf && Object.keys(snapshot.derive_pdf).length > 0)

  if (!cdfData.length) {
    return (
      <div className="h-64 flex items-center justify-center text-slate-500 text-sm">
        No curve data available
      </div>
    )
  }

  return (
    <div>
      {/* View toggle */}
      <div className="flex items-center gap-1 mb-4">
        <button
          onClick={() => setView('pdf')}
          className={`text-xs px-3 py-1 rounded-full border transition-colors ${
            view === 'pdf'
              ? 'bg-slate-700 border-slate-500 text-slate-100'
              : 'border-slate-700 text-slate-500 hover:text-slate-300'
          }`}
        >
          Distribution
        </button>
        <button
          onClick={() => setView('cdf')}
          className={`text-xs px-3 py-1 rounded-full border transition-colors ${
            view === 'cdf'
              ? 'bg-slate-700 border-slate-500 text-slate-100'
              : 'border-slate-700 text-slate-500 hover:text-slate-300'
          }`}
        >
          P(S&gt;K)
        </button>
      </div>

      {view === 'pdf' ? (
        /* ── PDF / Distribution view ── */
        <ResponsiveContainer width="100%" height={320}>
          <ComposedChart data={pdfData} margin={{ top: 10, right: 20, left: 10, bottom: 10 }}>
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
              tickFormatter={(v) => `${v}%`}
              tick={{ fill: '#64748b', fontSize: 11 }}
              axisLine={{ stroke: '#334155' }}
              tickLine={false}
              width={40}
              label={{ value: '% / $1k', angle: -90, position: 'insideLeft', fill: '#475569', fontSize: 10, dx: -4 }}
            />
            <Tooltip content={<PdfTooltip />} />
            <ReferenceLine
              x={spot}
              stroke="#475569"
              strokeDasharray="6 3"
              label={{ value: 'Spot', position: 'insideTopLeft', fill: '#64748b', fontSize: 10 }}
            />

            {/* SynthData AI — white filled area */}
            {hasPdf && (
              <Area
                type="monotone"
                dataKey="synthPdf"
                name="SynthData AI"
                stroke="#e2e8f0"
                fill="#e2e8f0"
                fillOpacity={0.08}
                strokeWidth={2.5}
                dot={false}
                connectNulls
              />
            )}

            {/* Derive DVM — orange filled area */}
            {hasPdf && (
              <Area
                type="monotone"
                dataKey="derivePdf"
                name="Derive (DVM)"
                stroke="#f97316"
                fill="#f97316"
                fillOpacity={0.08}
                strokeWidth={2.5}
                dot={false}
                connectNulls
              />
            )}

            {/* Polymarket implied density — blue dots */}
            <Scatter
              dataKey="polyDensity"
              name="Polymarket"
              fill="#3b82f6"
              shape={(props: any) => {
                const { cx, cy } = props
                if (cy == null || props.payload.polyDensity == null) return <g />
                return <circle cx={cx} cy={cy} r={5} fill="#3b82f6" stroke="#1e40af" strokeWidth={1.5} />
              }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      ) : (
        /* ── CDF / P(S>K) view ── */
        <ResponsiveContainer width="100%" height={320}>
          <ComposedChart data={cdfData} margin={{ top: 10, right: 20, left: 10, bottom: 10 }}>
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
            <Tooltip content={<CdfTooltip />} />
            <ReferenceLine
              x={spot}
              stroke="#475569"
              strokeDasharray="6 3"
              label={{ value: 'Spot', position: 'insideTopLeft', fill: '#64748b', fontSize: 10 }}
            />

            {/* Synth AI curve — white */}
            <Line
              type="monotone"
              dataKey="synth"
              name="SynthData AI"
              stroke="#e2e8f0"
              strokeWidth={2.5}
              dot={false}
              connectNulls
            />

            {/* Derive DVM curve — orange */}
            <Line
              type="monotone"
              dataKey="derive"
              name="Derive (DVM)"
              stroke="#f97316"
              strokeWidth={2.5}
              dot={false}
              connectNulls
            />

            {/* Polymarket dots — blue, clickable to embed */}
            <Scatter
              dataKey="poly"
              name="Polymarket"
              fill="#3b82f6"
              shape={(props: any) => {
                const { cx, cy, payload } = props
                if (cy == null) return <g />
                const isSelected = embedUrl === payload.polyEmbedUrl && !!payload.polyEmbedUrl
                return (
                  <circle
                    cx={cx}
                    cy={cy}
                    r={isSelected ? 9 : 6}
                    fill={isSelected ? '#93c5fd' : '#3b82f6'}
                    stroke={isSelected ? '#1d4ed8' : '#1e40af'}
                    strokeWidth={1.5}
                    style={{ cursor: payload.polyEmbedUrl ? 'pointer' : 'default' }}
                    onClick={() => {
                      if (!payload.polyEmbedUrl) return
                      if (embedUrl === payload.polyEmbedUrl) {
                        setEmbedUrl(null); setEmbedTitle('')
                      } else {
                        setEmbedUrl(payload.polyEmbedUrl)
                        setEmbedTitle(payload.polyQuestion ?? '')
                      }
                    }}
                  />
                )
              }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}

      {/* Polymarket embed panel (CDF view only) */}
      {view === 'cdf' && embedUrl && (
        <div className="mt-4 border border-blue-900/50 rounded-xl overflow-hidden bg-slate-950">
          <div className="flex items-center justify-between px-3 py-2 bg-slate-900 border-b border-slate-800">
            <p className="text-xs text-blue-400 font-medium truncate flex-1 mr-2">{embedTitle}</p>
            <button
              onClick={() => { setEmbedUrl(null); setEmbedTitle('') }}
              className="text-slate-500 hover:text-slate-300 text-xs shrink-0"
            >
              ✕ close
            </button>
          </div>
          <iframe
            src={embedUrl}
            className="w-full"
            height={220}
            frameBorder={0}
            title="Polymarket market"
            sandbox="allow-scripts allow-same-origin allow-popups"
          />
        </div>
      )}
    </div>
  )
}
