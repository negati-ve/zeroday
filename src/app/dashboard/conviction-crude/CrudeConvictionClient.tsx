'use client'
import { useEffect, useState, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import ThemeToggle from '@/components/ThemeToggle'

// ── Types ─────────────────────────────────────────────────────────────────────

interface HorizonPrediction {
  predictedMove: number
  bullProb: number
  bearProb: number
}

interface CrudePrediction {
  predictedMove: number
  bullProb: number
  bearProb: number
  topSim: number
  confidence: number
  nResolved: number
  direction: 'BULL' | 'BEAR' | null
  status: 'ready' | 'warming' | 'no_data'
  h5: HorizonPrediction | null
  h15: HorizonPrediction | null
  h20: HorizonPrediction | null
}

interface CrudeTechnicals {
  rsi: number | null
  emaShort: number | null
  emaLong: number | null
  emaCrossover: 'BULL' | 'BEAR' | null
  vwap: number | null
  vwapAlign: 'BULL' | 'BEAR' | null
  atr: number | null
  atrPct: number | null
  momentum1m: number
  momentum5m: number
  sessionHigh: number
  sessionLow: number
  rangePosition: number
  volume: number
  oi: number
}

interface CrudeComposite {
  predictedMove: number
  bullProb: number
  bearProb: number
  direction: 'BULL' | 'BEAR' | null
  confidence: number
  status: 'ready' | 'warming' | 'no_data'
  components: {
    patternWeight: number
    techWeight: number
    patternBullProb: number
    techBullScore: number
  }
}

interface CrudeOption {
  tradingsymbol: string
  instrumentToken: number
  strike: number
  expiry: string
  instrumentType: 'CE' | 'PE'
  product: string
}

interface OIStrike {
  strike: number
  callOI: number
  putOI: number
  callLTP: number
  putLTP: number
  callVol: number
  putVol: number
  painAtStrike: number
}

interface OIAnalytics {
  maxPainStrike: number
  pcr: number
  totalCallOI: number
  totalPutOI: number
  strikes: OIStrike[]
}

interface CrudeChain {
  calls: CrudeOption[]
  puts: CrudeOption[]
  spotEstimate: number
  expiry: string
  product: string
  lotSize: number
  strikeStep: number
  atmStrike: number
  oiAnalytics?: OIAnalytics
}

interface SysLogEntry {
  cycleTs: number
  cycleTime: string
  predMove: number
  predDir: 'BULL' | 'BEAR' | null
  predConf: number
  predBullProb: number
  predBearProb: number
  spotAtPred: number
  predSpot: number
  outcomeMove: number | null
  outcomeDir: 'BULL' | 'BEAR' | null
  spotAtOutcome: number | null
  resolved: boolean
  correct: boolean | null
  sessionDay: string
  peakMove?: number | null
  targetHit?: boolean
  targetHitTs?: number | null
  liveMove?: number | null
  liveSpot?: number | null
  optStrike?: number | null
  optType?: 'CE' | 'PE' | null
  optSymbol?: string | null
  optEntry?: number | null
  optTarget?: number | null
}

interface DepthLevel {
  price: number
  quantity: number
  orders: number
}

interface CrudeState {
  prediction: CrudePrediction
  technicals: CrudeTechnicals
  composite: CrudeComposite
  snapshotCount: number
  patternCount: number
  resolvedCount: number
  proxy: number
  minutesAccumulated: number
  sysLog: SysLogEntry[]
  chain: CrudeChain | null
  spot: number
  futureSymbol: string
  futureToken: number
  product: string
  marketOpen: boolean
  depth?: {
    buy: DepthLevel[]
    sell: DepthLevel[]
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtPct(v: number, decimals = 2): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(decimals)}%`
}

function fmtNum(v: number, decimals = 1): string {
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)}K`
  return v.toFixed(decimals)
}

function dirColor(dir: 'BULL' | 'BEAR' | null): string {
  if (dir === 'BULL') return 'var(--bull)'
  if (dir === 'BEAR') return 'var(--bear)'
  return 'var(--text3)'
}

const KNN_K_DISPLAY = 20

function dirArrow(dir: 'BULL' | 'BEAR' | null): string {
  if (dir === 'BULL') return '▲'
  if (dir === 'BEAR') return '▼'
  return '·'
}

// ── Estimate option Greeks from moneyness ─────────────────────────────────────

function estimateGreeks(spot: number, strike: number, type: 'CE' | 'PE', expiry: string, lotSize: number) {
  const now = Date.now()
  // MCX options expire at 17:00 IST (not 15:30 like NSE)
  const expiryDate = new Date(expiry + 'T17:00:00+05:30')
  const dte = Math.max(0, Math.ceil((expiryDate.getTime() - now) / 86400_000))
  const moneyness = type === 'CE' ? (spot - strike) / spot : (strike - spot) / spot

  // Delta estimation with DTE influence — sharper near expiry
  const dteFactor = Math.max(0.3, Math.min(1, Math.sqrt(dte / 30)))
  let absDelta = 0.5 + moneyness * (2 / dteFactor)
  absDelta = Math.max(0.05, Math.min(0.95, absDelta))

  // Convention: CE delta is positive, PE delta is negative
  const delta = type === 'PE' ? -absDelta : absDelta

  // Per-point sensitivity (always positive — magnitude of P&L per ₹1 underlying move)
  const perPoint = absDelta * lotSize

  const intrinsic = type === 'CE' ? Math.max(0, spot - strike) : Math.max(0, strike - spot)
  const itm = intrinsic > 0

  return { delta, absDelta, perPoint, dte, intrinsic, itm, moneyness }
}

// ── Dark terminal theme — color reserved for directional data only ────────────

const CYB = {
  // Structural UI — dark/muted, no color bleed
  glow: 'rgba(255,255,255,0.35)',       // dim label text (headers, section tags)
  glowDim: 'rgba(255,255,255,0.04)',    // subtle highlight bg (active toggle, status)
  glowBorder: 'rgba(255,255,255,0.08)', // barely-visible panel borders
  panel: 'rgba(0,0,0,0.25)',            // dark panel background
  scanline: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.01) 2px, rgba(255,255,255,0.01) 4px)',
  // Directional — only for oracle predictions & OI signals
  redGlow: '#ff003c',
  redDim: 'rgba(255,0,60,0.12)',
  accent: '#00ff9f',                    // used ONLY for prediction confidence / target-hit
  accentDim: 'rgba(0,255,159,0.12)',
}

// ── Components ────────────────────────────────────────────────────────────────

function OraclePanel({ state }: { state: CrudeState }) {
  const { composite, prediction, technicals: tech } = state
  const dir: 'BULL' | 'BEAR' | null = composite.predictedMove > 0 ? 'BULL' : composite.predictedMove < 0 ? 'BEAR' : null
  const bullPct = Math.round(composite.bullProb * 100)
  const bearPct = 100 - bullPct
  const compColor = dir === 'BULL' ? 'var(--bull)' : dir === 'BEAR' ? 'var(--bear)' : 'var(--text3)'

  return (
    <div style={{
      background: CYB.panel,
      border: `1px solid ${CYB.glowBorder}`,
      borderRadius: '6px',
      padding: '12px',
      backgroundImage: CYB.scanline,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '8px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
          <span style={{ fontSize: '8px', fontWeight: 700, color: CYB.glow, letterSpacing: '0.15em' }}>{'//ORACLE'}</span>
          <span style={{ fontSize: '9px', color: 'var(--text3)' }}>{state.minutesAccumulated}m</span>
        </div>
        {state.spot > 0 && (() => {
          const sym = state.futureSymbol
          const monthMatch = sym.match(/\d{2}([A-Z]{3})FUT$/)
          const month = monthMatch ? monthMatch[1] : ''
          const name = sym.replace(/\d{2}[A-Z]{3}FUT$/, '')
          return (
            <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.02em' }}>
              {name}
              {month && <span style={{ fontSize: '9px', fontWeight: 600, color: 'var(--text3)', marginLeft: '3px' }}>{month}FUT</span>}
              {' '}₹{state.spot.toFixed(0)}
              {' '}
              <span style={{
                fontSize: '10px', fontWeight: 600,
                color: state.proxy >= 0 ? 'var(--bull)' : 'var(--bear)',
              }}>
                {fmtPct(state.proxy)}
              </span>
            </span>
          )
        })()}
      </div>

      {composite.status === 'ready' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{
              fontSize: '8px', color: CYB.glow, letterSpacing: '0.1em', width: '48px', fontWeight: 700,
            }}>20M</span>
            <span style={{
              fontSize: '14px', fontWeight: 700, color: compColor,
              padding: '2px 10px', borderRadius: '3px',
              background: dir === 'BULL' ? 'rgba(34,197,94,0.14)' : dir === 'BEAR' ? 'rgba(239,68,68,0.14)' : 'rgba(255,255,255,0.05)',
              border: `1px solid ${dir === 'BULL' ? 'rgba(34,197,94,0.3)' : dir === 'BEAR' ? 'rgba(239,68,68,0.3)' : 'var(--border)'}`,
            }}>
              {(Math.abs(composite.predictedMove) < 0.01 && composite.confidence < 0.5) ? '·' : dirArrow(dir)} {fmtPct(composite.predictedMove, 3)}
              {state.spot > 0 && (
                <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text2)', marginLeft: '6px' }}>
                  → {(state.spot * (1 + composite.predictedMove / 100)).toFixed(0)}
                </span>
              )}
            </span>
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '4px', minWidth: '80px' }}>
              <span style={{ fontSize: '9px', fontWeight: 600, color: 'var(--bull)', width: '24px', textAlign: 'right' }}>{bullPct}</span>
              <div style={{ flex: 1, height: '6px', borderRadius: '3px', background: 'var(--bg3)', display: 'flex', overflow: 'hidden', minWidth: '40px' }}>
                <div style={{ width: `${bullPct}%`, background: 'var(--bull)', transition: 'width 0.3s' }} />
                <div style={{ width: `${bearPct}%`, background: 'var(--bear)', transition: 'width 0.3s' }} />
              </div>
              <span style={{ fontSize: '9px', fontWeight: 600, color: 'var(--bear)', width: '24px' }}>{bearPct}</span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '10px', fontSize: '8px', color: 'var(--text3)', paddingLeft: '56px', flexWrap: 'wrap' }}>
            <span>conf <span style={{ color: 'var(--text2)', fontWeight: 600 }}>{Math.round(composite.confidence * 100)}%</span></span>
            <span>pat <span style={{ color: CYB.glow, fontWeight: 600 }}>{Math.round(composite.components.patternWeight * 100)}%</span></span>
            <span>tech <span style={{ color: CYB.glow, fontWeight: 600 }}>{Math.round(composite.components.techWeight * 100)}%</span></span>
            <span>proxy <span style={{ color: state.proxy >= 0 ? 'var(--bull)' : 'var(--bear)', fontWeight: 600 }}>{fmtPct(state.proxy)}</span></span>
          </div>
        </div>
      ) : (
        <div style={{ fontSize: '10px', color: CYB.glow, padding: '4px 0', opacity: 0.6 }}>
          {'> '}{composite.status === 'warming'
            ? `WARMING — ${state.resolvedCount}/10 resolved · ${state.snapshotCount} snapshots`
            : `ACCUMULATING... ${state.snapshotCount} snapshots · ${state.patternCount} patterns`}
        </div>
      )}

      {/* Multi-horizon pattern predictions (Q·K→V attention) */}
      {prediction.status === 'ready' && (prediction.h5 || prediction.h15 || prediction.h20) && (
        <div style={{
          marginTop: '8px', padding: '8px 10px', borderRadius: '4px',
          background: 'rgba(0,0,0,0.15)', border: `1px solid ${CYB.glowBorder}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '6px' }}>
            <span style={{ fontSize: '9px', color: CYB.glow, letterSpacing: '0.15em', opacity: 0.5, fontWeight: 700 }}>{'//ATT'}</span>
            <span style={{ fontSize: '9px', color: 'var(--text3)' }}>
              sim:{prediction.topSim.toFixed(2)} k={Math.min(KNN_K_DISPLAY, prediction.nResolved)} n={prediction.nResolved}
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {([['PAT-5M', prediction.h5], ['PAT-15M', prediction.h15], ['PAT-20M', prediction.h20]] as [string, HorizonPrediction | null][]).map(([label, h]) => {
              if (!h) return <div key={label} style={{ fontSize: '11px', color: 'var(--text3)', fontFamily: 'monospace' }}>{label}: —</div>
              const hBull = Math.round(h.bullProb * 100)
              const hBear = 100 - hBull
              const hDir = hBull > hBear ? 'BULL' : 'BEAR'
              const pct = Math.max(hBull, hBear)
              const hColor = hDir === 'BULL' ? 'var(--bull)' : 'var(--bear)'
              return (
                <div key={label} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', fontFamily: 'monospace' }}>
                  <span style={{ width: '58px', color: 'var(--text3)', flexShrink: 0, fontSize: '10px' }}>{label}</span>
                  <div style={{ width: '70px', height: '5px', background: 'var(--bg3)', borderRadius: '3px', overflow: 'hidden', flexShrink: 0, display: 'flex' }}>
                    <div style={{ width: `${hBull}%`, height: '100%', background: 'var(--bull)' }} />
                    <div style={{ width: `${hBear}%`, height: '100%', background: 'var(--bear)' }} />
                  </div>
                  <span style={{ color: hColor, fontWeight: 700, minWidth: '40px' }}>
                    {hDir === 'BULL' ? '▲' : '▼'}{pct}%
                  </span>
                  <span style={{ color: h.predictedMove >= 0 ? 'var(--bull)' : 'var(--bear)', fontWeight: 600 }}>
                    {fmtPct(h.predictedMove, 3)}
                  </span>
                  {state.spot > 0 && (
                    <span style={{ color: 'var(--text3)', fontSize: '10px' }}>
                      →{(state.spot * (1 + h.predictedMove / 100)).toFixed(0)}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Technicals grid */}
      <div style={{
        marginTop: '8px', padding: '6px 8px', borderRadius: '4px',
        background: 'rgba(0,0,0,0.15)', border: `1px solid ${CYB.glowBorder}`,
      }}>
        <div style={{ fontSize: '7px', color: CYB.glow, letterSpacing: '0.15em', opacity: 0.5, marginBottom: '4px' }}>{'//TECHNICALS'}</div>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(85px, 1fr))',
          gap: '4px', fontSize: '10px', fontFamily: 'monospace',
        }}>
          <TechChip label="RSI" value={tech.rsi != null ? tech.rsi.toFixed(0) : '—'}
            color={tech.rsi != null ? (tech.rsi > 60 ? 'var(--bull)' : tech.rsi < 40 ? 'var(--bear)' : 'var(--text2)') : 'var(--text3)'} />
          <TechChip label="EMA" value={tech.emaCrossover ?? '—'} color={dirColor(tech.emaCrossover)} />
          <TechChip label="VWAP" value={tech.vwapAlign ?? '—'} color={dirColor(tech.vwapAlign)} />
          <TechChip label="ATR%" value={tech.atrPct != null ? tech.atrPct.toFixed(2) + '%' : '—'} color="var(--text2)" />
          <TechChip label="MOM1" value={fmtPct(tech.momentum1m * 100, 2)}
            color={tech.momentum1m > 0 ? 'var(--bull)' : tech.momentum1m < 0 ? 'var(--bear)' : 'var(--text3)'} />
          <TechChip label="MOM5" value={fmtPct(tech.momentum5m * 100, 2)}
            color={tech.momentum5m > 0 ? 'var(--bull)' : tech.momentum5m < 0 ? 'var(--bear)' : 'var(--text3)'} />
          <TechChip label="VOL" value={fmtNum(tech.volume)} color="var(--text2)" />
          <TechChip label="OI" value={fmtNum(tech.oi)} color="var(--text2)" />
        </div>
      </div>

      <div style={{ marginTop: '6px', fontSize: '8px', color: 'var(--text3)', fontFamily: 'monospace', opacity: 0.6 }}>
        {state.patternCount}pat ({state.resolvedCount}res) · {state.snapshotCount}snap
      </div>
    </div>
  )
}

function TechChip({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{
      background: 'rgba(255,255,255,0.02)',
      borderRadius: '3px',
      padding: '3px 5px',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      border: '1px solid rgba(255,255,255,0.06)',
    }}>
      <span style={{ color: CYB.glow, fontSize: '8px', opacity: 0.5, letterSpacing: '0.05em' }}>{label}</span>
      <span style={{ color, fontWeight: 600, fontSize: '10px' }}>{value}</span>
    </div>
  )
}

function DepthPanel({ depth, spot }: { depth: CrudeState['depth']; spot: number }) {
  if (!depth) return (
    <div style={{ background: CYB.panel, border: `1px solid ${CYB.glowBorder}`, borderRadius: '6px', padding: '12px', backgroundImage: CYB.scanline }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', marginBottom: '8px' }}>
        <span style={{ fontSize: '8px', fontWeight: 700, color: CYB.glow, letterSpacing: '0.15em' }}>{'//DEPTH'}</span>
      </div>
      <div style={{ fontSize: '10px', color: CYB.glow, opacity: 0.6 }}>{'> AWAITING DEPTH FEED...'}</div>
    </div>
  )

  const maxQty = Math.max(
    ...depth.buy.map(l => l.quantity),
    ...depth.sell.map(l => l.quantity),
    1,
  )
  const totalBid = depth.buy.reduce((s, l) => s + l.quantity, 0)
  const totalAsk = depth.sell.reduce((s, l) => s + l.quantity, 0)
  const imb = totalBid + totalAsk > 0 ? ((totalBid - totalAsk) / (totalBid + totalAsk) * 100) : 0

  return (
    <div style={{
      background: CYB.panel,
      border: `1px solid ${CYB.glowBorder}`,
      borderRadius: '6px',
      padding: '12px',
      backgroundImage: CYB.scanline,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px', flexWrap: 'wrap', gap: '6px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
          <span style={{ fontSize: '8px', fontWeight: 700, color: CYB.glow, letterSpacing: '0.15em' }}>{'//DEPTH'}</span>
        </div>
        <span style={{
          fontSize: '9px', fontWeight: 700, fontFamily: 'monospace',
          color: imb > 5 ? 'var(--bull)' : imb < -5 ? 'var(--bear)' : 'var(--text3)',
        }}>
          OBI {imb >= 0 ? '+' : ''}{imb.toFixed(0)}%
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', fontSize: '10px', fontFamily: 'monospace' }}>
        <div>
          <div style={{ fontSize: '8px', color: CYB.glow, letterSpacing: '0.1em', opacity: 0.5, marginBottom: '4px' }}>BID</div>
          {depth.buy.slice(0, 5).map((l, i) => (
            <div key={i} style={{ position: 'relative', display: 'flex', gap: '4px', alignItems: 'center', marginBottom: '2px', padding: '1px 4px' }}>
              <div style={{
                position: 'absolute', left: 0, top: 0, bottom: 0,
                width: `${(l.quantity / maxQty) * 100}%`,
                background: 'rgba(34,197,94,0.12)',
                borderRadius: '2px', minWidth: '2px',
              }} />
              <span style={{ color: 'var(--bull)', minWidth: '44px', position: 'relative', fontSize: '10px' }}>{l.price.toFixed(0)}</span>
              <span style={{ color: 'var(--text3)', position: 'relative', fontSize: '10px' }}>{fmtNum(l.quantity, 0)}</span>
            </div>
          ))}
        </div>
        <div>
          <div style={{ fontSize: '8px', color: CYB.glow, letterSpacing: '0.1em', opacity: 0.5, marginBottom: '4px' }}>ASK</div>
          {depth.sell.slice(0, 5).map((l, i) => (
            <div key={i} style={{ position: 'relative', display: 'flex', gap: '4px', alignItems: 'center', marginBottom: '2px', padding: '1px 4px' }}>
              <div style={{
                position: 'absolute', left: 0, top: 0, bottom: 0,
                width: `${(l.quantity / maxQty) * 100}%`,
                background: 'rgba(239,68,68,0.12)',
                borderRadius: '2px', minWidth: '2px',
              }} />
              <span style={{ color: 'var(--bear)', minWidth: '44px', position: 'relative', fontSize: '10px' }}>{l.price.toFixed(0)}</span>
              <span style={{ color: 'var(--text3)', position: 'relative', fontSize: '10px' }}>{fmtNum(l.quantity, 0)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function ChainPanel({ chain, spot, product, role = 'admin' }: { chain: CrudeChain; spot: number; product: string; role?: string }) {
  const [orderStatus, setOrderStatus] = useState<string | null>(null)
  const oi = chain.oiAnalytics

  const handleOrder = async (sym: string, type: 'BUY' | 'SELL') => {
    if (!confirm(`${type} 1 lot ${sym}?`)) return
    setOrderStatus('placing...')
    try {
      const res = await fetch('/api/crude/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tradingsymbol: sym, transaction_type: type, product }),
      })
      const data = await res.json()
      if (data.success) {
        setOrderStatus(`${type} ${sym} @ ${data.price} — order ${data.order_id}`)
      } else {
        setOrderStatus(`ERR: ${data.error}`)
      }
    } catch (err) {
      setOrderStatus(`ERR: ${err instanceof Error ? err.message : 'failed'}`)
    }
    setTimeout(() => setOrderStatus(null), 8000)
  }

  const maxOI = oi ? Math.max(...oi.strikes.map(s => Math.max(s.callOI, s.putOI)), 1) : 1
  const pcrColor = oi ? (oi.pcr > 1.2 ? 'var(--bull)' : oi.pcr < 0.8 ? 'var(--bear)' : 'var(--text2)') : 'var(--text3)'
  const pcrSignal = oi ? (oi.pcr > 1.2 ? 'BULL' : oi.pcr < 0.8 ? 'BEAR' : 'NEUTRAL') : '—'

  return (
    <div style={{
      background: CYB.panel,
      border: `1px solid ${CYB.glowBorder}`,
      borderRadius: '6px',
      padding: '12px',
      backgroundImage: CYB.scanline,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px', flexWrap: 'wrap', gap: '6px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
          <span style={{ fontSize: '8px', fontWeight: 700, color: CYB.glow, letterSpacing: '0.15em' }}>{'//CHAIN_OI'}</span>
        </div>
        <span style={{ fontSize: '11px', color: 'var(--text3)', fontFamily: 'monospace' }}>
          exp {chain.expiry} · ATM {chain.atmStrike} · lot {chain.lotSize}
        </span>
      </div>

      {/* OI Analytics summary bar */}
      {oi && (
        <div style={{
          display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '8px',
          padding: '8px 10px', borderRadius: '4px',
          background: 'rgba(0,0,0,0.15)', border: `1px solid ${CYB.glowBorder}`,
          fontFamily: 'monospace', fontSize: '11px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
            <span style={{ color: CYB.glow, opacity: 0.5, fontSize: '9px', letterSpacing: '0.1em' }}>MAX PAIN</span>
            <span style={{ color: 'var(--text)', fontWeight: 700 }}>{oi.maxPainStrike}</span>
            <span style={{ color: 'var(--text3)', fontSize: '10px' }}>
              ({spot > oi.maxPainStrike ? '▼' : '▲'}{Math.abs(spot - oi.maxPainStrike).toFixed(0)}pt)
            </span>
          </div>
          <span style={{ color: 'var(--border)' }}>|</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
            <span style={{ color: CYB.glow, opacity: 0.5, fontSize: '9px', letterSpacing: '0.1em' }}>PCR</span>
            <span style={{ color: pcrColor, fontWeight: 700 }}>{oi.pcr.toFixed(2)}</span>
            <span style={{ color: pcrColor, fontSize: '10px', fontWeight: 600 }}>{pcrSignal}</span>
          </div>
          <span style={{ color: 'var(--border)' }}>|</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
            <span style={{ color: 'var(--bull)', fontSize: '10px' }}>CE {fmtNum(oi.totalCallOI, 0)}</span>
            <span style={{ color: 'var(--text3)' }}>/</span>
            <span style={{ color: 'var(--bear)', fontSize: '10px' }}>PE {fmtNum(oi.totalPutOI, 0)}</span>
          </div>
        </div>
      )}

      {orderStatus && (
        <div style={{
          fontSize: '10px', padding: '4px 8px', borderRadius: '3px', marginBottom: '8px',
          background: orderStatus.startsWith('ERR') ? CYB.redDim : CYB.accentDim,
          color: orderStatus.startsWith('ERR') ? CYB.redGlow : CYB.accent,
          border: `1px solid ${orderStatus.startsWith('ERR') ? 'rgba(255,0,60,0.3)' : 'rgba(0,255,159,0.25)'}`,
          fontFamily: 'monospace',
        }}>
          {orderStatus}
        </div>
      )}

      {/* Chain header */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: oi ? '1fr 50px 50px auto 50px 50px 1fr' : '1fr auto 1fr',
        gap: '2px', fontSize: '12px', fontFamily: 'monospace',
      }}>
        {oi ? (
          <>
            <div style={{ color: 'var(--bull)', fontWeight: 700, textAlign: 'center', padding: '5px', fontSize: '10px', letterSpacing: '0.1em' }}>CE OI</div>
            <div style={{ color: 'var(--bull)', fontWeight: 700, textAlign: 'center', padding: '5px', fontSize: '10px', letterSpacing: '0.1em' }}>LTP</div>
            <div style={{ color: 'var(--bull)', fontWeight: 700, textAlign: 'center', padding: '5px', fontSize: '10px', letterSpacing: '0.1em' }}>VOL</div>
            <div style={{ color: CYB.glow, textAlign: 'center', padding: '5px', fontWeight: 700, fontSize: '10px', letterSpacing: '0.1em' }}>STRIKE</div>
            <div style={{ color: 'var(--bear)', fontWeight: 700, textAlign: 'center', padding: '5px', fontSize: '10px', letterSpacing: '0.1em' }}>VOL</div>
            <div style={{ color: 'var(--bear)', fontWeight: 700, textAlign: 'center', padding: '5px', fontSize: '10px', letterSpacing: '0.1em' }}>LTP</div>
            <div style={{ color: 'var(--bear)', fontWeight: 700, textAlign: 'center', padding: '5px', fontSize: '10px', letterSpacing: '0.1em' }}>PE OI</div>
          </>
        ) : (
          <>
            <div style={{ color: 'var(--bull)', fontWeight: 700, textAlign: 'center', padding: '5px', fontSize: '11px', letterSpacing: '0.1em' }}>CALLS</div>
            <div style={{ color: CYB.glow, textAlign: 'center', padding: '5px', fontWeight: 700, fontSize: '11px', letterSpacing: '0.1em' }}>STRIKE</div>
            <div style={{ color: 'var(--bear)', fontWeight: 700, textAlign: 'center', padding: '5px', fontSize: '11px', letterSpacing: '0.1em' }}>PUTS</div>
          </>
        )}

        {/* Rows */}
        {chain.calls.map((call, i) => {
          const put = chain.puts[i]
          const strike = call.strike
          const isAtm = strike === chain.atmStrike
          const isMaxPain = oi && strike === oi.maxPainStrike
          const oiRow = oi?.strikes.find(s => s.strike === strike)

          if (oi && oiRow) {
            const callBarW = maxOI > 0 ? (oiRow.callOI / maxOI) * 100 : 0
            const putBarW = maxOI > 0 ? (oiRow.putOI / maxOI) * 100 : 0
            return (
              <div key={strike} style={{ display: 'contents' }}>
                {/* CE OI bar */}
                <div style={{
                  position: 'relative', padding: '4px 5px', display: 'flex', alignItems: 'center',
                  justifyContent: 'flex-end', borderRadius: '2px',
                  background: isAtm ? 'rgba(34,197,94,0.06)' : 'transparent',
                }}>
                  <div style={{
                    position: 'absolute', right: 0, top: 0, bottom: 0,
                    width: `${callBarW}%`, background: 'rgba(34,197,94,0.15)',
                    borderRadius: '2px', minWidth: callBarW > 0 ? '2px' : '0',
                  }} />
                  <span style={{ position: 'relative', fontSize: '11px', color: 'var(--bull)', fontWeight: oiRow.callOI > 0 ? 600 : 400 }}>
                    {oiRow.callOI > 0 ? fmtNum(oiRow.callOI, 0) : '—'}
                  </span>
                  {role !== 'viewer' && (
                    <button onClick={() => handleOrder(call.tradingsymbol, 'BUY')} style={{
                      position: 'relative', marginLeft: '3px', background: CYB.glowDim, border: `1px solid ${CYB.glowBorder}`,
                      borderRadius: '2px', color: CYB.glow, fontSize: '7px', fontWeight: 700,
                      padding: '1px 4px', cursor: 'pointer', fontFamily: 'monospace', flexShrink: 0,
                    }}>B</button>
                  )}
                </div>
                {/* CE LTP */}
                <div style={{ textAlign: 'center', padding: '4px 3px', fontSize: '11px', color: 'var(--text2)' }}>
                  {oiRow.callLTP > 0 ? oiRow.callLTP.toFixed(1) : '—'}
                </div>
                {/* CE Vol */}
                <div style={{ textAlign: 'center', padding: '4px 3px', fontSize: '10px', color: 'var(--text3)' }}>
                  {oiRow.callVol > 0 ? fmtNum(oiRow.callVol, 0) : '—'}
                </div>

                {/* Strike */}
                <div style={{
                  textAlign: 'center', padding: '4px 6px',
                  fontWeight: isAtm || isMaxPain ? 800 : 500,
                  color: isMaxPain ? CYB.redGlow : isAtm ? 'var(--text)' : 'var(--text2)',
                  background: isMaxPain ? CYB.redDim : isAtm ? 'rgba(255,255,255,0.06)' : 'transparent',
                  borderRadius: '3px',
                  border: isMaxPain ? `1px solid rgba(255,0,60,0.3)` : isAtm ? `1px solid ${CYB.glowBorder}` : 'none',
                  fontSize: '12px', whiteSpace: 'nowrap',
                }}>
                  {strike}{isMaxPain && ' ⊗'}
                </div>

                {/* PE Vol */}
                <div style={{ textAlign: 'center', padding: '4px 3px', fontSize: '10px', color: 'var(--text3)' }}>
                  {oiRow.putVol > 0 ? fmtNum(oiRow.putVol, 0) : '—'}
                </div>
                {/* PE LTP */}
                <div style={{ textAlign: 'center', padding: '4px 3px', fontSize: '11px', color: 'var(--text2)' }}>
                  {oiRow.putLTP > 0 ? oiRow.putLTP.toFixed(1) : '—'}
                </div>
                {/* PE OI bar */}
                <div style={{
                  position: 'relative', padding: '4px 5px', display: 'flex', alignItems: 'center',
                  borderRadius: '2px',
                  background: isAtm ? 'rgba(239,68,68,0.06)' : 'transparent',
                }}>
                  <div style={{
                    position: 'absolute', left: 0, top: 0, bottom: 0,
                    width: `${putBarW}%`, background: 'rgba(239,68,68,0.15)',
                    borderRadius: '2px', minWidth: putBarW > 0 ? '2px' : '0',
                  }} />
                  {role !== 'viewer' && put && (
                    <button onClick={() => handleOrder(put.tradingsymbol, 'BUY')} style={{
                      position: 'relative', marginRight: '3px', background: CYB.redDim, border: '1px solid rgba(255,0,60,0.3)',
                      borderRadius: '2px', color: CYB.redGlow, fontSize: '8px', fontWeight: 700,
                      padding: '2px 5px', cursor: 'pointer', fontFamily: 'monospace', flexShrink: 0,
                    }}>B</button>
                  )}
                  <span style={{ position: 'relative', fontSize: '11px', color: 'var(--bear)', fontWeight: oiRow.putOI > 0 ? 600 : 400 }}>
                    {oiRow.putOI > 0 ? fmtNum(oiRow.putOI, 0) : '—'}
                  </span>
                </div>
              </div>
            )
          }

          // Fallback: no OI data (3-column layout)
          const callGreeks = estimateGreeks(spot, strike, 'CE', chain.expiry, chain.lotSize)
          const putGreeks = put ? estimateGreeks(spot, strike, 'PE', chain.expiry, chain.lotSize) : null
          return (
            <div key={strike} style={{ display: 'contents' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 6px', gap: '4px' }}>
                <span style={{ color: 'var(--text3)', fontSize: '9px' }}>{callGreeks.itm ? 'ITM' : 'OTM'} d{callGreeks.delta >= 0 ? '+' : ''}{callGreeks.delta.toFixed(2)}</span>
                {role !== 'viewer' && (
                  <button onClick={() => handleOrder(call.tradingsymbol, 'BUY')} style={{
                    background: CYB.glowDim, border: `1px solid ${CYB.glowBorder}`, borderRadius: '2px',
                    color: CYB.glow, fontSize: '8px', fontWeight: 700, padding: '2px 6px', cursor: 'pointer', fontFamily: 'monospace',
                  }}>BUY</button>
                )}
              </div>
              <div style={{ textAlign: 'center', padding: '3px 8px', fontWeight: isAtm ? 800 : 400, color: isAtm ? 'var(--text)' : 'var(--text2)', background: isAtm ? 'rgba(255,255,255,0.06)' : 'transparent', borderRadius: '3px', border: isAtm ? `1px solid ${CYB.glowBorder}` : 'none' }}>{strike}</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 6px', gap: '4px' }}>
                {put ? (
                  <>
                    {role !== 'viewer' && <button onClick={() => handleOrder(put.tradingsymbol, 'BUY')} style={{ background: CYB.redDim, border: '1px solid rgba(255,0,60,0.3)', borderRadius: '2px', color: CYB.redGlow, fontSize: '8px', fontWeight: 700, padding: '2px 6px', cursor: 'pointer', fontFamily: 'monospace' }}>BUY</button>}
                    <span style={{ color: 'var(--text3)', fontSize: '9px' }}>d{putGreeks?.delta.toFixed(2)} {putGreeks?.itm ? 'ITM' : 'OTM'}</span>
                  </>
                ) : <span style={{ color: 'var(--text3)' }}>—</span>}
              </div>
            </div>
          )
        })}
      </div>

      {/* ATM Greeks + OI summary */}
      <div style={{ marginTop: '8px', fontSize: '11px', color: 'var(--text3)', fontFamily: 'monospace', padding: '8px 10px', background: 'rgba(0,0,0,0.15)', borderRadius: '3px', border: `1px solid ${CYB.glowBorder}`, display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {(() => {
          const cg = estimateGreeks(spot, chain.atmStrike, 'CE', chain.expiry, chain.lotSize)
          const pg = estimateGreeks(spot, chain.atmStrike, 'PE', chain.expiry, chain.lotSize)
          return (
            <div>
              <span style={{ color: CYB.glow, opacity: 0.5, fontSize: '9px', letterSpacing: '0.1em' }}>ATM </span>
              {chain.atmStrike}: CE d{cg.delta >= 0 ? '+' : ''}{cg.delta.toFixed(2)} {cg.perPoint.toFixed(0)}/pt · PE d{pg.delta.toFixed(2)} {pg.perPoint.toFixed(0)}/pt · {cg.dte}d
            </div>
          )
        })()}
        {oi && (
          <div>
            <span style={{ color: CYB.glow, opacity: 0.5, fontSize: '9px', letterSpacing: '0.1em' }}>OI READ </span>
            <span style={{ color: pcrColor }}>
              PCR {oi.pcr.toFixed(2)} → {pcrSignal}
            </span>
            {' · '}
            max pain {oi.maxPainStrike} ({spot > oi.maxPainStrike ? 'spot above' : 'spot below'} by {Math.abs(spot - oi.maxPainStrike).toFixed(0)}pt)
            {' · '}
            {oi.pcr > 1.2 ? 'heavy put writing = support' : oi.pcr < 0.8 ? 'heavy call writing = resistance' : 'balanced'}
          </div>
        )}
      </div>

      {/* Explanation */}
      {oi && (() => {
        const painDist = spot - oi.maxPainStrike
        const painPct = Math.abs(painDist / spot * 100)
        const maxCallStrike = oi.strikes.reduce((a, b) => b.callOI > a.callOI ? b : a, oi.strikes[0])
        const maxPutStrike = oi.strikes.reduce((a, b) => b.putOI > a.putOI ? b : a, oi.strikes[0])

        const lines: string[] = []

        if (painDist > 0) {
          lines.push(`Spot is ${painPct.toFixed(1)}% above max pain (${oi.maxPainStrike}). Option writers profit most if price pulls back toward ${oi.maxPainStrike}. Expect gravitational drag downward near expiry.`)
        } else if (painDist < 0) {
          lines.push(`Spot is ${painPct.toFixed(1)}% below max pain (${oi.maxPainStrike}). Option writers profit most if price drifts up toward ${oi.maxPainStrike}. Expect upward pull near expiry.`)
        } else {
          lines.push(`Spot is at max pain (${oi.maxPainStrike}). Price is at the equilibrium where option writers lose the least. Expect low volatility / range-bound action.`)
        }

        if (oi.pcr > 1.5) {
          lines.push(`PCR ${oi.pcr.toFixed(2)} is very high — put writers are aggressively selling downside. This creates a floor of support. Contrarian bullish signal.`)
        } else if (oi.pcr > 1.2) {
          lines.push(`PCR ${oi.pcr.toFixed(2)} is elevated — more puts written than calls. Put sellers expect support below. Mild bullish bias.`)
        } else if (oi.pcr < 0.6) {
          lines.push(`PCR ${oi.pcr.toFixed(2)} is very low — call writers dominate. Heavy resistance above from call selling. Contrarian bearish signal.`)
        } else if (oi.pcr < 0.8) {
          lines.push(`PCR ${oi.pcr.toFixed(2)} is low — more calls written than puts. Call sellers expect a ceiling. Mild bearish bias.`)
        } else {
          lines.push(`PCR ${oi.pcr.toFixed(2)} is balanced — no strong directional bias from option writers.`)
        }

        if (maxCallStrike.callOI > 0) {
          lines.push(`Highest call OI at ${maxCallStrike.strike} (${fmtNum(maxCallStrike.callOI, 0)}) — this is the resistance level where call writers have the most at stake. Price crossing above this strike forces short covering.`)
        }
        if (maxPutStrike.putOI > 0) {
          lines.push(`Highest put OI at ${maxPutStrike.strike} (${fmtNum(maxPutStrike.putOI, 0)}) — this is the support level where put writers defend. Price dropping below triggers unwinding.`)
        }

        return (
          <div style={{
            marginTop: '6px', padding: '8px 10px', borderRadius: '3px',
            background: 'rgba(0,0,0,0.1)', border: `1px solid ${CYB.glowBorder}`,
            fontSize: '11px', color: 'var(--text3)', fontFamily: 'monospace',
            lineHeight: '1.6', display: 'flex', flexDirection: 'column', gap: '5px',
          }}>
            <span style={{ color: CYB.glow, opacity: 0.5, fontSize: '9px', letterSpacing: '0.1em' }}>{'//ANALYSIS'}</span>
            {lines.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
        )
      })()}
    </div>
  )
}

function SysLogPanel({ entries }: { entries: SysLogEntry[] }) {
  const [showCount, setShowCount] = useState(4)

  const reversed = entries.length > 0 ? [...entries].reverse() : []
  const visible = reversed.slice(0, showCount)
  const hasMore = showCount < reversed.length
  const resolved = entries.filter(e => e.resolved)
  const correctCount = resolved.filter(e => e.correct).length
  const targetHitCount = resolved.filter(e => e.targetHit).length
  const accuracy = resolved.length > 0 ? Math.round((correctCount / resolved.length) * 100) : 0

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: '4px',
      padding: '8px 10px', background: CYB.panel, borderRadius: '6px',
      border: `1px solid ${CYB.glowBorder}`,
    }}>
      <style>{`
        @media (max-width: 640px) {
          .syslog-head { display: none !important; }
          .syslog-entries > div {
            display: flex !important;
            flex-wrap: wrap !important;
            gap: 5px !important;
            font-size: 9px !important;
            grid-template-columns: unset !important;
          }
        }
      `}</style>
      {/* HEADER */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '2px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '8px', fontWeight: 700, color: CYB.glow, letterSpacing: '0.15em' }}>{'//SYS_LOG'}</span>
        <span style={{ fontSize: '8px', color: 'var(--text3)' }}>
          {resolved.length} resolved · {accuracy}% win
          {targetHitCount > 0 && ` · ${targetHitCount} target-hit`}
        </span>
        <span style={{ flex: 1 }} />
      </div>

      {/* COLUMN HEADERS — desktop only */}
      <div className="syslog-head" style={{
        display: 'grid', gridTemplateColumns: '44px 90px 68px 68px 68px 52px 70px 60px 62px 62px',
        gap: '4px', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.08)',
        fontSize: '11px', color: 'var(--text3)', fontWeight: 600, letterSpacing: '0.08em',
      }}>
        <span>TIME</span><span>PRED</span><span>ENTRY</span><span>TARGET</span><span>NOW</span><span>%→TGT</span><span>STATUS</span><span>STRIKE</span><span>OPT IN</span><span>OPT TGT</span>
      </div>

      {/* ENTRIES */}
      <div className="syslog-entries">
        {visible.map(e => {
          const pending = !e.resolved
          const liveInDir = (pending ? e.liveMove : e.outcomeMove) ?? 0
          const sameDir = (e.predMove > 0 && liveInDir > 0) || (e.predMove < 0 && liveInDir < 0)
          const targetPct = e.predMove !== 0 && sameDir
            ? Math.max(0, Math.min(100, Math.round(Math.abs(liveInDir / e.predMove) * 100)))
            : 0

          const spotNow = pending ? e.liveSpot : e.spotAtOutcome
          const targetSpot = e.predSpot
          const nowColor = spotNow != null
            ? (sameDir ? 'var(--bull)' : liveInDir === 0 ? 'var(--text3)' : 'var(--bear)')
            : 'var(--text3)'
          const pctColor = targetPct >= 80 ? 'var(--bull)' : targetPct >= 50 ? 'var(--text)' : 'var(--text3)'

          const hasOpt = e.optStrike != null && e.optType != null
          const optColor = dirColor(e.predMove >= 0 ? 'BULL' : 'BEAR')

          return (
            <div key={e.cycleTs} style={{
              padding: '5px 0', borderBottom: '1px solid rgba(255,255,255,0.03)',
              opacity: e.resolved ? 1 : 0.8,
            }}>
              {/* MAIN ROW */}
              <div style={{
                display: 'grid', gridTemplateColumns: '44px 90px 68px 68px 68px 52px 70px 60px 62px 62px',
                gap: '4px', alignItems: 'center', fontSize: '13px',
              }}>
                {/* TIME */}
                <span style={{ color: 'var(--text3)', fontSize: '12px' }}>{e.cycleTime}</span>

                {/* PREDICTION — direction + predicted % */}
                <span style={{
                  color: dirColor(e.predMove >= 0 ? 'BULL' : 'BEAR'), fontWeight: 700, fontSize: '13px',
                }}>
                  {e.predMove >= 0 ? '▲' : '▼'} {fmtPct(e.predMove, 3)}
                </span>

                {/* ENTRY PRICE */}
                <span style={{ color: 'var(--text)', fontSize: '12px', fontWeight: 600 }}>
                  ₹{e.spotAtPred.toFixed(0)}
                </span>

                {/* TARGET PRICE */}
                <span style={{ color: dirColor(e.predMove >= 0 ? 'BULL' : 'BEAR'), fontSize: '12px', fontWeight: 600, opacity: 0.85 }}>
                  ₹{targetSpot.toFixed(0)}
                </span>

                {/* CURRENT PRICE */}
                <span style={{ color: nowColor, fontSize: '12px', fontWeight: 600 }}>
                  {spotNow != null ? `₹${spotNow.toFixed(0)}` : '—'}
                </span>

                {/* % TO TARGET */}
                <span style={{ color: pctColor, fontSize: '12px', fontWeight: 700, textAlign: 'right' }}>
                  {e.resolved
                    ? (e.targetHit ? '100%' : (sameDir ? `${targetPct}%` : '0%'))
                    : `${targetPct}%`
                  }
                </span>

                {/* STATUS */}
                <span style={{ fontSize: '12px', fontWeight: 700 }}>
                  {e.resolved ? (
                    e.targetHit
                      ? <span style={{ color: CYB.accent }}>🎯HIT</span>
                      : <span style={{ color: e.correct ? 'var(--bull)' : 'var(--bear)' }}>{e.correct ? '✓' : '✗'}</span>
                  ) : (
                    e.targetHit
                      ? <span style={{ color: CYB.accent }}>🎯HIT</span>
                      : <span style={{ color: CYB.accent }}>LIVE</span>
                  )}
                </span>

                {/* STRIKE */}
                <span style={{ color: hasOpt ? optColor : 'var(--text3)', fontWeight: hasOpt ? 700 : 400, fontSize: '12px' }}>
                  {hasOpt ? `${e.optStrike}${e.optType}` : '—'}
                </span>

                {/* OPT IN */}
                <span style={{ color: 'var(--text2)', fontSize: '12px' }}>
                  {hasOpt && e.optEntry != null ? `₹${e.optEntry.toFixed(1)}` : '—'}
                </span>

                {/* OPT TGT */}
                <span style={{ color: hasOpt ? optColor : 'var(--text3)', fontSize: '12px', fontWeight: hasOpt ? 600 : 400 }}>
                  {hasOpt && e.optTarget != null ? `₹${e.optTarget.toFixed(1)}` : '—'}
                </span>
              </div>
            </div>
          )
        })}

        {/* MORE BUTTON */}
        {hasMore && (
          <button onClick={() => setShowCount(c => c + 3)} style={{
            display: 'block', width: '100%', marginTop: '4px', padding: '3px 0',
            fontSize: '8px', fontWeight: 700, fontFamily: 'inherit', letterSpacing: '0.1em',
            color: CYB.glow, background: 'transparent', border: `1px solid ${CYB.glowBorder}`,
            borderRadius: '2px', cursor: 'pointer', opacity: 0.7,
          }}>
            +{Math.min(3, reversed.length - showCount)} MORE ({reversed.length - showCount} remaining)
          </button>
        )}

        {/* EMPTY STATE */}
        {entries.length === 0 && (
          <div style={{ fontSize: '9px', color: 'var(--text3)', textAlign: 'center', padding: '4px 0' }}>first prediction in ~20m</div>
        )}
      </div>
    </div>
  )
}

function RangeBar({ low, high, current }: { low: number; high: number; current: number }) {
  if (high <= low) return null
  const pct = Math.max(0, Math.min(100, ((current - low) / (high - low)) * 100))
  const nearHigh = pct > 75
  const nearLow = pct < 25

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontFamily: 'monospace' }}>
      <span style={{ fontSize: '9px', color: 'var(--bear)', fontWeight: 600, minWidth: '36px', textAlign: 'right' }}>{low.toFixed(0)}</span>
      <div style={{ flex: 1, position: 'relative', height: '6px', background: 'rgba(255,255,255,0.06)', borderRadius: '3px', border: `1px solid ${CYB.glowBorder}` }}>
        {/* Track fill */}
        <div style={{
          position: 'absolute', left: 0, top: 0, bottom: 0,
          width: `${pct}%`, borderRadius: '3px',
          background: nearHigh ? 'rgba(34,197,94,0.25)' : nearLow ? 'rgba(239,68,68,0.25)' : 'rgba(255,255,255,0.08)',
          transition: 'width 0.3s',
        }} />
        {/* Current price marker */}
        <div style={{
          position: 'absolute',
          left: `calc(${pct}% - 3px)`, top: '-3px',
          width: '6px', height: '12px', borderRadius: '2px',
          background: 'var(--text)', boxShadow: '0 0 4px rgba(255,255,255,0.3)',
          transition: 'left 0.3s',
        }} />
      </div>
      <span style={{ fontSize: '9px', color: 'var(--bull)', fontWeight: 600, minWidth: '36px' }}>{high.toFixed(0)}</span>
    </div>
  )
}

// ── Expandable Panel wrapper — double-click/tap opens modal ─────────────────

function ExpandablePanel({ children, label }: { children: React.ReactNode; label: string }) {
  const [expanded, setExpanded] = useState(false)
  const lastTapRef = useRef(0)

  const handleInteraction = () => {
    const now = Date.now()
    if (now - lastTapRef.current < 400) {
      setExpanded(true)
      lastTapRef.current = 0
    } else {
      lastTapRef.current = now
    }
  }

  return (
    <>
      <div
        onDoubleClick={() => setExpanded(true)}
        onTouchEnd={handleInteraction}
        style={{ cursor: 'pointer', position: 'relative' }}
      >
        {children}
        {/* Expand hint */}
        <div style={{
          position: 'absolute', top: '6px', right: '6px',
          fontSize: '7px', color: CYB.glow, opacity: 0.3,
          letterSpacing: '0.1em', fontFamily: 'monospace',
          pointerEvents: 'none',
        }}>
          2×TAP
        </div>
      </div>

      {/* Modal overlay */}
      {expanded && (
        <div
          onClick={() => setExpanded(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 100,
            background: 'rgba(0,0,0,0.85)',
            backdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '12px',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: '100%', maxWidth: '92vw', maxHeight: '92vh',
              overflowY: 'auto', overflowX: 'hidden',
              borderRadius: '8px',
              border: `1px solid ${CYB.glowBorder}`,
              boxShadow: '0 0 20px rgba(0,0,0,0.5)',
              background: 'var(--bg)',
            }}
          >
            {/* Modal header */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '10px 16px',
              borderBottom: `1px solid ${CYB.glowBorder}`,
              background: CYB.panel,
              position: 'sticky', top: 0, zIndex: 1,
            }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
                <span style={{ fontSize: '14px', fontWeight: 700, color: CYB.glow, letterSpacing: '0.15em' }}>{'//'}{label}</span>
              </div>
              <button
                onClick={() => setExpanded(false)}
                style={{
                  background: 'transparent', border: `1px solid ${CYB.glowBorder}`,
                  color: CYB.glow, fontSize: '13px', fontWeight: 700,
                  padding: '5px 14px', borderRadius: '3px', cursor: 'pointer',
                  fontFamily: 'monospace', letterSpacing: '0.1em',
                }}
              >
                CLOSE
              </button>
            </div>
            {/* Scaled-up content — CSS zoom for uniform scaling */}
            <div style={{ padding: '20px', zoom: 1.6 }}>
              {children}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// ── Shared button style (matches N50 conviction) ────────────────────────────

const btnStyle: React.CSSProperties = {
  border: '1px solid var(--border)', borderRadius: '4px',
  padding: '4px 10px', fontSize: '11px', fontFamily: 'inherit',
  cursor: 'pointer', letterSpacing: '0.05em', transition: 'all 0.15s',
  background: 'transparent', color: 'var(--text2)', textDecoration: 'none',
  display: 'inline-block',
}

// ── Main Client ───────────────────────────────────────────────────────────────

export default function CrudeConvictionClient({ role = 'admin' }: { role?: string }) {
  const router = useRouter()
  const [state, setState] = useState<CrudeState | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [product, setProduct] = useState<'CRUDEOIL' | 'CRUDEOILM'>('CRUDEOILM')
  const [status, setStatus] = useState<'connecting' | 'live' | 'stale'>('connecting')

  const switchProduct = (p: 'CRUDEOIL' | 'CRUDEOILM') => {
    if (p === product) return
    setProduct(p)
    setState(null)
    setLoading(true)
  }
  const timerRef = useRef<NodeJS.Timeout | null>(null)

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch(`/api/crude?product=${product}`)
      if (!res.ok) throw new Error(`${res.status}`)
      const data = await res.json()
      setState(data)
      setError(null)
      setStatus('live')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'fetch failed')
      setStatus('stale')
    } finally {
      setLoading(false)
    }
  }, [product])

  useEffect(() => {
    fetchState()
    timerRef.current = setInterval(fetchState, 2000)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [fetchState])

  const handleSignOut = async () => {
    await fetch('/api/auth/logout', { method: 'POST' })
    router.push('/')
  }

  const updatedAt = state ? Date.now() : null

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', flexDirection: 'column' }}>
      {/* Header — matches N50 conviction sticky header */}
      <header style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexWrap: 'wrap', gap: '6px', padding: '8px 12px',
        borderBottom: '1px solid var(--border)', background: 'var(--bg2)',
        position: 'sticky', top: 0, zIndex: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
          <a href="/dashboard" style={{ fontWeight: 700, fontSize: '14px', letterSpacing: '-0.02em', color: 'var(--text)', textDecoration: 'none' }}>Z</a>
          <span style={{ color: 'var(--text3)', fontSize: '9px' }}>/</span>
          <span style={{ fontSize: '11px', color: 'var(--text)', letterSpacing: '0.08em', fontWeight: 700 }}>CRUDE</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
          {[{ href: '/dashboard', label: '📊' }, { href: '/dashboard/backtest', label: 'BT' }, { href: '/dashboard/conviction', label: 'N50' }, { href: '/dashboard/live', label: '◉' }].map(l => (
            <a key={l.href} href={l.href} style={{ ...btnStyle, padding: '3px 6px', fontSize: '10px' }}>{l.label}</a>
          ))}
          <ThemeToggle />
          <button onClick={handleSignOut} style={{ ...btnStyle, cursor: 'pointer', padding: '3px 6px', fontSize: '9px' }}>OUT</button>
        </div>
      </header>

      {/* Status bar + product toggle — matches N50 filter bar */}
      <div style={{
        padding: '6px 12px', borderBottom: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column', gap: '6px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <div style={{
            width: '6px', height: '6px', borderRadius: '50%', flexShrink: 0,
            background: status === 'live' ? 'var(--bull)' : status === 'connecting' ? 'var(--mixed)' : 'var(--bear)',
          }} />
          <span style={{ fontSize: '9px', color: 'var(--text3)' }}>
            {status === 'live' && updatedAt ? new Date(updatedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : status}
          </span>
          {state && (
            <span style={{ fontSize: '9px', color: 'var(--text3)' }}>
              {state.marketOpen ? 'MCX OPEN' : 'MCX CLOSED'} · {product === 'CRUDEOIL' ? '100bbl' : '10bbl'}
              {state.patternCount > 0 ? ` · ${state.patternCount}pat (${state.resolvedCount}res)` : ''}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: '3px', flexWrap: 'wrap' }}>
          {/* Product toggle */}
          {(['CRUDEOIL', 'CRUDEOILM'] as const).map(p => (
            <button
              key={p}
              onClick={() => switchProduct(p)}
              style={{
                ...btnStyle, padding: '3px 8px', fontSize: '9px',
                background: product === p ? 'rgba(255,255,255,0.12)' : 'transparent',
                color: product === p ? 'var(--text)' : 'var(--text3)',
                border: `1px solid ${product === p ? 'rgba(255,255,255,0.2)' : CYB.glowBorder}`,
                fontWeight: 700, letterSpacing: '0.1em',
              }}
            >
              {p === 'CRUDEOIL' ? 'STD' : 'MINI'}
            </button>
          ))}
        </div>
      </div>

      {/* Loading / Error */}
      {loading && <div style={{ color: CYB.glow, fontSize: '10px', textAlign: 'center', padding: '40px', fontFamily: 'monospace', opacity: 0.6 }}>{'> CONNECTING TO CRUDE FEED...'}</div>}
      {error && !state && <div style={{ color: CYB.redGlow, fontSize: '10px', textAlign: 'center', padding: '20px', fontFamily: 'monospace' }}>{'> ERR: '}{error}</div>}

      {/* Content — all panels */}
      {state && !loading && (
        <div style={{ padding: '8px 10px', flex: 1, display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {/* Row 1: Oracle + Depth side by side on desktop */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '10px' }}>
            <ExpandablePanel label="ORACLE">
              <OraclePanel state={state} />
            </ExpandablePanel>
            <ExpandablePanel label="DEPTH">
              <DepthPanel depth={state.depth} spot={state.spot} />
            </ExpandablePanel>
          </div>

          {/* Row 2: SysLog full width */}
          <ExpandablePanel label="SYS_LOG">
            <SysLogPanel entries={state.sysLog} />
          </ExpandablePanel>

          {/* Row 3: Options Chain full width */}
          {state.chain ? (
            <ExpandablePanel label="CHAIN">
              <ChainPanel chain={state.chain} spot={state.spot} product={state.product} role={role} />
            </ExpandablePanel>
          ) : (
            <div style={{ color: CYB.glow, fontSize: '10px', padding: '16px', background: CYB.panel, border: `1px solid ${CYB.glowBorder}`, borderRadius: '6px', fontFamily: 'monospace', opacity: 0.6 }}>
              {'> CHAIN UNAVAILABLE — instruments CSV may be stale or market closed'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
