'use client'
import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import ThemeToggle from '@/components/ThemeToggle'

// ── Types ────────────────────────────────────────────────────────────────────

interface OpenPos {
  id: number
  stock: string
  direction: 'BULL' | 'BEAR'
  entryPrice: number
  entryTime: number
  peakMovePct: number
  currentPrice: number
  pnlPct: number
  optionPnl: number | null
  holdMin: number
}

interface ClosedPos {
  id: number
  stock: string
  direction: 'BULL' | 'BEAR'
  entryPrice: number
  entryTime: number
  exitPrice: number
  exitTime: number
  exitReason: string
  peakMovePct: number
  optType: string | null
  strike: number | null
  lotSize: number | null
  optionPnl: number | null
}

interface LiveStrat {
  liveId: number
  strategyId: number
  name: string
  isActive: boolean
  openPositions: OpenPos[]
  closedToday: ClosedPos[]
  totalPnlToday: number
  totalOptionPnlToday: number
}

interface Snapshot {
  strategies: LiveStrat[]
  updatedAt: number
}

interface SavedStrat { id: number; name: string; config: any }

// ── Styles ───────────────────────────────────────────────────────────────────

const btnStyle: React.CSSProperties = {
  border: '1px solid var(--border)', borderRadius: '4px',
  padding: '6px 14px', fontSize: '11px', fontFamily: 'inherit',
  cursor: 'pointer', letterSpacing: '0.05em', transition: 'all 0.15s',
  background: 'transparent', color: 'var(--text2)',
}

const cardStyle: React.CSSProperties = {
  background: 'var(--bg2)', border: '1px solid var(--border)',
  borderRadius: '6px', padding: '12px 14px',
  display: 'flex', flexDirection: 'column', gap: '4px',
}

const sectionTitle: React.CSSProperties = {
  fontSize: '10px', fontWeight: 700, letterSpacing: '0.1em',
  color: 'var(--text3)', textTransform: 'uppercase',
  marginBottom: '8px', marginTop: '16px',
}

const thStyle: React.CSSProperties = {
  padding: '6px 8px', textAlign: 'left', fontSize: '9px',
  color: 'var(--text3)', letterSpacing: '0.08em',
  borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
}

const tdStyle: React.CSSProperties = {
  padding: '4px 8px', fontSize: '11px',
  borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
}

function fmtTime(epoch: number): string {
  return new Date(epoch).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
}

function fmtDateTime(epoch: number): string {
  return new Date(epoch).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

function pnlColor(v: number): string { return v >= 0 ? 'var(--bull)' : 'var(--bear)' }
function signed(v: number, decimals = 2): string { return `${v >= 0 ? '+' : ''}${v.toFixed(decimals)}` }

// ── Main Component ───────────────────────────────────────────────────────────

export default function LiveClient() {
  const router = useRouter()
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [strategies, setStrategies] = useState<SavedStrat[]>([])
  const [selectedStratId, setSelectedStratId] = useState<number | null>(null)
  const esRef = useRef<EventSource | null>(null)

  // Load saved strategies
  useEffect(() => {
    fetch('/api/strategies').then(r => r.json()).then(d => {
      if (Array.isArray(d)) {
        setStrategies(d)
        if (d.length > 0 && !selectedStratId) setSelectedStratId(d[0].id)
      }
    }).catch(() => {})
  }, [])

  // SSE connection
  useEffect(() => {
    const es = new EventSource('/api/live/stream')
    esRef.current = es
    es.onmessage = (ev) => {
      try { setSnapshot(JSON.parse(ev.data)) } catch {}
    }
    return () => es.close()
  }, [])

  async function handleStart() {
    if (!selectedStratId) return
    await fetch('/api/live', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ strategyId: selectedStratId }),
    })
  }

  async function handleStop(liveId: number) {
    await fetch('/api/live', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ liveId }),
    })
  }

  async function handleClosePosition(positionId: number) {
    await fetch('/api/live/positions', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ positionId }),
    })
  }

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' })
    router.push('/')
  }

  const activeStrats = snapshot?.strategies.filter(s => s.isActive) ?? []
  const stoppedStrats = snapshot?.strategies.filter(s => !s.isActive) ?? []
  const allOpenPositions = activeStrats.flatMap(s => s.openPositions.map(p => ({ ...p, stratName: s.name })))
  const allClosedToday = snapshot?.strategies.flatMap(s => s.closedToday.map(t => ({ ...t, stratName: s.name }))) ?? []

  const totalPnl = snapshot?.strategies.reduce((s, st) => s + st.totalPnlToday, 0) ?? 0
  const totalOptPnl = snapshot?.strategies.reduce((s, st) => s + st.totalOptionPnlToday, 0) ?? 0
  const totalTrades = allClosedToday.length
  const wins = allClosedToday.filter(t => {
    const move = t.direction === 'BULL'
      ? ((t.exitPrice - t.entryPrice) / t.entryPrice) * 100
      : ((t.entryPrice - t.exitPrice) / t.entryPrice) * 100
    return move > 0
  }).length

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <header style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexWrap: 'wrap', gap: '8px', padding: '10px 16px',
        borderBottom: '1px solid var(--border)', background: 'var(--bg2)',
        position: 'sticky', top: 0, zIndex: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px' }}>
          <a href="/dashboard" style={{ fontWeight: 700, fontSize: '15px', letterSpacing: '-0.02em', color: 'var(--text)', textDecoration: 'none' }}>ZERODAY</a>
          <span style={{ color: 'var(--text3)', fontSize: '10px' }}>/</span>
          <span style={{ fontSize: '12px', color: 'var(--text2)', letterSpacing: '0.05em', fontWeight: 600 }}>LIVE PAPER</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <a href="/dashboard" style={{ ...btnStyle, textDecoration: 'none', display: 'inline-block', padding: '4px 10px', fontSize: '11px' }}>DASHBOARD</a>
          <a href="/dashboard/backtest" style={{ ...btnStyle, textDecoration: 'none', display: 'inline-block', padding: '4px 10px', fontSize: '11px' }}>BACKTEST</a>
          <a href="/dashboard/conviction" style={{ ...btnStyle, textDecoration: 'none', display: 'inline-block', padding: '4px 10px', fontSize: '11px', color: 'var(--accent)', fontWeight: 700 }}>CONVICTION</a>
          <ThemeToggle />
          <button onClick={handleLogout} style={{ ...btnStyle, padding: '4px 10px', fontSize: '11px' }}>SIGN OUT</button>
        </div>
      </header>

      <div style={{ padding: '16px', maxWidth: '1200px', width: '100%', margin: '0 auto' }}>
        {/* Strategy controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
          <select
            value={selectedStratId ?? ''}
            onChange={e => setSelectedStratId(Number(e.target.value) || null)}
            style={{
              padding: '6px 10px', background: 'var(--bg3)', border: '1px solid var(--border)',
              borderRadius: '4px', color: 'var(--text)', fontFamily: 'inherit', fontSize: '12px',
              minWidth: '200px',
            }}
          >
            <option value="">Select strategy...</option>
            {strategies.map(s => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <button onClick={handleStart} disabled={!selectedStratId} style={{
            ...btnStyle, background: 'var(--bull)', color: 'var(--bg)', border: 'none',
            fontWeight: 700, opacity: selectedStratId ? 1 : 0.4,
          }}>START LIVE</button>
          {strategies.length === 0 && (
            <span style={{ fontSize: '10px', color: 'var(--text3)' }}>
              No strategies saved. Go to BACKTEST to create one.
            </span>
          )}
        </div>

        {/* Summary cards */}
        {snapshot && snapshot.strategies.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: '8px', marginBottom: '16px' }}>
            <div style={cardStyle}>
              <span style={{ fontSize: '9px', color: 'var(--text3)', letterSpacing: '0.08em' }}>ACTIVE</span>
              <span style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text)' }}>{activeStrats.length}</span>
            </div>
            <div style={cardStyle}>
              <span style={{ fontSize: '9px', color: 'var(--text3)', letterSpacing: '0.08em' }}>OPEN POS</span>
              <span style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text)' }}>{allOpenPositions.length}</span>
            </div>
            <div style={cardStyle}>
              <span style={{ fontSize: '9px', color: 'var(--text3)', letterSpacing: '0.08em' }}>CLOSED TODAY</span>
              <span style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text)' }}>{totalTrades}</span>
            </div>
            <div style={cardStyle}>
              <span style={{ fontSize: '9px', color: 'var(--text3)', letterSpacing: '0.08em' }}>WIN RATE</span>
              <span style={{ fontSize: '16px', fontWeight: 700, color: totalTrades > 0 && wins / totalTrades >= 0.5 ? 'var(--bull)' : 'var(--bear)' }}>
                {totalTrades > 0 ? `${(wins / totalTrades * 100).toFixed(0)}%` : '—'}
              </span>
            </div>
            <div style={cardStyle}>
              <span style={{ fontSize: '9px', color: 'var(--text3)', letterSpacing: '0.08em' }}>TOTAL P&L</span>
              <span style={{ fontSize: '16px', fontWeight: 700, color: pnlColor(totalPnl) }}>
                {signed(totalPnl, 3)}%
              </span>
            </div>
            {totalOptPnl !== 0 && (
              <div style={cardStyle}>
                <span style={{ fontSize: '9px', color: 'var(--text3)', letterSpacing: '0.08em' }}>OPTION P&L</span>
                <span style={{ fontSize: '16px', fontWeight: 700, color: pnlColor(totalOptPnl) }}>
                  {signed(totalOptPnl, 0)}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Active strategies */}
        {activeStrats.length > 0 && (
          <>
            <div style={sectionTitle}>ACTIVE STRATEGIES</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: '10px', marginBottom: '8px' }}>
              {activeStrats.map(s => (
                <div key={s.liveId} style={{ ...cardStyle, borderColor: 'var(--bull)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontWeight: 700, fontSize: '13px', color: 'var(--text)' }}>{s.name}</span>
                    <button onClick={() => handleStop(s.liveId)} style={{
                      ...btnStyle, padding: '3px 8px', fontSize: '9px', color: 'var(--bear)',
                    }}>STOP</button>
                  </div>
                  <div style={{ display: 'flex', gap: '16px', fontSize: '11px', color: 'var(--text2)', marginTop: '4px' }}>
                    <span>{s.openPositions.length} open</span>
                    <span>{s.closedToday.length} closed</span>
                    <span style={{ color: pnlColor(s.totalPnlToday), fontWeight: 600 }}>
                      {signed(s.totalPnlToday, 3)}%
                    </span>
                    {s.totalOptionPnlToday !== 0 && (
                      <span style={{ color: pnlColor(s.totalOptionPnlToday), fontWeight: 600 }}>
                        {s.totalOptionPnlToday >= 0 ? '+' : ''}{s.totalOptionPnlToday.toLocaleString('en-IN')}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Open positions */}
        {allOpenPositions.length > 0 && (
          <>
            <div style={sectionTitle}>OPEN POSITIONS</div>
            <div style={{ overflowX: 'auto', marginBottom: '16px' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'inherit' }}>
                <thead>
                  <tr>
                    <th style={thStyle}>STRATEGY</th>
                    <th style={thStyle}>STOCK</th>
                    <th style={thStyle}>DIR</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>ENTRY</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>CURRENT</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>P&L</th>
                    {allOpenPositions.some(p => p.optionPnl != null) && (
                      <th style={{ ...thStyle, textAlign: 'right' }}>OPT P&L</th>
                    )}
                    <th style={{ ...thStyle, textAlign: 'right' }}>HOLD</th>
                    <th style={thStyle}></th>
                  </tr>
                </thead>
                <tbody>
                  {allOpenPositions.map((p, i) => (
                    <tr key={p.id} style={{ background: i % 2 === 0 ? 'transparent' : 'var(--bg2)' }}>
                      <td style={{ ...tdStyle, fontSize: '10px', color: 'var(--text3)' }}>{p.stratName}</td>
                      <td style={{ ...tdStyle, fontWeight: 600, color: 'var(--text)' }}>{p.stock.replace('NSE:', '')}</td>
                      <td style={{ ...tdStyle, color: p.direction === 'BULL' ? 'var(--bull)' : 'var(--bear)', fontWeight: 600 }}>
                        {p.direction === 'BULL' ? '▲' : '▼'}
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--text2)' }}>{p.entryPrice.toFixed(2)}</td>
                      <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--text2)' }}>{p.currentPrice.toFixed(2)}</td>
                      <td style={{ ...tdStyle, textAlign: 'right', color: pnlColor(p.pnlPct), fontWeight: 600 }}>
                        {signed(p.pnlPct, 3)}%
                      </td>
                      {allOpenPositions.some(p => p.optionPnl != null) && (
                        <td style={{ ...tdStyle, textAlign: 'right', color: pnlColor(p.optionPnl ?? 0), fontWeight: 600 }}>
                          {p.optionPnl != null ? `${p.optionPnl >= 0 ? '+' : ''}${p.optionPnl.toLocaleString('en-IN')}` : '—'}
                        </td>
                      )}
                      <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--text2)' }}>{p.holdMin.toFixed(1)}m</td>
                      <td style={tdStyle}>
                        <button onClick={() => handleClosePosition(p.id)} style={{
                          ...btnStyle, padding: '2px 6px', fontSize: '9px', color: 'var(--bear)',
                        }}>CLOSE</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* Closed trades today */}
        {allClosedToday.length > 0 && (
          <>
            <div style={sectionTitle}>CLOSED TODAY ({allClosedToday.length})</div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'inherit' }}>
                <thead>
                  <tr>
                    <th style={thStyle}>TIME</th>
                    <th style={thStyle}>STRATEGY</th>
                    <th style={thStyle}>STOCK</th>
                    <th style={thStyle}>DIR</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>ENTRY</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>EXIT</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>P&L</th>
                    {allClosedToday.some(t => t.optionPnl != null) && (
                      <th style={{ ...thStyle, textAlign: 'right' }}>OPT P&L</th>
                    )}
                    <th style={thStyle}>EXIT</th>
                  </tr>
                </thead>
                <tbody>
                  {allClosedToday
                    .sort((a, b) => b.exitTime - a.exitTime)
                    .map((t, i) => {
                      const movePct = t.direction === 'BULL'
                        ? ((t.exitPrice - t.entryPrice) / t.entryPrice) * 100
                        : ((t.entryPrice - t.exitPrice) / t.entryPrice) * 100
                      return (
                        <tr key={t.id} style={{ background: i % 2 === 0 ? 'transparent' : 'var(--bg2)' }}>
                          <td style={{ ...tdStyle, fontSize: '10px', color: 'var(--text3)' }}>{fmtTime(t.exitTime)}</td>
                          <td style={{ ...tdStyle, fontSize: '10px', color: 'var(--text3)' }}>{t.stratName}</td>
                          <td style={{ ...tdStyle, fontWeight: 600, color: 'var(--text)' }}>{t.stock.replace('NSE:', '')}</td>
                          <td style={{ ...tdStyle, color: t.direction === 'BULL' ? 'var(--bull)' : 'var(--bear)', fontWeight: 600 }}>
                            {t.direction === 'BULL' ? '▲' : '▼'}
                          </td>
                          <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--text2)' }}>{t.entryPrice.toFixed(2)}</td>
                          <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--text2)' }}>{t.exitPrice.toFixed(2)}</td>
                          <td style={{ ...tdStyle, textAlign: 'right', color: pnlColor(movePct), fontWeight: 600 }}>
                            {signed(movePct, 3)}%
                          </td>
                          {allClosedToday.some(t2 => t2.optionPnl != null) && (
                            <td style={{ ...tdStyle, textAlign: 'right', color: pnlColor(t.optionPnl ?? 0), fontWeight: 600 }}>
                              {t.optionPnl != null ? `${t.optionPnl >= 0 ? '+' : ''}${t.optionPnl.toLocaleString('en-IN')}` : '—'}
                            </td>
                          )}
                          <td style={{ ...tdStyle, fontSize: '10px', color: exitColor(t.exitReason) }}>{t.exitReason}</td>
                        </tr>
                      )
                    })}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* Empty state */}
        {snapshot && snapshot.strategies.length === 0 && (
          <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text3)' }}>
            <div style={{ fontSize: '14px', marginBottom: '8px' }}>No live strategies running</div>
            <div style={{ fontSize: '11px' }}>
              Save a strategy from the <a href="/dashboard/backtest" style={{ color: 'var(--accent)' }}>BACKTEST</a> screen, then start it here.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function exitColor(reason: string): string {
  switch (reason) {
    case 'TakeProfit': return 'var(--bull)'
    case 'StopLoss': case 'NoProfit': return 'var(--bear)'
    case 'Trail': return 'var(--mixed)'
    default: return 'var(--text3)'
  }
}
