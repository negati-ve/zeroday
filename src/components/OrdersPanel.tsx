'use client'
import { useState, useCallback } from 'react'

interface KiteOrder {
  order_id: string
  tradingsymbol: string
  exchange: string
  transaction_type: 'BUY' | 'SELL'
  order_type: string
  quantity: number
  pending_quantity: number
  filled_quantity: number
  price: number
  trigger_price: number
  average_price: number
  status: string
  status_message: string | null
  product: string
  validity: string
  order_timestamp: string
}

const ACTIVE_STATUSES = new Set(['OPEN', 'TRIGGER PENDING', 'AMO REQ RECEIVED'])

function fmtTime(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    })
  } catch { return ts }
}

// ── Inline edit form ─────────────────────────────────────────────────────────

function EditForm({
  order,
  onDone,
}: {
  order: KiteOrder
  onDone: (changed: boolean) => void
}) {
  const [price, setPrice] = useState(String(order.price || order.trigger_price || ''))
  const [triggerPrice, setTriggerPrice] = useState(String(order.trigger_price || ''))
  const [qty, setQty] = useState(String(order.pending_quantity))
  const [loading, setLoading] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const isSL = order.order_type === 'SL' || order.order_type === 'SL-M'

  async function submit() {
    setLoading(true)
    setMsg(null)
    const body: any = { quantity: parseInt(qty, 10) }
    const p = parseFloat(price)
    const tp = parseFloat(triggerPrice)
    if (!isNaN(p) && p > 0 && order.order_type !== 'MARKET') body.price = p
    if (!isNaN(tp) && tp > 0 && isSL) body.trigger_price = tp
    try {
      const res = await fetch(`/api/orders/${order.order_id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (res.ok) {
        setMsg(`✓ Modified — ${data.order_id}`)
        setTimeout(() => onDone(true), 800)
      } else {
        setMsg(`✗ ${data.error}`)
      }
    } catch {
      setMsg('✗ Network error')
    }
    setLoading(false)
  }

  const labelStyle: React.CSSProperties = {
    fontSize: '9px', color: 'var(--text3)', letterSpacing: '0.08em', textTransform: 'uppercase',
  }
  const inputStyle: React.CSSProperties = {
    width: '80px',
    background: 'var(--bg)',
    border: '1px solid var(--border)',
    borderRadius: '3px',
    padding: '3px 6px',
    color: 'var(--text)',
    fontSize: '12px',
    fontFamily: 'inherit',
    outline: 'none',
  }
  const btnBase: React.CSSProperties = {
    border: 'none', borderRadius: '3px',
    padding: '4px 10px', fontSize: '11px',
    fontFamily: 'inherit', fontWeight: 700,
    cursor: loading ? 'not-allowed' : 'pointer',
    opacity: loading ? 0.6 : 1, letterSpacing: '0.05em',
  }

  return (
    <div style={{
      marginTop: '8px', padding: '8px 10px',
      background: 'var(--bg)',
      border: '1px solid var(--border)',
      borderRadius: '4px',
      display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'flex-end',
    }}>
      {/* Qty */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
        <span style={labelStyle}>Qty</span>
        <input type="number" min="1" step="1" value={qty}
          onChange={e => setQty(e.target.value)} style={inputStyle} />
      </div>

      {/* Price (for LIMIT / SL) */}
      {order.order_type !== 'MARKET' && order.order_type !== 'SL-M' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
          <span style={labelStyle}>Price ₹</span>
          <input type="number" min="0.05" step="0.05" value={price}
            onChange={e => setPrice(e.target.value)} style={inputStyle} />
        </div>
      )}

      {/* Trigger price (for SL / SL-M) */}
      {isSL && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
          <span style={labelStyle}>Trigger ₹</span>
          <input type="number" min="0.05" step="0.05" value={triggerPrice}
            onChange={e => setTriggerPrice(e.target.value)} style={inputStyle} />
        </div>
      )}

      <button onClick={submit} disabled={loading}
        style={{ ...btnBase, background: '#2196f3', color: '#fff' }}>
        {loading ? '...' : 'UPDATE'}
      </button>
      <button onClick={() => onDone(false)} disabled={loading}
        style={{ ...btnBase, background: 'transparent', color: 'var(--text3)',
          border: '1px solid var(--border)' }}>
        CANCEL
      </button>

      {msg && (
        <span style={{
          fontSize: '11px',
          color: msg.startsWith('✓') ? 'var(--bull)' : 'var(--bear)',
        }}>{msg}</span>
      )}
    </div>
  )
}

// ── Single order row ─────────────────────────────────────────────────────────

function OrderRow({
  order,
  onRefresh,
}: {
  order: KiteOrder
  onRefresh: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  async function cancelOrder() {
    if (!confirm(`Cancel order ${order.order_id}?`)) return
    setCancelling(true)
    setMsg(null)
    try {
      const res = await fetch(`/api/orders/${order.order_id}`, { method: 'DELETE' })
      const data = await res.json()
      if (res.ok) {
        setMsg('✓ Cancelled')
        setTimeout(onRefresh, 600)
      } else {
        setMsg(`✗ ${data.error}`)
      }
    } catch {
      setMsg('✗ Network error')
    }
    setCancelling(false)
  }

  const isBuy = order.transaction_type === 'BUY'
  const dirColor = isBuy ? 'var(--bull)' : 'var(--bear)'

  const tdStyle: React.CSSProperties = {
    padding: '5px 8px', fontSize: '11px',
    borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
  }
  const btnSmall: React.CSSProperties = {
    border: '1px solid var(--border)', borderRadius: '3px',
    padding: '2px 7px', fontSize: '10px', fontFamily: 'inherit',
    cursor: 'pointer', background: 'transparent', color: 'var(--text2)',
    letterSpacing: '0.04em',
  }

  return (
    <>
      <tr>
        {/* Time */}
        <td style={tdStyle}>
          <span style={{ color: 'var(--text3)', fontSize: '10px' }}>
            {fmtTime(order.order_timestamp)}
          </span>
        </td>
        {/* Symbol */}
        <td style={tdStyle}>
          <span style={{ fontWeight: 700 }}>{order.tradingsymbol}</span>
          <span style={{ color: 'var(--text3)', fontSize: '10px', marginLeft: '4px' }}>
            {order.exchange}
          </span>
        </td>
        {/* Direction */}
        <td style={{ ...tdStyle, color: dirColor, fontWeight: 700 }}>
          {order.transaction_type}
        </td>
        {/* Type */}
        <td style={{ ...tdStyle, color: 'var(--text3)', fontSize: '10px' }}>
          {order.order_type}
        </td>
        {/* Qty */}
        <td style={tdStyle}>
          {order.pending_quantity}
          {order.filled_quantity > 0 && (
            <span style={{ color: 'var(--text3)', fontSize: '10px' }}>
              {' '}({order.filled_quantity} filled)
            </span>
          )}
        </td>
        {/* Price */}
        <td style={{ ...tdStyle, fontWeight: 600 }}>
          {order.order_type === 'MARKET' ? '—' : `₹${order.price.toFixed(2)}`}
          {(order.order_type === 'SL' || order.order_type === 'SL-M') && order.trigger_price > 0 && (
            <span style={{ color: 'var(--text3)', fontSize: '10px' }}>
              {' '}trg ₹{order.trigger_price.toFixed(2)}
            </span>
          )}
        </td>
        {/* Status */}
        <td style={{ ...tdStyle, fontSize: '10px', color: 'var(--text3)' }}>
          {order.status}
          {order.status_message && (
            <span title={order.status_message}> ⚠</span>
          )}
        </td>
        {/* Actions */}
        <td style={{ ...tdStyle, display: 'flex', gap: '4px' }}>
          <button style={btnSmall} onClick={() => { setEditing(e => !e); setMsg(null) }}>
            {editing ? 'CLOSE' : 'EDIT'}
          </button>
          <button
            style={{ ...btnSmall, color: 'var(--bear)', borderColor: 'var(--bear)' }}
            disabled={cancelling}
            onClick={cancelOrder}
          >
            {cancelling ? '...' : 'CANCEL'}
          </button>
        </td>
      </tr>
      {/* Inline edit */}
      {editing && (
        <tr>
          <td colSpan={8} style={{ padding: '0 8px 6px', borderBottom: '1px solid var(--border)' }}>
            <EditForm order={order} onDone={(changed) => {
              setEditing(false)
              if (changed) setTimeout(onRefresh, 300)
            }} />
          </td>
        </tr>
      )}
      {/* Cancel message */}
      {msg && !editing && (
        <tr>
          <td colSpan={8} style={{ padding: '2px 8px 4px', borderBottom: '1px solid var(--border)' }}>
            <span style={{
              fontSize: '11px',
              color: msg.startsWith('✓') ? 'var(--bull)' : 'var(--bear)',
            }}>{msg}</span>
          </td>
        </tr>
      )}
    </>
  )
}

// ── Main panel ───────────────────────────────────────────────────────────────

export default function OrdersPanel() {
  const [orders, setOrders] = useState<KiteOrder[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/orders')
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to load orders')
      setOrders(data.orders ?? [])
    } catch (e: any) {
      setError(e.message)
    }
    setLoading(false)
  }, [])

  // Auto-load on mount
  useState(() => { load() })

  const activeOrders = (orders ?? []).filter(o => ACTIVE_STATUSES.has(o.status))
  const allOrders = (orders ?? [])

  const headerStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: expanded ? '8px' : '0',
    cursor: 'pointer', userSelect: 'none',
  }
  const thStyle: React.CSSProperties = {
    padding: '5px 8px', textAlign: 'left', fontSize: '9px',
    color: 'var(--text3)', letterSpacing: '0.08em',
    borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
  }

  return (
    <div style={{
      background: 'var(--bg2)',
      border: '1px solid var(--border)',
      borderRadius: '6px',
      padding: '12px 14px',
      marginTop: '16px',
    }}>
      {/* Header */}
      <div style={headerStyle} onClick={() => setExpanded(e => !e)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em', color: 'var(--text)' }}>
            ZERODHA ORDERS
          </span>
          {orders !== null && (
            <span style={{
              fontSize: '10px', color: activeOrders.length > 0 ? '#2196f3' : 'var(--text3)',
              background: activeOrders.length > 0 ? 'rgba(33,150,243,0.12)' : 'transparent',
              borderRadius: '3px', padding: '1px 5px',
            }}>
              {activeOrders.length} active / {allOrders.length} total
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <button
            onClick={e => { e.stopPropagation(); load() }}
            disabled={loading}
            style={{
              border: '1px solid var(--border)', borderRadius: '3px',
              padding: '3px 8px', fontSize: '10px', fontFamily: 'inherit',
              cursor: loading ? 'not-allowed' : 'pointer',
              background: 'transparent', color: 'var(--text3)',
              opacity: loading ? 0.5 : 1,
            }}
          >
            {loading ? '↻ ...' : '↻ REFRESH'}
          </button>
          <span style={{ fontSize: '12px', color: 'var(--text3)' }}>
            {expanded ? '▲' : '▼'}
          </span>
        </div>
      </div>

      {expanded && (
        <>
          {error && (
            <div style={{
              padding: '8px 10px', fontSize: '11px',
              color: 'var(--bear)', background: 'rgba(244,67,54,0.08)',
              borderRadius: '4px', marginBottom: '8px',
            }}>
              {error}
            </div>
          )}

          {orders === null && !loading && (
            <div style={{ fontSize: '11px', color: 'var(--text3)', padding: '8px 0' }}>
              Click REFRESH to load orders
            </div>
          )}

          {orders !== null && allOrders.length === 0 && (
            <div style={{ fontSize: '11px', color: 'var(--text3)', padding: '8px 0' }}>
              No orders found
            </div>
          )}

          {orders !== null && allOrders.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                <thead>
                  <tr>
                    <th style={thStyle}>TIME</th>
                    <th style={thStyle}>SYMBOL</th>
                    <th style={thStyle}>SIDE</th>
                    <th style={thStyle}>TYPE</th>
                    <th style={thStyle}>QTY</th>
                    <th style={thStyle}>PRICE</th>
                    <th style={thStyle}>STATUS</th>
                    <th style={thStyle}>ACTIONS</th>
                  </tr>
                </thead>
                <tbody>
                  {allOrders.map(o => (
                    <OrderRow key={o.order_id} order={o} onRefresh={load} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
