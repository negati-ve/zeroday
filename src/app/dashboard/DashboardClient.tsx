'use client'
import { useEffect, useState, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import StockCard from '@/components/StockCard'
import ThemeToggle from '@/components/ThemeToggle'
import PositionsPanel from '@/components/PositionsPanel'
import type { StockState, Position, CapitalData } from '@/lib/stockState'

type StockEntry = StockState & { name: string }

// All NSE F&O stocks available for adding to watchlist
const NFO_STOCKS = ["360ONE","ABB","ABCAPITAL","ADANIENSOL","ADANIENT","ADANIGREEN","ADANIPORTS","ADANIPOWER","ALKEM","AMBER","AMBUJACEM","ANGELONE","APLAPOLLO","APOLLOHOSP","ASHOKLEY","ASIANPAINT","ASTRAL","AUBANK","AUROPHARMA","AXISBANK","BAJAJ-AUTO","BAJAJFINSV","BAJAJHLDNG","BAJFINANCE","BANDHANBNK","BANKBARODA","BANKINDIA","BDL","BEL","BHARATFORG","BHARTIARTL","BHEL","BIOCON","BLUESTARCO","BOSCHLTD","BPCL","BRITANNIA","BSE","CAMS","CANBK","CDSL","CGPOWER","CHOLAFIN","CIPLA","COALINDIA","COCHINSHIP","COFORGE","COLPAL","CONCOR","CROMPTON","CUMMINSIND","DABUR","DALBHARAT","DELHIVERY","DIVISLAB","DIXON","DLF","DMART","DRREDDY","EICHERMOT","ETERNAL","EXIDEIND","FEDERALBNK","FORCEMOT","FORTIS","GAIL","GLENMARK","GMRAIRPORT","GODFRYPHLP","GODREJCP","GODREJPROP","GRASIM","HAL","HAVELLS","HCLTECH","HDFCAMC","HDFCBANK","HDFCLIFE","HEROMOTOCO","HINDALCO","HINDPETRO","HINDUNILVR","HINDZINC","HUDCO","HYUNDAI","ICICIBANK","ICICIGI","ICICIPRULI","IDEA","IDFCFIRSTB","IEX","INDHOTEL","INDIANB","INDIGO","INDUSINDBK","INDUSTOWER","INFY","INOXWIND","IOC","IREDA","IRFC","ITC","JINDALSTEL","JIOFIN","JSWENERGY","JSWSTEEL","JUBLFOOD","KALYANKJIL","KAYNES","KEI","KFINTECH","KOTAKBANK","KPITTECH","LAURUSLABS","LICHSGFIN","LICI","LODHA","LT","LTF","LTM","LUPIN","M&M","MANAPPURAM","MANKIND","MARICO","MARUTI","MAXHEALTH","MAZDOCK","MCX","MFSL","MOTHERSON","MOTILALOFS","MPHASIS","MUTHOOTFIN","NAM-INDIA","NATIONALUM","NAUKRI","NBCC","NESTLEIND","NHPC","NMDC","NTPC","NUVAMA","NYKAA","OBEROIRLTY","OFSS","OIL","ONGC","PAGEIND","PATANJALI","PAYTM","PERSISTENT","PETRONET","PFC","PGEL","PHOENIXLTD","PIDILITIND","PIIND","PNB","PNBHOUSING","POLICYBZR","POLYCAB","POWERGRID","POWERINDIA","PPLPHARMA","PREMIERENE","PRESTIGE","RBLBANK","RECLTD","RELIANCE","RVNL","SAIL","SBICARD","SBILIFE","SBIN","SHREECEM","SHRIRAMFIN","SIEMENS","SOLARINDS","SONACOMS","SRF","SUNPHARMA","SUPREMEIND","SUZLON","SWIGGY","TATACONSUM","TATAELXSI","TATAPOWER","TATASTEEL","TATATECH","TCS","TECHM","TIINDIA","TITAN","TORNTPHARM","TORNTPOWER","TRENT","TVSMOTOR","ULTRACEMCO","UNIONBANK","UNITDSPR","UNOMINDA","UPL","VBL","VEDL","VOLTAS","WAAREEENER","WIPRO","YESBANK","ZYDUSLIFE"]

function toIST(ts: number) {
  return new Date(ts).toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  })
}

// ── Watchlist Modal ────────────────────────────────────────────────────────────

function WatchlistModal({ onClose }: { onClose: () => void }) {
  const [stocks, setStocks]   = useState<string[]>([])
  const [input, setInput]     = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving]   = useState(false)
  const [toast, setToast]     = useState<{ msg: string; ok: boolean } | null>(null)
  const [dirty, setDirty]     = useState(false)
  const inputRef              = useRef<HTMLInputElement>(null)
  const overlayRef            = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch('/api/watchlist').then(r => r.json()).then(d => {
      setStocks(d.stocks ?? [])
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [onClose])

  const onOverlayClick = (e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose()
  }

  const filtered = input.trim().length > 0
    ? NFO_STOCKS.filter(s => s.includes(input.trim().toUpperCase()) && !stocks.includes(s))
    : []

  function addStock(sym: string) {
    const s = sym.trim().toUpperCase()
    if (!s || stocks.includes(s)) return
    setStocks(prev => [...prev, s])
    setInput('')
    setDirty(true)
    inputRef.current?.focus()
  }

  function removeStock(sym: string) {
    setStocks(prev => prev.filter(s => s !== sym))
    setDirty(true)
  }

  async function save(restartBot: boolean) {
    setSaving(true)
    setToast(null)
    try {
      const res = await fetch('/api/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stocks, restartBot }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Save failed')
      setDirty(false)
      const msg = restartBot
        ? data.botRestarted ? '✓ Saved — bot restarting…' : `✓ Saved${data.botError ? ` (bot: ${data.botError})` : ''}`
        : '✓ Saved — restart bot to apply changes'
      setToast({ msg, ok: !data.botError || !restartBot })
    } catch (e: any) {
      setToast({ msg: `✗ ${e?.message ?? 'Unknown error'}`, ok: false })
    } finally {
      setSaving(false)
    }
  }

  const btn: React.CSSProperties = {
    border: '1px solid var(--border)', borderRadius: '4px',
    padding: '6px 14px', fontSize: '11px', fontFamily: 'inherit',
    cursor: 'pointer', letterSpacing: '0.05em', transition: 'all 0.15s',
  }

  return (
    <div
      ref={overlayRef}
      onClick={onOverlayClick}
      style={{
        position: 'fixed', inset: 0, zIndex: 2000,
        background: 'rgba(0,0,0,0.65)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '16px',
      }}
    >
      <div style={{
        background: 'var(--bg2)', border: '1px solid var(--border)',
        borderRadius: '8px', padding: '20px',
        width: '100%', maxWidth: '480px', maxHeight: '90vh',
        display: 'flex', flexDirection: 'column', gap: '16px',
        boxShadow: '0 8px 40px rgba(0,0,0,0.5)',
        overflowY: 'auto',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: '13px', fontWeight: 700, letterSpacing: '-0.02em' }}>STOCK WATCHLIST</span>
          <button
            onClick={onClose}
            style={{ ...btn, padding: '3px 8px', fontSize: '12px', color: 'var(--text3)' }}
          >✕</button>
        </div>

        {/* Add input */}
        <div>
          <div style={{ fontSize: '9px', color: 'var(--text3)', letterSpacing: '0.1em', marginBottom: '6px' }}>ADD STOCK</div>
          <div style={{ position: 'relative' }}>
            <input
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value.toUpperCase())}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  if (filtered.length > 0) addStock(filtered[0])
                  else if (NFO_STOCKS.includes(input.trim().toUpperCase())) addStock(input)
                }
              }}
              placeholder="Type to search (e.g. HDFC)"
              autoFocus
              style={{
                width: '100%', padding: '8px 10px',
                background: 'var(--bg3)', border: '1px solid var(--border)',
                borderRadius: '4px', color: 'var(--text)',
                fontFamily: 'inherit', fontSize: '12px', outline: 'none',
              }}
            />
            {filtered.length > 0 && (
              <div style={{
                position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100,
                background: 'var(--bg2)', border: '1px solid var(--border)',
                borderRadius: '4px', marginTop: '2px',
                maxHeight: '160px', overflowY: 'auto',
                boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
              }}>
                {filtered.slice(0, 8).map(s => (
                  <button
                    key={s}
                    onClick={() => addStock(s)}
                    style={{
                      display: 'block', width: '100%', padding: '7px 12px',
                      textAlign: 'left', border: 'none', background: 'transparent',
                      color: 'var(--text)', fontFamily: 'inherit', fontSize: '12px',
                      cursor: 'pointer',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg3)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Current stocks */}
        <div>
          <div style={{ fontSize: '9px', color: 'var(--text3)', letterSpacing: '0.1em', marginBottom: '8px' }}>
            CURRENT WATCHLIST {loading ? '…' : `(${stocks.length})`}
          </div>
          {loading ? (
            <div style={{ color: 'var(--text3)', fontSize: '11px' }}>Loading…</div>
          ) : stocks.length === 0 ? (
            <div style={{ color: 'var(--text3)', fontSize: '11px', fontStyle: 'italic' }}>No stocks — add one above</div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {stocks.map(s => (
                <div key={s} style={{
                  display: 'flex', alignItems: 'center', gap: '4px',
                  background: 'var(--bg3)', border: '1px solid var(--border)',
                  borderRadius: '4px', padding: '3px 8px',
                  fontSize: '11px', color: 'var(--text2)',
                }}>
                  <span>{s}</span>
                  <button
                    onClick={() => removeStock(s)}
                    style={{
                      border: 'none', background: 'transparent',
                      color: 'var(--text3)', cursor: 'pointer',
                      padding: '0 0 0 4px', fontFamily: 'inherit',
                      fontSize: '13px', lineHeight: 1,
                    }}
                    title={`Remove ${s}`}
                  >×</button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Toast */}
        {toast && (
          <div style={{
            fontSize: '11px', padding: '8px 12px', borderRadius: '4px',
            background: toast.ok ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
            border: `1px solid ${toast.ok ? 'var(--bull)' : 'var(--bear)'}`,
            color: toast.ok ? 'var(--bull)' : 'var(--bear)',
          }}>
            {toast.msg}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button
            onClick={() => save(false)}
            disabled={saving || !dirty}
            style={{
              ...btn,
              background: dirty && !saving ? 'var(--bg3)' : 'transparent',
              color: dirty ? 'var(--text2)' : 'var(--text3)',
              opacity: saving ? 0.6 : 1,
            }}
          >
            {saving ? 'SAVING…' : 'SAVE'}
          </button>
          <button
            onClick={() => save(true)}
            disabled={saving}
            style={{
              ...btn,
              background: saving ? 'transparent' : 'var(--bull)',
              color: saving ? 'var(--text3)' : '#000',
              border: saving ? '1px solid var(--border)' : 'none',
              opacity: saving ? 0.6 : 1,
            }}
          >
            {saving ? 'SAVING…' : dirty ? 'SAVE & RESTART BOT' : 'RESTART BOT'}
          </button>
          <button
            onClick={onClose}
            style={{ ...btn, marginLeft: 'auto', color: 'var(--text3)' }}
          >
            CLOSE
          </button>
        </div>

        <div style={{ fontSize: '9px', color: 'var(--text3)', lineHeight: 1.6 }}>
          Changes take effect after bot restart. Bot reinitialises WebSocket subscriptions for the new stock list.
        </div>
      </div>
    </div>
  )
}

// ── Account Value Bar ─────────────────────────────────────────────────────────

function fmtINR(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1_00_000) return `${(n / 1_00_000).toFixed(2)}L`
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toFixed(0)
}

function AccountBar({ capital, positions }: { capital: CapitalData | null; positions: Position[] }) {
  const available = capital?.net ?? null
  const holdings = positions.reduce((sum, p) => sum + (p.currentBid != null ? p.currentBid * p.lotSize : 0), 0)
  const openPnl = positions.reduce((sum, p) => sum + (p.pnl ?? 0), 0)
  const total = available != null ? available + holdings : null
  const pnlColor = openPnl >= 0 ? 'var(--bull)' : 'var(--bear)'
  const realizedToday = capital?.realizedToday ?? 0
  const realColor = realizedToday >= 0 ? 'var(--bull)' : 'var(--bear)'

  const cell: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px', minWidth: '70px',
  }
  const label: React.CSSProperties = {
    fontSize: '9px', color: 'var(--text3)', letterSpacing: '0.08em', textTransform: 'uppercase',
  }
  const value: React.CSSProperties = {
    fontSize: '14px', fontWeight: 700, letterSpacing: '-0.02em',
  }
  const sep: React.CSSProperties = { fontSize: '14px', color: 'var(--text3)', fontWeight: 300 }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      gap: '20px', padding: '10px 16px',
      borderBottom: '1px solid var(--border)', background: 'var(--bg2)',
      flexWrap: 'wrap',
    }}>
      <div style={cell}>
        <span style={label}>Available</span>
        <span style={{ ...value, color: 'var(--text)' }}>
          {available != null ? `₹${fmtINR(available)}` : '—'}
        </span>
      </div>
      <span style={sep}>+</span>
      <div style={cell}>
        <span style={label}>Holdings</span>
        <span style={{ ...value, color: 'var(--text)' }}>
          ₹{fmtINR(holdings)}
        </span>
      </div>
      <span style={sep}>=</span>
      <div style={cell}>
        <span style={label}>Total</span>
        <span style={{ ...value, color: 'var(--text)' }}>
          {total != null ? `₹${fmtINR(total)}` : '—'}
        </span>
      </div>
      <div style={{ width: '1px', height: '28px', background: 'var(--border)' }} />
      <div style={cell}>
        <span style={label}>Open P&L</span>
        <span style={{ ...value, color: pnlColor }}>
          {openPnl >= 0 ? '+' : ''}₹{fmtINR(openPnl)}
        </span>
      </div>
      {capital && (
        <>
          {capital.cash > 0 && (
            <div style={{ fontSize: '9px', color: 'var(--text3)' }}>
              open ₹{fmtINR(capital.cash)}
            </div>
          )}
          {realizedToday !== 0 && (
            <div style={{ fontSize: '9px', color: realColor, fontWeight: 600 }}>
              today {realizedToday >= 0 ? '+' : ''}₹{fmtINR(realizedToday)}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Filters ───────────────────────────────────────────────────────────────────

type FilterKey = 'pat30_90' | 'pat30_5_80' | 'pat60_20_80' | 'all_aligned' | 'signal_on' | 'cd_agrees' | 'outside_va' | 'cusum' | 'big_move' | 'high_confirm'

const FILTER_DEFS: { key: FilterKey; label: string; desc: string; test: (s: StockEntry) => boolean }[] = [
  {
    key: 'pat30_90', label: 'PAT-30 ≥90%',
    desc: 'PAT-30v2 bull or bear probability ≥90%',
    test: s => { const p = s.pat30v2 ?? s.pat30; return p != null && (p.bull >= 90 || p.bear >= 90) },
  },
  {
    key: 'pat30_5_80', label: '30→5 ≥80%',
    desc: 'PAT-30→5 bull or bear probability ≥80%',
    test: s => s.pat30_5 != null && (s.pat30_5.bull >= 80 || s.pat30_5.bear >= 80),
  },
  {
    key: 'pat60_20_80', label: '60→20 ≥80%',
    desc: 'PAT-60→20 bull or bear probability ≥80%',
    test: s => s.pat60_20 != null && (s.pat60_20.bull >= 80 || s.pat60_20.bear >= 80),
  },
  {
    key: 'big_move', label: 'Move ≥0.3%',
    desc: 'PAT-30v2 predicted 30-min move ≥ ±0.3% from LTP',
    test: s => s.pat30v2 != null && Math.abs(s.pat30v2.move) >= 0.3,
  },
  {
    key: 'all_aligned', label: 'All TF aligned',
    desc: 'PAT-30→5 + PAT-60→20 + PAT-30v2 all point the same direction',
    test: s => s.alignDir === 'BULL' || s.alignDir === 'BEAR',
  },
  {
    key: 'signal_on', label: 'Signal active',
    desc: 'Current order book signal is BULL or BEAR (not neutral)',
    test: s => s.signal !== 'NEUTRAL',
  },
  {
    key: 'cd_agrees', label: 'CD confirms',
    desc: 'CDZ ≥ +0.5σ (aligned bull) or ≤ −0.5σ (aligned bear)',
    test: s => (s.alignDir === 'BULL' && s.cdZ >= 0.5) || (s.alignDir === 'BEAR' && s.cdZ <= -0.5),
  },
  {
    key: 'outside_va', label: 'Outside VA',
    desc: 'Price is outside the session value area — not range-bound',
    test: s => s.va != null && !s.va.inside,
  },
  {
    key: 'cusum', label: 'CUSUM',
    desc: 'Sustained CUSUM regime alarm active (persistent directional pressure)',
    test: s => s.cusumBull || s.cusumBear,
  },
  {
    key: 'high_confirm', label: '≥4 confirms',
    desc: 'Signal held for 4+ consecutive order book ticks',
    test: s => s.confirmCount >= 4,
  },
]

// ── Pinned stocks ────────────────────────────────────────────────────────────
const PINNED_KEY = 'zeroday:pinned'

function loadPinned(): Set<string> {
  if (typeof window === 'undefined') return new Set()
  try { return new Set(JSON.parse(localStorage.getItem(PINNED_KEY) ?? '[]')) } catch { return new Set() }
}

function savePinned(s: Set<string>) {
  localStorage.setItem(PINNED_KEY, JSON.stringify([...s]))
}

function loadFilters(): Set<FilterKey> {
  if (typeof window === 'undefined') return new Set(['pat30_90'])
  try {
    const stored = localStorage.getItem('zeroday:filters')
    if (stored) return new Set(JSON.parse(stored) as FilterKey[])
    // migrate old single-toggle
    const old = localStorage.getItem('zeroday:filterPat30')
    if (old === '1') return new Set<FilterKey>(['pat30_90'])
    if (old === '0') return new Set<FilterKey>()
  } catch { /* */ }
  return new Set<FilterKey>(['pat30_90'])
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

export default function DashboardClient({ role = 'admin' }: { role?: string }) {
  const router = useRouter()
  const [stocks, setStocks] = useState<StockEntry[]>([])
  const [positions, setPositions] = useState<Position[]>([])
  const [capital, setCapital] = useState<CapitalData | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [status, setStatus] = useState<'connecting' | 'live' | 'waiting' | 'error'>('connecting')
  const [pinnedStocks, setPinnedStocks] = useState<Set<string>>(loadPinned)
  const [activeFilters, setActiveFilters] = useState<Set<FilterKey>>(loadFilters)
  const [sortMode, setSortMode] = useState<'alignment' | 'pat30' | 'move' | 'pat30_5' | 'pat60_20'>(() => {
    if (typeof window === 'undefined') return 'alignment'
    return (localStorage.getItem('zeroday:sortMode') as 'alignment' | 'pat30' | 'move' | 'pat30_5' | 'pat60_20') ?? 'alignment'
  })
  const [sortMenuPos, setSortMenuPos] = useState<{ x: number; y: number } | null>(null)
  const [showWatchlist, setShowWatchlist] = useState(false)
  const sortMenuRef = useRef<HTMLDivElement>(null)
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => {
    function connect() {
      const es = new EventSource('/api/stream')
      esRef.current = es

      es.onopen = () => setStatus('connecting')

      es.onmessage = (e) => {
        const msg = JSON.parse(e.data)
        if (msg.type === 'snapshot') {
          setStocks(msg.stocks)
          setPositions(msg.positions ?? [])
          setCapital(msg.capital ?? null)
          setUpdatedAt(msg.updatedAt)
          setStatus('live')
        } else if (msg.type === 'prices') {
          setStocks(prev => prev.length === 0 ? prev : prev.map(s => {
            const p = msg.prices[s.name]
            if (!p) return s
            return { ...s, ltp: p.ltp, signal: p.signal, confirmCount: p.confirmCount, cdZ: p.cdZ, trend: p.trend, imbalance: p.imbalance }
          }))
          setUpdatedAt(msg.updatedAt)
          setStatus('live')
        } else if (msg.type === 'waiting') {
          setStatus('waiting')
        }
      }

      es.onerror = () => {
        setStatus('error')
        es.close()
        setTimeout(connect, 5000)
      }
    }
    connect()
    return () => esRef.current?.close()
  }, [])

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' })
    router.push('/')
  }

  function togglePin(name: string) {
    setPinnedStocks(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name); else next.add(name)
      savePinned(next)
      return next
    })
  }

  function toggleFilter(key: FilterKey) {
    setActiveFilters(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      localStorage.setItem('zeroday:filters', JSON.stringify([...next]))
      return next
    })
  }

  useEffect(() => {
    if (!sortMenuPos) return
    function onDown(e: MouseEvent) { if (!sortMenuRef.current?.contains(e.target as Node)) setSortMenuPos(null) }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setSortMenuPos(null) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [sortMenuPos])

  const selectSort = useCallback((mode: 'alignment' | 'pat30' | 'move' | 'pat30_5' | 'pat60_20') => {
    setSortMode(mode)
    localStorage.setItem('zeroday:sortMode', mode)
    setSortMenuPos(null)
  }, [])

  function pat30Score(s: StockEntry): number {
    const p = s.pat30v2 ?? s.pat30
    if (!p) return -9999
    return p.bull - p.bear
  }

  const activeFilterList = FILTER_DEFS.filter(f => activeFilters.has(f.key))
  const filteredStocks = activeFilterList.length === 0
    ? stocks
    : stocks.filter(s => activeFilterList.every(f => f.test(s)))

  function pat30v2MoveScore(s: StockEntry): number {
    return s.pat30v2 != null ? Math.abs(s.pat30v2.move) : -9999
  }

  function pat30_5Score(s: StockEntry): number {
    if (!s.pat30_5) return -9999
    return s.pat30_5.bull - s.pat30_5.bear
  }

  function pat60_20Score(s: StockEntry): number {
    if (!s.pat60_20) return -9999
    return s.pat60_20.bull - s.pat60_20.bear
  }

  const sorted = sortMode === 'pat30'
    ? [...filteredStocks].sort((a, b) => pat30Score(b) - pat30Score(a))
    : sortMode === 'move'
      ? [...filteredStocks].sort((a, b) => pat30v2MoveScore(b) - pat30v2MoveScore(a))
      : sortMode === 'pat30_5'
        ? [...filteredStocks].sort((a, b) => pat30_5Score(b) - pat30_5Score(a))
        : sortMode === 'pat60_20'
          ? [...filteredStocks].sort((a, b) => pat60_20Score(b) - pat60_20Score(a))
          : filteredStocks

  // Pinned stocks always float to top, preserving sort order within each group
  const visibleStocks = pinnedStocks.size > 0
    ? [...sorted].sort((a, b) => {
        const ap = pinnedStocks.has(a.name) ? 0 : 1
        const bp = pinnedStocks.has(b.name) ? 0 : 1
        return ap - bp
      })
    : sorted

  const statusDot = {
    connecting: { color: 'var(--mixed)', label: 'CONNECTING' },
    live:       { color: 'var(--bull)',  label: 'LIVE' },
    waiting:    { color: 'var(--mixed)', label: 'WAITING FOR BOT' },
    error:      { color: 'var(--bear)',  label: 'RECONNECTING' },
  }[status]

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', flexDirection: 'column' }}>
      {/* Top bar */}
      <header style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: '8px',
        padding: '10px 16px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg2)',
        position: 'sticky',
        top: 0,
        zIndex: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px' }}>
          <span style={{ fontWeight: 700, fontSize: '15px', letterSpacing: '-0.02em' }}>ZERODAY</span>
          <span className="zd-header-subtitle" style={{ fontSize: '10px', color: 'var(--text3)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            NSE F&amp;O Intelligence
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          {/* Live status */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '10px', color: 'var(--text3)' }}>
            <span style={{
              width: '6px', height: '6px', borderRadius: '50%',
              background: statusDot.color,
              boxShadow: status === 'live' ? `0 0 6px ${statusDot.color}` : undefined,
              flexShrink: 0,
            }} />
            <span>{statusDot.label}</span>
            {updatedAt && status === 'live' && (
              <span className="zd-header-subtitle" style={{ color: 'var(--text3)' }}>· {toIST(updatedAt)} IST</span>
            )}
          </div>

          {/* Watchlist management */}
          <button
            onClick={() => setShowWatchlist(true)}
            style={{
              background: 'transparent',
              border: '1px solid var(--border)',
              borderRadius: '4px',
              padding: '4px 10px',
              color: 'var(--text2)',
              fontSize: '11px',
              fontFamily: 'inherit',
              cursor: 'pointer',
              letterSpacing: '0.05em',
            }}
            title="Manage watchlist stocks"
          >
            STOCKS
          </button>

          <a
            href="/dashboard/backtest"
            style={{
              background: 'transparent',
              border: '1px solid var(--border)',
              borderRadius: '4px',
              padding: '4px 10px',
              color: 'var(--text2)',
              fontSize: '11px',
              fontFamily: 'inherit',
              cursor: 'pointer',
              letterSpacing: '0.05em',
              textDecoration: 'none',
              display: 'inline-flex',
              alignItems: 'center',
            }}
            title="Backtest strategies"
          >
            BACKTEST
          </a>

          <a
            href="/dashboard/conviction"
            style={{
              background: 'transparent',
              border: '1px solid var(--border)',
              borderRadius: '4px',
              padding: '4px 10px',
              color: 'var(--accent)',
              fontSize: '11px',
              fontFamily: 'inherit',
              cursor: 'pointer',
              letterSpacing: '0.05em',
              textDecoration: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              fontWeight: 700,
            }}
            title="Conviction mode"
          >
            CONVICTION
          </a>

          <a
            href="/dashboard/conviction-crude"
            style={{
              background: 'transparent',
              border: '1px solid var(--border)',
              borderRadius: '4px',
              padding: '4px 10px',
              color: 'var(--text2)',
              fontSize: '11px',
              fontFamily: 'inherit',
              cursor: 'pointer',
              letterSpacing: '0.05em',
              textDecoration: 'none',
              display: 'inline-flex',
              alignItems: 'center',
            }}
            title="Crude Oil Conviction"
          >
            CRUDE
          </a>

          <a
            href="/dashboard/live"
            style={{
              background: 'transparent',
              border: '1px solid var(--border)',
              borderRadius: '4px',
              padding: '4px 10px',
              color: 'var(--text2)',
              fontSize: '11px',
              fontFamily: 'inherit',
              cursor: 'pointer',
              letterSpacing: '0.05em',
              textDecoration: 'none',
              display: 'inline-flex',
              alignItems: 'center',
            }}
            title="Live paper trading"
          >
            LIVE
          </a>

          <ThemeToggle />

          <button
            onClick={handleLogout}
            style={{
              background: 'transparent',
              border: '1px solid var(--border)',
              borderRadius: '4px',
              padding: '4px 10px',
              color: 'var(--text2)',
              fontSize: '11px',
              fontFamily: 'inherit',
              cursor: 'pointer',
              letterSpacing: '0.05em',
            }}>
            SIGN OUT
          </button>
        </div>
      </header>

      {/* Account value bar + Positions — restricted for viewer */}
      {role !== 'viewer' ? (
        <>
          <AccountBar capital={capital} positions={positions} />
          <PositionsPanel positions={positions} />
        </>
      ) : (
        <div style={{
          margin: '6px 12px', padding: '10px 14px',
          background: 'repeating-linear-gradient(135deg, rgba(255,0,60,0.03), rgba(255,0,60,0.03) 10px, transparent 10px, transparent 20px)',
          border: '1px solid rgba(255,0,60,0.15)', borderRadius: '6px',
          display: 'flex', alignItems: 'center', gap: '10px',
        }}>
          <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.15em', color: 'rgba(255,0,60,0.6)', fontFamily: 'monospace' }}>
            ⛔ RESTRICTED
          </span>
          <span style={{ fontSize: '9px', color: 'var(--text3)', fontFamily: 'monospace' }}>
            // account_data + positions require elevated access
          </span>
        </div>
      )}

      {/* Sort + filter bar */}
      <div style={{ borderBottom: '1px solid var(--border)', userSelect: 'none' }}>
        {/* Top row: count + sort + legend */}
        <div
          onContextMenu={e => { e.preventDefault(); setSortMenuPos({ x: e.clientX, y: e.clientY }) }}
          style={{
            padding: '7px 16px',
            fontSize: '10px', color: 'var(--text3)',
            display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '10px',
          }}
        >
          <span style={{ color: 'var(--text2)' }}>
            {activeFilters.size > 0 ? `${visibleStocks.length} / ${stocks.length} stocks` : `${stocks.length} stocks`}
          </span>
          <span className="zd-legend-sort-label">
            {sortMode === 'pat30'
              ? 'sorted by PAT-30 bull → bear ↓'
              : sortMode === 'move'
                ? 'sorted by PAT-30v2 move % ↓'
                : sortMode === 'pat30_5'
                  ? 'sorted by PAT-30→5 bull → bear ↓'
                  : sortMode === 'pat60_20'
                    ? 'sorted by PAT-60→20 bull → bear ↓'
                    : 'sorted by alignment ↓'}
          </span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: '10px' }}>
            <span><span style={{ color: 'var(--bull)' }}>■</span> BULL</span>
            <span><span style={{ color: 'var(--bear)' }}>■</span> BEAR</span>
            <span><span style={{ color: 'var(--mixed)' }}>■</span> MIXED</span>
          </span>
        </div>
        {/* Filter chips row */}
        <div style={{
          padding: '0 16px 8px',
          display: 'flex', flexWrap: 'wrap', gap: '6px',
        }}>
          {FILTER_DEFS.map(f => {
            const on = activeFilters.has(f.key)
            const matchCount = stocks.filter(s => f.test(s)).length
            return (
              <button
                key={f.key}
                onClick={() => toggleFilter(f.key)}
                title={f.desc}
                style={{
                  background: on ? 'var(--bull)' : 'var(--bg3)',
                  border: `1px solid ${on ? 'var(--bull)' : 'var(--border)'}`,
                  borderRadius: '4px',
                  padding: '3px 8px',
                  color: on ? '#000' : 'var(--text3)',
                  fontSize: '10px',
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                  letterSpacing: '0.04em',
                  transition: 'all 0.15s',
                  display: 'flex', alignItems: 'center', gap: '5px',
                }}
              >
                <span>{f.label}</span>
                <span style={{
                  fontSize: '9px',
                  color: on ? 'rgba(0,0,0,0.55)' : 'var(--text3)',
                  background: on ? 'rgba(0,0,0,0.12)' : 'var(--bg2)',
                  borderRadius: '3px', padding: '0 4px',
                }}>{matchCount}</span>
              </button>
            )
          })}
          {activeFilters.size > 0 && (
            <button
              onClick={() => {
                setActiveFilters(new Set())
                localStorage.setItem('zeroday:filters', '[]')
              }}
              style={{
                background: 'transparent', border: '1px solid var(--border)',
                borderRadius: '4px', padding: '3px 8px',
                color: 'var(--text3)', fontSize: '10px',
                fontFamily: 'inherit', cursor: 'pointer', letterSpacing: '0.04em',
              }}
            >
              clear
            </button>
          )}
        </div>
      </div>

      {/* Sort context menu */}
      {sortMenuPos && (
        <div ref={sortMenuRef} style={{
          position: 'fixed',
          left: Math.min(sortMenuPos.x, window.innerWidth - 220),
          top: Math.min(sortMenuPos.y, window.innerHeight - 100),
          zIndex: 1000,
          background: 'var(--bg2)',
          border: '1px solid var(--border)',
          borderRadius: '6px',
          padding: '4px',
          boxShadow: '0 4px 24px rgba(0,0,0,0.35)',
          minWidth: '200px',
          fontSize: '11px',
        }}>
          <div style={{ padding: '5px 12px 4px', fontSize: '9px', color: 'var(--text3)', letterSpacing: '0.1em' }}>SORT BY</div>
          {(['alignment', 'pat30_5', 'pat60_20', 'pat30', 'move'] as const).map(mode => (
            <button
              key={mode}
              onClick={() => selectSort(mode)}
              style={{
                display: 'flex', alignItems: 'center', gap: '8px',
                width: '100%', padding: '7px 12px', border: 'none',
                background: sortMode === mode ? 'var(--bg3)' : 'transparent',
                borderRadius: '4px', fontFamily: 'inherit', fontSize: '11px',
                color: sortMode === mode ? 'var(--text)' : 'var(--text2)',
                cursor: 'pointer', textAlign: 'left', letterSpacing: '0.02em',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg3)')}
              onMouseLeave={e => (e.currentTarget.style.background = sortMode === mode ? 'var(--bg3)' : 'transparent')}
            >
              <span style={{ width: '10px', color: 'var(--bull)' }}>{sortMode === mode ? '✓' : ''}</span>
              <span>
                {mode === 'alignment' ? 'Combined alignment (30→5+60→20+30v2)'
                  : mode === 'pat30_5' ? 'PAT-30→5 bull → bear'
                  : mode === 'pat60_20' ? 'PAT-60→20 bull → bear'
                  : mode === 'pat30' ? 'PAT-30 bull → bear'
                  : 'PAT-30v2 biggest predicted move'}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Card grid */}
      <main style={{ flex: 1, padding: '16px' }}>
        {stocks.length === 0 ? (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '200px',
            color: 'var(--text3)',
            fontSize: '12px',
            flexDirection: 'column',
            gap: '8px',
          }}>
            <div>{status === 'waiting' ? '⏳ Waiting for bot data…' : status === 'connecting' ? '⟳ Connecting…' : '✗ Stream error — retrying…'}</div>
            {status === 'waiting' && <div style={{ fontSize: '10px' }}>Bot writes stock-state.json every 5s during market hours</div>}
          </div>
        ) : visibleStocks.length === 0 && activeFilters.size > 0 ? (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            height: '200px', color: 'var(--text3)', fontSize: '12px',
            flexDirection: 'column', gap: '8px',
          }}>
            <div>No stocks match all active filters</div>
            <div style={{ fontSize: '10px' }}>
              {activeFilters.size === 1 ? 'Remove the filter' : `Remove one of ${activeFilters.size} active filters`} to see more stocks
            </div>
          </div>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(min(420px, 100%), 1fr))',
            gap: '10px',
          }}>
            {visibleStocks.map(stock => (
              <StockCard
                key={stock.name}
                name={stock.name}
                stock={stock}
                pinned={pinnedStocks.has(stock.name)}
                onPin={() => togglePin(stock.name)}
              />
            ))}
          </div>
        )}
      </main>

      {/* Watchlist modal */}
      {showWatchlist && <WatchlistModal onClose={() => setShowWatchlist(false)} />}
    </div>
  )
}
