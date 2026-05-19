'use client'
import { useState } from 'react'
import type { Position } from '@/lib/stockState'

function pnlColor(pnl: number | null) {
  if (pnl == null) return 'var(--text3)'
  if (pnl > 0) return 'var(--bull)'
  if (pnl < 0) return 'var(--bear)'
  return 'var(--text3)'
}

function ExitForm({ pos, onDone }: { pos: Position; onDone: () => void }) {
  const [price, setPrice] = useState(
    pos.currentBid != null ? String(pos.currentBid.toFixed(2)) : ''
  )
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  async function submit() {
    const p = parseFloat(price)
    if (!p || p <= 0) { setResult('Enter a valid price'); return }
    setLoading(true)
    setResult(null)
    try {
      const res = await fetch('/api/positions/exit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: pos.buySymbol, quantity: pos.lotSize, price: p }),
      })
      const data = await res.json()
      if (res.ok) {
        setResult(`✓ Order placed — ID: ${data.order_id}`)
      } else {
        setResult(`✗ ${data.error}`)
      }
    } catch (e) {
      setResult(`✗ Network error`)
    }
    setLoading(false)
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px', flexWrap: 'wrap' }}>
      <span style={{ fontSize: '10px', color: 'var(--text3)' }}>LIMIT SELL {pos.lotSize} @ ₹</span>
      <input
        type="number"
        step="0.05"
        min="0.05"
        value={price}
        onChange={e => setPrice(e.target.value)}
        style={{
          width: '80px',
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: '3px',
          padding: '3px 6px',
          color: 'var(--text)',
          fontSize: '12px',
          fontFamily: 'inherit',
          outline: 'none',
        }}
      />
      <button
        onClick={submit}
        disabled={loading}
        style={{
          background: 'var(--bear)',
          color: '#fff',
          border: 'none',
          borderRadius: '3px',
          padding: '4px 10px',
          fontSize: '11px',
          fontFamily: 'inherit',
          fontWeight: 700,
          cursor: loading ? 'not-allowed' : 'pointer',
          opacity: loading ? 0.6 : 1,
          letterSpacing: '0.05em',
        }}
      >
        {loading ? '...' : 'PLACE'}
      </button>
      <button
        onClick={onDone}
        style={{
          background: 'transparent',
          border: '1px solid var(--border)',
          borderRadius: '3px',
          padding: '4px 8px',
          fontSize: '11px',
          fontFamily: 'inherit',
          color: 'var(--text3)',
          cursor: 'pointer',
        }}
      >
        CANCEL
      </button>
      {result && (
        <span style={{ fontSize: '11px', color: result.startsWith('✓') ? 'var(--bull)' : 'var(--bear)' }}>
          {result}
        </span>
      )}
    </div>
  )
}

export default function PositionsPanel({ positions }: { positions: Position[] }) {
  const [exitingId, setExitingId] = useState<string | null>(null)

  if (!positions || positions.length === 0) return null

  return (
    <div style={{
      padding: '12px 20px',
      borderBottom: '1px solid var(--border)',
      background: 'var(--bg2)',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
    }}>
      <div style={{ fontSize: '10px', color: 'var(--text3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
        Open Positions ({positions.length})
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
        {positions.map(pos => {
          const id = pos.buySymbol
          const isExitOpen = exitingId === id
          const dirColor = pos.direction === 'BULL' ? 'var(--bull)' : 'var(--bear)'

          return (
            <div key={id} style={{
              background: 'var(--bg3)',
              border: `1px solid ${pos.isExiting ? 'var(--mixed)' : 'var(--border)'}`,
              borderRadius: '6px',
              padding: '10px 12px',
              minWidth: '280px',
              flex: '0 0 auto',
            }}>
              {/* Header row */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ fontWeight: 700, fontSize: '13px' }}>{pos.stock}</span>
                  <span style={{ fontSize: '10px', color: dirColor, fontWeight: 700 }}>
                    {pos.direction === 'BULL' ? '▲' : '▼'} {pos.direction}
                  </span>
                  {pos.source === 'zerodha' && (
                    <span style={{ fontSize: '9px', color: 'var(--text3)', border: '1px solid var(--border)', borderRadius: '3px', padding: '1px 4px' }}>
                      LIVE
                    </span>
                  )}
                  {pos.isExiting && (
                    <span style={{ fontSize: '9px', color: 'var(--mixed)', border: '1px solid var(--mixed)', borderRadius: '3px', padding: '1px 4px' }}>
                      ALERT
                    </span>
                  )}
                </div>
                <span style={{ fontSize: '11px', color: pnlColor(pos.pnl), fontWeight: 600 }}>
                  {pos.pnl != null ? `${pos.pnl >= 0 ? '+' : ''}₹${pos.pnl}` : '—'}
                </span>
              </div>

              {/* Symbol + details */}
              <div style={{ marginTop: '4px', fontSize: '10px', color: 'var(--text3)', display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--text2)' }}>{pos.buySymbol}</span>
                <span>entry ₹{pos.buyEntry.toFixed(2)}</span>
                {pos.currentBid != null && <span>bid ₹{pos.currentBid.toFixed(2)}</span>}
                <span>held {pos.heldMin}m</span>
                {pos.peak > 0 && <span>peak ₹{pos.peak.toFixed(0)}</span>}
                <span>qty {pos.lotSize}</span>
              </div>

              {/* Exit controls */}
              {!isExitOpen ? (
                <button
                  onClick={() => setExitingId(id)}
                  style={{
                    marginTop: '8px',
                    background: 'transparent',
                    border: '1px solid var(--bear)',
                    borderRadius: '3px',
                    padding: '3px 10px',
                    fontSize: '11px',
                    fontFamily: 'inherit',
                    color: 'var(--bear)',
                    cursor: 'pointer',
                    letterSpacing: '0.05em',
                    fontWeight: 600,
                  }}
                >
                  LIMIT EXIT
                </button>
              ) : (
                <ExitForm pos={pos} onDone={() => setExitingId(null)} />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
