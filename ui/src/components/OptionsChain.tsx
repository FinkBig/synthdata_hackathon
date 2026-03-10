import { useEffect, useState, useMemo } from 'react'
import { OptionsChainData, OptionsChainExpiry, OptionsChainRow } from '../types'

interface Props { asset: string }

type EdgeSource = 'synth' | 'derive'

// ── Helpers ────────────────────────────────────────────────────────────────────

function pct(v: number | null | undefined, decimals = 1) {
  if (v == null) return '—'
  return `${(v * 100).toFixed(decimals)}%`
}

function usd(v: number | null | undefined) {
  if (v == null) return '—'
  return v < 1 ? `$${v.toFixed(2)}` : `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
}

function EdgeCell({ val }: { val: number | null | undefined }) {
  if (val == null) return <span className="text-slate-600">—</span>
  const abs = Math.abs(val * 100)
  const color = abs >= 8 ? (val > 0 ? 'text-red-400' : 'text-green-400')
    : abs >= 4 ? (val > 0 ? 'text-orange-400' : 'text-cyan-400')
    : 'text-slate-500'
  return <span className={`font-mono font-semibold ${color}`}>{val > 0 ? '+' : ''}{(val * 100).toFixed(1)} pts</span>
}

function ActionBadge({ action }: { action: string | null | undefined }) {
  if (!action) return <span className="text-slate-600 text-xs">—</span>
  const yes = action === 'BUY YES'
  return (
    <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${yes ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
      {action}
    </span>
  )
}

function MoneynessBadge({ m }: { m: number }) {
  if (Math.abs(m) <= 0.5) return <span className="text-xs bg-yellow-500/20 text-yellow-300 px-1.5 py-0.5 rounded font-bold">ATM</span>
  const color = m > 0 ? 'text-green-400' : 'text-red-400'
  return <span className={`font-mono text-xs ${color}`}>{m > 0 ? '+' : ''}{m.toFixed(1)}%</span>
}

// ── Per-row tooltip content ────────────────────────────────────────────────────

function RowDetail({ row }: { row: OptionsChainRow }) {
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-lg p-3 text-xs shadow-xl max-w-xs">
      <p className="font-semibold text-slate-200 mb-2">${row.strike.toLocaleString()} — {row.moneyness_pct > 0 ? '+' : ''}{row.moneyness_pct}% OTM</p>
      {row.poly_question && <p className="text-slate-400 mb-2 leading-tight">{row.poly_question}</p>}
      <div className="space-y-1">
        <div className="flex justify-between gap-4"><span className="text-slate-500">SynthData P(S&gt;K)</span><span className="text-slate-100 font-mono">{pct(row.synth_prob)}</span></div>
        <div className="flex justify-between gap-4"><span className="text-slate-500">Derive binary (BSM)</span><span className="text-orange-300 font-mono">{pct(row.derive_binary)}</span></div>
        {row.poly_yes_price != null && (
          <div className="flex justify-between gap-4"><span className="text-slate-500">Poly YES mid</span><span className="text-purple-300 font-mono">{pct(row.poly_yes_price)}</span></div>
        )}
        {row.poly_yes_bid != null && (
          <div className="flex justify-between gap-4 text-slate-600"><span>Poly bid / ask</span><span className="font-mono">{pct(row.poly_yes_bid)} / {pct(row.poly_yes_ask)}</span></div>
        )}
      </div>
    </div>
  )
}

// ── Table ──────────────────────────────────────────────────────────────────────

function ExpiryTable({ expiry, spot, edgeSource }: { expiry: OptionsChainExpiry; spot: number; edgeSource: EdgeSource }) {
  const [showDetail, setShowDetail] = useState<number | null>(null)

  const rows = useMemo(() => {
    return expiry.rows.filter(r => r.call_bid != null || r.put_bid != null)
  }, [expiry.rows])

  const anyPoly = rows.some(r => r.poly_yes_price != null)

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
      {/* Expiry header */}
      <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between bg-slate-900/50">
        <div>
          <span className="font-semibold text-slate-200">{expiry.label}</span>
          <span className="ml-3 text-xs text-slate-500">Derive expiry</span>
          <span className="ml-4 text-xs text-slate-600">Poly settles: {expiry.poly_settle_label}</span>
        </div>
        <span className="text-xs text-slate-600">{rows.length} strikes · {anyPoly ? `${rows.filter(r => r.poly_yes_price != null).length} with Poly match` : 'no Poly match'}</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-slate-800 bg-slate-800/40 text-slate-400">
              <th className="px-3 py-2 text-right">Strike</th>
              <th className="px-3 py-2 text-center">OTM%</th>
              <th className="px-3 py-2 text-right text-green-400">Call Bid</th>
              <th className="px-3 py-2 text-right text-green-400">Call Ask</th>
              <th className="px-3 py-2 text-right text-green-400">Call IV</th>
              <th className="px-3 py-2 text-right text-red-400">Put Bid</th>
              <th className="px-3 py-2 text-right text-red-400">Put Ask</th>
              <th className="px-3 py-2 text-right text-red-400">Put IV</th>
              <th className="px-3 py-2 text-right text-slate-300">SynthData</th>
              <th className="px-3 py-2 text-right text-orange-400">Derive N(d2)</th>
              {anyPoly && <th className="px-3 py-2 text-right text-purple-400">Poly YES</th>}
              {anyPoly && <th className="px-3 py-2 text-right">Edge vs {edgeSource === 'synth' ? 'AI' : 'Derive'}</th>}
              {anyPoly && <th className="px-3 py-2 text-center">Action</th>}
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const edge = edgeSource === 'synth' ? row.edge_vs_synth : row.edge_vs_derive
              const edgeAbs = edge != null ? Math.abs(edge * 100) : 0
              const rowBg = edgeAbs >= 8
                ? (edge! > 0 ? 'bg-red-500/5 border-l-2 border-red-500/50' : 'bg-green-500/5 border-l-2 border-green-500/50')
                : edgeAbs >= 4 ? 'bg-yellow-500/5 border-l-2 border-yellow-500/30' : ''
              const isATM = Math.abs(row.moneyness_pct) <= 0.5

              return (
                <tr
                  key={i}
                  className={`border-b border-slate-800/50 hover:bg-slate-800/30 cursor-pointer ${rowBg} ${isATM ? 'bg-slate-800/30' : ''}`}
                  onClick={() => setShowDetail(showDetail === i ? null : i)}
                >
                  <td className="px-3 py-2 text-right font-mono text-slate-200 font-semibold">
                    ${row.strike.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <MoneynessBadge m={row.moneyness_pct} />
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-green-300">{usd(row.call_bid)}</td>
                  <td className="px-3 py-2 text-right font-mono text-green-200">{usd(row.call_ask)}</td>
                  <td className="px-3 py-2 text-right font-mono text-green-400">{pct(row.call_iv)}</td>
                  <td className="px-3 py-2 text-right font-mono text-red-300">{usd(row.put_bid)}</td>
                  <td className="px-3 py-2 text-right font-mono text-red-200">{usd(row.put_ask)}</td>
                  <td className="px-3 py-2 text-right font-mono text-red-400">{pct(row.put_iv)}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-300">{pct(row.synth_prob)}</td>
                  <td className="px-3 py-2 text-right font-mono text-orange-300">{pct(row.derive_binary)}</td>
                  {anyPoly && (
                    <td className="px-3 py-2 text-right font-mono text-purple-300">
                      {row.poly_yes_price != null ? pct(row.poly_yes_price) : <span className="text-slate-700">—</span>}
                    </td>
                  )}
                  {anyPoly && <td className="px-3 py-2 text-right"><EdgeCell val={edge} /></td>}
                  {anyPoly && <td className="px-3 py-2 text-center"><ActionBadge action={row.action} /></td>}
                  <td className="px-3 py-2 text-center">
                    {row.poly_url ? (
                      <a href={row.poly_url} target="_blank" rel="noopener noreferrer"
                        onClick={e => e.stopPropagation()}
                        className="text-slate-600 hover:text-slate-300">↗</a>
                    ) : ''}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="px-4 py-2 border-t border-slate-800 text-xs text-slate-600">
        Prices in USD · Call/Put IV = Derive implied vol · SynthData = P(S&gt;K) from AI percentile CDF · Derive N(d2) = BSM digital call using Derive IV · Poly match within ±{spot > 10000 ? '$500' : '$50'}
      </div>
    </div>
  )
}

// ── Summary cards ──────────────────────────────────────────────────────────────

function SummaryCards({ data }: { data: OptionsChainData }) {
  const totalSignals = data.expiries.reduce((sum, e) =>
    sum + e.rows.filter(r => r.action != null).length, 0)
  const maxEdge = data.expiries.flatMap(e => e.rows.map(r => r.edge_vs_synth ?? 0))
    .reduce((m, v) => Math.abs(v) > Math.abs(m) ? v : m, 0)

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Spot</p>
        <p className="text-2xl font-bold text-slate-100">${data.spot.toLocaleString()}</p>
      </div>
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Expiries</p>
        <p className="text-2xl font-bold text-slate-100">{data.expiries.length}</p>
        <p className="text-xs text-slate-600">{data.expiries.map(e => e.label.split(' ').slice(0,2).join(' ')).join(', ')}</p>
      </div>
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Actionable Rows</p>
        <p className={`text-2xl font-bold ${totalSignals > 0 ? 'text-yellow-400' : 'text-slate-100'}`}>{totalSignals}</p>
        <p className="text-xs text-slate-600">edge &gt; 4% vs SynthData</p>
      </div>
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Max Edge</p>
        <p className={`text-2xl font-bold font-mono ${Math.abs(maxEdge * 100) >= 8 ? (maxEdge > 0 ? 'text-red-400' : 'text-green-400') : 'text-slate-300'}`}>
          {maxEdge !== 0 ? `${maxEdge > 0 ? '+' : ''}${(maxEdge * 100).toFixed(1)} pts` : '—'}
        </p>
        <p className="text-xs text-slate-600">Poly vs SynthData</p>
      </div>
    </div>
  )
}

// ── Main ───────────────────────────────────────────────────────────────────────

export default function OptionsChain({ asset }: Props) {
  const [data, setData] = useState<OptionsChainData | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedExpiry, setSelectedExpiry] = useState(0)
  const [edgeSource, setEdgeSource] = useState<EdgeSource>('synth')
  const [moneynessFilter, setMoneynessFilter] = useState<'all' | '5' | '10'>('10')

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      try {
        const res = await fetch(`/api/options_chain/${asset}`)
        if (res.ok) {
          const d = await res.json()
          setData(d)
          setSelectedExpiry(0)
        }
      } catch (e) { console.error(e) }
      finally { setLoading(false) }
    }
    load()
    const id = setInterval(load, 60000)
    return () => clearInterval(id)
  }, [asset])

  const filteredExpiry = useMemo(() => {
    if (!data || !data.expiries[selectedExpiry]) return null
    const exp = data.expiries[selectedExpiry]
    const maxMono = moneynessFilter === 'all' ? 999 : Number(moneynessFilter)
    return {
      ...exp,
      rows: exp.rows.filter(r => Math.abs(r.moneyness_pct) <= maxMono),
    }
  }, [data, selectedExpiry, moneynessFilter])

  if (loading && !data) {
    return <div className="flex items-center justify-center h-64 text-slate-400 text-sm">Loading options chain…</div>
  }
  if (!data || !data.expiries.length) {
    return <div className="flex items-center justify-center h-48 text-slate-500 text-sm">No options chain data (requires live mode)</div>
  }

  return (
    <div className="space-y-5">
      {/* Summary */}
      <SummaryCards data={data} />

      {/* Expiry selector + controls */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap gap-1">
          {data.expiries.map((exp, i) => (
            <button
              key={exp.expiry}
              onClick={() => setSelectedExpiry(i)}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                selectedExpiry === i
                  ? 'bg-slate-700 border-slate-500 text-slate-100'
                  : 'border-slate-700 text-slate-500 hover:text-slate-300'
              }`}
            >
              {exp.label}
            </button>
          ))}
        </div>

        <div className="flex gap-1 ml-auto">
          <span className="text-xs text-slate-500 self-center mr-1">OTM range:</span>
          {(['5', '10', 'all'] as const).map(v => (
            <button key={v} onClick={() => setMoneynessFilter(v)}
              className={`text-xs px-2.5 py-1 rounded-lg border transition-colors ${
                moneynessFilter === v ? 'bg-slate-700 border-slate-500 text-slate-100' : 'border-slate-700 text-slate-500 hover:text-slate-300'
              }`}>
              {v === 'all' ? '±20%' : `±${v}%`}
            </button>
          ))}
        </div>

        <div className="flex gap-1">
          <span className="text-xs text-slate-500 self-center mr-1">Edge vs:</span>
          <button onClick={() => setEdgeSource('synth')}
            className={`text-xs px-2.5 py-1 rounded-lg border transition-colors ${edgeSource === 'synth' ? 'bg-slate-700 border-slate-500 text-slate-100' : 'border-slate-700 text-slate-500 hover:text-slate-300'}`}>
            SynthData AI
          </button>
          <button onClick={() => setEdgeSource('derive')}
            className={`text-xs px-2.5 py-1 rounded-lg border transition-colors ${edgeSource === 'derive' ? 'bg-slate-700 border-slate-500 text-slate-100' : 'border-slate-700 text-slate-500 hover:text-slate-300'}`}>
            Derive BSM
          </button>
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-4 text-xs text-slate-500 px-1">
        <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-green-500 inline-block" /> Call bid/ask (Derive)</div>
        <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-red-500 inline-block" /> Put bid/ask (Derive)</div>
        <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-slate-300 inline-block" /> SynthData P(S&gt;K)</div>
        <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-orange-400 inline-block" /> Derive N(d2) binary</div>
        <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-purple-500 inline-block" /> Polymarket YES</div>
        <div className="ml-auto text-slate-600">Click row for detail</div>
      </div>

      {/* Table */}
      {filteredExpiry && (
        <ExpiryTable expiry={filteredExpiry} spot={data.spot} edgeSource={edgeSource} />
      )}

      {/* Methodology note */}
      <div className="bg-slate-900/50 border border-slate-800 rounded-lg p-4 text-xs text-slate-500">
        <p className="font-semibold text-slate-400 mb-1">Expiry matching: Poly settlement = Derive expiry date − 1 day at 17:00 UTC</p>
        <p>Derive expires 08:00 UTC on date D · Polymarket settles 17:00 UTC on D−1 (≈15h before Derive expiry).
          Edge = Poly YES price − SynthData P(S&gt;K): positive → Poly overpriced → BUY NO; negative → BUY YES.
          Derive N(d2) = BSM digital call using Derive IV at that strike and TTE.</p>
      </div>
    </div>
  )
}
