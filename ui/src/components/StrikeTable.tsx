import { StrikeRow } from '../types'

interface Props {
  rows: StrikeRow[]
}

function pctCell(val: number | null): string {
  if (val == null) return '—'
  return `${(val * 100).toFixed(0)}%`
}

function bidAskCell(bid: number | null, ask: number | null): string {
  if (bid == null || ask == null) return '—'
  const fmt = (v: number) => v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toFixed(0)}`
  return `${fmt(bid)} / ${fmt(ask)}`
}

export default function StrikeTable({ rows }: Props) {
  if (!rows.length) {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 text-center text-slate-500 text-sm">
        No strike data available
      </div>
    )
  }

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-800">
              <Th>Strike</Th>
              <Th color="text-blue-400">Synth%</Th>
              <Th color="text-orange-400">Derive Bin</Th>
              <Th color="text-green-400">Poly%</Th>
              <Th color="text-cyan-400">IV</Th>
              <Th color="text-slate-400">Bid/Ask</Th>
              <Th color="text-yellow-400">Edge</Th>
              <Th>Action</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const hasOption = row.derive_binary != null
              return (
                <tr
                  key={i}
                  className={`border-b border-slate-800/50 transition-colors ${
                    row.highlight
                      ? 'bg-yellow-500/5 hover:bg-yellow-500/10'
                      : 'hover:bg-slate-800/40'
                  }`}
                >
                  <td className="px-4 py-2.5 font-mono font-semibold text-slate-200">
                    {row.highlight && <span className="mr-1.5 text-yellow-400">▸</span>}
                    ${row.strike.toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-blue-400">
                    {pctCell(row.synth_prob)}
                  </td>
                  <td className="px-4 py-2.5 font-mono">
                    {hasOption ? (
                      <span className="text-orange-400">{pctCell(row.derive_binary)}</span>
                    ) : (
                      <span className="text-orange-400/50">{pctCell(row.derive_prob)}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-green-400">
                    {pctCell(row.poly_prob)}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-cyan-400">
                    {row.derive_iv != null ? `${(row.derive_iv * 100).toFixed(0)}%` : '—'}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-slate-400 whitespace-nowrap">
                    {bidAskCell(row.derive_bid, row.derive_ask)}
                  </td>
                  <td className={`px-4 py-2.5 font-mono font-bold ${
                    row.edge >= 0.08 ? 'text-green-400' :
                    row.edge >= 0.05 ? 'text-yellow-400' :
                    row.edge >= 0.03 ? 'text-orange-400' :
                    'text-slate-500'
                  }`}>
                    {row.edge > 0 ? `+${(row.edge * 100).toFixed(1)}%` : '—'}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-1.5">
                      {row.action ? (
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded ${
                          row.action.toUpperCase().includes('SELL')
                            ? 'bg-red-500/20 text-red-300'
                            : 'bg-green-500/20 text-green-300'
                        }`}>
                          {row.action}
                        </span>
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                      {row.poly_url && (
                        <a
                          href={row.poly_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={row.poly_question || 'View on Polymarket'}
                          className="text-slate-500 hover:text-green-400 transition-colors shrink-0"
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
