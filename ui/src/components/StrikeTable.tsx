import { StrikeRow } from '../types'

interface Props {
  rows: StrikeRow[]
}

function pctCell(val: number | null, color?: string): string {
  if (val == null) return '—'
  return `${(val * 100).toFixed(0)}%`
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
              <Th color="text-blue-400">Synth P%</Th>
              <Th color="text-orange-400">Derive P%</Th>
              <Th color="text-green-400">Poly P%</Th>
              <Th color="text-yellow-400">Edge</Th>
              <Th>Action</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
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
                <td className="px-4 py-2.5 font-mono text-orange-400">
                  {pctCell(row.derive_prob)}
                </td>
                <td className="px-4 py-2.5 font-mono text-green-400">
                  {pctCell(row.poly_prob)}
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
                </td>
              </tr>
            ))}
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
