import { useState, useEffect, useCallback } from 'react'
import Dashboard from './components/Dashboard'
import { Snapshot } from './types'

const ASSETS = ['BTC', 'ETH'] as const
type Asset = typeof ASSETS[number]

interface LivePolyPrice { bid: number; ask: number; mid: number }

function App() {
  const [asset, setAsset] = useState<Asset>('BTC')
  const [snapshots, setSnapshots] = useState<Record<Asset, Snapshot | null>>({ BTC: null, ETH: null })
  const [loading, setLoading] = useState(false)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const [livePolyPrices, setLivePolyPrices] = useState<Record<string, LivePolyPrice>>({})
  const [clobConnected, setClobConnected] = useState(false)

  const fetchSnapshot = useCallback(async (a: Asset) => {
    setLoading(true)
    try {
      const res = await fetch(`/api/snapshot/${a}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: Snapshot = await res.json()
      setSnapshots(prev => ({ ...prev, [a]: data }))
      setLastRefresh(new Date())
    } catch (err) {
      console.error('Fetch error:', err)
      // Fallback to mock
      try {
        const res = await fetch(`/api/mock/${a}`)
        const data: Snapshot = await res.json()
        setSnapshots(prev => ({ ...prev, [a]: data }))
      } catch (mockErr) {
        console.error('Mock fallback error:', mockErr)
      }
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial load for both assets
  useEffect(() => {
    fetchSnapshot('BTC')
    fetchSnapshot('ETH')
  }, [fetchSnapshot])

  // Auto-refresh every 60s
  useEffect(() => {
    const interval = setInterval(() => {
      fetchSnapshot(asset)
    }, 60000)
    return () => clearInterval(interval)
  }, [asset, fetchSnapshot])

  // Poll live Polymarket CLOB prices every 5s
  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch(`/api/poly/live/${asset}`)
        if (!res.ok) return
        const data = await res.json()
        setClobConnected(data.connected ?? false)
        setLivePolyPrices(data.prices ?? {})
      } catch {
        // silently ignore — live prices are best-effort
      }
    }
    poll()
    const id = setInterval(poll, 5000)
    return () => clearInterval(id)
  }, [asset])

  const currentSnapshot = snapshots[asset]

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-orange-500 rounded-lg flex items-center justify-center text-white font-bold text-sm">
              SV
            </div>
            <div>
              <h1 className="font-bold text-slate-100 tracking-tight">Synth-Vol Triangulator</h1>
              <p className="text-xs text-slate-400">BTC/ETH Volatility Arbitrage Dashboard</p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            {/* Mode badge */}
            {currentSnapshot && (
              <span className={`text-xs font-medium px-2 py-1 rounded-full ${
                currentSnapshot.mode === 'live'
                  ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                  : currentSnapshot.mode === 'partial'
                  ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30'
                  : 'bg-orange-500/20 text-orange-400 border border-orange-500/30 animate-pulse'
              }`}>
                {currentSnapshot.mode === 'live' ? '● LIVE' : currentSnapshot.mode === 'partial' ? '◐ PARTIAL' : '◈ DEMO'}
              </span>
            )}

            {lastRefresh && (
              <span className="text-xs text-slate-500">
                Updated {lastRefresh.toLocaleTimeString()}
              </span>
            )}

            <button
              onClick={() => fetchSnapshot(asset)}
              disabled={loading}
              className="text-xs bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
            >
              {loading ? '...' : 'Refresh'}
            </button>
          </div>
        </div>
      </header>

      {/* Demo banner */}
      {currentSnapshot?.mode === 'demo' && (
        <div className="bg-orange-500/10 border-b border-orange-500/20 text-orange-300 text-center text-xs py-2 px-4">
          DEMO MODE — Showing pre-computed example data. Set SYNTHDATA_API_KEY and restart for live signals.
        </div>
      )}

      {/* Asset tabs */}
      <div className="max-w-7xl mx-auto px-4 pt-4">
        <div className="flex gap-2 mb-4">
          {ASSETS.map(a => (
            <button
              key={a}
              onClick={() => setAsset(a)}
              className={`px-6 py-2 rounded-lg font-semibold text-sm transition-all ${
                asset === a
                  ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20'
                  : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-200'
              }`}
            >
              {a}
              {snapshots[a] && (
                <span className="ml-2 text-xs opacity-70">
                  ${snapshots[a]!.spot.toLocaleString()}
                </span>
              )}
              {snapshots[a]?.signals?.length ? (
                <span className="ml-2 bg-red-500 text-white text-xs px-1.5 py-0.5 rounded-full">
                  {snapshots[a]!.signals.length}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </div>

      {/* Main content */}
      <main className="max-w-7xl mx-auto px-4 pb-12">
        {loading && !currentSnapshot ? (
          <div className="flex items-center justify-center h-64 text-slate-400">
            <div className="text-center">
              <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
              <p>Loading {asset} data...</p>
            </div>
          </div>
        ) : currentSnapshot ? (
          <Dashboard
            snapshot={currentSnapshot}
            asset={asset}
            livePolyPrices={livePolyPrices}
            clobConnected={clobConnected}
          />
        ) : (
          <div className="flex items-center justify-center h-64 text-slate-500">
            No data available
          </div>
        )}
      </main>
    </div>
  )
}

export default App
