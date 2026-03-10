import { StrikeRow } from '../types'

interface Props {
  rows: StrikeRow[]
  spot?: number
}

function pctCell(val: number | null): string {
  if (val == null) return '—'
  return `${(val * 100).toFixed(1)}%`
}

export default function StrikeTable({ rows, spot }: Props) {
  // Only show rows where all three sources have data — the comparison is only useful when all three agree/disagree
  const filtered = rows.filter(r => r.poly_prob != null && r.synth_prob != null)

  if (!filtered.length) {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 text-center text-slate-500 text-sm">
        No matched strikes (all three sources need to cover the same strike)
      </div>
    )
  }

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-slate-800 bg-slate-800/50">
              <Th>Strike</Th>
              <Th color="text-slate-400">OTM%</Th>
              <Th color="text-slate-200">SynthData</Th>
              <Th color="text-orange-400">Derive</Th>
              <Th color="text-blue-400">Polymarket</Th>
              <Th color="text-cyan-400">Derive IV</Th>
              <Th color="text-slate-400">Option Bid/Ask</Th>
              <Th color="text-yellow-400">Edge</Th>
              <Th>Action</Th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row, i) => {
              const moneyness = spot != null ? ((row.strike / spot) - 1) * 100 : null
              const isAtm = moneyness != null && Math.abs(moneyness) < 0.8
              const hasOption = row.derive_binary != null

              // Per-source agreement coloring: highlight divergence
              const synthProb  = row.synth_prob  ?? 0
              const deriveProb = row.derive_binary ?? row.derive_prob ?? 0
              const polyProb   = row.poly_prob   ?? 0
              const maxDivergence = Math.max(
                Math.abs(synthProb - polyProb),
                Math.abs(deriveProb - polyProb),
              )

              return (
                <tr
                  key={i}
                  className={`border-b border-slate-800/40 transition-colors ${
                    row.highlight
                      ? 'bg-yellow-500/5 hover:bg-yellow-500/10'
                      : isAtm
                      ? 'bg-slate-800/20 hover:bg-slate-800/40'
                      : 'hover:bg-slate-800/30'
                  }`}
                >
                  {/* Strike */}
                  <td className="px-4 py-2.5 font-mono font-semibold text-slate-200 whitespace-nowrap">
                    {row.highlight && <span className="mr-1 text-yellow-400">▸</span>}
                    {isAtm && <span className="mr-1 text-slate-500 text-xs">ATM</span>}
                    ${row.strike.toLocaleString()}
                  </td>

                  {/* Moneyness */}
                  <td className={`px-3 py-2.5 font-mono text-xs ${
                    isAtm ? 'text-slate-400'
                    : moneyness != null && moneyness > 0 ? 'text-orange-400/70'
                    : 'text-blue-400/70'
                  }`}>
                    {moneyness != null
                      ? `${moneyness > 0 ? '+' : ''}${moneyness.toFixed(1)}%`
                      : '—'}
                  </td>

                  {/* SynthData P(S>K) */}
                  <td className="px-3 py-2.5 font-mono text-slate-200">
                    {pctCell(row.synth_prob)}
                  </td>

                  {/* Derive — prefer BSM N(d2) over DVM curve prob */}
                  <td className="px-3 py-2.5 font-mono">
                    <span className={hasOption ? 'text-orange-400' : 'text-orange-400/50'}>
                      {pctCell(hasOption ? row.derive_binary : row.derive_prob)}
                    </span>
                    {!hasOption && <span className="ml-1 text-slate-600 text-xs">(DVM)</span>}
                  </td>

                  {/* Polymarket YES */}
                  <td className="px-3 py-2.5 font-mono text-blue-400">
                    {pctCell(row.poly_prob)}
                  </td>

                  {/* Derive IV */}
                  <td className="px-3 py-2.5 font-mono text-cyan-400">
                    {row.derive_iv != null
                      ? `${(row.derive_iv * 100).toFixed(0)}%`
                      : '—'}
                  </td>

                  {/* Option bid/ask */}
                  <td className="px-3 py-2.5 font-mono text-slate-400 whitespace-nowrap">
                    {row.derive_bid != null && row.derive_ask != null
                      ? `$${row.derive_bid.toFixed(0)} / $${row.derive_ask.toFixed(0)}`
                      : '—'}
                  </td>

                  {/* Edge */}
                  <td className={`px-3 py-2.5 font-mono font-bold ${
                    row.edge >= 0.08 ? 'text-green-400' :
                    row.edge >= 0.05 ? 'text-yellow-400' :
                    row.edge >= 0.03 ? 'text-orange-400' :
                    maxDivergence >= 0.05 ? 'text-slate-400' :
                    'text-slate-600'
                  }`}>
                    {row.edge > 0 ? `+${(row.edge * 100).toFixed(1)}%` : '—'}
                  </td>

                  {/* Action + link */}
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-1.5">
                      {row.action ? (
                        <span className={`text-xs font-semibold px-1.5 py-0.5 rounded ${
                          row.action.toUpperCase().includes('SELL')
                            ? 'bg-red-500/20 text-red-300'
                            : 'bg-green-500/20 text-green-300'
                        }`}>
                          {row.action}
                        </span>
                      ) : (
                        <span className="text-slate-700">—</span>
                      )}
                      {row.poly_url && (
                        <a
                          href={row.poly_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={row.poly_question || 'View on Polymarket'}
                          className="text-slate-600 hover:text-blue-400 transition-colors shrink-0"
                        >
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                            <polyline points="15 3 21 3 21 9"/>
                            <line x1="10" y1="14" x2="21" y2="3"/>
                          </svg>
                        </a>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="px-4 py-2 border-t border-slate-800/50 text-xs text-slate-600">
        {filtered.length} strikes where Polymarket, Derive, and SynthData all have coverage
        {rows.length > filtered.length && ` · ${rows.length - filtered.length} strikes hidden (no Poly match)`}
      </div>
    </div>
  )
}

function Th({ children, color = 'text-slate-400' }: { children: React.ReactNode; color?: string }) {
  return (
    <th className={`px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider ${color}`}>
      {children}
    </th>
  )
}
