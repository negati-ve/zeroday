'use client'
import { useEffect, useState, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import ThemeToggle from '@/components/ThemeToggle'
import type { StockState, Position, CapitalData } from '@/lib/stockState'

type StockEntry = StockState & { name: string }

const NIFTY50_SET = new Set([
  'ADANIPORTS','APOLLOHOSP','ASIANPAINT','AXISBANK','BAJAJ-AUTO',
  'BAJAJFINSV','BAJFINANCE','BEL','BHARTIARTL','BPCL',
  'BRITANNIA','CIPLA','COALINDIA','DRREDDY','EICHERMOT',
  'ETERNAL','GRASIM','HCLTECH','HDFCBANK','HDFCLIFE',
  'HEROMOTOCO','HINDALCO','HINDUNILVR','ICICIBANK','INDUSINDBK',
  'INFY','ITC','JIOFIN','JSWSTEEL','KOTAKBANK',
  'LT','M&M','MARUTI','NESTLEIND','NTPC',
  'ONGC','POWERGRID','RELIANCE','SBILIFE','SBIN',
  'SHRIRAMFIN','SUNPHARMA','TATACONSUM','TATASTEEL','TCS',
  'TECHM','TITAN','TRENT','ULTRACEMCO','WIPRO',
])

interface N50Prediction {
  predictedMove: number
  bullProb: number
  bearProb: number
  topSim: number
  confidence: number
  nResolved: number
  direction: 'BULL' | 'BEAR' | null
  status: 'ready' | 'warming' | 'no_data'
}

interface N50State {
  prediction: N50Prediction
  snapshotCount: number
  patternCount: number
  resolvedCount: number
  niftyProxy: number
  bullStockPct: number
  bearStockPct: number
  coverageCount: number
  minutesAccumulated: number
}

interface ConvictionResult {
  score: number
  direction: 'BULL' | 'BEAR' | null
  checks: Check[]
}

interface Check {
  id: string
  label: string
  pass: boolean
  direction: 'BULL' | 'BEAR' | null
  detail: string
}

function computeConviction(s: StockState): ConvictionResult {
  const checks: Check[] = []
  let bullPoints = 0, bearPoints = 0, maxPoints = 0

  // 1. Pattern agreement (weight: 3)
  const pats = [s.pat30_5, s.pat60_20, s.pat30v2].filter(Boolean) as NonNullable<typeof s.pat5>[]
  if (pats.length > 0) {
    maxPoints += 3
    const bullPats = pats.filter(p => p.bull > p.bear)
    const bearPats = pats.filter(p => p.bear > p.bull)
    const allAgree = bullPats.length === pats.length || bearPats.length === pats.length
    const avgBull = pats.reduce((a, p) => a + p.bull, 0) / pats.length
    const avgBear = pats.reduce((a, p) => a + p.bear, 0) / pats.length
    const dominantDir = avgBull > avgBear ? 'BULL' as const : 'BEAR' as const
    const dominantPct = Math.max(avgBull, avgBear)
    if (allAgree && dominantPct >= 60) {
      const pts = dominantPct >= 80 ? 3 : dominantPct >= 70 ? 2.5 : 2
      if (dominantDir === 'BULL') bullPoints += pts; else bearPoints += pts
      checks.push({ id: 'pat', label: 'PAT', pass: true, direction: dominantDir, detail: `${pats.length}/${pats.length} agree ${dominantDir} avg ${dominantPct.toFixed(0)}%` })
    } else if (bullPats.length > bearPats.length || bearPats.length > bullPats.length) {
      const majDir = bullPats.length > bearPats.length ? 'BULL' as const : 'BEAR' as const
      const majCount = Math.max(bullPats.length, bearPats.length)
      if (majDir === 'BULL') bullPoints += 1; else bearPoints += 1
      checks.push({ id: 'pat', label: 'PAT', pass: false, direction: majDir, detail: `${majCount}/${pats.length} ${majDir}, mixed` })
    } else {
      checks.push({ id: 'pat', label: 'PAT', pass: false, direction: null, detail: `split — no consensus` })
    }
  }

  // 2. EMA crossover (weight: 1.5)
  const ind = s.indicators
  maxPoints += 1.5
  if (ind?.emaCrossover) {
    if (ind.emaCrossover === 'BULL') bullPoints += 1.5; else bearPoints += 1.5
    checks.push({ id: 'ema', label: 'EMA', pass: true, direction: ind.emaCrossover, detail: `${ind.emaShort?.toFixed(1)} ${ind.emaCrossover === 'BULL' ? '>' : '<'} ${ind.emaLong?.toFixed(1)}` })
  } else {
    checks.push({ id: 'ema', label: 'EMA', pass: false, direction: null, detail: ind ? 'warming up' : 'no data' })
  }

  // 3. VWAP alignment (weight: 1.5)
  maxPoints += 1.5
  if (ind?.vwapAlign) {
    if (ind.vwapAlign === 'BULL') bullPoints += 1.5; else bearPoints += 1.5
    checks.push({ id: 'vwap', label: 'VWAP', pass: true, direction: ind.vwapAlign, detail: `₹${s.ltp.toFixed(1)} ${ind.vwapAlign === 'BULL' ? '>' : '<'} ₹${ind.vwap?.toFixed(1)}` })
  } else {
    checks.push({ id: 'vwap', label: 'VWAP', pass: false, direction: null, detail: ind ? 'no data' : 'no data' })
  }

  // 4. ATR (volatility sufficient) (weight: 1)
  maxPoints += 1
  if (ind?.atrPct != null && ind.atrPct > 0) {
    const sufficient = ind.atrPct >= 0.12
    if (sufficient) {
      bullPoints += 1; bearPoints += 1
    }
    checks.push({ id: 'atr', label: 'ATR', pass: sufficient, direction: null, detail: `${ind.atrPct.toFixed(2)}% ${sufficient ? '— vol OK' : '— low vol'}` })
  } else {
    checks.push({ id: 'atr', label: 'ATR', pass: false, direction: null, detail: ind ? 'warming up' : 'no data' })
  }

  // 5. RSI (not extreme against direction) (weight: 0.5)
  maxPoints += 0.5
  if (ind?.rsi != null && ind.rsi > 0 && ind.rsi < 100) {
    const overbought = ind.rsi > 70
    const oversold = ind.rsi < 30
    checks.push({
      id: 'rsi', label: 'RSI', pass: !overbought && !oversold,
      direction: oversold ? 'BULL' : overbought ? 'BEAR' : null,
      detail: `${ind.rsi.toFixed(0)}${overbought ? ' overbought' : oversold ? ' oversold' : ' neutral'}`,
    })
    if (!overbought && !oversold) { bullPoints += 0.5; bearPoints += 0.5 }
  } else {
    checks.push({ id: 'rsi', label: 'RSI', pass: false, direction: null, detail: ind ? 'warming up' : 'no data' })
  }

  // 6. CD agreement (weight: 2)
  maxPoints += 2
  if (s.cdZ != null) {
    const cdDir = s.cdZ >= 0.5 ? 'BULL' as const : s.cdZ <= -0.5 ? 'BEAR' as const : null
    if (cdDir) {
      if (cdDir === 'BULL') bullPoints += 2; else bearPoints += 2
      checks.push({ id: 'cd', label: 'CD', pass: true, direction: cdDir, detail: `${s.cdZ >= 0 ? '+' : ''}${s.cdZ.toFixed(1)}σ ${cdDir === 'BULL' ? 'net buying' : 'net selling'}` })
    } else {
      checks.push({ id: 'cd', label: 'CD', pass: false, direction: null, detail: `${s.cdZ >= 0 ? '+' : ''}${s.cdZ.toFixed(1)}σ — weak` })
    }
  }

  // 7. CUSUM (sustained regime) (weight: 1)
  maxPoints += 1
  if (s.cusumBull || s.cusumBear) {
    const dir = s.cusumBull ? 'BULL' as const : 'BEAR' as const
    if (dir === 'BULL') bullPoints += 1; else bearPoints += 1
    checks.push({ id: 'cusum', label: 'CUSUM', pass: true, direction: dir, detail: `sustained ${dir} regime` })
  } else {
    checks.push({ id: 'cusum', label: 'CUSUM', pass: false, direction: null, detail: 'no alarm' })
  }

  const dominant = bullPoints > bearPoints ? 'BULL' as const : bearPoints > bullPoints ? 'BEAR' as const : null
  const dominantPts = Math.max(bullPoints, bearPoints)
  const score = maxPoints > 0 ? Math.min(1, dominantPts / maxPoints) : 0

  // Penalize if checks disagree on direction
  const passedChecks = checks.filter(c => c.pass && c.direction)
  const bullChecks = passedChecks.filter(c => c.direction === 'BULL').length
  const bearChecks = passedChecks.filter(c => c.direction === 'BEAR').length
  const disagreement = Math.min(bullChecks, bearChecks)
  const penalty = disagreement * 0.1
  const finalScore = Math.max(0, score - penalty)

  return { score: finalScore, direction: dominant, checks }
}

function convictionTier(score: number): { label: string; color: string; bg: string } {
  if (score >= 0.7) return { label: 'STRONG', color: 'var(--bull)', bg: 'rgba(34,197,94,0.08)' }
  if (score >= 0.45) return { label: 'PARTIAL', color: 'var(--mixed)', bg: 'rgba(234,179,8,0.06)' }
  return { label: 'WAIT', color: 'var(--text3)', bg: 'transparent' }
}

// ── ConvictionCard ──────────────────────────────────────────────────────────

function ConvictionCard({ stock, conviction, positions }: {
  stock: StockEntry; conviction: ConvictionResult; positions: Position[]
}) {
  const [expanded, setExpanded] = useState(false)
  const tier = convictionTier(conviction.score)
  const pct = Math.round(conviction.score * 100)
  const pos = positions.find(p => p.stock === stock.name)

  return (
    <div style={{
      background: tier.bg || 'var(--bg2)',
      border: `1px solid ${conviction.score >= 0.7 ? tier.color : 'var(--border)'}`,
      borderRadius: '8px',
      padding: '14px 16px',
      display: 'flex', flexDirection: 'column', gap: '8px',
      transition: 'all 0.2s',
      boxShadow: conviction.score >= 0.7 ? `0 0 16px ${conviction.direction === 'BULL' ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)'}` : undefined,
    }}>
      {/* Layer 1: Glanceable */}
      <div onClick={() => setExpanded(e => !e)} style={{ cursor: 'pointer' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
            <span style={{ fontSize: '15px', fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--text)' }}>{stock.name}</span>
            <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)' }}>₹{stock.ltp.toFixed(2)}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '10px', color: 'var(--text3)' }}>{expanded ? '▲' : '▼'}</span>
          </div>
        </div>

        {/* Conviction bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{ flex: 1, height: '8px', background: 'var(--bg3)', borderRadius: '4px', overflow: 'hidden', position: 'relative' }}>
            <div style={{
              width: `${pct}%`, height: '100%',
              background: tier.color,
              borderRadius: '4px',
              transition: 'width 0.5s ease',
            }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
            <span style={{ fontSize: '13px', fontWeight: 700, color: tier.color }}>{pct}%</span>
            {conviction.direction && (
              <span style={{
                fontSize: '10px', fontWeight: 700,
                color: conviction.direction === 'BULL' ? 'var(--bull)' : 'var(--bear)',
                padding: '2px 6px', borderRadius: '3px',
                background: conviction.direction === 'BULL' ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
              }}>
                {conviction.direction === 'BULL' ? '▲' : '▼'} {conviction.direction}
              </span>
            )}
          </div>
        </div>

        {/* Pass/fail chips */}
        <div style={{ display: 'flex', gap: '4px', marginTop: '8px', flexWrap: 'wrap' }}>
          {conviction.checks.map(c => (
            <span key={c.id} style={{
              fontSize: '10px', fontWeight: 600,
              padding: '2px 7px', borderRadius: '3px',
              background: c.pass
                ? (c.direction === 'BULL' ? 'rgba(34,197,94,0.15)' : c.direction === 'BEAR' ? 'rgba(239,68,68,0.15)' : 'rgba(255,255,255,0.08)')
                : 'rgba(255,255,255,0.03)',
              color: c.pass
                ? (c.direction === 'BULL' ? 'var(--bull)' : c.direction === 'BEAR' ? 'var(--bear)' : 'var(--text2)')
                : 'var(--text3)',
              border: `1px solid ${c.pass ? (c.direction === 'BULL' ? 'rgba(34,197,94,0.25)' : c.direction === 'BEAR' ? 'rgba(239,68,68,0.25)' : 'var(--border)') : 'var(--border)'}`,
            }}>
              {c.label} {c.pass ? '✓' : '✗'}
            </span>
          ))}
        </div>

        {/* Open position alert */}
        {pos && (
          <div style={{
            marginTop: '8px', padding: '6px 10px', borderRadius: '4px',
            background: (pos.pnl ?? 0) >= 0 ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
            border: `1px solid ${(pos.pnl ?? 0) >= 0 ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}`,
            display: 'flex', gap: '12px', alignItems: 'center', fontSize: '11px',
          }}>
            <span style={{ fontWeight: 700, color: pos.direction === 'BULL' ? 'var(--bull)' : 'var(--bear)' }}>
              {pos.direction === 'BULL' ? '▲' : '▼'} OPEN
            </span>
            <span style={{ color: (pos.pnl ?? 0) >= 0 ? 'var(--bull)' : 'var(--bear)', fontWeight: 600 }}>
              {(pos.pnl ?? 0) >= 0 ? '+' : ''}₹{pos.pnl?.toLocaleString('en-IN') ?? '—'}
            </span>
            <span style={{ color: 'var(--text3)' }}>{pos.heldMin.toFixed(0)}m</span>
            <span style={{ color: 'var(--text3)', fontSize: '10px' }}>{pos.buySymbol}</span>
            {pos.isExiting && <span style={{ color: 'var(--bear)', fontWeight: 700 }}>EXIT ALERT</span>}
            {conviction.direction && conviction.direction !== pos.direction && conviction.score >= 0.45 && (
              <span style={{ color: 'var(--bear)', fontWeight: 700, marginLeft: 'auto' }}>
                ⚠ conviction flipping {conviction.direction}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Layer 2: Expanded — detailed checks + data */}
      {expanded && (
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: '10px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {/* Check details */}
          <div>
            <div style={{ fontSize: '9px', color: 'var(--text3)', letterSpacing: '0.1em', marginBottom: '6px' }}>FILTER DETAILS</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {conviction.checks.map(c => (
                <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px' }}>
                  <span style={{
                    width: '18px', textAlign: 'center',
                    color: c.pass ? 'var(--bull)' : 'var(--text3)',
                  }}>{c.pass ? '✓' : '✗'}</span>
                  <span style={{
                    width: '48px', fontWeight: 700, flexShrink: 0,
                    color: c.pass
                      ? (c.direction === 'BULL' ? 'var(--bull)' : c.direction === 'BEAR' ? 'var(--bear)' : 'var(--text2)')
                      : 'var(--text3)',
                  }}>{c.label}</span>
                  <span style={{ color: 'var(--text2)' }}>{c.detail}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Pattern predictions */}
          <div>
            <div style={{ fontSize: '9px', color: 'var(--text3)', letterSpacing: '0.1em', marginBottom: '6px' }}>PATTERN PREDICTIONS</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
              {([['PAT-30→5', stock.pat30_5], ['PAT-60→20', stock.pat60_20], ['PAT-30v2', stock.pat30v2]] as [string, typeof stock.pat5][]).map(([label, pat]) => {
                if (!pat) return <div key={label} style={{ fontSize: '10px', color: 'var(--text3)' }}>{label}: —</div>
                const dir = pat.bull > pat.bear ? 'BULL' : 'BEAR'
                const pct = Math.max(pat.bull, pat.bear)
                return (
                  <div key={label} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '10px' }}>
                    <span style={{ width: '60px', color: 'var(--text3)', flexShrink: 0 }}>{label}</span>
                    <div style={{ width: '60px', height: '4px', background: 'var(--bg3)', borderRadius: '2px', overflow: 'hidden', flexShrink: 0 }}>
                      <div style={{
                        width: `${pct}%`, height: '100%', borderRadius: '2px',
                        background: dir === 'BULL' ? 'var(--bull)' : 'var(--bear)',
                      }} />
                    </div>
                    <span style={{ color: dir === 'BULL' ? 'var(--bull)' : 'var(--bear)', fontWeight: 600 }}>
                      {dir === 'BULL' ? '▲' : '▼'}{pct}%
                    </span>
                    <span style={{ color: pat.move >= 0 ? 'var(--bull)' : 'var(--bear)' }}>
                      {pat.move >= 0 ? '+' : ''}{pat.move.toFixed(2)}%
                    </span>
                    <span style={{ color: 'var(--text3)' }}>sim:{pat.sim.toFixed(2)} n={pat.n}</span>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Indicators */}
          {stock.indicators && (
            <div>
              <div style={{ fontSize: '9px', color: 'var(--text3)', letterSpacing: '0.1em', marginBottom: '6px' }}>INDICATORS</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', fontSize: '10px' }}>
                {stock.indicators.emaShort != null && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
                    <span style={{ fontSize: '9px', color: 'var(--text3)' }}>EMA 9/21</span>
                    <span style={{ fontWeight: 600, color: stock.indicators.emaCrossover === 'BULL' ? 'var(--bull)' : stock.indicators.emaCrossover === 'BEAR' ? 'var(--bear)' : 'var(--text2)' }}>
                      {stock.indicators.emaShort.toFixed(1)} / {stock.indicators.emaLong?.toFixed(1) ?? '—'}
                      {stock.indicators.emaCrossover === 'BULL' ? ' ↗' : stock.indicators.emaCrossover === 'BEAR' ? ' ↘' : ''}
                    </span>
                  </div>
                )}
                {stock.indicators.vwap != null && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
                    <span style={{ fontSize: '9px', color: 'var(--text3)' }}>VWAP</span>
                    <span style={{ fontWeight: 600, color: stock.indicators.vwapAlign === 'BULL' ? 'var(--bull)' : stock.indicators.vwapAlign === 'BEAR' ? 'var(--bear)' : 'var(--text2)' }}>
                      ₹{stock.indicators.vwap.toFixed(1)} {stock.indicators.vwapAlign === 'BULL' ? '▲ above' : stock.indicators.vwapAlign === 'BEAR' ? '▼ below' : ''}
                    </span>
                  </div>
                )}
                {stock.indicators.rsi != null && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
                    <span style={{ fontSize: '9px', color: 'var(--text3)' }}>RSI</span>
                    <span style={{ fontWeight: 600, color: stock.indicators.rsi > 70 ? 'var(--bear)' : stock.indicators.rsi < 30 ? 'var(--bull)' : 'var(--text2)' }}>
                      {stock.indicators.rsi.toFixed(1)}{stock.indicators.rsi > 70 ? ' OB' : stock.indicators.rsi < 30 ? ' OS' : ''}
                    </span>
                  </div>
                )}
                {stock.indicators.atr != null && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
                    <span style={{ fontSize: '9px', color: 'var(--text3)' }}>ATR</span>
                    <span style={{ fontWeight: 600, color: stock.indicators.atrPct != null && stock.indicators.atrPct >= 0.12 ? 'var(--text2)' : 'var(--text3)' }}>
                      ₹{stock.indicators.atr.toFixed(2)} ({stock.indicators.atrPct?.toFixed(2)}%)
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Orderbook signals */}
          <div>
            <div style={{ fontSize: '9px', color: 'var(--text3)', letterSpacing: '0.1em', marginBottom: '6px' }}>ORDERBOOK</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', fontSize: '10px' }}>
              <Pill label="OBI" value={stock.imbalance != null ? `${stock.imbalance >= 0 ? '+' : ''}${stock.imbalance.toFixed(2)}` : '—'}
                color={stock.imbalance >= 0.1 ? 'var(--bull)' : stock.imbalance <= -0.1 ? 'var(--bear)' : 'var(--text3)'} />
              <Pill label="CDZ" value={`${stock.cdZ >= 0 ? '+' : ''}${stock.cdZ?.toFixed(1) ?? '—'}σ`}
                color={stock.cdZ >= 0.5 ? 'var(--bull)' : stock.cdZ <= -0.5 ? 'var(--bear)' : 'var(--text3)'} />
              <Pill label="VEL-Z" value={`${stock.cdVelZ >= 0 ? '+' : ''}${stock.cdVelZ?.toFixed(1) ?? '—'}σ`}
                color={stock.cdVelZ >= 0.5 ? 'var(--bull)' : stock.cdVelZ <= -0.5 ? 'var(--bear)' : 'var(--text3)'} />
              <Pill label="COS" value={stock.cosineBull?.toFixed(2) ?? '—'}
                color={stock.cosineBull > 0.3 ? 'var(--bull)' : stock.cosineBull < -0.3 ? 'var(--bear)' : 'var(--text3)'} />
              {(stock.cusumBull || stock.cusumBear) && (
                <Pill label="CUSUM" value={stock.cusumBull ? '⚡BULL' : '⚡BEAR'}
                  color={stock.cusumBull ? 'var(--bull)' : 'var(--bear)'} />
              )}
            </div>
          </div>

          {/* Volume profile */}
          {(stock.hvn || stock.va) && (
            <div>
              <div style={{ fontSize: '9px', color: 'var(--text3)', letterSpacing: '0.1em', marginBottom: '6px' }}>VOLUME PROFILE</div>
              <div style={{ display: 'flex', gap: '16px', fontSize: '10px', flexWrap: 'wrap' }}>
                {stock.hvn && (
                  <span style={{ color: 'var(--text2)' }}>
                    HVN ₹{stock.hvn.price} <span style={{ color: stock.hvn.dev < 0.3 ? 'var(--mixed)' : 'var(--bull)' }}>{stock.hvn.dev < 0.3 ? '🔒' : '✓'}{stock.hvn.dev.toFixed(2)}%</span>
                  </span>
                )}
                {stock.va && (
                  <span style={{ color: 'var(--text2)' }}>
                    VA [₹{stock.va.low}–₹{stock.va.high}] <span style={{ color: stock.va.inside ? 'var(--mixed)' : 'var(--bull)' }}>{stock.va.inside ? '🔒 inside' : '✓ outside'}</span>
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Pill({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', minWidth: '44px' }}>
      <span style={{ fontSize: '9px', color: 'var(--text3)', letterSpacing: '0.06em' }}>{label}</span>
      <span style={{ fontSize: '11px', fontWeight: 600, color }}>{value}</span>
    </div>
  )
}

// ── N50 Prediction Panel ───────────────────────────────────────────────────

function N50PredictionPanel({ n50 }: { n50: N50State | null }) {
  if (!n50) return (
    <div style={{ padding: '16px', background: 'var(--bg2)', borderRadius: '8px', border: '1px solid var(--border)', textAlign: 'center' }}>
      <span style={{ fontSize: '11px', color: 'var(--text3)' }}>Loading NIFTY 50 model...</span>
    </div>
  )

  const pred = n50.prediction
  const bullPct = Math.round(pred.bullProb * 100)
  const bearPct = Math.round(pred.bearProb * 100)
  const dirColor = pred.direction === 'BULL' ? 'var(--bull)' : pred.direction === 'BEAR' ? 'var(--bear)' : 'var(--text3)'
  const proxySign = n50.niftyProxy >= 0 ? '+' : ''

  return (
    <div style={{
      padding: '16px', background: 'var(--bg2)', borderRadius: '8px',
      border: `1px solid ${pred.status === 'ready' && pred.direction ? dirColor : 'var(--border)'}`,
      display: 'flex', flexDirection: 'column', gap: '12px',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px' }}>
          <span style={{ fontSize: '13px', fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--text)' }}>patN50-60-20</span>
          <span style={{ fontSize: '10px', color: 'var(--text3)' }}>QKV Attention · 60m query → 20m prediction</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '10px', color: 'var(--text3)' }}>{n50.coverageCount}/50 stocks</span>
          <span style={{ fontSize: '10px', color: 'var(--text3)' }}>{n50.minutesAccumulated}m accumulated</span>
        </div>
      </div>

      {pred.status === 'no_data' ? (
        <div style={{ fontSize: '11px', color: 'var(--text3)', padding: '8px 0' }}>
          Accumulating conviction snapshots... Predictions start after ~20 min of market data.
          <br /><span style={{ fontSize: '10px' }}>Snapshots: {n50.snapshotCount} | Patterns: {n50.patternCount} | Resolved: {n50.resolvedCount}</span>
        </div>
      ) : pred.status === 'warming' ? (
        <div style={{ fontSize: '11px', color: 'var(--mixed)', padding: '8px 0' }}>
          Warming up — {n50.resolvedCount}/10 resolved patterns (need 10 minimum).
          <br /><span style={{ fontSize: '10px', color: 'var(--text3)' }}>Snapshots: {n50.snapshotCount} | {n50.minutesAccumulated}m of data</span>
        </div>
      ) : (
        <>
          {/* Prediction row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
            {/* Direction + predicted move */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {pred.direction && (
                <span style={{
                  fontSize: '14px', fontWeight: 700, color: dirColor,
                  padding: '3px 10px', borderRadius: '4px',
                  background: pred.direction === 'BULL' ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
                }}>
                  {pred.direction === 'BULL' ? '▲' : '▼'} {pred.direction}
                </span>
              )}
              <span style={{ fontSize: '16px', fontWeight: 700, color: pred.predictedMove >= 0 ? 'var(--bull)' : 'var(--bear)' }}>
                {pred.predictedMove >= 0 ? '+' : ''}{pred.predictedMove.toFixed(3)}%
              </span>
            </div>

            {/* Bull/Bear probability bar */}
            <div style={{ flex: 1, minWidth: '120px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: '10px', fontWeight: 600, color: 'var(--bull)', width: '30px', textAlign: 'right' }}>{bullPct}%</span>
              <div style={{ flex: 1, height: '6px', background: 'var(--bg3)', borderRadius: '3px', overflow: 'hidden', display: 'flex' }}>
                <div style={{ width: `${bullPct}%`, height: '100%', background: 'var(--bull)', borderRadius: '3px 0 0 3px' }} />
                <div style={{ width: `${bearPct}%`, height: '100%', background: 'var(--bear)', borderRadius: '0 3px 3px 0' }} />
              </div>
              <span style={{ fontSize: '10px', fontWeight: 600, color: 'var(--bear)', width: '30px' }}>{bearPct}%</span>
            </div>
          </div>

          {/* Model stats */}
          <div style={{ display: 'flex', gap: '16px', fontSize: '10px', flexWrap: 'wrap', color: 'var(--text3)' }}>
            <span>sim: <span style={{ color: 'var(--text2)', fontWeight: 600 }}>{pred.topSim.toFixed(3)}</span></span>
            <span>conf: <span style={{ color: 'var(--text2)', fontWeight: 600 }}>{(pred.confidence * 100).toFixed(0)}%</span></span>
            <span>n: <span style={{ color: 'var(--text2)', fontWeight: 600 }}>{pred.nResolved}</span></span>
            <span>proxy: <span style={{ color: n50.niftyProxy >= 0 ? 'var(--bull)' : 'var(--bear)', fontWeight: 600 }}>{proxySign}{n50.niftyProxy.toFixed(3)}%</span></span>
          </div>
        </>
      )}

      {/* Breadth bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={{ fontSize: '9px', color: 'var(--text3)', letterSpacing: '0.05em', width: '50px', flexShrink: 0 }}>BREADTH</span>
        <div style={{ flex: 1, height: '4px', background: 'var(--bg3)', borderRadius: '2px', overflow: 'hidden', display: 'flex' }}>
          <div style={{ width: `${n50.bullStockPct}%`, height: '100%', background: 'var(--bull)' }} />
          <div style={{ width: `${100 - n50.bullStockPct - n50.bearStockPct}%`, height: '100%', background: 'var(--bg3)' }} />
          <div style={{ width: `${n50.bearStockPct}%`, height: '100%', background: 'var(--bear)' }} />
        </div>
        <span style={{ fontSize: '10px', color: 'var(--bull)', fontWeight: 600, width: '28px', textAlign: 'right' }}>{n50.bullStockPct}%</span>
        <span style={{ fontSize: '10px', color: 'var(--bear)', fontWeight: 600, width: '28px' }}>{n50.bearStockPct}%</span>
      </div>
    </div>
  )
}

// ── Styles ───────────────────────────────────────────────────────────────────

const btnStyle: React.CSSProperties = {
  border: '1px solid var(--border)', borderRadius: '4px',
  padding: '4px 10px', fontSize: '11px', fontFamily: 'inherit',
  cursor: 'pointer', letterSpacing: '0.05em', transition: 'all 0.15s',
  background: 'transparent', color: 'var(--text2)', textDecoration: 'none',
  display: 'inline-block',
}

// ── Main ─────────────────────────────────────────────────────────────────────

export default function ConvictionClient() {
  const router = useRouter()
  const [stocks, setStocks] = useState<StockEntry[]>([])
  const [positions, setPositions] = useState<Position[]>([])
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [status, setStatus] = useState<'connecting' | 'live' | 'stale'>('connecting')
  const [filter, setFilter] = useState<'all' | 'strong' | 'partial' | 'positions' | 'nifty50'>('all')
  const [n50, setN50] = useState<N50State | null>(null)
  const esRef = useRef<EventSource | null>(null)

  // Poll N50 predictions when in nifty50 mode
  useEffect(() => {
    if (filter !== 'nifty50') return
    let cancelled = false
    const poll = () => {
      fetch('/api/nifty50').then(r => r.json()).then(data => {
        if (!cancelled) setN50(data)
      }).catch(() => {})
    }
    poll()
    const iv = setInterval(poll, 10_000)
    return () => { cancelled = true; clearInterval(iv); setN50(null) }
  }, [filter])

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
          setUpdatedAt(msg.updatedAt)
          setStatus('live')
        } else if (msg.type === 'prices') {
          setStocks(prev => prev.length === 0 ? prev : prev.map(s => {
            const p = msg.prices[s.name]
            return p ? { ...s, ltp: p.ltp, signal: p.signal, confirmCount: p.confirmCount, cdZ: p.cdZ, trend: p.trend, imbalance: p.imbalance } : s
          }))
          setUpdatedAt(msg.updatedAt)
        }
      }
      es.onerror = () => { setStatus('stale'); es.close(); setTimeout(connect, 5000) }
    }
    connect()
    return () => { esRef.current?.close() }
  }, [])

  const convictions = stocks.map(s => ({ stock: s, conviction: computeConviction(s) }))
  convictions.sort((a, b) => b.conviction.score - a.conviction.score)

  const filtered = convictions.filter(({ stock, conviction }) => {
    if (filter === 'nifty50') return NIFTY50_SET.has(stock.name)
    if (filter === 'strong') return conviction.score >= 0.7
    if (filter === 'partial') return conviction.score >= 0.45
    if (filter === 'positions') return positions.some(p => p.stock === stock.name)
    return true
  })

  const posStocks = positions.map(p => p.stock)
  const posConvictions = convictions.filter(({ stock }) => posStocks.includes(stock.name))

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' })
    router.push('/')
  }

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
          <span style={{ fontSize: '12px', color: 'var(--accent)', letterSpacing: '0.05em', fontWeight: 700 }}>CONVICTION</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <a href="/dashboard" style={btnStyle}>WATCHLIST</a>
          <a href="/dashboard/backtest" style={btnStyle}>BACKTEST</a>
          <a href="/dashboard/live" style={btnStyle}>LIVE</a>
          <ThemeToggle />
          <button onClick={handleLogout} style={{ ...btnStyle, cursor: 'pointer' }}>SIGN OUT</button>
        </div>
      </header>

      {/* Status + filters */}
      <div style={{
        padding: '10px 16px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{
            width: '6px', height: '6px', borderRadius: '50%',
            background: status === 'live' ? 'var(--bull)' : status === 'connecting' ? 'var(--mixed)' : 'var(--bear)',
          }} />
          <span style={{ fontSize: '10px', color: 'var(--text3)' }}>
            {status === 'live' && updatedAt ? `Live · ${new Date(updatedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })} IST` : status}
          </span>
          <span style={{ fontSize: '10px', color: 'var(--text3)' }}>
            {filtered.length} stocks · {convictions.filter(c => c.conviction.score >= 0.7).length} strong
            {filter === 'nifty50' && n50 ? ` · ${n50.coverageCount}/50 covered` : ''}
          </span>
        </div>
        <div style={{ display: 'flex', gap: '4px' }}>
          {(['all', 'nifty50', 'strong', 'partial', 'positions'] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)} style={{
              ...btnStyle, padding: '3px 10px', fontSize: '10px',
              background: filter === f ? (f === 'nifty50' ? 'var(--mixed)' : 'var(--accent)') : 'transparent',
              color: filter === f ? 'var(--bg)' : f === 'nifty50' ? 'var(--mixed)' : 'var(--text3)',
              border: filter === f ? 'none' : `1px solid ${f === 'nifty50' ? 'var(--mixed)' : 'var(--border)'}`,
              fontWeight: f === 'nifty50' ? 700 : undefined,
            }}>
              {f === 'all' ? 'ALL' : f === 'nifty50' ? 'NIFTY 50' : f === 'strong' ? 'STRONG' : f === 'partial' ? '≥ PARTIAL' : 'POSITIONS'}
            </button>
          ))}
        </div>
      </div>

      {/* N50 prediction panel */}
      {filter === 'nifty50' && (
        <div style={{ padding: '12px 16px 0' }}>
          <N50PredictionPanel n50={n50} />
        </div>
      )}

      {/* Positions pinned at top */}
      {posConvictions.length > 0 && filter !== 'positions' && (
        <div style={{ padding: '12px 16px 0', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ fontSize: '9px', color: 'var(--text3)', letterSpacing: '0.1em', fontWeight: 700 }}>OPEN POSITIONS</div>
          {posConvictions.map(({ stock, conviction }) => (
            <ConvictionCard key={stock.name} stock={stock} conviction={conviction} positions={positions} />
          ))}
        </div>
      )}

      {/* Main grid */}
      <div style={{
        padding: '12px 16px', flex: 1,
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(min(380px, 100%), 1fr))',
        gap: '10px',
        alignContent: 'start',
      }}>
        {filtered.length === 0 && (
          <div style={{ gridColumn: '1 / -1', textAlign: 'center', padding: '60px 0', color: 'var(--text3)', fontSize: '12px' }}>
            {status === 'connecting' ? 'Connecting to data stream...' : 'No stocks match this filter'}
          </div>
        )}
        {filtered
          .filter(({ stock }) => filter === 'positions' || !posStocks.includes(stock.name))
          .map(({ stock, conviction }) => (
            <ConvictionCard key={stock.name} stock={stock} conviction={conviction} positions={positions} />
          ))}
      </div>
    </div>
  )
}
