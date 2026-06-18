'use client'
import { useEffect, useState, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import ThemeToggle from '@/components/ThemeToggle'
import type { StockState, Position, CapitalData } from '@/lib/stockState'
import DraggablePanelLayout, { type PanelDef } from '@/components/DraggablePanelLayout'

type StockEntry = StockState & { name: string }

const NIFTY50_SET = new Set([
  'ADANIENT','ADANIPORTS','APOLLOHOSP','ASIANPAINT','AXISBANK',
  'BAJAJ-AUTO','BAJAJFINSV','BAJFINANCE','BEL','BHARTIARTL',
  'CIPLA','COALINDIA','DRREDDY','EICHERMOT','ETERNAL',
  'GRASIM','HCLTECH','HDFCBANK','HDFCLIFE','HINDALCO',
  'HINDUNILVR','ICICIBANK','INDIGO','INFY','ITC',
  'JIOFIN','JSWSTEEL','KOTAKBANK','LT','M&M',
  'MARUTI','MAXHEALTH','NESTLEIND','NTPC','ONGC',
  'POWERGRID','RELIANCE','SBILIFE','SBIN','SHRIRAMFIN',
  'SUNPHARMA','TATACONSUM','TATASTEEL','TCS','TECHM',
  'TITAN','TMPV','TRENT','ULTRACEMCO','WIPRO',
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

interface DayPrediction {
  predictedMove: number
  bullProb: number
  bearProb: number
  topSim: number
  confidence: number
  nResolved: number
  direction: 'BULL' | 'BEAR' | null
  status: 'ready' | 'warming' | 'no_data'
  captureDay: string
  targetDay: string
}

interface DayResolutionLog {
  captureDay: string
  targetDay: string
  predictedMove: number
  predictedDirection: 'BULL' | 'BEAR' | null
  actualProxy20: number
  correct: boolean
  error: number
  resolvedAt: number
}

interface DayPredictionState {
  prediction: DayPrediction | null
  recentLog: DayResolutionLog[]
  patternCount: number
  resolvedCount: number
}

interface NiftyOption {
  tradingsymbol: string
  strike: number
  expiry: string
  instrumentType: 'CE' | 'PE'
}

interface NiftyContracts {
  bull: NiftyOption[]
  bear: NiftyOption[]
  spotEstimate: number
  expiry: string
  lotSize: number
}

interface N50Technicals {
  avgRsi: number | null
  avgAtrPct: number | null
  vwapBullPct: number
  vwapBearPct: number
  emaBullPct: number
  emaBearPct: number
  avgCdZ: number
  cusumBullCount: number
  cusumBearCount: number
  avgImbalance: number
  avgAggRatio: number
  trendBullPct: number
  trendBearPct: number
  stocksWithIndicators: number
  pat60_20: { avgBull: number; avgBear: number; avgMove: number; n: number } | null
}

interface N50Composite {
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

interface SysLogEntry {
  cycleTs: number
  cycleTime: string
  predMove: number
  predDir: 'BULL' | 'BEAR' | null
  predConf: number
  predBullProb: number
  predBearProb: number
  niftySpotAtPred: number
  predSpot: number
  outcomeMove: number | null
  outcomeDir: 'BULL' | 'BEAR' | null
  niftySpotAtOutcome: number | null
  resolved: boolean
  correct: boolean | null
  sessionDay: string
  peakMove?: number | null
  liveMove?: number | null
  liveSpot?: number | null
  targetHit?: boolean
  targetHitTs?: number | null
}

// ── Elliott Wave (client-side types) ──────────────────────────────────────────

interface EWPivotC { ts: number; price: number; type: 'H'|'L'; wave: string; timeStr: string }
interface EWLevelC { price: number; label: string; role: 'support'|'resistance'|'target' }
interface EWState {
  pattern: string; currentWave: string; pivots: EWPivotC[]; levels: EWLevelC[]
  primaryTarget: number|null; invalidation: number|null; confidence: number
  combinedBias: 'STRONG_BULL'|'BULL'|'NEUTRAL'|'BEAR'|'STRONG_BEAR'; combinedNote: string; updatedAt: number
}

interface N50State {
  prediction: N50Prediction
  technicals: N50Technicals
  composite: N50Composite
  snapshotCount: number
  patternCount: number
  resolvedCount: number
  niftyProxy: number
  bullStockPct: number
  bearStockPct: number
  coverageCount: number
  minutesAccumulated: number
  dayPrediction?: DayPredictionState
  contracts?: NiftyContracts
  niftySpot?: number
  sysLog?: SysLogEntry[]
  autoTrader?: ATState
  heavyweights?: { name: string; weight: number; ltp: number; trend: string; cdZ: number; signal: string; vwap: string; pat30v2Bull: number; pat30v2Bear: number }[]
  midweights?: { name: string; weight: number; ltp: number; trend: string; cdZ: number; signal: string; vwap: string; pat30v2Bull: number; pat30v2Bear: number }[]
  lowweights?: { name: string; weight: number; ltp: number; trend: string; cdZ: number; signal: string; vwap: string; pat30v2Bull: number; pat30v2Bear: number }[]
  oiAnalytics?: {
    strikes: Array<{
      strike: number; ceSymbol: string; peSymbol: string
      ceOI: number; peOI: number; ceLtp: number; peLtp: number
      callVol: number; putVol: number; painAtStrike: number
    }>
    maxPainStrike: number; maxPainPull: number; pcr: number
    totalCallOI: number; totalPutOI: number; atmStrike: number
  }
  elliottWave?: EWState | null
  elliottWaveByTF?: Record<string, EWState>
  phaseAnalysis?: {
    phase: 'START' | 'MID' | 'END' | 'UNKNOWN'
    confidence: number
    stabilityLabel: 'STABLE' | 'TRANSITIONING' | 'NOISY'
    featureMaxStd: number
    cdVelRoC: number
    cdVelRoCLabel: 'ACCELERATING' | 'STEADY' | 'DECELERATING'
    obiCdCorr: number
    obiCdPhase: 'HIDDEN' | 'VISIBLE' | 'NEUTRAL'
    knnConsistency: 'ALIGNED' | 'MIXED' | 'INSUFFICIENT'
    knnConsistencyDetail: string
  }
  hero?: {
    armed: boolean
    position: {
      id: string
      direction: 'BULL' | 'BEAR'
      entryTs: number
      entrySpot: number
      legs: Array<{
        label: 'NEAR' | 'MID' | 'FAR'
        symbol: string
        strike: number
        optionType: 'CE' | 'PE'
        lots: number
        entryPremium: number
        currentPremium: number
        peakPremium: number
        tpLow: number; tpMid: number; tpHigh: number
        slTight: number; slMid: number; slWide: number
        status: 'OPEN' | 'EXITED'
        exitTs?: number
        exitPremium?: number
        exitReason?: string
        pnl?: number
      }>
      gtScoreAtEntry: number
      oracleDirAtEntry: 'BULL' | 'BEAR' | null
      oracleConfAtEntry: number
      phaseAtEntry: string
      oraclePredMoveAtEntry: number
      momTier: 'TIGHT' | 'MID' | 'WIDE'
      lastGtScore: number
      totalPnl: number
    } | null
    closedPositions: Array<{
      id: string
      direction: 'BULL' | 'BEAR'
      entryTs: number
      legs: Array<{ label: 'NEAR' | 'MID' | 'FAR'; pnl?: number; exitReason?: string; status: 'OPEN' | 'EXITED' }>
      totalPnl: number
    }>
    log: Array<{
      ts: number
      act: 'ENTRY' | 'EXIT_LEG' | 'EXIT_ALL' | 'HOLD' | 'SKIP' | 'TIER_CHANGE' | 'ERR'
      msg: string
      pnl?: number
      leg?: 'NEAR' | 'MID' | 'FAR'
      dir?: 'BULL' | 'BEAR'
    }>
    stats: { trades: number; wins: number; pnl: number }
    lastTickTs: number
  }
}

interface ConvictionResult {
  score: number
  direction: 'BULL' | 'BEAR' | null
  checks: Check[]
  qualified: boolean
}

interface Check {
  id: string
  label: string
  pass: boolean
  direction: 'BULL' | 'BEAR' | null
  detail: string
}

const MIN_PATTERN_N = 20

interface KalmanBiasState {
  bias: number; P: number; innovVar: number
  correctedMove: number; sigma: number
  nResolved: number; rmse: number; hitRate: number
}
function computeKalmanBias(sysLog: SysLogEntry[], rawPredMove: number): KalmanBiasState | null {
  const resolved = [...sysLog].filter(e => e.resolved && e.outcomeMove != null).sort((a, b) => a.cycleTs - b.cycleTs)
  if (resolved.length < 5) return null
  const Q = 1e-5; let x = 0, P = 0.01, innovVarEMA = 0.04
  const alpha = 0.25; let sumSq = 0, hitCount = 0
  for (const e of resolved) {
    const innov = e.outcomeMove! - e.predMove
    innovVarEMA = alpha * innov * innov + (1 - alpha) * innovVarEMA
    const R = Math.max(innovVarEMA, 1e-5)
    const Ppred = P + Q; const K = Ppred / (Ppred + R)
    x = x + K * (innov - x); P = (1 - K) * Ppred
    sumSq += innov * innov
    if (Math.abs(innov) < 0.3) hitCount++
  }
  const n = resolved.length; const R = Math.max(innovVarEMA, 1e-5)
  return { bias: x, P, innovVar: R, correctedMove: rawPredMove + x, sigma: Math.sqrt(P + R), nResolved: n, rmse: Math.sqrt(sumSq / n), hitRate: hitCount / n }
}

function computeConviction(s: StockState): ConvictionResult {
  const checks: Check[] = []
  let bullPoints = 0, bearPoints = 0, maxPoints = 0

  // 1. Pattern agreement (weight: 3)
  const pats = [s.pat30_5, s.pat60_20, s.pat30v2].filter(Boolean) as NonNullable<typeof s.pat5>[]
  const qualified = pats.some(p => p.n >= MIN_PATTERN_N)
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

  return { score: finalScore, direction: dominant, checks, qualified }
}

function convictionTier(score: number, direction: 'BULL' | 'BEAR' | null): { label: string; color: string; bg: string } {
  if (score >= 0.7) {
    const isBear = direction === 'BEAR'
    return { label: 'STRONG', color: isBear ? 'var(--bear)' : 'var(--bull)', bg: isBear ? 'rgba(239,68,68,0.08)' : 'rgba(34,197,94,0.08)' }
  }
  if (score >= 0.45) return { label: 'PARTIAL', color: 'var(--mixed)', bg: 'rgba(234,179,8,0.06)' }
  return { label: 'WAIT', color: 'var(--text3)', bg: 'transparent' }
}

function PositionCardInline({ pos, conviction, n50, stocks }: { pos: Position; conviction?: ConvictionResult; n50?: N50State | null; stocks?: StockEntry[] }) {
  const [exitStatus, setExitStatus] = useState<{ msg: string; ok: boolean } | null>(null)
  const prevPnlRef = useRef<number | null>(null)
  const [pnlFlash, setPnlFlash] = useState<'up' | 'down' | null>(null)

  useEffect(() => {
    const cur = pos.pnl ?? 0
    if (prevPnlRef.current !== null && cur !== prevPnlRef.current) {
      setPnlFlash(cur > prevPnlRef.current ? 'up' : 'down')
      const t = setTimeout(() => setPnlFlash(null), 800)
      return () => clearTimeout(t)
    }
    prevPnlRef.current = cur
  }, [pos.pnl])

  useEffect(() => { prevPnlRef.current = pos.pnl ?? 0 }, [pos.pnl])

  const predSupports = n50?.composite?.direction === pos.direction
  const profitable = (pos.pnl ?? 0) > 0
  const stockLabel = pos.stock.replace('NSE:', '')
  const spotStock = stocks?.find(s => s.name === stockLabel || s.name === pos.stock.replace('NSE:', ''))
  const isNiftyPos = stockLabel === 'NIFTY' || pos.buySymbol.startsWith('NIFTY')
  const spot = spotStock?.ltp ?? (isNiftyPos ? (n50?.niftySpot ?? null) : null)

  return (
    <div style={{
      marginTop: '8px', padding: '8px 10px', borderRadius: '4px',
      background: (pos.pnl ?? 0) >= 0 ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
      border: `1px solid ${(pos.pnl ?? 0) >= 0 ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}`,
      display: 'flex', flexDirection: 'column', gap: '4px',
    }}>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '12px', fontWeight: 700, color: pos.direction === 'BULL' ? 'var(--bull)' : 'var(--bear)' }}>
          {pos.direction === 'BULL' ? '▲' : '▼'}
        </span>
        <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
          {pos.buySymbol}
        </span>
        <span style={{
          fontSize: '12px', fontWeight: 700,
          color: (pos.pnl ?? 0) >= 0 ? 'var(--bull)' : 'var(--bear)',
          textShadow: pnlFlash === 'up' ? '0 0 8px rgba(34,197,94,0.6)' : pnlFlash === 'down' ? '0 0 8px rgba(239,68,68,0.6)' : 'none',
          transition: 'text-shadow 0.3s',
        }}>
          {(pos.pnl ?? 0) >= 0 ? '+' : ''}₹{pos.pnl?.toLocaleString('en-IN') ?? '—'}
        </span>
        {pos.isExiting && (
          profitable && predSupports
            ? <span style={{ color: 'var(--bull)', fontWeight: 700, fontSize: '9px', letterSpacing: '0.05em' }}>N50 HOLD</span>
            : <span style={{ color: 'var(--bear)', fontWeight: 700, fontSize: '9px' }}>ALERT</span>
        )}
        <PositionExitButton pos={pos} onStatus={(msg, ok) => setExitStatus({ msg, ok })} n50={n50} />
      </div>
      <div style={{ display: 'flex', gap: '10px', fontSize: '11px', flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ color: 'var(--text3)' }}>{stockLabel}{spot ? ` ₹${spot.toFixed(1)}` : ''}</span>
        <span style={{ color: 'var(--text3)' }}>pk ₹{pos.peak.toLocaleString('en-IN')}</span>
        <span style={{ color: 'var(--text3)' }}>₹{pos.buyEntry}→{pos.currentBid != null ? `₹${pos.currentBid}` : '—'}</span>
        <span style={{ color: 'var(--text3)' }}>{pos.lotSize}×{pos.heldMin.toFixed(0)}m</span>
      </div>
      <OptionMetricsDisplay symbol={pos.buySymbol} bid={pos.currentBid} spot={spot} lotSize={pos.lotSize} direction={pos.direction} />
      {n50?.composite?.status === 'ready' && (
        <span style={{
          fontSize: '10px',
          color: n50.composite.direction === 'BULL' ? 'var(--bull)' : n50.composite.direction === 'BEAR' ? 'var(--bear)' : 'var(--text3)',
        }}>
          N50:{n50.composite.direction ?? '—'} {n50.composite.predictedMove >= 0 ? '+' : ''}{n50.composite.predictedMove.toFixed(2)}%
        </span>
      )}
      {conviction && conviction.direction && conviction.direction !== pos.direction && conviction.score >= 0.45 && (
        <span style={{ color: 'var(--bear)', fontWeight: 700, fontSize: '11px' }}>
          conviction flipping {conviction.direction}
        </span>
      )}
      {exitStatus && (
        <span style={{ fontSize: '10px', color: exitStatus.ok ? 'var(--bull)' : 'var(--bear)', width: '100%' }}>
          {exitStatus.msg}
          <button onClick={() => setExitStatus(null)} style={{
            marginLeft: '6px', background: 'none', border: 'none', color: 'inherit',
            cursor: 'pointer', fontSize: '9px', fontFamily: 'inherit',
          }}>dismiss</button>
        </span>
      )}
    </div>
  )
}

// ── ConvictionCard ──────────────────────────────────────────────────────────

function ConvictionCard({ stock, conviction, positions, n50, role = 'admin' }: {
  stock: StockEntry; conviction: ConvictionResult; positions: Position[]; n50?: N50State | null; role?: string
}) {
  const [expanded, setExpanded] = useState(false)
  const tier = convictionTier(conviction.score, conviction.direction)
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

        {/* Open position alert — admin only */}
        {pos && role !== 'viewer' && (
          <PositionCardInline pos={pos} conviction={conviction} n50={n50} stocks={[stock]} />
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
                    {role !== 'viewer' && <span style={{ color: 'var(--text3)' }}>sim:{pat.sim.toFixed(2)} n={pat.n}</span>}
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

// ── Cyberpunk styling helpers ──────────────────────────────────────────────

const CYB = {
  glow: '#00ff9f',
  glowDim: 'rgba(0,255,159,0.15)',
  glowBorder: 'rgba(0,255,159,0.25)',
  redGlow: '#ff003c',
  redDim: 'rgba(255,0,60,0.12)',
  panel: 'rgba(0,255,159,0.03)',
  scanline: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,255,159,0.02) 2px, rgba(0,255,159,0.02) 4px)',
}

// ── Auto-Trader Types (server-managed, display-only on client) ─────────────

interface ATPos { sym: string; dir: 'BULL' | 'BEAR'; entry: number; lot: number; oid: string; ts: number }
interface ATLog { ts: number; act: 'BUY' | 'SELL' | 'HOLD' | 'SKIP' | 'ERR'; sym?: string; dir?: string; price?: number; oid?: string; pnl?: number; msg?: string }
interface ATState {
  mode: 'IDLE' | 'ARMED' | 'LIVE' | 'COOLDOWN'
  lastCycle: number
  cd: number
  pos: ATPos | null
  log: ATLog[]
  stats: { n: number; w: number; pnl: number }
  lastProcessedAt: number
}
const AT_CD_TICKS = 2
const AT_DEFAULT: ATState = { mode: 'IDLE', lastCycle: 0, cd: 0, pos: null, log: [], stats: { n: 0, w: 0, pnl: 0 }, lastProcessedAt: 0 }

function SysHeader({ label, sub, right }: { label: string; sub?: string; right?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
        <span style={{ fontSize: '8px', color: CYB.glow, letterSpacing: '0.15em', opacity: 0.6 }}>{'//SYS'}</span>
        <span style={{ fontSize: '11px', fontWeight: 700, color: CYB.glow, letterSpacing: '0.08em' }}>{label}</span>
        {sub && <span style={{ fontSize: '9px', color: 'var(--text3)' }}>{sub}</span>}
      </div>
      {right}
    </div>
  )
}

function MiniBar({ bull, bear, height = 4 }: { bull: number; bear: number; height?: number }) {
  return (
    <div style={{ flex: 1, height: `${height}px`, background: 'var(--bg3)', borderRadius: `${height / 2}px`, overflow: 'hidden', display: 'flex', minWidth: '40px' }}>
      <div style={{ width: `${bull}%`, height: '100%', background: 'var(--bull)' }} />
      <div style={{ flex: 1 }} />
      <div style={{ width: `${bear}%`, height: '100%', background: 'var(--bear)' }} />
    </div>
  )
}

// ── Signal Row ────────────────────────────────────────────────────────────

function SignalRow({ label, bullPct, bearPct, move, detail, dim }: {
  label: string; bullPct: number; bearPct: number; move?: number; detail?: string; dim?: boolean
}) {
  const moveDir = (move ?? 0) >= 0 ? 'BULL' as const : 'BEAR' as const
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', opacity: dim ? 0.6 : 1 }}>
      <span style={{ fontSize: '8px', color: 'var(--text3)', letterSpacing: '0.1em', width: '48px', flexShrink: 0 }}>{label}</span>
      {move != null && (
        <span style={{
          fontSize: '11px', fontWeight: 700, color: moveDir === 'BULL' ? 'var(--bull)' : 'var(--bear)',
          padding: '1px 6px', borderRadius: '3px',
          background: moveDir === 'BULL' ? 'rgba(34,197,94,0.10)' : 'rgba(239,68,68,0.10)',
          minWidth: '62px', textAlign: 'center',
        }}>
          {moveDir === 'BULL' ? '▲' : '▼'} {move >= 0 ? '+' : ''}{move.toFixed(3)}%
        </span>
      )}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '3px', minWidth: '60px' }}>
        <span style={{ fontSize: '8px', fontWeight: 600, color: 'var(--bull)', width: '20px', textAlign: 'right' }}>{bullPct}</span>
        <MiniBar bull={bullPct} bear={bearPct} height={4} />
        <span style={{ fontSize: '8px', fontWeight: 600, color: 'var(--bear)', width: '20px' }}>{bearPct}</span>
      </div>
      {detail && <span style={{ fontSize: '8px', color: 'var(--text3)' }}>{detail}</span>}
    </div>
  )
}

// ── N50 Option Chain OI Panel ────────────────────────────────────────────────

function N50ChainPanel({ n50 }: { n50: N50State }) {
  const [showMenu, setShowMenu] = useState(false)
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 })
  const [showModal, setShowModal] = useState(false)
  const oi = n50.oiAnalytics
  if (!oi) return null

  const spot = n50.niftySpot ?? n50.niftyProxy ?? 0
  const maxOI = Math.max(...oi.strikes.map(s => Math.max(s.ceOI, s.peOI)), 1)
  const pcrBull = oi.pcr > 1.3
  const pcrBear = oi.pcr < 0.7
  const pcrColor = pcrBull ? 'var(--bull)' : pcrBear ? 'var(--bear)' : 'var(--text3)'
  const pcrLabel = pcrBull ? 'BULL hedges' : pcrBear ? 'BEAR complacency' : 'neutral'

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    setMenuPos({ x: e.clientX, y: e.clientY })
    setShowMenu(true)
  }

  return (
    <>
      <div
        onContextMenu={handleContextMenu}
        style={{ padding: '8px 10px', background: CYB.panel, borderRadius: '6px', border: `1px solid ${CYB.glowBorder}`, display: 'flex', flexDirection: 'column', gap: '6px', cursor: 'context-menu' }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '8px', fontWeight: 700, color: CYB.glow, letterSpacing: '0.15em' }}>{'//OI_CHAIN'}</span>
          <span style={{ fontSize: '9px', color: 'var(--text3)' }}>ATM ₹{oi.atmStrike}</span>
          <span style={{ fontSize: '9px', fontWeight: 700, color: pcrColor }}>PCR {oi.pcr.toFixed(2)} {pcrLabel}</span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: '9px', color: 'var(--mixed)', fontWeight: 700 }}>MAX PAIN ₹{oi.maxPainStrike} ({oi.maxPainPull}%↑)</span>
        </div>

        {/* OI Table */}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '10px', minWidth: '480px' }}>
            <thead>
              <tr style={{ color: 'var(--text3)', fontSize: '8px', letterSpacing: '0.06em' }}>
                <td style={{ padding: '2px 6px', textAlign: 'right' }}>CE OI</td>
                <td style={{ padding: '2px 6px', textAlign: 'right' }}>CE LTP</td>
                <td style={{ padding: '2px 6px', textAlign: 'center', fontWeight: 700 }}>STRIKE</td>
                <td style={{ padding: '2px 6px', textAlign: 'left' }}>PE LTP</td>
                <td style={{ padding: '2px 6px', textAlign: 'left' }}>PE OI</td>
              </tr>
            </thead>
            <tbody>
              {oi.strikes.map(s => {
                const isATM = s.strike === oi.atmStrike
                const isMaxPain = s.strike === oi.maxPainStrike
                const ceBarW = Math.round((s.ceOI / maxOI) * 60)
                const peBarW = Math.round((s.peOI / maxOI) * 60)
                const rowBg = isMaxPain ? 'rgba(234,179,8,0.08)' : isATM ? 'rgba(0,255,159,0.05)' : 'transparent'
                const strikeFontColor = isMaxPain ? 'var(--mixed)' : isATM ? CYB.glow : 'var(--text)'
                const ceColor = s.ceOI > s.peOI ? 'var(--bear)' : 'var(--text3)'
                const peColor = s.peOI > s.ceOI ? 'var(--bull)' : 'var(--text3)'
                return (
                  <tr key={s.strike} style={{ background: rowBg }}>
                    <td style={{ padding: '2px 6px', textAlign: 'right' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px' }}>
                        <span style={{ color: ceColor, fontSize: '9px' }}>{(s.ceOI / 1000).toFixed(0)}K</span>
                        <div style={{ width: `${ceBarW}px`, height: '6px', background: 'rgba(239,68,68,0.4)', borderRadius: '2px', minWidth: '2px' }} />
                      </div>
                    </td>
                    <td style={{ padding: '2px 6px', textAlign: 'right', color: 'var(--bear)', fontSize: '9px' }}>₹{s.ceLtp.toFixed(1)}</td>
                    <td style={{ padding: '2px 6px', textAlign: 'center', fontWeight: 700, color: strikeFontColor, fontSize: '10px' }}>
                      {isMaxPain ? '🎯' : ''}{s.strike}{isATM ? ' ◉' : ''}
                    </td>
                    <td style={{ padding: '2px 6px', textAlign: 'left', color: 'var(--bull)', fontSize: '9px' }}>₹{s.peLtp.toFixed(1)}</td>
                    <td style={{ padding: '2px 6px', textAlign: 'left' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <div style={{ width: `${peBarW}px`, height: '6px', background: 'rgba(34,197,94,0.4)', borderRadius: '2px', minWidth: '2px' }} />
                        <span style={{ color: peColor, fontSize: '9px' }}>{(s.peOI / 1000).toFixed(0)}K</span>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', gap: '12px', fontSize: '8px', color: 'var(--text3)', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '4px' }}>
          <span>Total CE OI: <span style={{ color: 'var(--bear)' }}>{(oi.totalCallOI / 100000).toFixed(1)}L</span></span>
          <span>Total PE OI: <span style={{ color: 'var(--bull)' }}>{(oi.totalPutOI / 100000).toFixed(1)}L</span></span>
          <span style={{ opacity: 0.5 }}>right-click for explanation</span>
        </div>
      </div>

      {/* Context menu */}
      {showMenu && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 7999 }} onClick={() => setShowMenu(false)}>
          <div style={{
            position: 'fixed', left: menuPos.x, top: menuPos.y, zIndex: 8000,
            background: 'var(--bg)', border: `1px solid ${CYB.glowBorder}`,
            borderRadius: '6px', padding: '4px', minWidth: '160px', boxShadow: '0 4px 20px rgba(0,0,0,0.6)',
          }} onClick={e => e.stopPropagation()}>
            <button
              style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: '5px 12px', fontSize: '11px', color: 'var(--text)', borderRadius: '3px' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.08)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'none')}
              onClick={() => { setShowModal(true); setShowMenu(false) }}
            >
              📖 Explain this analysis
            </button>
          </div>
        </div>
      )}

      {/* Explanation modal */}
      {showModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(0,0,0,0.82)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '12px' }}
          onClick={e => { if (e.target === e.currentTarget) setShowModal(false) }}>
          <div style={{ background: 'var(--bg)', border: `1px solid ${CYB.glowBorder}`, borderRadius: '10px', maxWidth: '560px', width: '100%', maxHeight: '88vh', overflowY: 'auto', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: '8px', fontWeight: 700, color: CYB.glow, letterSpacing: '0.15em', marginBottom: '4px' }}>{'//OI_CHAIN  ·  EXPLANATION'}</div>
                <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text)' }}>Option Chain OI Analysis</div>
              </div>
              <button style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '5px', color: 'var(--text2)', cursor: 'pointer', fontSize: '11px', padding: '3px 10px' }} onClick={() => setShowModal(false)}>✕ close</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '11px', color: 'var(--text2)', lineHeight: 1.6 }}>
              <div>
                <div style={{ fontSize: '9px', fontWeight: 700, color: CYB.glow, letterSpacing: '0.12em', marginBottom: '4px' }}>MAX PAIN (Nash Equilibrium)</div>
                <p>Max Pain is the strike price at which total losses to option writers are minimized. Because option writers (typically institutions/market makers) hold far more premium than buyers, there is a structural gravity toward this price near expiry. It acts as a Nash Equilibrium: each writer's position exerts force pulling price toward max pain. With current max pain at ₹{oi.maxPainStrike} (pull strength {oi.maxPainPull}%), there is a {oi.maxPainPull}% steeper pain gradient at adjacent strikes vs the minimum — the stronger this number, the greater the magnetic pull.</p>
              </div>
              <div>
                <div style={{ fontSize: '9px', fontWeight: 700, color: CYB.glow, letterSpacing: '0.12em', marginBottom: '4px' }}>PUT/CALL RATIO (PCR = {oi.pcr.toFixed(2)})</div>
                <p>PCR = Total Put OI / Total Call OI. Interpretation (contrarian): high PCR (&gt;1.3) means more put buying = fear/hedging = markets often reverse up (sellers are hedged, bounce likely). Low PCR (&lt;0.7) means complacency = markets often fall. Neutral range (0.7–1.3) = balanced positioning, take direction from microstructure signals.</p>
              </div>
              <div>
                <div style={{ fontSize: '9px', fontWeight: 700, color: CYB.glow, letterSpacing: '0.12em', marginBottom: '4px' }}>OI WALLS AS SCHELLING FOCAL POINTS</div>
                <p>Large OI at a strike creates a Schelling Point — a level that participants naturally focus on without coordination. Writers who sold calls at ₹X will defend that level by delta-hedging (buying the underlying as price approaches). Writers who sold puts at ₹Y will defend that level by selling the underlying as price approaches. This creates two-way attraction that forms range-bound behavior and makes breakouts more meaningful when they occur.</p>
              </div>
              <div>
                <div style={{ fontSize: '9px', fontWeight: 700, color: CYB.glow, letterSpacing: '0.12em', marginBottom: '4px' }}>HOW TO READ THE CHAIN</div>
                <p>1. Find ATM (◉): this is where the most theta decay and gamma risk lives. 2. Find max pain (🎯): likely gravitational target before expiry. 3. Look for the largest OI walls: these act as resistance (call OI) and support (put OI). 4. Spot divergence: if call OI far exceeds put OI at and above ATM, writers are positioned for downside protection — follow their delta-hedging. 5. Combine with PCR for direction bias.</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// ── N50 Game Theory Panel (admin only) ──────────────────────────────────────

interface N50GTAnalysis {
  maxPainStrike: number | null
  maxPainDir: 'BULL' | 'BEAR' | 'NEUTRAL' | null
  maxPainDistPct: number | null
  maxPainPull: number
  pcr: number | null
  pcrSignal: 'BULL' | 'BEAR' | 'NEUTRAL' | null
  pcrInterp: string
  callWallStrike: number | null
  callWallOI: number
  putWallStrike: number | null
  putWallOI: number
  wallPosition: 'ABOVE_RESISTANCE' | 'BELOW_SUPPORT' | 'IN_RANGE' | null
  wallRangeUsed: number
  regime: 'ACCUMULATION' | 'MARKUP' | 'DISTRIBUTION' | 'MARKDOWN' | 'CHOP' | 'UNKNOWN'
  oracleAlignment: 'ALIGNED' | 'DIVERGING' | 'NEUTRAL' | null
  microDir: 'BULL' | 'BEAR' | 'NEUTRAL'
  gtScore: number
  gtDirection: 'BULL' | 'BEAR' | 'NEUTRAL'
  gtConviction: 'HIGH' | 'MEDIUM' | 'LOW'
  components: { mpC: number; pcrC: number; schC: number; orcC: number; microC: number }
  // Per-component directional verdicts for checklist (1=agree, 0=neutral, -1=diverge)
  checks: { mp: number; pcr: number; sch: number; orc: number; micro: number }
  agreementCount: number  // how many of 5 signals agree with gt direction
  divergeCount: number
  oracleTarget: number | null
  oracleTargetPct: number | null
  nashTarget: number | null
  nashTargetPct: number | null
  gtTarget: number | null
  gtTargetPct: number | null
  setupLabel: 'PERFECT' | 'STRONG' | 'PARTIAL' | 'WEAK' | 'CONFLICTED'
}

function computeN50GT(n50: N50State): N50GTAnalysis {
  const comp = n50.composite
  const tech = n50.technicals
  const oi = n50.oiAnalytics
  const spot = n50.niftySpot ?? 0

  // ── 1. Max Pain (Nash Equilibrium gravity) ────────────────────────────────
  const mpStrike = oi?.maxPainStrike ?? null
  const mpPull   = oi?.maxPainPull   ?? 0
  let mpDir: N50GTAnalysis['maxPainDir'] = null
  let mpDistPct: number | null = null
  let mpC = 0
  if (mpStrike != null && spot > 0) {
    mpDistPct = (mpStrike - spot) / spot * 100
    mpDir = mpDistPct > 0.15 ? 'BULL' : mpDistPct < -0.15 ? 'BEAR' : 'NEUTRAL'
    const pullNorm = Math.min(1, mpPull / 30)
    mpC = Math.max(-1, Math.min(1, (mpDistPct / 1.5) * pullNorm))
  }

  // ── 2. PCR (Kyle costly signal) ──────────────────────────────────────────
  const pcr = oi?.pcr ?? null
  let pcrSignal: N50GTAnalysis['pcrSignal'] = null
  let pcrInterp = ''
  let pcrC = 0
  if (pcr != null) {
    if (pcr >= 1.5)      { pcrSignal = 'BEAR'; pcrInterp = 'Heavy put buying — bears paying real premium (costly signal)'; pcrC = -Math.min(1, (pcr - 1) * 0.7) }
    else if (pcr >= 1.2) { pcrSignal = 'BEAR'; pcrInterp = 'Moderate put bias — downside hedging elevated'; pcrC = -0.35 }
    else if (pcr <= 0.6) { pcrSignal = 'BULL'; pcrInterp = 'Heavy call buying — bulls paying real premium (costly signal)'; pcrC = Math.min(1, (1 - pcr) * 0.7) }
    else if (pcr <= 0.8) { pcrSignal = 'BULL'; pcrInterp = 'Moderate call bias — upside speculation elevated'; pcrC = 0.35 }
    else                 { pcrSignal = 'NEUTRAL'; pcrInterp = 'Balanced options market — no informed directional bias' }
  }

  // ── 3. Schelling Focal Points (max-OI walls as coordination anchors) ──────
  const strikes = oi?.strikes ?? []
  let callWallStrike: number | null = null; let callWallOI = 0
  let putWallStrike:  number | null = null; let putWallOI  = 0
  let wallPosition: N50GTAnalysis['wallPosition'] = null
  let wallRangeUsed = 0.5
  let schC = 0
  if (strikes.length > 0 && spot > 0) {
    const maxCall = strikes.reduce((b, s) => s.ceOI > b.ceOI ? s : b)
    const maxPut  = strikes.reduce((b, s) => s.peOI > b.peOI ? s : b)
    callWallStrike = maxCall.strike; callWallOI = maxCall.ceOI
    putWallStrike  = maxPut.strike;  putWallOI  = maxPut.peOI
    if (spot > callWallStrike) {
      wallPosition = 'ABOVE_RESISTANCE'; wallRangeUsed = 1; schC = 0.8
    } else if (spot < putWallStrike) {
      wallPosition = 'BELOW_SUPPORT'; wallRangeUsed = 0; schC = -0.8
    } else {
      wallPosition = 'IN_RANGE'
      const rangeW = callWallStrike - putWallStrike || 1
      wallRangeUsed = (spot - putWallStrike) / rangeW
      schC = (wallRangeUsed - 0.5) * -0.6
    }
  }

  // ── 4. Regime from N50 microstructure ─────────────────────────────────────
  const avgCdZ = tech.avgCdZ
  const avgImb = tech.avgImbalance
  let regime: N50GTAnalysis['regime']
  if      (avgCdZ > 0.5 && avgImb < 0.1)  regime = 'ACCUMULATION'
  else if (avgCdZ > 0.5 && avgImb >= 0.1) regime = 'MARKUP'
  else if (avgCdZ < -0.5 && avgImb > -0.1) regime = 'DISTRIBUTION'
  else if (avgCdZ < -0.5 && avgImb <= -0.1) regime = 'MARKDOWN'
  else if (Math.abs(avgCdZ) < 0.3)         regime = 'CHOP'
  else                                      regime = 'UNKNOWN'
  const regimeMult = regime === 'CHOP' ? 0.5 : 1.0

  // ── 5. Oracle contribution ────────────────────────────────────────────────
  const orcC = comp.direction === 'BULL'
    ? comp.confidence
    : comp.direction === 'BEAR' ? -comp.confidence : 0

  // ── 6. Microstructure (N50-specific: CD Z-score + CUSUM) ─────────────────
  // This is the improvement over crude: direct access to order-flow data
  const cdNorm = Math.max(-1, Math.min(1, avgCdZ / 3))
  const cusumTotal = tech.cusumBullCount + tech.cusumBearCount
  const cusumNorm = cusumTotal > 0
    ? (tech.cusumBullCount - tech.cusumBearCount) / cusumTotal : 0
  const microC = (cdNorm + cusumNorm) / 2
  const microDir: N50GTAnalysis['microDir'] =
    microC > 0.15 ? 'BULL' : microC < -0.15 ? 'BEAR' : 'NEUTRAL'

  // ── 7. Weighted GT score ──────────────────────────────────────────────────
  // Weights sum to 1.0: microstructure (0.20) replaces part of oracle weight vs crude
  const w = { mp: 0.20, pcr: 0.20, sch: 0.15, orc: 0.25, micro: 0.20 }
  const gtScore = regimeMult * (w.mp * mpC + w.pcr * pcrC + w.sch * schC)
    + w.orc * orcC + w.micro * microC
  const clamped = Math.max(-1, Math.min(1, gtScore))
  const gtDirection: N50GTAnalysis['gtDirection'] =
    clamped > 0.15 ? 'BULL' : clamped < -0.15 ? 'BEAR' : 'NEUTRAL'
  const absScore = Math.abs(clamped)
  const gtConviction: N50GTAnalysis['gtConviction'] =
    absScore > 0.5 ? 'HIGH' : absScore > 0.25 ? 'MEDIUM' : 'LOW'

  const oracleAlignment: N50GTAnalysis['oracleAlignment'] =
    comp.direction == null ? null :
    comp.direction === gtDirection ? 'ALIGNED' :
    gtDirection === 'NEUTRAL' ? 'NEUTRAL' : 'DIVERGING'

  // ── 8. Price prediction ───────────────────────────────────────────────────
  const oracleTarget = spot > 0 && comp.predictedMove != null
    ? spot * (1 + comp.predictedMove / 100) : null
  const oracleTargetPct = oracleTarget != null ? comp.predictedMove : null
  const nashTarget = mpStrike ?? null
  const nashTargetPct = (nashTarget != null && spot > 0) ? (nashTarget - spot) / spot * 100 : null

  let gtTarget: number | null = null
  let gtTargetPct: number | null = null
  if (spot > 0 && gtDirection !== 'NEUTRAL') {
    const isBull = gtDirection === 'BULL'
    const orcW = (isBull ? orcC > 0 : orcC < 0) ? Math.abs(orcC) : 0
    const mpW  = (isBull ? mpC  > 0 : mpC  < 0) ? Math.abs(mpC)  : 0
    const total = orcW + mpW
    if (total > 0 && oracleTarget != null && nashTarget != null) {
      gtTarget = (oracleTarget * orcW + nashTarget * mpW) / total
    } else if (orcW > 0 && oracleTarget != null) {
      gtTarget = oracleTarget
    } else if (mpW > 0 && nashTarget != null) {
      gtTarget = nashTarget
    }
    if (gtTarget != null) {
      gtTargetPct = (gtTarget - spot) / spot * 100
      if ((isBull && gtTargetPct <= 0) || (!isBull && gtTargetPct >= 0)) {
        gtTarget = null
        gtTargetPct = null
      }
    }
  }

  // Per-component agree/neutral/diverge vs gt direction
  const dirSign = gtDirection === 'BULL' ? 1 : gtDirection === 'BEAR' ? -1 : 0
  function checkSign(val: number): number {
    if (dirSign === 0) return 0
    if (val * dirSign > 0.05) return 1
    if (val * dirSign < -0.05) return -1
    return 0
  }
  const checks = {
    mp: mpStrike != null ? checkSign(mpC) : 0,
    pcr: pcr != null ? checkSign(pcrC) : 0,
    sch: wallPosition != null ? (wallPosition === 'IN_RANGE' ? 0 : checkSign(schC)) : 0,
    orc: checkSign(orcC),
    micro: checkSign(microC),
  }
  const agreementCount = Object.values(checks).filter(v => v === 1).length
  const divergeCount = Object.values(checks).filter(v => v === -1).length
  const setupLabel: N50GTAnalysis['setupLabel'] =
    gtDirection === 'NEUTRAL' ? 'CONFLICTED' :
    agreementCount >= 5 ? 'PERFECT' :
    agreementCount >= 4 ? 'STRONG' :
    agreementCount >= 3 ? 'PARTIAL' : 'WEAK'

  return {
    maxPainStrike: mpStrike, maxPainDir: mpDir, maxPainDistPct: mpDistPct, maxPainPull: mpPull,
    pcr, pcrSignal, pcrInterp,
    callWallStrike, callWallOI, putWallStrike, putWallOI, wallPosition, wallRangeUsed,
    regime, oracleAlignment, microDir,
    gtScore: clamped, gtDirection, gtConviction,
    components: { mpC, pcrC, schC, orcC, microC },
    checks, agreementCount, divergeCount,
    oracleTarget, oracleTargetPct, nashTarget, nashTargetPct, gtTarget, gtTargetPct,
    setupLabel,
  }
}

function N50GTExplanationModal({ gt, n50, onClose }: { gt: N50GTAnalysis; n50: N50State; onClose: () => void }) {
  const spot = n50.niftySpot ?? 0
  const gtColor = gt.gtDirection === 'BULL' ? 'var(--bull)' : gt.gtDirection === 'BEAR' ? 'var(--bear)' : 'var(--text3)'
  const convColor = gt.gtConviction === 'HIGH' ? '#eab308' : gt.gtConviction === 'MEDIUM' ? 'var(--text2)' : 'var(--text3)'
  const regimeEmoji: Record<string, string> = { ACCUMULATION: '📦', MARKUP: '🚀', DISTRIBUTION: '📤', MARKDOWN: '📉', CHOP: '〰️', UNKNOWN: '❓' }
  const S: Record<string, React.CSSProperties> = {
    overlay: { position: 'fixed', inset: 0, zIndex: 9500, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '12px' },
    modal: { background: 'var(--bg)', border: `1px solid ${CYB.glowBorder}`, borderRadius: '10px', maxWidth: '600px', width: '100%', maxHeight: '90vh', overflowY: 'auto', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '14px' },
    sec: { display: 'flex', flexDirection: 'column', gap: '5px', paddingBottom: '12px', borderBottom: '1px solid rgba(255,255,255,0.05)' },
    secTitle: { fontSize: '9px', fontWeight: 700, color: CYB.glow, letterSpacing: '0.12em', marginBottom: '2px' } as React.CSSProperties,
    body: { fontSize: '11px', color: 'var(--text2)', lineHeight: 1.6 } as React.CSSProperties,
    row: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' } as React.CSSProperties,
    closeBtn: { background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '5px', color: 'var(--text2)', cursor: 'pointer', fontSize: '11px', padding: '3px 10px', flexShrink: 0 } as React.CSSProperties,
  }
  const chip = (c: string): React.CSSProperties => ({ display: 'inline-block', fontSize: '9px', padding: '2px 6px', borderRadius: '3px', fontWeight: 700, background: `${c}22`, border: `1px solid ${c}44`, color: c })
  const compBar = (label: string, val: number, weight: number) => {
    const c = val > 0 ? 'var(--bull)' : val < 0 ? 'var(--bear)' : 'var(--text3)'
    const contrib = val * weight
    return (
      <div key={label} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '10px' }}>
        <span style={{ width: '80px', color: 'var(--text3)', textAlign: 'right' }}>{label}</span>
        <div style={{ position: 'relative', width: '120px', height: '8px', background: 'rgba(255,255,255,0.06)', borderRadius: '4px' }}>
          <div style={{ position: 'absolute', top: 0, height: '100%', width: `${Math.abs(val) * 60}px`, [val >= 0 ? 'left' : 'right']: '50%', background: c, borderRadius: '4px', maxWidth: '50%' }} />
          <div style={{ position: 'absolute', top: 0, left: '50%', width: '1px', height: '100%', background: 'rgba(255,255,255,0.2)' }} />
        </div>
        <span style={{ color: c, fontWeight: 700, minWidth: '40px' }}>{val >= 0 ? '+' : ''}{val.toFixed(2)}</span>
        <span style={{ color: 'var(--text3)' }}>×{weight}</span>
        <span style={{ color: contrib > 0 ? 'var(--bull)' : contrib < 0 ? 'var(--bear)' : 'var(--text3)', fontWeight: 700 }}>= {contrib >= 0 ? '+' : ''}{contrib.toFixed(3)}</span>
      </div>
    )
  }

  return (
    <div style={S.overlay} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={S.modal}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: '8px', fontWeight: 700, color: CYB.glow, letterSpacing: '0.15em' }}>{'//GT_ENGINE  ·  NIFTY 50  ·  EXPLANATION'}</div>
            <div style={{ fontSize: '14px', fontWeight: 900, color: gtColor, marginTop: '4px' }}>{gt.gtDirection} — {gt.gtConviction} CONVICTION</div>
            <div style={{ fontSize: '10px', color: 'var(--text3)', marginTop: '2px' }}>
              spot ₹{spot.toFixed(0)}  ·  GT score: {gt.gtScore >= 0 ? '+' : ''}{gt.gtScore.toFixed(3)}  ·  regime: {regimeEmoji[gt.regime]} {gt.regime}
            </div>
          </div>
          <button style={S.closeBtn} onClick={onClose}>✕ close</button>
        </div>

        <div style={S.sec}>
          <div style={S.secTitle}>WHAT IS GT ENGINE?</div>
          <div style={S.body}>Five game-theoretic signals synthesised into one conviction score −1..+1. Unlike the Oracle (statistical pattern memory), GT measures whether the current moment has institutional fingerprints across five independent dimensions. N50 adds a microstructure layer (CD + CUSUM) unavailable in commodity markets.</div>
        </div>

        <div style={S.sec}>
          <div style={S.secTitle}>① MAX PAIN — NASH EQUILIBRIUM (weight 20%)</div>
          <div style={S.row}>
            <span style={{ fontSize: '12px', fontWeight: 700, color: gt.maxPainDir === 'BULL' ? 'var(--bull)' : gt.maxPainDir === 'BEAR' ? 'var(--bear)' : 'var(--text3)' }}>{gt.maxPainDir ?? 'NO DATA'}</span>
            {gt.maxPainStrike != null && <span style={{ fontSize: '10px', color: 'var(--text2)' }}>₹{gt.maxPainStrike.toFixed(0)} ({gt.maxPainDistPct != null ? `spot ${gt.maxPainDistPct > 0 ? '+' : ''}${gt.maxPainDistPct.toFixed(2)}% away` : '—'})</span>}
            {gt.maxPainPull > 0 && <span style={chip(gt.maxPainPull >= 15 ? '#eab308' : 'var(--text3)')}>pull:{gt.maxPainPull.toFixed(1)}%</span>}
          </div>
          <div style={S.body}>The strike price where option writers collectively lose the least. Every writer delta-hedges toward this level — not by conspiracy but because it is the Nash Equilibrium of the hedging game. Pull % measures the steepness of the pain gradient at adjacent strikes — higher pull = stronger gravitational force.</div>
          {gt.maxPainStrike == null && <div style={{ fontSize: '10px', color: 'var(--text3)', fontStyle: 'italic' }}>OI chain data not yet loaded</div>}
        </div>

        <div style={S.sec}>
          <div style={S.secTitle}>② PCR — KYLE COSTLY SIGNAL (weight 20%)</div>
          <div style={S.row}>
            <span style={{ fontSize: '12px', fontWeight: 700, color: gt.pcrSignal === 'BULL' ? 'var(--bull)' : gt.pcrSignal === 'BEAR' ? 'var(--bear)' : 'var(--text3)' }}>{gt.pcrSignal ?? 'NO DATA'}</span>
            {gt.pcr != null && <span style={{ fontSize: '10px', color: 'var(--text2)' }}>PCR: {gt.pcr.toFixed(2)}</span>}
          </div>
          <div style={S.body}>{gt.pcrInterp || 'No PCR data available.'} Buying a put/call requires paying real premium that is lost if wrong — a costly signal in the Kyle (1985) sense. High PCR (≥1.2) = money committed to downside = informed bearish hedging. Contrast with the order book where walls are free to place and pull.</div>
        </div>

        <div style={S.sec}>
          <div style={S.secTitle}>③ SCHELLING FOCAL POINTS — OI WALLS (weight 15%)</div>
          {gt.callWallStrike != null && gt.putWallStrike != null ? (
            <>
              <div style={S.row}>
                <span style={chip('var(--bear)')}>CALL WALL ₹{gt.callWallStrike.toFixed(0)}</span>
                <span style={{ fontSize: '10px', color: 'var(--text3)' }}>{(gt.callWallOI / 1000).toFixed(0)}K OI — resistance ceiling</span>
              </div>
              <div style={S.row}>
                <span style={chip('var(--bull)')}>PUT WALL ₹{gt.putWallStrike.toFixed(0)}</span>
                <span style={{ fontSize: '10px', color: 'var(--text3)' }}>{(gt.putWallOI / 1000).toFixed(0)}K OI — support floor</span>
              </div>
              <div style={{ marginTop: '4px', fontSize: '10px', color: gt.wallPosition === 'ABOVE_RESISTANCE' ? 'var(--bull)' : gt.wallPosition === 'BELOW_SUPPORT' ? 'var(--bear)' : 'var(--text3)' }}>
                Spot ₹{spot.toFixed(0)}: {gt.wallPosition === 'ABOVE_RESISTANCE' ? '↑ ABOVE resistance — bullish breakout' : gt.wallPosition === 'BELOW_SUPPORT' ? '↓ BELOW support — bearish breakdown' : `IN RANGE (${(gt.wallRangeUsed * 100).toFixed(0)}% used from put wall)`}
              </div>
            </>
          ) : <div style={{ fontSize: '10px', color: 'var(--text3)', fontStyle: 'italic' }}>OI chain data not yet loaded</div>}
          <div style={S.body}>Strikes with large OI become Schelling Points — natural coordination anchors. Call wall writers delta-hedge above (suppress price). Put wall writers defend below (support price). Breaking a wall triggers cascade exits from the losing side.</div>
        </div>

        <div style={S.sec}>
          <div style={S.secTitle}>④ ORACLE (weight 25%)</div>
          <div style={S.body}>The Oracle is the softmax kNN pattern memory (N={n50.snapshotCount} snapshots). It is statistically independent of the three OI signals above. When all four components agree in direction, GT score approaches ±1. Oracle divergence pulls the score toward NEUTRAL.</div>
        </div>

        <div style={S.sec}>
          <div style={S.secTitle}>⑤ MICROSTRUCTURE — CD + CUSUM (weight 20%, N50-specific)</div>
          <div style={S.row}>
            <span style={{ fontSize: '12px', fontWeight: 700, color: gt.microDir === 'BULL' ? 'var(--bull)' : gt.microDir === 'BEAR' ? 'var(--bear)' : 'var(--text3)' }}>{gt.microDir}</span>
            <span style={{ fontSize: '10px', color: 'var(--text2)' }}>avgCdZ: {n50.technicals.avgCdZ.toFixed(2)}σ  ·  CUSUM B:{n50.technicals.cusumBullCount} / Bear:{n50.technicals.cusumBearCount}</span>
          </div>
          <div style={S.body}>Live order-flow data unavailable in commodity GT panels — this is the N50 improvement. Cumulative Delta Z-score measures net buy/sell pressure from actual trade prints (unfakeable). CUSUM detects sustained regime shifts rather than single noisy ticks. Together they confirm whether institutions are actively positioned in the GT direction.</div>
        </div>

        <div style={S.sec}>
          <div style={S.secTitle}>⑥ REGIME: {regimeEmoji[gt.regime]} {gt.regime} (multiplier applied)</div>
          <div style={S.body}>
            {gt.regime === 'ACCUMULATION' && 'CD positive but book not yet bullish — institution buying in stealth. Follow CD, not OBI. CHOP multiplier = 1.0.'}
            {gt.regime === 'MARKUP' && 'CD positive AND book bullish — momentum phase. Institution done hiding, now running price. Full conviction.'}
            {gt.regime === 'DISTRIBUTION' && 'CD negative but book not yet bearish — institution selling quietly. Follow CD over displayed walls.'}
            {gt.regime === 'MARKDOWN' && 'CD negative AND book bearish — visible selling phase. High conviction BEAR.'}
            {gt.regime === 'CHOP' && 'No dominant player. CD weak, book noisy. OI signals halved (0.5× multiplier) — only microstructure and oracle count at full weight.'}
            {gt.regime === 'UNKNOWN' && 'Intermediate state — CD and OBI partially conflicting. Both directions carry uncertainty.'}
          </div>
        </div>

        <div style={{ ...S.sec, borderBottom: 'none', paddingBottom: 0 }}>
          <div style={S.secTitle}>COMPONENT BREAKDOWN</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '4px' }}>
            {compBar('Max Pain',    gt.components.mpC,    0.20)}
            {compBar('PCR',        gt.components.pcrC,   0.20)}
            {compBar('OI Walls',   gt.components.schC,   0.15)}
            {compBar('Oracle',     gt.components.orcC,   0.25)}
            {compBar('Micro CD+C', gt.components.microC, 0.20)}
          </div>
          <div style={{ marginTop: '10px', display: 'flex', alignItems: 'baseline', gap: '8px' }}>
            <span style={{ fontSize: '10px', color: 'var(--text3)' }}>GT SCORE</span>
            <span style={{ fontSize: '16px', fontWeight: 900, color: gtColor }}>{gt.gtScore >= 0 ? '+' : ''}{gt.gtScore.toFixed(3)}</span>
            <span style={{ fontSize: '10px', color: convColor, fontWeight: 700 }}>{gt.gtConviction} CONVICTION</span>
          </div>
          <div style={{ fontSize: '9px', color: 'var(--text3)', marginTop: '4px', lineHeight: 1.5 }}>
            Score −1 (strong BEAR) to +1 (strong BULL). HIGH = |score| &gt; 0.5. MEDIUM = 0.25–0.5. LOW = &lt; 0.25. In CHOP regime, OI signal weights are halved.
          </div>
        </div>
      </div>
    </div>
  )
}

type GTSnapshot = { ts: number; direction: 'BULL' | 'BEAR' | 'NEUTRAL'; spot: number; gtScore: number }

function N50GTPanel({ n50 }: { n50: N50State }) {
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)
  const [showModal, setShowModal] = useState(false)
  const gtHistory = useRef<GTSnapshot[]>([])

  useEffect(() => {
    const close = () => setCtxMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [])
  useEffect(() => {
    if (!showModal) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowModal(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showModal])

  const gt = computeN50GT(n50)
  const spot = n50.niftySpot ?? 0
  const gtColor = gt.gtDirection === 'BULL' ? 'var(--bull)' : gt.gtDirection === 'BEAR' ? 'var(--bear)' : 'var(--text3)'
  const convColor = gt.gtConviction === 'HIGH' ? '#eab308' : gt.gtConviction === 'MEDIUM' ? 'var(--text2)' : 'var(--text3)'
  const regimeEmoji: Record<string, string> = { ACCUMULATION: '📦', MARKUP: '🚀', DISTRIBUTION: '📤', MARKDOWN: '📉', CHOP: '〰️', UNKNOWN: '❓' }
  const regimeColor = ['MARKUP', 'ACCUMULATION'].includes(gt.regime) ? 'var(--bull)' :
    ['MARKDOWN', 'DISTRIBUTION'].includes(gt.regime) ? 'var(--bear)' :
    gt.regime === 'CHOP' ? 'var(--text3)' : 'rgba(255,255,255,0.25)'

  // ── Rolling GT price-confirmation tracking ────────────────────────────────
  // Accumulate snapshots ~every 5s (guarded by 3s min gap to avoid re-render dupes)
  if (spot > 0) {
    const hist = gtHistory.current
    const now = Date.now()
    if (hist.length === 0 || now - hist[hist.length - 1].ts > 3_000) {
      hist.push({ ts: now, direction: gt.gtDirection, spot, gtScore: gt.gtScore })
      if (hist.length > 120) gtHistory.current = hist.slice(-120)  // keep last 10 min
    }
  }

  // Find start of current direction streak (walk back while direction matches)
  const hist = gtHistory.current
  const currentDir = gt.gtDirection
  let streakStart = hist.length - 1
  while (streakStart > 0 && hist[streakStart - 1].direction === currentDir) streakStart--
  const streakSnap = hist[streakStart]
  const streakLen = hist.length - streakStart
  const callTs = streakSnap?.ts ?? 0
  const callSpot = streakSnap?.spot ?? 0
  const heldMs = callTs > 0 ? Date.now() - callTs : 0
  const heldMin = Math.floor(heldMs / 60_000)
  const heldSec = Math.floor((heldMs % 60_000) / 1_000)
  const priceDelta = spot > 0 && callSpot > 0 ? (spot - callSpot) / callSpot * 100 : null
  const priceConfirming = priceDelta != null && (
    (currentDir === 'BULL' && priceDelta > 0.02) ||
    (currentDir === 'BEAR' && priceDelta < -0.02)
  )
  const priceDiverging = priceDelta != null && (
    (currentDir === 'BULL' && priceDelta < -0.02) ||
    (currentDir === 'BEAR' && priceDelta > 0.02)
  )
  // Score consistency over streak: fraction of streak samples on correct sign
  const streakSamples = hist.slice(streakStart)
  const scoreCorrect = streakSamples.filter(s =>
    (currentDir === 'BULL' && s.gtScore > 0) ||
    (currentDir === 'BEAR' && s.gtScore < 0)
  ).length
  const scoreConsistency = streakSamples.length > 0 ? scoreCorrect / streakSamples.length : 0
  // Recent momentum: last 6 snapshots (30s) — is score trending up or down?
  const recentSamples = hist.slice(-6)
  let scoreTrend: 'STRENGTHENING' | 'WEAKENING' | 'STABLE' = 'STABLE'
  if (recentSamples.length >= 4) {
    const half = Math.floor(recentSamples.length / 2)
    const early = recentSamples.slice(0, half).reduce((a, s) => a + Math.abs(s.gtScore), 0) / half
    const late  = recentSamples.slice(-half).reduce((a, s) => a + Math.abs(s.gtScore), 0) / half
    if (late - early > 0.04) scoreTrend = 'STRENGTHENING'
    else if (early - late > 0.04) scoreTrend = 'WEAKENING'
  }

  const noOI = !n50.oiAnalytics
  const scoreBarW = 140
  const scoreFill = Math.abs(gt.gtScore) * (scoreBarW / 2)
  const pa = n50.phaseAnalysis

  // Setup label color
  const setupColor = gt.setupLabel === 'PERFECT' || gt.setupLabel === 'STRONG' ? '#eab308'
    : gt.setupLabel === 'PARTIAL' ? 'var(--text2)'
    : gt.setupLabel === 'CONFLICTED' ? 'var(--bear)' : 'var(--text3)'

  // Checklist item renderer
  const checkItem = (icon: '✓' | '✗' | '~', label: string, detail: string, iconColor: string) => (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: '5px', fontSize: '10px', lineHeight: 1.4 }}>
      <span style={{ color: iconColor, fontWeight: 900, fontSize: '11px', flexShrink: 0, width: '12px' }}>{icon}</span>
      <span style={{ color: 'var(--text2)', fontWeight: 700, flexShrink: 0, minWidth: '68px' }}>{label}</span>
      <span style={{ color: 'var(--text3)' }}>{detail}</span>
    </div>
  )

  // Per-check icon+color
  function checkIC(v: number): ['✓' | '✗' | '~', string] {
    return v === 1 ? ['✓', 'var(--bull)'] : v === -1 ? ['✗', 'var(--bear)'] : ['~', 'var(--text3)']
  }

  // OI range visualization — spot between put wall and call wall
  const showRange = gt.putWallStrike != null && gt.callWallStrike != null && spot > 0
  const rangeW = showRange ? Math.max(1, gt.callWallStrike! - gt.putWallStrike!) : 1
  const spotPct = showRange ? Math.max(0, Math.min(1, (spot - gt.putWallStrike!) / rangeW)) : 0
  const mpPct   = showRange && gt.maxPainStrike != null
    ? Math.max(0, Math.min(1, (gt.maxPainStrike - gt.putWallStrike!) / rangeW)) : null

  // Regime trading instruction (compact, actionable)
  const regimeInstruction: Record<string, string> = {
    ACCUMULATION: 'Follow CD not book — hidden BULL phase',
    MARKUP:       'Visible momentum — full BULL weight',
    DISTRIBUTION: 'Follow CD not book — hidden BEAR phase',
    MARKDOWN:     'Visible selling — full BEAR weight',
    CHOP:         'No dominant player — OI signals halved',
    UNKNOWN:      'Conflicting signals — wait for clarity',
  }

  // Entry verdict text
  const verdictText =
    gt.setupLabel === 'PERFECT'    ? `ENTER — all 5 signals agree ${gt.gtDirection}` :
    gt.setupLabel === 'STRONG'     ? `CONSIDER — 4/5 agree, 1 neutral/diverge` :
    gt.setupLabel === 'PARTIAL'    ? `WATCH — 3/5 agree, setup developing` :
    gt.setupLabel === 'WEAK'       ? `WAIT — fewer than 3 signals aligned` :
                                     `NO SETUP — direction unclear`

  return (
    <>
      <div
        onContextMenu={e => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY }) }}
        style={{ padding: '8px 10px', background: CYB.panel, borderRadius: '6px', border: `1px solid ${CYB.glowBorder}`, display: 'flex', flexDirection: 'column', gap: '7px', cursor: 'context-menu' }}
      >
        {/* ── Header ─────────────────────────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ fontSize: '8px', fontWeight: 700, color: CYB.glow, letterSpacing: '0.15em' }}>{'//GT_ENGINE'}</span>
          <span style={{ fontSize: '8px', color: '#eab308', border: `1px solid ${'#eab308'}44`, borderRadius: '3px', padding: '0 4px', fontWeight: 700 }}>ADMIN</span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: '8px', color: 'var(--text3)', opacity: 0.45 }}>right-click · explain</span>
        </div>

        {/* ── Direction + Score + Agreement ──────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '20px', fontWeight: 900, color: gtColor, lineHeight: 1 }}>{gt.gtDirection}</span>
          {/* Score bar */}
          <div style={{ position: 'relative', width: `${scoreBarW}px`, height: '8px', background: 'rgba(255,255,255,0.06)', borderRadius: '4px', flexShrink: 0 }}>
            <div style={{ position: 'absolute', top: 0, height: '100%', width: `${scoreFill}px`, background: gtColor, borderRadius: '4px', [gt.gtScore >= 0 ? 'left' : 'right']: '50%', maxWidth: '50%' }} />
            <div style={{ position: 'absolute', top: 0, left: '50%', width: '1px', height: '100%', background: 'rgba(255,255,255,0.2)' }} />
          </div>
          <span style={{ fontSize: '10px', color: 'var(--text3)', minWidth: '38px' }}>{gt.gtScore >= 0 ? '+' : ''}{gt.gtScore.toFixed(3)}</span>
          {/* Agreement badge */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginLeft: 'auto' }}>
            <span style={{ fontSize: '13px', fontWeight: 900, color: setupColor }}>{gt.agreementCount}/5</span>
            <span style={{ fontSize: '9px', fontWeight: 700, color: setupColor }}>{gt.setupLabel}</span>
          </div>
        </div>

        {/* ── OI Range Visualization ─────────────────────────────── */}
        {showRange ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
            {/* price labels */}
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '8px', color: 'var(--text3)' }}>
              <span style={{ color: 'var(--bull)' }}>PUT ₹{gt.putWallStrike!.toFixed(0)}</span>
              {gt.maxPainStrike != null && <span style={{ color: '#eab308' }}>PAIN ₹{gt.maxPainStrike.toFixed(0)}</span>}
              <span style={{ color: 'var(--bear)' }}>CALL ₹{gt.callWallStrike!.toFixed(0)}</span>
            </div>
            {/* range bar */}
            <div style={{ position: 'relative', height: '12px', background: 'rgba(255,255,255,0.05)', borderRadius: '3px', overflow: 'hidden' }}>
              {/* bull zone (left) */}
              <div style={{ position: 'absolute', left: 0, top: 0, width: `${spotPct * 100}%`, height: '100%', background: 'rgba(var(--bull-rgb,34,197,94),0.18)' }} />
              {/* bear zone (right) */}
              <div style={{ position: 'absolute', right: 0, top: 0, width: `${(1 - spotPct) * 100}%`, height: '100%', background: 'rgba(var(--bear-rgb,239,68,68),0.18)' }} />
              {/* max pain marker */}
              {mpPct != null && (
                <div style={{ position: 'absolute', top: 0, left: `${mpPct * 100}%`, width: '2px', height: '100%', background: '#eab308', opacity: 0.7 }} />
              )}
              {/* spot marker */}
              <div style={{ position: 'absolute', top: '1px', left: `${spotPct * 100}%`, transform: 'translateX(-50%)', width: '3px', height: 'calc(100% - 2px)', background: 'white', borderRadius: '2px' }} />
            </div>
            {/* spot reading */}
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '8px', color: 'var(--text3)' }}>
              <span>
                {gt.wallPosition === 'ABOVE_RESISTANCE' ? <span style={{ color: 'var(--bull)', fontWeight: 700 }}>↑ ABOVE resistance</span>
                  : gt.wallPosition === 'BELOW_SUPPORT' ? <span style={{ color: 'var(--bear)', fontWeight: 700 }}>↓ BELOW support</span>
                  : <span>in range · {(spotPct * 100).toFixed(0)}% from put wall</span>}
              </span>
              <span>spot ₹{spot.toFixed(0)}</span>
            </div>
          </div>
        ) : noOI ? (
          <div style={{ fontSize: '9px', color: 'var(--text3)', opacity: 0.5, fontStyle: 'italic' }}>OI chain loading — max pain · PCR · walls pending</div>
        ) : null}

        {/* ── Signal Checklist ───────────────────────────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '6px' }}>
          {(() => {
            const [mpI, mpC2] = checkIC(gt.checks.mp)
            const mpDetail = gt.maxPainStrike != null
              ? `₹${gt.maxPainStrike.toFixed(0)} · ${gt.maxPainDistPct != null ? `${gt.maxPainDistPct > 0 ? '+' : ''}${gt.maxPainDistPct.toFixed(2)}% away · pull ${gt.maxPainPull.toFixed(0)}%` : ''}`
              : 'no OI data'
            const [pcrI, pcrC2] = checkIC(gt.checks.pcr)
            const pcrDetail = gt.pcr != null
              ? `${gt.pcr.toFixed(2)} — ${gt.pcrSignal === 'BULL' ? 'call-heavy (costly BULL)' : gt.pcrSignal === 'BEAR' ? 'put-heavy (costly BEAR)' : 'balanced (no bias)'}`
              : 'no OI data'
            const [schI, schC2] = checkIC(gt.checks.sch)
            const schDetail = gt.wallPosition === 'ABOVE_RESISTANCE' ? '↑ broke call wall (bullish)'
              : gt.wallPosition === 'BELOW_SUPPORT' ? '↓ broke put wall (bearish)'
              : gt.wallPosition === 'IN_RANGE' ? `in range ${(gt.wallRangeUsed * 100).toFixed(0)}% — no breakout`
              : 'no OI data'
            const [orcI, orcC2] = checkIC(gt.checks.orc)
            const orcDetail = `${n50.composite.direction ?? 'NEUTRAL'} ${(n50.composite.confidence * 100).toFixed(0)}% · n=${n50.snapshotCount}`
            const [micI, micC2] = checkIC(gt.checks.micro)
            const micDetail = `CD Z ${n50.technicals.avgCdZ >= 0 ? '+' : ''}${n50.technicals.avgCdZ.toFixed(2)}σ · CUSUM B:${n50.technicals.cusumBullCount} S:${n50.technicals.cusumBearCount}`
            return (<>
              {checkItem(mpI,  'MAX PAIN',  mpDetail,  mpC2)}
              {checkItem(pcrI, 'PCR',       pcrDetail, pcrC2)}
              {checkItem(schI, 'OI WALLS',  schDetail, schC2)}
              {checkItem(orcI, 'ORACLE',    orcDetail, orcC2)}
              {checkItem(micI, 'CD+CUSUM',  micDetail, micC2)}
            </>)
          })()}
        </div>

        {/* ── Price Confirmation ─────────────────────────────────── */}
        {streakLen >= 2 && currentDir !== 'NEUTRAL' && callSpot > 0 && (
          <div style={{
            borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '6px',
            display: 'flex', flexDirection: 'column', gap: '3px',
          }}>
            {/* Confirmation header row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '8px', fontWeight: 700, color: CYB.glow, letterSpacing: '0.1em' }}>PRICE CONFIRM</span>
              {priceDelta != null && (
                <>
                  <span style={{ fontSize: '9px', color: 'var(--text3)' }}>
                    ₹{callSpot.toFixed(0)} → ₹{spot.toFixed(0)}
                  </span>
                  <span style={{
                    fontSize: '11px', fontWeight: 900,
                    color: priceConfirming ? '#34d399' : priceDiverging ? '#f87171' : 'var(--text3)',
                  }}>
                    {priceDelta >= 0 ? '+' : ''}{priceDelta.toFixed(2)}%
                  </span>
                  <span style={{
                    fontSize: '9px', fontWeight: 700,
                    color: priceConfirming ? '#34d399' : priceDiverging ? '#f87171' : 'var(--text3)',
                  }}>
                    {priceConfirming ? '✓ confirming' : priceDiverging ? '✗ diverging' : '~ flat'}
                  </span>
                </>
              )}
            </div>
            {/* Streak stats row */}
            <div style={{ display: 'flex', gap: '10px', fontSize: '8px', color: 'var(--text3)', flexWrap: 'wrap' }}>
              <span>
                held{' '}
                <span style={{ color: 'var(--text2)', fontWeight: 600 }}>
                  {heldMin > 0 ? `${heldMin}m ${heldSec}s` : `${heldSec}s`}
                </span>
                {' '}({streakLen} polls)
              </span>
              <span>
                score consistency{' '}
                <span style={{
                  fontWeight: 700,
                  color: scoreConsistency >= 0.8 ? '#34d399' : scoreConsistency >= 0.5 ? '#fbbf24' : '#f87171',
                }}>
                  {(scoreConsistency * 100).toFixed(0)}%
                </span>
              </span>
              {scoreTrend !== 'STABLE' && (
                <span style={{
                  fontWeight: 700,
                  color: scoreTrend === 'STRENGTHENING' ? '#34d399' : '#f87171',
                }}>
                  {scoreTrend === 'STRENGTHENING' ? '↑ strengthening' : '↓ weakening'}
                </span>
              )}
            </div>
            {/* Mini sparkline — last 12 score values as bars */}
            {hist.length >= 3 && (() => {
              const bars = hist.slice(-12)
              return (
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: '2px', height: '14px' }}>
                  {bars.map((s, i) => {
                    const h = Math.max(2, Math.abs(s.gtScore) * 14)
                    const c = s.direction === 'BULL' ? 'var(--bull)' : s.direction === 'BEAR' ? 'var(--bear)' : 'rgba(255,255,255,0.15)'
                    const isLast = i === bars.length - 1
                    return (
                      <div key={i} style={{ flex: 1, height: `${h}px`, background: c, borderRadius: '1px', opacity: isLast ? 1 : 0.4 + (i / bars.length) * 0.5 }} />
                    )
                  })}
                </div>
              )
            })()}
          </div>
        )}

        {/* ── Entry Verdict ──────────────────────────────────────── */}
        <div style={{
          borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '6px',
          display: 'flex', flexDirection: 'column', gap: '3px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '9px', fontWeight: 900, color: setupColor, letterSpacing: '0.05em' }}>{verdictText}</span>
            {/* Confirmation modifier on verdict */}
            {priceDiverging && streakLen >= 4 && (
              <span style={{ fontSize: '8px', color: '#f87171', fontWeight: 700 }}>⚠ price not following</span>
            )}
          </div>
          {/* Target line */}
          {gt.gtTarget != null && gt.gtDirection !== 'NEUTRAL' && (
            <div style={{ fontSize: '9px', color: 'var(--text3)', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <span>target <span style={{ color: gtColor, fontWeight: 700 }}>₹{gt.gtTarget.toFixed(0)}</span>
                <span style={{ color: gtColor }}> ({gt.gtTargetPct! >= 0 ? '+' : ''}{gt.gtTargetPct!.toFixed(2)}%)</span>
              </span>
              {gt.oracleTargetPct != null && <span>oracle ₹{gt.oracleTarget!.toFixed(0)}</span>}
              {gt.nashTargetPct != null && <span>pain ₹{gt.nashTarget!.toFixed(0)}</span>}
            </div>
          )}
          {/* Regime + phase compact row */}
          <div style={{ display: 'flex', gap: '8px', fontSize: '8px', color: 'var(--text3)', flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ color: regimeColor, fontWeight: 700 }}>{regimeEmoji[gt.regime]} {gt.regime}</span>
            <span>—</span>
            <span>{regimeInstruction[gt.regime]}</span>
            {pa && pa.phase !== 'UNKNOWN' && (
              <>
                <span>·</span>
                <span style={{ color: pa.obiCdPhase === 'HIDDEN' ? '#fbbf24' : pa.obiCdPhase === 'VISIBLE' ? '#34d399' : 'var(--text3)', fontWeight: 700 }}>
                  phase {pa.phase}·{pa.obiCdPhase}
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Context menu */}
      {ctxMenu && (
        <div style={{
          position: 'fixed', left: ctxMenu.x, top: ctxMenu.y, zIndex: 8500,
          background: 'var(--bg)', border: `1px solid ${CYB.glowBorder}`,
          borderRadius: '6px', padding: '4px', minWidth: '210px', boxShadow: '0 4px 20px rgba(0,0,0,0.6)',
        }} onClick={e => e.stopPropagation()}>
          <button onClick={() => { setShowModal(true); setCtxMenu(null) }} style={{
            display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none',
            cursor: 'pointer', padding: '7px 12px', fontSize: '12px', color: 'var(--text)', borderRadius: '4px',
          }}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.08)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'none')}>
            🎯 Explain GT analysis
          </button>
          <div style={{ height: '1px', background: 'rgba(255,255,255,0.08)', margin: '3px 0' }} />
          <div style={{ padding: '5px 12px 4px', fontSize: '9px', color: 'var(--text3)' }}>
            max pain · PCR · OI walls · oracle · micro CD+CUSUM
          </div>
        </div>
      )}

      {/* Explanation modal */}
      {showModal && (
        <N50GTExplanationModal gt={gt} n50={n50} onClose={() => setShowModal(false)} />
      )}
    </>
  )
}

// ── N50 Elliott Wave Panel ─────────────────────────────────────────────────────

const EW_TF_LABELS_N50 = ['15m', '1h', '4h', '1d', '1w', '1M'] as const
type EWTimeframeN50 = typeof EW_TF_LABELS_N50[number]

const N50_BIAS_COLOR: Record<string, string> = {
  STRONG_BULL: 'var(--bull)',
  BULL: 'var(--bull)',
  NEUTRAL: 'var(--text3)',
  BEAR: 'var(--bear)',
  STRONG_BEAR: 'var(--bear)',
}

const N50_WAVE_COLORS: Record<string, string> = {
  '0': 'var(--text3)', '1': '#4ade80', '2': '#facc15', '3': '#00ff9f',
  '4': '#f97316', '5': '#60a5fa', 'A': '#f87171', 'B': '#a78bfa', 'C': '#f472b6', '?': 'var(--text3)',
}

const N50_PATTERN_LABEL: Record<string, string> = {
  IMPULSE_BULL: 'Bull Impulse (1-2-3-4-5)',
  IMPULSE_BEAR: 'Bear Impulse (1-2-3-4-5)',
  CORRECTIVE_BULL: 'Bullish Correction (A-B-C)',
  CORRECTIVE_BEAR: 'Bearish Correction (A-B-C)',
  UNKNOWN: 'Unknown Pattern',
}

function N50EWContextMenu({ ctxMenu, selectedTF, availableTFs, onExplain, onSelectTF }: {
  ctxMenu: { x: number; y: number }
  selectedTF: string
  availableTFs: string[]
  onExplain: (() => void) | null
  onSelectTF: (tf: EWTimeframeN50) => void
}) {
  const btnStyle = (active: boolean, disabled: boolean): React.CSSProperties => ({
    display: 'block', width: '100%', textAlign: 'left',
    background: active ? `${CYB.glow}22` : 'none',
    border: 'none', cursor: disabled ? 'default' : 'pointer',
    padding: '5px 12px', fontSize: '11px',
    color: disabled ? 'var(--text3)' : active ? CYB.glow : 'var(--text)',
    borderRadius: '3px', opacity: disabled ? 0.4 : 1,
  })
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 7999 }} onClick={e => e.stopPropagation()}>
      <div style={{
        position: 'fixed', left: ctxMenu.x, top: ctxMenu.y, zIndex: 8000,
        background: 'var(--bg)', border: `1px solid ${CYB.glowBorder}`,
        borderRadius: '6px', padding: '4px', minWidth: '170px', boxShadow: '0 4px 20px rgba(0,0,0,0.6)',
      }}>
        {onExplain && (
          <>
            <button style={btnStyle(false, false)} onClick={onExplain}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.08)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'none')}>
              📖 Explain Elliott Wave
            </button>
            <div style={{ height: '1px', background: 'rgba(255,255,255,0.08)', margin: '3px 0' }} />
          </>
        )}
        <div style={{ padding: '3px 12px 4px', fontSize: '9px', color: 'var(--text3)', letterSpacing: '0.1em', fontWeight: 700 }}>TIMEFRAME</div>
        {EW_TF_LABELS_N50.map(tf => {
          const hasData = availableTFs.includes(tf)
          const isActive = tf === selectedTF
          return (
            <button key={tf} style={btnStyle(isActive, !hasData)} onClick={() => hasData && onSelectTF(tf)}
              onMouseEnter={e => { if (hasData && !isActive) e.currentTarget.style.background = 'rgba(255,255,255,0.08)' }}
              onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'none' }}>
              {isActive ? '◉' : hasData ? '○' : '·'} {tf}
              {!hasData && <span style={{ fontSize: '9px', opacity: 0.5, marginLeft: '6px' }}>loading…</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function N50EWExplanationModal({ ew, spot, composite, onClose }: {
  ew: EWState; spot: number; composite: N50Composite; onClose: () => void
}) {
  const biasColor = N50_BIAS_COLOR[ew.combinedBias]
  const waveColor = N50_WAVE_COLORS[ew.currentWave] ?? 'var(--text)'

  const ewBullish = ew.combinedBias === 'STRONG_BULL' || ew.combinedBias === 'BULL'
  const ewBearish = ew.combinedBias === 'STRONG_BEAR' || ew.combinedBias === 'BEAR'
  const oracleBullish = composite.direction === 'BULL'
  const oracleBearish = composite.direction === 'BEAR'
  const aligned = (ewBullish && oracleBullish) || (ewBearish && oracleBearish)
  const diverged = (ewBullish && oracleBearish) || (ewBearish && oracleBullish)
  const alignColor = aligned ? 'var(--bull)' : diverged ? 'var(--bear)' : 'var(--text3)'
  const alignLabel = aligned ? '✓ ALIGNED' : diverged ? '⚠ DIVERGING' : '~ NEUTRAL'

  const nearestLevel = ew.levels.reduce<EWLevelC | null>((best, lv) => {
    if (!best) return lv
    return Math.abs(lv.price - spot) < Math.abs(best.price - spot) ? lv : best
  }, null)
  const distPct = nearestLevel ? ((spot - nearestLevel.price) / nearestLevel.price * 100) : null

  const S: Record<string, React.CSSProperties> = {
    overlay: { position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(0,0,0,0.82)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '12px' },
    modal: { background: 'var(--bg)', border: `1px solid ${CYB.glowBorder}`, borderRadius: '10px', maxWidth: '560px', width: '100%', maxHeight: '88vh', overflowY: 'auto', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '14px' },
    sectionTitle: { fontSize: '9px', fontWeight: 700, color: CYB.glow, letterSpacing: '0.12em', marginBottom: '4px' },
    section: { display: 'flex', flexDirection: 'column', gap: '4px', paddingBottom: '12px', borderBottom: '1px solid rgba(255,255,255,0.05)' },
    body: { fontSize: '11px', color: 'var(--text2)', lineHeight: 1.55 },
    chip: { display: 'inline-block', fontSize: '9px', padding: '2px 6px', borderRadius: '3px', fontWeight: 700, marginRight: '4px' },
    closeBtn: { background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '5px', color: 'var(--text2)', cursor: 'pointer', fontSize: '11px', padding: '3px 10px', flexShrink: 0 },
    levelRow: { display: 'flex', alignItems: 'center', gap: '6px', padding: '3px 0', fontSize: '11px' },
    pivotRow: { display: 'flex', gap: '4px', flexWrap: 'wrap', alignItems: 'center' },
  }

  return (
    <div style={S.overlay} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={S.modal}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
          <div>
            <div style={{ fontSize: '8px', fontWeight: 700, color: CYB.glow, letterSpacing: '0.15em', marginBottom: '4px' }}>{'//ELLIOTT_WAVE  ·  NIFTY 50  ·  EXPLANATION'}</div>
            <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text)' }}>{N50_PATTERN_LABEL[ew.pattern]}</div>
            <div style={{ fontSize: '10px', color: 'var(--text3)', marginTop: '2px' }}>conf:{Math.round(ew.confidence * 100)}%  ·  {ew.pivots.length} pivots  ·  spot ₹{spot.toFixed(0)}</div>
          </div>
          <button style={S.closeBtn} onClick={onClose}>✕ close</button>
        </div>

        {/* Pattern */}
        <div style={S.section}>
          <div style={S.sectionTitle}>PATTERN</div>
          <div style={{ ...S.body }}>{N50_PATTERN_LABEL[ew.pattern]} — Wave {ew.currentWave} in progress. Confidence: {Math.round(ew.confidence * 100)}%</div>
          <div style={{ marginTop: '4px', fontSize: '10px', color: biasColor, fontWeight: 700 }}>{ew.combinedBias.replace('_', ' ')}</div>
          <div style={{ fontSize: '10px', color: 'var(--text2)', marginTop: '2px' }}>{ew.combinedNote}</div>
        </div>

        {/* Pivot sequence */}
        {ew.pivots.length >= 2 && (
          <div style={S.section}>
            <div style={S.sectionTitle}>PIVOT SEQUENCE ({ew.pivots.length} pivots)</div>
            <div style={S.pivotRow}>
              {ew.pivots.map((pv, i) => {
                const col = N50_WAVE_COLORS[pv.wave] ?? 'var(--text3)'
                const isLast = i === ew.pivots.length - 1
                return (
                  <span key={pv.ts} style={{
                    ...S.chip,
                    background: `${col}22`, border: `1px solid ${col}55`,
                    color: isLast ? col : 'var(--text2)', fontWeight: isLast ? 800 : 600,
                  }}>
                    {pv.wave !== '?' && pv.wave !== '0' ? pv.wave : '?'} {pv.type === 'H' ? '▲' : '▼'} ₹{pv.price.toFixed(0)} <span style={{ opacity: 0.6 }}>{pv.timeStr}</span>
                  </span>
                )
              })}
              <span style={{ ...S.chip, background: `${CYB.glow}22`, border: `1px dashed ${CYB.glow}`, color: CYB.glow }}>
                NOW ₹{spot.toFixed(0)}
              </span>
            </div>
          </div>
        )}

        {/* Fibonacci levels */}
        {(ew.invalidation != null || ew.primaryTarget != null || ew.levels.length > 0) && (
          <div style={S.section}>
            <div style={S.sectionTitle}>FIBONACCI KEY LEVELS</div>
            {ew.invalidation != null && (
              <div style={S.levelRow}>
                <span style={{ ...S.chip, background: 'rgba(255,80,80,0.15)', border: '1px solid rgba(255,80,80,0.35)', color: 'var(--bear)' }}>INV</span>
                <span style={{ color: 'var(--bear)', fontWeight: 700 }}>₹{ew.invalidation.toFixed(0)}</span>
                <span style={{ color: 'var(--text3)', fontSize: '10px' }}>— wave count invalidated if price closes beyond this</span>
              </div>
            )}
            {ew.primaryTarget != null && (
              <div style={S.levelRow}>
                <span style={{ ...S.chip, background: `${biasColor}22`, border: `1px solid ${biasColor}44`, color: biasColor }}>TGT</span>
                <span style={{ color: biasColor, fontWeight: 700 }}>₹{ew.primaryTarget.toFixed(0)}</span>
                <span style={{ color: 'var(--text3)', fontSize: '10px' }}>— primary Elliott wave completion target</span>
              </div>
            )}
            {ew.levels.map((lv, i) => {
              const near = Math.abs(lv.price - spot) / spot < 0.005
              const rc = lv.role === 'support' ? 'var(--bull)' : lv.role === 'target' ? 'var(--bull)' : 'var(--bear)'
              return (
                <div key={i} style={{ ...S.levelRow, opacity: near ? 1 : 0.7 }}>
                  <span style={{ ...S.chip, background: `${rc}15`, border: `1px solid ${rc}33`, color: rc }}>{lv.label}</span>
                  <span style={{ color: near ? rc : 'var(--text)', fontWeight: near ? 700 : 400 }}>₹{lv.price.toFixed(0)}</span>
                  {near && <span style={{ fontSize: '9px', color: CYB.glow }}>← near spot</span>}
                </div>
              )
            })}
            {nearestLevel && distPct != null && (
              <div style={{ marginTop: '6px', fontSize: '10px', color: 'var(--text3)' }}>
                Nearest level: <span style={{ color: 'var(--text)' }}>{nearestLevel.label} ₹{nearestLevel.price.toFixed(0)}</span>
                {' '}— spot is <span style={{ color: Math.abs(distPct) < 0.3 ? CYB.glow : 'var(--text2)', fontWeight: 700 }}>{distPct > 0 ? '+' : ''}{distPct.toFixed(2)}%</span> away
              </div>
            )}
          </div>
        )}

        {/* Oracle alignment */}
        <div style={{ ...S.section, borderBottom: 'none', paddingBottom: 0 }}>
          <div style={S.sectionTitle}>ORACLE vs ELLIOTT WAVE</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '6px' }}>
            <span style={{ fontSize: '13px', fontWeight: 900, color: alignColor }}>{alignLabel}</span>
            <span style={{ fontSize: '10px', color: 'var(--text3)' }}>
              EW: <span style={{ color: biasColor, fontWeight: 700 }}>{ew.combinedBias.replace('_', ' ')}</span>
              {'  ·  '}Oracle: <span style={{ color: composite.direction === 'BULL' ? 'var(--bull)' : composite.direction === 'BEAR' ? 'var(--bear)' : 'var(--text3)', fontWeight: 700 }}>
                {composite.direction === 'BULL' ? '▲' : composite.direction === 'BEAR' ? '▼' : '~'} {(composite.bullProb * 100).toFixed(0)}%B / {(composite.bearProb * 100).toFixed(0)}%Be
              </span>
            </span>
          </div>
          <div style={S.body}>
            {aligned
              ? `Both Elliott Wave and Oracle agree: ${ewBullish ? 'BULLISH' : 'BEARISH'} bias. When wave structure and pattern probability align, setup has higher structural conviction.`
              : diverged
              ? `Elliott Wave says ${ewBullish ? 'BULLISH' : 'BEARISH'} but Oracle says ${oracleBullish ? 'BULLISH' : 'BEARISH'}. Divergence means a wave transition may be near, or the pattern memory detects a regime change. Exercise caution.`
              : 'No strong directional read from either system. Market likely in a corrective or ranging phase.'}
          </div>
          <div style={{ marginTop: '8px', fontSize: '9px', color: 'var(--text3)', lineHeight: 1.5 }}>
            Elliott Wave is a structural pivot framework applied to NIFTY 50 index (token 256265) historical candles. The Oracle is the N50 composite pattern-memory system. They are independent — agreement raises confidence, divergence is a warning.
          </div>
        </div>
      </div>
    </div>
  )
}

function N50EWPanel({ n50 }: { n50: N50State }) {
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)
  const [showModal, setShowModal] = useState(false)
  const [selectedTF, setSelectedTF] = useState<EWTimeframeN50>('15m')

  const activeEW: EWState | null | undefined =
    selectedTF === '15m' ? n50.elliottWave : (n50.elliottWaveByTF?.[selectedTF] ?? null)

  useEffect(() => {
    const close = () => setCtxMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [])

  useEffect(() => {
    if (!showModal) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowModal(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showModal])

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY })
  }

  const availableTFs = EW_TF_LABELS_N50.filter(tf =>
    tf === '15m'
      ? !!(n50.elliottWave && n50.elliottWave.pattern !== 'UNKNOWN')
      : !!(n50.elliottWaveByTF?.[tf] && n50.elliottWaveByTF[tf]!.pattern !== 'UNKNOWN')
  )

  const spot = n50.niftySpot ?? 0

  if (!activeEW || activeEW.pattern === 'UNKNOWN') {
    return (
      <>
        <div onContextMenu={handleContextMenu} style={{ padding: '8px 10px', background: CYB.panel, borderRadius: '6px', border: `1px solid ${CYB.glowBorder}`, cursor: 'context-menu' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '8px', fontWeight: 700, color: CYB.glow, letterSpacing: '0.15em' }}>{'//ELLIOTT_WAVE  ·  NIFTY 50'}</span>
            <span style={{ fontSize: '9px', color: 'var(--text3)' }}>
              {selectedTF === '15m' ? 'accumulating 15-min candle history…' : `loading ${selectedTF} data…`}
            </span>
            <span style={{ flex: 1 }} />
            <div style={{ display: 'flex', gap: '2px' }}>
              {EW_TF_LABELS_N50.map(tf => {
                const hasData = tf === '15m' ? !!(n50.elliottWave && n50.elliottWave.pattern !== 'UNKNOWN') : !!(n50.elliottWaveByTF?.[tf] && n50.elliottWaveByTF[tf]!.pattern !== 'UNKNOWN')
                return (
                  <button key={tf} onClick={() => setSelectedTF(tf)} style={{
                    background: selectedTF === tf ? `${CYB.glow}33` : 'transparent',
                    border: `1px solid ${selectedTF === tf ? CYB.glow : 'rgba(255,255,255,0.12)'}`,
                    color: selectedTF === tf ? CYB.glow : hasData ? 'var(--text2)' : 'var(--text3)',
                    borderRadius: '3px', padding: '1px 5px', fontSize: '8px', cursor: 'pointer', fontWeight: selectedTF === tf ? 700 : 400,
                    opacity: hasData ? 1 : 0.4,
                  }}>{tf}</button>
                )
              })}
            </div>
          </div>
        </div>
        {ctxMenu && (
          <N50EWContextMenu ctxMenu={ctxMenu} selectedTF={selectedTF} availableTFs={availableTFs}
            onExplain={activeEW && activeEW.pattern !== 'UNKNOWN' ? () => { setShowModal(true); setCtxMenu(null) } : null}
            onSelectTF={(tf) => { setSelectedTF(tf); setCtxMenu(null) }} />
        )}
      </>
    )
  }

  const biasColor = N50_BIAS_COLOR[activeEW.combinedBias]
  const isStrong = activeEW.combinedBias === 'STRONG_BULL' || activeEW.combinedBias === 'STRONG_BEAR'
  const waveColor = N50_WAVE_COLORS[activeEW.currentWave] ?? 'var(--text)'

  const pivots = activeEW.pivots
  const minP = Math.min(...pivots.map(p => p.price))
  const maxP = Math.max(...pivots.map(p => p.price))
  const range = maxP - minP || 1

  return (
    <>
      <div onContextMenu={handleContextMenu} style={{ padding: '8px 10px', background: CYB.panel, borderRadius: '6px', border: `1px solid ${CYB.glowBorder}`, display: 'flex', flexDirection: 'column', gap: '6px', cursor: 'context-menu' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '8px', fontWeight: 700, color: CYB.glow, letterSpacing: '0.15em' }}>{'//ELLIOTT_WAVE  ·  NIFTY 50'}</span>
          <span style={{ fontSize: '10px', color: 'var(--text2)', fontWeight: 600 }}>{N50_PATTERN_LABEL[activeEW.pattern]}</span>
          <span style={{ fontSize: '9px', color: 'var(--text3)' }}>conf:{Math.round(activeEW.confidence * 100)}%</span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: '9px', color: 'var(--text3)' }}>{selectedTF} pivots:{activeEW.pivots.length}</span>
          <div style={{ display: 'flex', gap: '2px' }}>
            {EW_TF_LABELS_N50.map(tf => {
              const hasData = tf === '15m' ? !!(n50.elliottWave && n50.elliottWave.pattern !== 'UNKNOWN') : !!(n50.elliottWaveByTF?.[tf] && n50.elliottWaveByTF[tf]!.pattern !== 'UNKNOWN')
              return (
                <button key={tf} onClick={e => { e.stopPropagation(); setSelectedTF(tf) }} style={{
                  background: selectedTF === tf ? `${CYB.glow}33` : 'transparent',
                  border: `1px solid ${selectedTF === tf ? CYB.glow : 'rgba(255,255,255,0.12)'}`,
                  color: selectedTF === tf ? CYB.glow : hasData ? 'var(--text2)' : 'var(--text3)',
                  borderRadius: '3px', padding: '1px 5px', fontSize: '8px', cursor: 'pointer', fontWeight: selectedTF === tf ? 700 : 400,
                  opacity: hasData ? 1 : 0.4,
                }}>{tf}</button>
              )
            })}
          </div>
        </div>

        {/* Current wave badge + combined bias */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
            <span style={{ fontSize: '9px', color: 'var(--text3)' }}>WAVE</span>
            <span style={{ fontSize: '20px', fontWeight: 900, color: waveColor, lineHeight: 1 }}>{activeEW.currentWave}</span>
          </div>
          <div style={{ width: '1px', height: '24px', background: 'rgba(255,255,255,0.1)' }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: '10px', fontWeight: 700, color: biasColor }}>
              {isStrong ? '⚡ ' : ''}{activeEW.combinedBias.replace('_', ' ')}
            </span>
            <span style={{ fontSize: '9px', color: 'var(--text2)', lineHeight: 1.3 }}>{activeEW.combinedNote}</span>
          </div>
        </div>

        {/* Pivot mini-chart */}
        {pivots.length >= 3 && (
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: '2px', overflowX: 'auto' }}>
            {pivots.map((pv, i) => {
              const heightPct = (pv.price - minP) / range
              const barH = Math.max(12, Math.round(heightPct * 40) + 12)
              const isH = pv.type === 'H'
              const col = N50_WAVE_COLORS[pv.wave] ?? 'var(--text3)'
              const isCurrent = i === pivots.length - 1
              return (
                <div key={pv.ts} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1px', minWidth: '28px' }}>
                  <span style={{ fontSize: '9px', fontWeight: 700, color: col, opacity: isCurrent ? 1 : 0.75 }}>
                    {pv.wave !== '?' && pv.wave !== '0' ? pv.wave : ''}
                  </span>
                  <div style={{
                    width: '20px', height: `${barH}px`,
                    background: isH ? `linear-gradient(180deg, ${col}99, ${col}44)` : `linear-gradient(0deg, ${col}99, ${col}44)`,
                    border: isCurrent ? `1px solid ${col}` : '1px solid rgba(255,255,255,0.1)',
                    borderRadius: '2px', position: 'relative',
                  }}>
                    <span style={{ position: 'absolute', top: isH ? '-1px' : 'auto', bottom: isH ? 'auto' : '-1px', left: '50%', transform: 'translateX(-50%)', fontSize: '7px', color: col }}>
                      {isH ? '▲' : '▼'}
                    </span>
                  </div>
                  <span style={{ fontSize: '7px', color: 'var(--text3)', whiteSpace: 'nowrap' }}>
                    {pv.price >= 1000 ? pv.price.toFixed(0) : pv.price.toFixed(1)}
                  </span>
                  <span style={{ fontSize: '7px', color: 'var(--text3)', opacity: 0.7 }}>{pv.timeStr}</span>
                </div>
              )
            })}
            {/* Current spot marker */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1px', minWidth: '28px' }}>
              <span style={{ fontSize: '9px', color: CYB.glow }}>NOW</span>
              <div style={{ width: '20px', height: `${Math.max(12, Math.round(((spot - minP) / range) * 40) + 12)}px`, border: `1px dashed ${CYB.glow}`, borderRadius: '2px', background: `${CYB.glow}22` }} />
              <span style={{ fontSize: '7px', color: CYB.glow }}>{spot.toFixed(0)}</span>
            </div>
          </div>
        )}

        {/* Key levels */}
        {activeEW.levels.length > 0 && (
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {activeEW.primaryTarget != null && (
              <span style={{ fontSize: '9px', padding: '1px 5px', background: `${biasColor}22`, border: `1px solid ${biasColor}44`, borderRadius: '3px', color: biasColor, fontWeight: 700 }}>
                TGT ₹{activeEW.primaryTarget.toFixed(0)}
              </span>
            )}
            {activeEW.invalidation != null && (
              <span style={{ fontSize: '9px', padding: '1px 5px', background: 'rgba(255,100,100,0.1)', border: '1px solid rgba(255,100,100,0.3)', borderRadius: '3px', color: 'var(--bear)', fontWeight: 700 }}>
                INV ₹{activeEW.invalidation.toFixed(0)}
              </span>
            )}
            {activeEW.levels.slice(0, 4).map((lv, i) => {
              const isNearSpot = spot > 0 && Math.abs(lv.price - spot) / spot < 0.005
              const roleColor = lv.role === 'target' ? 'var(--bull)' : lv.role === 'support' ? 'var(--bull)' : 'var(--bear)'
              return (
                <span key={i} style={{ fontSize: '9px', padding: '1px 5px', background: isNearSpot ? `${roleColor}22` : 'transparent', border: `1px solid ${roleColor}44`, borderRadius: '3px', color: isNearSpot ? roleColor : 'var(--text3)' }}>
                  {lv.label} ₹{lv.price.toFixed(0)}
                </span>
              )
            })}
          </div>
        )}

        {/* Oracle context */}
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '4px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '8px', color: 'var(--text3)' }}>ORACLE</span>
          <span style={{ fontSize: '10px', fontWeight: 700, color: n50.composite.direction === 'BULL' ? 'var(--bull)' : n50.composite.direction === 'BEAR' ? 'var(--bear)' : 'var(--text3)' }}>
            {n50.composite.direction === 'BULL' ? '▲' : n50.composite.direction === 'BEAR' ? '▼' : '~'} {(n50.composite.bullProb * 100).toFixed(0)}%B / {(n50.composite.bearProb * 100).toFixed(0)}%Be
          </span>
          <span style={{ fontSize: '9px', color: 'var(--text3)' }}>conf:{Math.round(n50.composite.confidence * 100)}%</span>
          <span style={{ fontSize: '9px', color: 'var(--text3)' }}>pred:{n50.composite.predictedMove >= 0 ? '+' : ''}{n50.composite.predictedMove.toFixed(3)}%</span>
        </div>
      </div>

      {/* Context menu */}
      {ctxMenu && (
        <N50EWContextMenu ctxMenu={ctxMenu} selectedTF={selectedTF} availableTFs={availableTFs}
          onExplain={() => { setShowModal(true); setCtxMenu(null) }}
          onSelectTF={tf => { setSelectedTF(tf); setCtxMenu(null) }} />
      )}

      {/* Explanation modal */}
      {showModal && activeEW && (
        <N50EWExplanationModal ew={activeEW} spot={spot} composite={n50.composite} onClose={() => setShowModal(false)} />
      )}
    </>
  )
}

// ── N50 SysLog ──────────────────────────────────────────────────────────

function N50SysLog({ entries, at, onArm, onDisarm, restricted = false }: { entries: SysLogEntry[]; at: ATState; onArm: () => void; onDisarm: () => void; restricted?: boolean }) {
  const [showCount, setShowCount] = useState(3)

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
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '2px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '8px', fontWeight: 700, color: CYB.glow, letterSpacing: '0.15em' }}>{'//SYS_LOG'}</span>
        <span style={{ fontSize: '8px', color: 'var(--text3)' }}>
          {resolved.length} resolved · {accuracy}% win
          {targetHitCount > 0 && ` · ${targetHitCount} target-hit`}
        </span>
        <span style={{ flex: 1 }} />
        {at.mode !== 'IDLE' && (
          <span style={{
            fontSize: '7px', fontWeight: 700, letterSpacing: '0.1em', padding: '1px 5px', borderRadius: '2px',
            color: at.mode === 'LIVE' ? '#000' : at.mode === 'ARMED' ? CYB.glow : 'var(--mixed)',
            background: at.mode === 'LIVE' ? 'var(--bull)' : at.mode === 'ARMED' ? CYB.glowDim : 'rgba(255,180,0,0.12)',
            border: at.mode === 'LIVE' ? 'none' : `1px solid ${at.mode === 'ARMED' ? CYB.glowBorder : 'rgba(255,180,0,0.3)'}`,
          }}>
            {at.mode === 'LIVE' ? `LIVE ${(at.pos?.sym ?? '').replace(/^NIFTY/, 'N')} ${at.pos?.dir === 'BULL' ? '▲' : '▼'}` : at.mode === 'ARMED' ? '⚡ARMED' : `⏳COOL ${at.cd}/${AT_CD_TICKS}`}
          </span>
        )}
        {!restricted && (at.mode === 'IDLE' ? (
          <button onClick={onArm} style={{ fontSize: '7px', fontWeight: 700, fontFamily: 'inherit', letterSpacing: '0.1em', color: CYB.glow, background: CYB.glowDim, border: `1px solid ${CYB.glowBorder}`, borderRadius: '2px', padding: '2px 6px', cursor: 'pointer' }}>⚡ARM</button>
        ) : (
          <button onClick={onDisarm} style={{ fontSize: '7px', fontWeight: 700, fontFamily: 'inherit', letterSpacing: '0.1em', color: CYB.redGlow, background: CYB.redDim, border: '1px solid rgba(255,0,60,0.3)', borderRadius: '2px', padding: '2px 6px', cursor: 'pointer' }}>DISARM</button>
        ))}
      </div>
      {at.stats.n > 0 && (
        <div style={{ fontSize: '8px', color: 'var(--text3)', display: 'flex', gap: '8px' }}>
          <span>AT: {at.stats.n} trades</span>
          <span>{Math.round((at.stats.w / at.stats.n) * 100)}% win</span>
          <span style={{ color: at.stats.pnl >= 0 ? 'var(--bull)' : 'var(--bear)', fontWeight: 600 }}>{at.stats.pnl >= 0 ? '+' : ''}₹{Math.round(at.stats.pnl).toLocaleString()}</span>
        </div>
      )}
      <div>
        {visible.map(entry => {
          const pending = !entry.resolved
          const liveNow = (entry as any).liveMove ?? entry.peakMove ?? 0
          const sameDirN50 = (entry.predMove > 0 && liveNow > 0) || (entry.predMove < 0 && liveNow < 0)
          const targetPct = entry.predMove !== 0 && pending && sameDirN50
            ? Math.min(100, Math.round(Math.abs(liveNow / entry.predMove) * 100))
            : 0
          const predIsUp = entry.predMove > 0

          return (
            <div key={entry.cycleTs} style={{
              display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap',
              padding: '2px 0', borderBottom: '1px solid rgba(255,255,255,0.03)',
              fontSize: '9px', opacity: entry.resolved ? 1 : 0.65,
            }}>
              <span style={{ color: 'var(--text3)', width: '34px', flexShrink: 0 }}>{entry.cycleTime}</span>
              <span style={{
                color: predIsUp ? 'var(--bull)' : entry.predMove < 0 ? 'var(--bear)' : 'var(--text3)',
                fontWeight: 700, width: '72px', flexShrink: 0,
              }}>
                {predIsUp ? '▲' : entry.predMove < 0 ? '▼' : '·'}{' '}
                {entry.predMove >= 0 ? '+' : ''}{entry.predMove.toFixed(3)}%
              </span>
              <span style={{ color: 'var(--text3)', width: '46px', flexShrink: 0 }}>→{entry.predSpot.toFixed(0)}</span>
              {entry.resolved ? (
                <>
                  <span style={{
                    fontWeight: 700, width: '12px',
                    color: entry.correct ? 'var(--bull)' : 'var(--bear)',
                  }}>{entry.correct ? '✓' : '✗'}</span>
                  <span style={{
                    color: (entry.outcomeMove ?? 0) >= 0 ? 'var(--bull)' : 'var(--bear)',
                    fontWeight: 600, width: '72px',
                  }}>
                    {(entry.outcomeMove ?? 0) >= 0 ? '+' : ''}{entry.outcomeMove?.toFixed(3)}%
                  </span>
                  <span style={{ color: 'var(--text3)' }}>
                    {entry.niftySpotAtOutcome?.toFixed(0)}
                  </span>
                  {entry.targetHit && (
                    <span style={{ fontSize: '7px', color: CYB.glow, fontWeight: 700 }}>🎯HIT</span>
                  )}
                </>
              ) : (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                  {entry.targetHit ? (
                    <span style={{ fontSize: '8px', color: CYB.glow, fontWeight: 700, letterSpacing: '0.1em' }}>🎯 TARGET HIT</span>
                  ) : (
                    <>
                      <span style={{ fontSize: '8px', color: CYB.glow, letterSpacing: '0.1em' }}>LIVE</span>
                      <span style={{ fontSize: '7px', color: liveNow >= 0 === predIsUp ? 'var(--bull)' : 'var(--bear)' }}>
                        {liveNow >= 0 ? '+' : ''}{liveNow.toFixed(3)}%
                      </span>
                      <span style={{ fontSize: '7px', color: targetPct >= 80 ? 'var(--bull)' : 'var(--text3)' }}>
                        {targetPct}%→tgt
                      </span>
                    </>
                  )}
                </span>
              )}
            </div>
          )
        })}
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
        {entries.length === 0 && (
          <div style={{ fontSize: '9px', color: 'var(--text3)', textAlign: 'center', padding: '4px 0' }}>first prediction in ~20m</div>
        )}
      </div>
      {at.mode !== 'IDLE' && at.log.length > 0 && (
        <div style={{ borderTop: `1px solid ${CYB.glowBorder}`, paddingTop: '3px', marginTop: '2px' }}>
          <span style={{ fontSize: '7px', fontWeight: 700, color: CYB.glow, letterSpacing: '0.15em', opacity: 0.5 }}>AT LOG</span>
          {at.log.slice(-5).map((l, i) => (
            <div key={i} style={{ fontSize: '8px', color: 'var(--text3)', padding: '1px 0', display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
              <span>{new Date(l.ts).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false })}</span>
              <span style={{ fontWeight: 700, color: l.act === 'BUY' ? 'var(--bull)' : l.act === 'SELL' ? 'var(--bear)' : l.act === 'ERR' ? CYB.redGlow : 'var(--text3)' }}>{l.act}</span>
              {l.sym && <span>{l.sym.replace(/^NIFTY/, 'N')}</span>}
              {l.pnl != null && <span style={{ fontWeight: 700, color: l.pnl >= 0 ? 'var(--bull)' : 'var(--bear)' }}>{l.pnl >= 0 ? '+' : ''}₹{Math.round(l.pnl)}</span>}
              {l.msg && <span style={{ opacity: 0.7 }}>{l.msg}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── N50 Oracle (composite + pattern + technicals + day + breadth) ────────

function N50Oracle({ n50, role = 'admin' }: { n50: N50State | null; role?: string }) {
  const [showComponents, setShowComponents] = useState(true)
  const [topSimHistory, setTopSimHistory] = useState<{ ts: number; sim: number; dir: 'BULL' | 'BEAR' | null }[]>([])
  const lastTopSimTs = useRef(0)

  const pred0 = n50?.prediction
  useEffect(() => {
    if (!pred0 || pred0.status !== 'ready') return
    const now = Date.now()
    if (now - lastTopSimTs.current < 12_000) return
    lastTopSimTs.current = now
    setTopSimHistory(h => [...h.slice(-19), { ts: now, sim: pred0.topSim, dir: pred0.direction }])
  }, [pred0?.topSim, pred0?.direction, pred0?.status])

  if (!n50) return (
    <div style={{ padding: '12px', background: CYB.panel, border: `1px solid ${CYB.glowBorder}`, borderRadius: '6px' }}>
      <span style={{ fontSize: '10px', color: CYB.glow, opacity: 0.6 }}>{'> CONNECTING TO NEURAL NETWORK...'}</span>
    </div>
  )

  const comp = n50.composite
  const pred = n50.prediction
  const tech = n50.technicals
  const dp = n50.dayPrediction
  const dayPred = dp?.prediction
  const dayLog = dp?.recentLog ?? []

  const dirColor = (d: 'BULL' | 'BEAR' | null) =>
    d === 'BULL' ? 'var(--bull)' : d === 'BEAR' ? 'var(--bear)' : 'var(--text3)'

  const winCount = dayLog.filter(l => l.correct).length
  const isResolved = dayPred && dayLog.length > 0 && dayLog[dayLog.length - 1].targetDay === dayPred.targetDay

  const compBull = Math.round(comp.bullProb * 100)
  const compBear = Math.round(comp.bearProb * 100)
  const compDir = comp.predictedMove >= 0 ? 'BULL' as const : 'BEAR' as const
  const compColor = compDir === 'BULL' ? 'var(--bull)' : 'var(--bear)'

  const kb = role !== 'viewer' ? computeKalmanBias(n50.sysLog ?? [], comp.predictedMove) : null

  const techBullPct = Math.round(comp.components.techBullScore * 100)
  const techBearPct = 100 - techBullPct

  const patBull = Math.round(pred.bullProb * 100)
  const patBear = Math.round(pred.bearProb * 100)

  const fmtPct = (v: number) => `${v}%`

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: '8px',
      padding: '12px', background: CYB.panel, borderRadius: '6px',
      border: `1px solid ${CYB.glowBorder}`,
      backgroundImage: CYB.scanline,
    }}>
      <SysHeader label="ORACLE" sub={`${n50.coverageCount}/50 · ${n50.minutesAccumulated}m`}
        right={n50.niftySpot != null && n50.niftySpot > 0 ? (
          <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.02em' }}>
            NIFTY {n50.niftySpot.toFixed(1)}
          </span>
        ) : undefined}
      />

      {/* Composite prediction — main 20M row */}
      {comp.status === 'ready' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{
              fontSize: '8px', color: CYB.glow, letterSpacing: '0.1em', width: '48px',
              fontWeight: 700,
            }}>20M</span>
            <span style={{
              fontSize: '14px', fontWeight: 700, color: compColor,
              padding: '2px 10px', borderRadius: '3px',
              background: compDir === 'BULL' ? 'rgba(34,197,94,0.14)' : 'rgba(239,68,68,0.14)',
              border: `1px solid ${compDir === 'BULL' ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
            }}>
              {compDir === 'BULL' ? '▲' : '▼'} {comp.predictedMove >= 0 ? '+' : ''}{comp.predictedMove.toFixed(3)}%
              {n50.niftySpot != null && n50.niftySpot > 0 && (
                <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text2)', marginLeft: '6px' }}>
                  → {(n50.niftySpot * (1 + comp.predictedMove / 100)).toFixed(0)}
                </span>
              )}
            </span>
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '4px', minWidth: '80px' }}>
              <span style={{ fontSize: '9px', fontWeight: 600, color: 'var(--bull)', width: '24px', textAlign: 'right' }}>{compBull}</span>
              <MiniBar bull={compBull} bear={compBear} height={6} />
              <span style={{ fontSize: '9px', fontWeight: 600, color: 'var(--bear)', width: '24px' }}>{compBear}</span>
            </div>
          </div>
          {(() => {
            const syslog = n50.sysLog ?? []
            const resolved = syslog.filter(e => e.resolved && e.outcomeMove != null)
            const correct = resolved.filter(e => (e.predMove > 0) === (e.outcomeMove! > 0))
            const hitRate = resolved.length >= 3 ? correct.length / resolved.length : null
            const confColor = comp.confidence >= 0.5 ? 'var(--bull)' : comp.confidence >= 0.25 ? '#ffd93d' : 'var(--text2)'
            const hitColor = hitRate == null ? 'var(--text3)' : hitRate >= 0.65 ? 'var(--bull)' : hitRate >= 0.50 ? '#ffd93d' : 'var(--bear)'
            return (
              <div style={{ display: 'flex', gap: '10px', fontSize: '8px', color: 'var(--text3)', paddingLeft: '56px', flexWrap: 'wrap' }}>
                <span>conf <span style={{ color: confColor, fontWeight: 600 }}>{(comp.confidence * 100).toFixed(0)}%</span></span>
                {hitRate != null && (
                  <span>acc <span style={{ color: hitColor, fontWeight: 600 }}>{Math.round(hitRate * 100)}%</span><span style={{ opacity: 0.6 }}> ({resolved.length})</span></span>
                )}
                <span>pat <span style={{ color: CYB.glow, fontWeight: 600 }}>{(comp.components.patternWeight * 100).toFixed(0)}%</span></span>
                <span>tech <span style={{ color: CYB.glow, fontWeight: 600 }}>{(comp.components.techWeight * 100).toFixed(0)}%</span></span>
                <span>proxy <span style={{ color: n50.niftyProxy >= 0 ? 'var(--bull)' : 'var(--bear)', fontWeight: 600 }}>{n50.niftyProxy >= 0 ? '+' : ''}{n50.niftyProxy.toFixed(3)}%</span></span>
              </div>
            )
          })()}
        </div>
      ) : (
        <div style={{ fontSize: '10px', color: 'var(--text3)', padding: '4px 0' }}>
          {comp.status === 'warming'
            ? `Warming — ${n50.resolvedCount}/${10} resolved · ${n50.snapshotCount} snapshots`
            : `Accumulating... ${n50.snapshotCount} snapshots · ${n50.patternCount} patterns`}
        </div>
      )}

      {/* Kalman bias panel — admin only */}
      {kb && (
        <div style={{ marginTop: '0px', padding: '6px 8px', borderRadius: '4px', background: 'rgba(0,0,0,0.15)', border: `1px solid ${CYB.glowBorder}`, fontSize: '9px', display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
          <span style={{ color: CYB.glow, letterSpacing: '0.1em', fontWeight: 700 }}>{'//KALMAN'}</span>
          <span style={{ color: 'var(--text2)' }}>adj <span style={{ color: kb.correctedMove > 0 ? 'var(--bull)' : kb.correctedMove < 0 ? 'var(--bear)' : 'var(--text3)', fontWeight: 700 }}>{kb.correctedMove >= 0 ? '+' : ''}{kb.correctedMove.toFixed(3)}%</span></span>
          <span style={{ color: kb.bias > 0.01 ? 'var(--bull)' : kb.bias < -0.01 ? 'var(--bear)' : 'var(--text3)' }}>bias {kb.bias >= 0 ? '+' : ''}{kb.bias.toFixed(3)}% {Math.abs(kb.bias) > 0.01 ? (kb.bias > 0 ? '·cold' : '·hot') : '·'}</span>
          <span style={{ color: 'var(--text3)' }}>σ=±{kb.sigma.toFixed(3)}%</span>
          <span style={{ color: 'var(--text3)' }}>rmse={kb.rmse.toFixed(3)}%</span>
          <span style={{ color: 'var(--text3)' }}>hit±0.3%: {Math.round(kb.hitRate * 100)}%</span>
          <span style={{ color: 'var(--text3)' }}>n={kb.nResolved}</span>
        </div>
      )}
      {!kb && role !== 'viewer' && comp.status === 'ready' && (
        <div style={{ fontSize: '9px', color: 'var(--text3)' }}>
          {'//KALMAN'} calibrating — {(n50.sysLog ?? []).filter(e => e.resolved).length}/5 resolved
        </div>
      )}

      {/* //SIGNAL QUALITY — 6 oracle readiness indicators */}
      {pred.status === 'ready' && (() => {
        const pa = n50.phaseAnalysis
        const isTradeableSim   = pred.topSim >= 0.40
        const isTradeableConf  = comp.confidence >= 0.25
        const isTradeableStab  = !pa || pa.featureMaxStd < 0.50
        const isTradeableMove  = Math.abs(pred.predictedMove) >= 0.15
        const passCount = [isTradeableSim, isTradeableConf, isTradeableStab, isTradeableMove].filter(Boolean).length
        const sqStatus  = passCount === 4 ? 'GO' : passCount >= 2 ? 'CAUTION' : 'NO'
        const sqColor   = sqStatus === 'GO' ? '#4ecdc4' : sqStatus === 'CAUTION' ? '#ffd93d' : '#ff6b6b'
        const sqBg      = sqStatus === 'GO' ? 'rgba(78,205,196,0.08)' : sqStatus === 'CAUTION' ? 'rgba(255,217,61,0.08)' : 'rgba(255,107,107,0.08)'

        // Effective-N from topSim² heuristic (softmax concentrates mass near topSim)
        const effectiveN = Math.max(1, Math.round(pred.nResolved * pred.topSim * pred.topSim * 4))

        // Microstructure vs kNN divergence — "memory only" when most stocks are NEUTRAL but kNN is directional
        const compScoreNeutral = (n50.bullStockPct + n50.bearStockPct) < 20
        const knnDirectional   = pred.bullProb > 0.70 || pred.bearProb > 0.70
        const memoryOnly       = compScoreNeutral && knnDirectional

        // OBI vs CD divergence check
        const obiDir = tech.avgImbalance > 0.08 ? 'BULL' : tech.avgImbalance < -0.08 ? 'BEAR' : null
        const cdDir  = tech.avgCdZ > 0.3 ? 'BULL' : tech.avgCdZ < -0.3 ? 'BEAR' : null
        const obiCdConflict = obiDir !== null && cdDir !== null && obiDir !== cdDir

        // topSim sparkline
        const simBars = topSimHistory.slice(-12)
        const simBarH = 16
        const simBarW = 8

        return (
          <div style={{ padding: '7px 9px', borderRadius: '4px', background: sqBg, border: `1px solid ${sqColor}30`, display: 'flex', flexDirection: 'column', gap: '5px' }}>
            {/* Header: TRADEABLE status + checklist */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '7px', color: CYB.glow, letterSpacing: '0.15em', fontWeight: 700 }}>{'//SIGNAL QUALITY'}</span>
              <span style={{
                fontSize: '9px', fontWeight: 800, padding: '1px 8px', borderRadius: '3px',
                background: sqColor + '22', border: `1px solid ${sqColor}60`, color: sqColor, letterSpacing: '0.12em',
              }}>{sqStatus === 'GO' ? '✓ TRADEABLE' : sqStatus === 'CAUTION' ? '~ WEAK' : '✗ NOT TRADEABLE'}</span>
              <span style={{ fontSize: '8px', color: 'var(--text3)', marginLeft: 'auto' }}>{passCount}/4 checks</span>
            </div>

            {/* 4 checklist items */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 12px', fontSize: '8px' }}>
              {([
                [isTradeableSim,  `sim ${pred.topSim.toFixed(2)}`, `need ≥0.40 · eff-n~${effectiveN}`],
                [isTradeableConf, `conf ${(comp.confidence*100).toFixed(0)}%`, 'need ≥25%'],
                [isTradeableStab, pa ? `σ ${pa.featureMaxStd.toFixed(2)}` : 'stab n/a', 'need σ<0.50'],
                [isTradeableMove, `|Δ| ${Math.abs(pred.predictedMove).toFixed(3)}%`, 'need ≥0.15%'],
              ] as [boolean,string,string][]).map(([pass, val, need]) => (
                <div key={need} style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                  <span style={{ color: pass ? '#4ecdc4' : '#ff6b6b', fontWeight: 700, width: '10px' }}>{pass ? '✓' : '✗'}</span>
                  <span style={{ color: pass ? 'var(--text2)' : 'var(--text3)', fontWeight: 600 }}>{val}</span>
                  {!pass && <span style={{ color: 'var(--text3)', fontSize: '7px' }}>{need}</span>}
                </div>
              ))}
            </div>

            {/* topSim sparkline */}
            {simBars.length >= 2 && (
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: '1px', marginTop: '1px' }}>
                <span style={{ fontSize: '7px', color: 'var(--text3)', marginRight: '3px', lineHeight: '1', alignSelf: 'center' }}>sim</span>
                {simBars.map((s, i) => {
                  const h = Math.max(2, Math.round((s.sim / 1.0) * simBarH))
                  const c = s.sim >= 0.40 ? '#4ecdc4' : s.sim >= 0.25 ? '#ffd93d' : '#ff6b6b'
                  const dirMark = s.dir === 'BULL' ? '▲' : s.dir === 'BEAR' ? '▼' : '·'
                  return (
                    <div key={i} title={`sim=${s.sim.toFixed(2)} ${s.dir ?? 'NEUTRAL'}`} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1px' }}>
                      <span style={{ fontSize: '5px', color: s.dir === 'BULL' ? 'var(--bull)' : s.dir === 'BEAR' ? 'var(--bear)' : 'var(--text3)', lineHeight: '1' }}>{dirMark}</span>
                      <div style={{ width: `${simBarW}px`, height: `${h}px`, background: c, borderRadius: '1px', opacity: 0.7 + 0.3 * (i / simBars.length) }} />
                      <span style={{ fontSize: '5px', color: 'var(--text3)', lineHeight: '1' }}>{s.sim.toFixed(2)}</span>
                    </div>
                  )
                })}
                <div style={{ width: '1px', height: `${Math.round(0.4 * simBarH)}px`, background: '#4ecdc4', opacity: 0.4, marginLeft: '2px', alignSelf: 'flex-end' }} title="0.40 threshold" />
              </div>
            )}

            {/* Divergence warnings */}
            {memoryOnly && (
              <div style={{ fontSize: '8px', color: '#ffd93d', background: 'rgba(255,217,61,0.08)', borderRadius: '3px', padding: '2px 6px', borderLeft: '2px solid #ffd93d' }}>
                ⚠ MEMORY ONLY — oracle from patterns, no live book signal (all {(n50.heavyweights?.length ?? 0) + (n50.midweights?.length ?? 0) + (n50.lowweights?.length ?? 0)} stocks NEUTRAL)
              </div>
            )}
            {obiCdConflict && (
              <div style={{ fontSize: '8px', color: '#fb923c', background: 'rgba(251,146,60,0.08)', borderRadius: '3px', padding: '2px 6px', borderLeft: '2px solid #fb923c' }}>
                ⚡ OBI·CD CONFLICT — book={obiDir} cd={cdDir} · Kyle model: follow CD, not book
              </div>
            )}
            {pa?.stabilityLabel === 'NOISY' && (
              <div style={{ fontSize: '8px', color: '#f87171', background: 'rgba(248,113,113,0.07)', borderRadius: '3px', padding: '2px 6px', borderLeft: '2px solid #f87171' }}>
                ✗ STATE UNSTABLE — σ={pa.featureMaxStd.toFixed(2)} · features unsettled, oracle unreliable until STABLE
              </div>
            )}
          </div>
        )
      })()}

      {/* Component breakdown: Pattern KNN + Pat60_20 + Technicals */}
      <div style={{
        display: 'flex', flexDirection: 'column', gap: '3px',
        padding: '6px 8px', borderRadius: '4px',
        background: 'rgba(0,0,0,0.15)',
        border: `1px solid ${CYB.glowBorder}`,
      }}>
        <div
          onClick={() => setShowComponents(s => !s)}
          style={{ fontSize: '7px', color: CYB.glow, letterSpacing: '0.15em', opacity: 0.5, marginBottom: '2px', cursor: 'pointer', userSelect: 'none', display: 'flex', alignItems: 'center', gap: '4px' }}
        >
          <span>{showComponents ? '▼' : '▶'}</span>
          <span>{'//COMPONENTS'}</span>
        </div>

        {showComponents && <>
        {/* Pattern KNN (n50 300-dim attention) */}
        {(() => {
          const effN = pred.status === 'ready' ? Math.max(1, Math.round(pred.nResolved * pred.topSim * pred.topSim * 4)) : 0
          const simWarn = pred.status === 'ready' && pred.topSim < 0.4
          return (
            <SignalRow
              label="PAT·N50"
              bullPct={patBull} bearPct={patBear}
              move={pred.status === 'ready' ? pred.predictedMove : undefined}
              detail={pred.status === 'ready' ? (role !== 'viewer' ? `sim ${pred.topSim.toFixed(2)}${simWarn ? '⚠' : ''} · n=${pred.nResolved} eff~${effN}` : '') : pred.status}
              dim={pred.status !== 'ready'}
            />
          )
        })()}

        {/* Pat60_20 aggregate (per-stock 60min→20min patterns) */}
        {tech.pat60_20 && (
          <SignalRow
            label="PAT·60→20"
            bullPct={tech.pat60_20.avgBull} bearPct={tech.pat60_20.avgBear}
            move={tech.pat60_20.avgMove}
            detail={`n=${tech.pat60_20.n} stocks`}
          />
        )}

        {/* Technical aggregate */}
        <SignalRow
          label="TECH"
          bullPct={techBullPct} bearPct={techBearPct}
          detail={`${tech.stocksWithIndicators} ind`}
        />

        {/* Technical detail row */}
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', paddingLeft: '56px', fontSize: '8px', color: 'var(--text3)' }}>
          {tech.avgRsi != null && (
            <span>RSI <span style={{
              fontWeight: 600,
              color: tech.avgRsi > 60 ? 'var(--bull)' : tech.avgRsi < 40 ? 'var(--bear)' : 'var(--text2)',
            }}>{tech.avgRsi.toFixed(0)}</span></span>
          )}
          {tech.avgAtrPct != null && (
            <span>ATR <span style={{ fontWeight: 600, color: 'var(--text2)' }}>{tech.avgAtrPct.toFixed(2)}%</span></span>
          )}
          <span>VWAP <span style={{ fontWeight: 600, color: 'var(--bull)' }}>{fmtPct(tech.vwapBullPct)}</span>/<span style={{ fontWeight: 600, color: 'var(--bear)' }}>{fmtPct(tech.vwapBearPct)}</span></span>
          <span>EMA <span style={{ fontWeight: 600, color: 'var(--bull)' }}>{fmtPct(tech.emaBullPct)}</span>/<span style={{ fontWeight: 600, color: 'var(--bear)' }}>{fmtPct(tech.emaBearPct)}</span></span>
          <span>CD <span style={{
            fontWeight: 600,
            color: tech.avgCdZ > 0.5 ? 'var(--bull)' : tech.avgCdZ < -0.5 ? 'var(--bear)' : 'var(--text2)',
          }}>{tech.avgCdZ >= 0 ? '+' : ''}{tech.avgCdZ.toFixed(1)}σ</span></span>
          {(tech.cusumBullCount > 0 || tech.cusumBearCount > 0) && (
            <span>CUSUM <span style={{ fontWeight: 600, color: 'var(--bull)' }}>{tech.cusumBullCount}B</span>/<span style={{ fontWeight: 600, color: 'var(--bear)' }}>{tech.cusumBearCount}S</span></span>
          )}
        </div>

        {/* Flow row */}
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', paddingLeft: '56px', fontSize: '8px', color: 'var(--text3)' }}>
          <span>trend <span style={{ fontWeight: 600, color: 'var(--bull)' }}>{fmtPct(tech.trendBullPct)}</span>/<span style={{ fontWeight: 600, color: 'var(--bear)' }}>{fmtPct(tech.trendBearPct)}</span></span>
          <span>OBI <span style={{
            fontWeight: 600,
            color: tech.avgImbalance > 0.1 ? 'var(--bull)' : tech.avgImbalance < -0.1 ? 'var(--bear)' : 'var(--text2)',
          }}>{tech.avgImbalance >= 0 ? '+' : ''}{tech.avgImbalance.toFixed(2)}</span></span>
          <span>agg <span style={{
            fontWeight: 600,
            color: tech.avgAggRatio > 0.1 ? 'var(--bull)' : tech.avgAggRatio < -0.1 ? 'var(--bear)' : 'var(--text2)',
          }}>{tech.avgAggRatio >= 0 ? '+' : ''}{tech.avgAggRatio.toFixed(2)}</span></span>
        </div>

        {/* Phase Analysis — 4 metrics */}
        {n50.phaseAnalysis && (() => {
          const pa = n50.phaseAnalysis!
          const phaseColor = pa.phase === 'START' ? '#a78bfa' : pa.phase === 'MID' ? '#34d399' : pa.phase === 'END' ? '#f87171' : 'var(--text3)'
          const obiColor = pa.obiCdPhase === 'HIDDEN' ? '#fbbf24' : pa.obiCdPhase === 'VISIBLE' ? '#34d399' : 'var(--text3)'
          const rocColor = pa.cdVelRoCLabel === 'ACCELERATING' ? 'var(--bull)' : pa.cdVelRoCLabel === 'DECELERATING' ? 'var(--bear)' : 'var(--text3)'
          const knnColor = pa.knnConsistency === 'ALIGNED' ? '#34d399' : pa.knnConsistency === 'MIXED' ? '#fbbf24' : 'var(--text3)'
          const stabColor = pa.stabilityLabel === 'STABLE' ? '#34d399' : pa.stabilityLabel === 'TRANSITIONING' ? '#fbbf24' : '#f87171'
          return (
            <>
              {/* Phase header row */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', paddingLeft: '56px', marginTop: '3px', fontSize: '8px', color: 'var(--text3)' }}>
                <span style={{ fontWeight: 700, color: CYB.glow, letterSpacing: '0.1em' }}>PHASE</span>
                <span style={{ fontWeight: 700, color: phaseColor }}>{pa.phase}</span>
                <span style={{ color: 'var(--text3)' }}>{(pa.confidence * 100).toFixed(0)}%</span>
                <span style={{ fontWeight: 600, color: stabColor }}>{pa.stabilityLabel}</span>
                <span style={{ color: 'var(--text3)' }}>σ={pa.featureMaxStd.toFixed(3)}</span>
                {pa.stabilityLabel === 'NOISY' && (
                  <span style={{ fontSize: '7px', color: '#f87171', background: 'rgba(248,113,113,0.12)', borderRadius: '2px', padding: '0 3px' }}>oracle↓</span>
                )}
                {pa.stabilityLabel === 'STABLE' && (
                  <span style={{ fontSize: '7px', color: '#4ecdc4', background: 'rgba(78,205,196,0.12)', borderRadius: '2px', padding: '0 3px' }}>oracle↑</span>
                )}
              </div>
              {/* 4 metric detail row */}
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', paddingLeft: '56px', fontSize: '8px', color: 'var(--text3)' }}>
                <span>
                  cdVelZ <span style={{ fontWeight: 600, color: rocColor }}>
                    {pa.cdVelRoC >= 0 ? '+' : ''}{pa.cdVelRoC.toFixed(3)}
                  </span>
                  <span style={{ color: rocColor }}> {pa.cdVelRoCLabel.slice(0, 5)}</span>
                </span>
                <span>
                  OBI·CD·r <span style={{ fontWeight: 600, color: obiColor }}>
                    {pa.obiCdCorr >= 0 ? '+' : ''}{pa.obiCdCorr.toFixed(2)}
                  </span>
                  <span style={{ color: obiColor }}> {pa.obiCdPhase}</span>
                </span>
                <span>
                  kNN <span style={{ fontWeight: 600, color: knnColor }}>{pa.knnConsistencyDetail}</span>
                </span>
                {pa.obiCdPhase === 'HIDDEN' && (
                  <span style={{ fontSize: '7px', color: '#fbbf24', background: 'rgba(251,191,36,0.1)', borderRadius: '2px', padding: '0 3px' }}>Kyle: institution hiding</span>
                )}
                {pa.obiCdPhase === 'VISIBLE' && (
                  <span style={{ fontSize: '7px', color: '#34d399', background: 'rgba(52,211,153,0.1)', borderRadius: '2px', padding: '0 3px' }}>Stackelberg: markup visible</span>
                )}
              </div>
            </>
          )
        })()}

        </>}
      </div>

      {/* Weight tiers — HEAVY / MID / LOW, all N50 constituents */}
      {(() => {
        type WD = { name: string; weight: number; trend: string; cdZ: number; pat30v2Bull: number; pat30v2Bear: number }

        function tierSummary(stocks: WD[]) {
          const bullW = stocks.filter(h => h.trend === 'BULL').reduce((s, h) => s + h.weight, 0)
          const bearW = stocks.filter(h => h.trend === 'BEAR').reduce((s, h) => s + h.weight, 0)
          const totalW = stocks.reduce((s, h) => s + h.weight, 0)
          const bullPct = totalW > 0 ? Math.round((bullW / totalW) * 100) : 0
          const bearPct = totalW > 0 ? Math.round((bearW / totalW) * 100) : 0
          const dir = bullPct > bearPct + 20 ? 'BULL' : bearPct > bullPct + 20 ? 'BEAR' : null
          return { bullPct, bearPct, dir, totalW }
        }

        function WeightTierRow({ label, stocks, chipSize }: { label: string; stocks: WD[]; chipSize: number }) {
          if (!stocks || stocks.length === 0) return null
          const { bullPct, bearPct, dir, totalW } = tierSummary(stocks)
          return (
            <div style={{
              padding: '5px 7px', borderRadius: '4px',
              background: 'rgba(0,0,0,0.15)',
              border: `1px solid ${dir === 'BULL' ? 'rgba(34,197,94,0.25)' : dir === 'BEAR' ? 'rgba(239,68,68,0.25)' : CYB.glowBorder}`,
              marginBottom: '4px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                <span style={{ fontSize: '8px', color: CYB.glow, letterSpacing: '0.1em', fontWeight: 700, width: '48px' }}>{label}</span>
                <span style={{ fontSize: '12px', fontWeight: 700, color: dir === 'BULL' ? 'var(--bull)' : dir === 'BEAR' ? 'var(--bear)' : 'var(--text2)' }}>
                  {dir === 'BULL' ? '▲' : dir === 'BEAR' ? '▼' : '·'} {bullPct}B / {bearPct}S
                </span>
                <span style={{ fontSize: '9px', color: 'var(--text3)' }}>· {Math.round(totalW)}% of index</span>
              </div>
              <div style={{ display: 'flex', gap: '3px', flexWrap: 'wrap' }}>
                {stocks.map(h => {
                  const dir2 = h.trend === 'BULL' ? 'bull' : h.trend === 'BEAR' ? 'bear' : 'neut'
                  const patDir = h.pat30v2Bull > 60 ? 'bull' : h.pat30v2Bear > 60 ? 'bear' : 'neut'
                  const color = dir2 === 'bull' ? 'var(--bull)' : dir2 === 'bear' ? 'var(--bear)' : 'var(--text3)'
                  return (
                    <div key={h.name} style={{
                      padding: `2px ${chipSize >= 10 ? 5 : 4}px`, borderRadius: '3px',
                      background: dir2 === 'bull' ? 'rgba(34,197,94,0.09)' : dir2 === 'bear' ? 'rgba(239,68,68,0.09)' : 'rgba(255,255,255,0.03)',
                      border: `1px solid ${dir2 === 'bull' ? 'rgba(34,197,94,0.18)' : dir2 === 'bear' ? 'rgba(239,68,68,0.18)' : 'var(--border)'}`,
                      display: 'flex', gap: '3px', alignItems: 'center',
                    }}>
                      <span style={{ fontWeight: 700, color, fontSize: `${chipSize}px` }}>{h.name}</span>
                      <span style={{ color: 'var(--text3)', fontSize: '8px' }}>{h.weight.toFixed(1)}%</span>
                      <span style={{ color, fontSize: '9px' }}>{h.trend === 'BULL' ? '▲' : h.trend === 'BEAR' ? '▼' : '·'}</span>
                      <span style={{ fontSize: '8px', color: h.cdZ > 0.5 ? 'var(--bull)' : h.cdZ < -0.5 ? 'var(--bear)' : 'var(--text3)' }}>
                        cd{h.cdZ >= 0 ? '+' : ''}{h.cdZ.toFixed(1)}
                      </span>
                      <span style={{ fontSize: '8px', fontWeight: 600, color: patDir === 'bull' ? 'var(--bull)' : patDir === 'bear' ? 'var(--bear)' : 'var(--text3)' }}>
                        {h.pat30v2Bull}/{h.pat30v2Bear}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        }

        const allStocks = [...(n50.heavyweights ?? []), ...(n50.midweights ?? []), ...(n50.lowweights ?? [])]
        const n50Summary = tierSummary(allStocks)
        const n50Dir = n50Summary.dir
        const n50Color = n50Dir === 'BULL' ? 'var(--bull)' : n50Dir === 'BEAR' ? 'var(--bear)' : 'var(--text2)'
        const n50BgColor = n50Dir === 'BULL' ? 'rgba(34,197,94,0.07)' : n50Dir === 'BEAR' ? 'rgba(239,68,68,0.07)' : 'rgba(255,255,255,0.03)'
        const n50BorderColor = n50Dir === 'BULL' ? 'rgba(34,197,94,0.35)' : n50Dir === 'BEAR' ? 'rgba(239,68,68,0.35)' : CYB.glowBorder
        const bullCount = allStocks.filter(s => s.trend === 'BULL').length
        const bearCount = allStocks.filter(s => s.trend === 'BEAR').length
        const neutCount = allStocks.length - bullCount - bearCount

        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0px', border: `1px solid ${n50BorderColor}`, borderRadius: '6px', background: n50BgColor, overflow: 'hidden' }}>
            {/* NIFTY 50 summary header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '6px 10px', borderBottom: `1px solid ${n50BorderColor}` }}>
              <span style={{ fontSize: '8px', color: CYB.glow, letterSpacing: '0.12em', fontWeight: 700 }}>NIFTY·50</span>
              <span style={{ fontSize: '15px', fontWeight: 800, color: n50Color }}>
                {n50Dir === 'BULL' ? '▲' : n50Dir === 'BEAR' ? '▼' : '·'} {n50Summary.bullPct}B / {n50Summary.bearPct}S
              </span>
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span style={{ fontSize: '9px', fontWeight: 700, color: 'var(--bull)', width: '22px', textAlign: 'right' }}>{n50Summary.bullPct}</span>
                <MiniBar bull={n50Summary.bullPct} bear={n50Summary.bearPct} height={6} />
                <span style={{ fontSize: '9px', fontWeight: 700, color: 'var(--bear)', width: '22px' }}>{n50Summary.bearPct}</span>
              </div>
              <span style={{ fontSize: '8px', color: 'var(--text3)', marginLeft: 'auto' }}>
                {bullCount}▲ {bearCount}▼ {neutCount}·
              </span>
            </div>
            {/* Tier rows inside the wrapper */}
            <div style={{ padding: '4px 6px', display: 'flex', flexDirection: 'column', gap: '0px' }}>
              <WeightTierRow label="HEAVY" stocks={n50.heavyweights ?? []} chipSize={10} />
              <WeightTierRow label="MID" stocks={n50.midweights ?? []} chipSize={9} />
              <WeightTierRow label="LOW" stocks={n50.lowweights ?? []} chipSize={9} />
            </div>
          </div>
        )
      })()}

      {/* Day prediction */}
      {dayPred && dayPred.status === 'ready' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '8px', color: 'var(--text3)', letterSpacing: '0.1em', width: '48px' }}>NEXT DAY</span>
          <span style={{
            fontSize: '13px', fontWeight: 700, color: dayPred.predictedMove >= 0 ? 'var(--bull)' : 'var(--bear)',
            padding: '2px 8px', borderRadius: '3px',
            background: dayPred.predictedMove >= 0 ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
          }}>
            {dayPred.direction === 'BULL' ? '▲' : dayPred.direction === 'BEAR' ? '▼' : '·'} {dayPred.predictedMove >= 0 ? '+' : ''}{dayPred.predictedMove.toFixed(3)}%
          </span>
          {dayPred.targetDay && (
            <span style={{ fontSize: '9px', color: isResolved ? 'var(--text3)' : 'var(--text2)', fontWeight: 600 }}>
              {isResolved
                ? `resolved · ${dayLog[dayLog.length - 1].correct ? '✓' : '✗'} actual ${dayLog[dayLog.length - 1].actualProxy20 >= 0 ? '+' : ''}${dayLog[dayLog.length - 1].actualProxy20.toFixed(3)}%`
                : `→ ${dayPred.targetDay}`}
            </span>
          )}
          {dayLog.length >= 2 && (
            <span style={{ fontSize: '9px', color: 'var(--text2)', fontWeight: 600, marginLeft: 'auto' }}>
              {winCount}W {dayLog.length - winCount}L
              {dayLog.length >= 3 && ` · ${Math.round((winCount / dayLog.length) * 100)}%`}
            </span>
          )}
        </div>
      )}

      {/* Day track record chips */}
      {dayLog.length > 0 && (
        <div style={{ display: 'flex', gap: '3px', flexWrap: 'wrap', paddingLeft: '56px' }}>
          {dayLog.map((entry, i) => (
            <div key={i} title={`${entry.captureDay} → ${entry.targetDay}\nPred: ${entry.predictedDirection ?? '—'} ${entry.predictedMove >= 0 ? '+' : ''}${entry.predictedMove.toFixed(3)}%\nActual: ${entry.actualProxy20 >= 0 ? '+' : ''}${entry.actualProxy20.toFixed(3)}%`}
              style={{
                padding: '2px 5px', borderRadius: '3px', cursor: 'default',
                background: entry.correct ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
                border: `1px solid ${entry.correct ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}`,
                display: 'flex', alignItems: 'center', gap: '3px',
              }}>
              <span style={{ fontSize: '9px', fontWeight: 700, color: entry.correct ? 'var(--bull)' : 'var(--bear)' }}>
                {entry.correct ? '✓' : '✗'}
              </span>
              <span style={{ fontSize: '8px', color: dirColor(entry.predictedDirection) }}>
                {entry.predictedDirection === 'BULL' ? '▲' : '▼'}
              </span>
              <span style={{ fontSize: '8px', color: 'var(--text3)' }}>{entry.targetDay.slice(5)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Breadth */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span style={{ fontSize: '8px', color: 'var(--text3)', letterSpacing: '0.1em', width: '48px' }}>BREADTH</span>
        <span style={{ fontSize: '9px', fontWeight: 600, color: 'var(--bull)', width: '22px', textAlign: 'right' }}>{n50.bullStockPct}%</span>
        <MiniBar bull={n50.bullStockPct} bear={n50.bearStockPct} />
        <span style={{ fontSize: '9px', fontWeight: 600, color: 'var(--bear)', width: '22px' }}>{n50.bearStockPct}%</span>
      </div>
    </div>
  )
}

// ── N50 Contracts (compact) ──────────────────────────────────────────────

interface OrderState {
  confirm: { symbol: string; type: 'BUY' | 'SELL'; lot: number } | null
  status: { msg: string; ok: boolean } | null
  ordering: boolean
}

function N50ContractsCompact({ n50, orderState, setOrderState }: {
  n50: N50State | null
  orderState: OrderState
  setOrderState: (fn: (prev: OrderState) => OrderState) => void
}) {
  const contracts = n50?.contracts
  const contractsRef = useRef(contracts)
  contractsRef.current = contracts
  const orderingRef = useRef(false)

  useEffect(() => {
    if (!orderState.confirm || !contracts || orderState.ordering) return
    const allSymbols = [...contracts.bull, ...contracts.bear].map(c => c.tradingsymbol)
    if (!allSymbols.includes(orderState.confirm.symbol)) {
      setOrderState(s => ({
        ...s, confirm: null,
        status: { msg: `${s.confirm?.symbol} no longer available — ATM shifted`, ok: false },
      }))
    }
  }, [contracts, orderState.confirm, orderState.ordering, setOrderState])

  if (!contracts) return (
    <div style={{ padding: '12px', background: CYB.panel, border: `1px solid ${CYB.glowBorder}`, borderRadius: '6px' }}>
      <span style={{ fontSize: '10px', color: CYB.glow, opacity: 0.6 }}>{'> LOADING CONTRACTS...'}</span>
    </div>
  )

  const spot = n50!.niftySpot ?? contracts.spotEstimate
  const atm = Math.round(spot / 50) * 50
  const hasLiveSpot = n50!.niftySpot != null && n50!.niftySpot > 0
  const lotSize = contracts.lotSize
  const { confirm } = orderState

  async function placeOrder() {
    if (!confirm || orderingRef.current) return
    orderingRef.current = true
    const currentContracts = contractsRef.current
    const allSymbols = [...(currentContracts?.bull ?? []), ...(currentContracts?.bear ?? [])].map(c => c.tradingsymbol)
    if (!allSymbols.includes(confirm.symbol)) {
      orderingRef.current = false
      setOrderState(s => ({ ...s, confirm: null, status: { msg: `Contract ${confirm.symbol} no longer available`, ok: false } }))
      return
    }
    setOrderState(s => ({ ...s, ordering: true, status: null }))
    try {
      const res = await fetch('/api/nifty50/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tradingsymbol: confirm.symbol, transaction_type: confirm.type, lotSize: confirm.lot }),
      })
      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
      if (data.ok) {
        setOrderState(() => ({ confirm: null, ordering: false, status: { msg: `${data.order_id} @ ₹${data.price}`, ok: true } }))
      } else {
        setOrderState(s => ({ ...s, ordering: false, status: { msg: data.error ?? 'Order failed', ok: false } }))
      }
    } catch (err) {
      setOrderState(s => ({ ...s, ordering: false, status: { msg: String(err), ok: false } }))
    } finally { orderingRef.current = false }
  }

  function StrikeRow({ opt, color, bgColor, txnType }: { opt: NiftyOption; color: string; bgColor: string; txnType: 'BUY' | 'SELL' }) {
    const isATM = opt.strike === atm
    const shortSym = opt.tradingsymbol.replace(/^NIFTY\d{2}[A-Z]{3}/, '')
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: '4px',
        padding: '3px 4px', borderRadius: '3px',
        background: isATM ? bgColor : 'transparent',
        border: isATM ? `1px solid ${color}` : '1px solid transparent',
        minWidth: 0,
      }}>
        <span style={{ fontSize: '10px', fontWeight: 700, color, flexShrink: 0 }}>{opt.strike}</span>
        <span style={{ fontSize: '8px', color: 'var(--text3)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
          {shortSym}
        </span>
        {isATM && <span style={{ fontSize: '7px', fontWeight: 700, color, letterSpacing: '0.05em', flexShrink: 0 }}>ATM</span>}
        <button
          onClick={() => setOrderState(s => ({ ...s, confirm: { symbol: opt.tradingsymbol, type: txnType, lot: lotSize }, status: null }))}
          disabled={!!confirm}
          style={{
            fontSize: '7px', fontWeight: 700, fontFamily: 'inherit',
            padding: '2px 5px', borderRadius: '2px', flexShrink: 0,
            cursor: confirm ? 'not-allowed' : 'pointer',
            background: txnType === 'BUY' ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
            color, border: `1px solid ${color}`,
            opacity: confirm ? 0.4 : 1,
          }}
        >BUY</button>
      </div>
    )
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: '8px',
      padding: '12px', background: CYB.panel, borderRadius: '6px',
      border: `1px solid ${CYB.glowBorder}`,
      backgroundImage: CYB.scanline,
    }}>
      <SysHeader label="CONTRACTS" sub={`exp ${contracts.expiry} · lot ${lotSize}`}
        right={<span style={{ fontSize: '10px', color: 'var(--text3)' }}>
          {hasLiveSpot ? '' : '~'}{spot.toFixed(0)} · ATM {atm}
        </span>}
      />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', minWidth: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0, overflow: 'hidden' }}>
          <span style={{ fontSize: '8px', fontWeight: 700, letterSpacing: '0.1em', color: 'var(--bull)', padding: '0 4px' }}>BULL CE</span>
          {contracts.bull.map(opt => <StrikeRow key={opt.tradingsymbol} opt={opt} color="var(--bull)" bgColor="rgba(34,197,94,0.08)" txnType="BUY" />)}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0, overflow: 'hidden' }}>
          <span style={{ fontSize: '8px', fontWeight: 700, letterSpacing: '0.1em', color: 'var(--bear)', padding: '0 4px' }}>BEAR PE</span>
          {contracts.bear.map(opt => <StrikeRow key={opt.tradingsymbol} opt={opt} color="var(--bear)" bgColor="rgba(239,68,68,0.08)" txnType="BUY" />)}
        </div>
      </div>

      {confirm && (
        <div style={{
          padding: '6px 8px', borderRadius: '4px',
          background: 'var(--bg)', border: `1px solid ${CYB.glow}`,
          display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap',
        }}>
          <span style={{ fontSize: '9px', color: 'var(--text2)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {confirm.type} <span style={{ fontWeight: 700, color: 'var(--text)' }}>{confirm.symbol.replace(/^NIFTY\d{2}[A-Z]{3}/, '')}</span> ×{confirm.lot}
          </span>
          <button onClick={placeOrder} disabled={orderState.ordering} style={{
            fontSize: '9px', fontWeight: 700, fontFamily: 'inherit',
            padding: '4px 12px', borderRadius: '3px', cursor: orderState.ordering ? 'not-allowed' : 'pointer',
            background: 'var(--bull)', color: 'var(--bg)', border: 'none',
            opacity: orderState.ordering ? 0.6 : 1,
          }}>{orderState.ordering ? '...' : 'CONFIRM'}</button>
          <button onClick={() => setOrderState(s => ({ ...s, confirm: null }))} disabled={orderState.ordering} style={{
            fontSize: '9px', fontFamily: 'inherit', padding: '4px 8px', borderRadius: '3px',
            cursor: 'pointer', background: 'transparent', color: 'var(--text3)', border: '1px solid var(--border)',
          }}>X</button>
        </div>
      )}

      {orderState.status && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          fontSize: '10px', padding: '6px 10px', borderRadius: '3px',
          background: orderState.status.ok ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
          color: orderState.status.ok ? 'var(--bull)' : 'var(--bear)',
        }}>
          <span>{orderState.status.msg}</span>
          <button onClick={() => setOrderState(s => ({ ...s, status: null }))}
            style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: '10px', fontFamily: 'inherit' }}>dismiss</button>
        </div>
      )}
    </div>
  )
}

// ── N50 Command Center (grid container) ──────────────────────────────────

function N50CommandCenter({ n50, role = 'admin' }: {
  n50: N50State | null
  role?: string
}) {
  return <N50Oracle n50={n50} role={role} />
}

// ── Option Metrics (Delta, Theta, Sensitivity) ─────────────────────────

interface OptionMetrics {
  dte: number
  strike: number
  optType: 'CE' | 'PE'
  moneyness: number
  intrinsic: number
  timeValue: number
  delta: number
  dailyDecay: number
  decayPct: number
  tomorrowPrice: number
  pnlPerPt: number
  pnlPer10pt: number
}

function estimateOptionMetrics(symbol: string, currentBid: number | null, spot: number | null, lotSize: number): OptionMetrics | null {
  if (!currentBid || currentBid <= 0 || !spot || spot <= 0) return null
  const m = symbol.match(/(\d{2})([A-Z]{3})(\d{3,6})(CE|PE)$/)
  if (!m) return null
  const months: Record<string, number> = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 }
  const yr = 2000 + parseInt(m[1])
  const mo = months[m[2]]
  if (mo === undefined) return null
  const strike = parseInt(m[3])
  const optType = m[4] as 'CE' | 'PE'
  let expiryDate = new Date(yr, mo + 1, 0)
  const dow = expiryDate.getDay()
  const thuOffset = dow >= 4 ? dow - 4 : dow + 3
  expiryDate = new Date(expiryDate.getTime() - thuOffset * 86_400_000)
  const now = new Date()
  const dte = Math.max(0, Math.ceil((expiryDate.getTime() - now.getTime()) / 86_400_000))

  const intrinsic = optType === 'PE' ? Math.max(0, strike - spot) : Math.max(0, spot - strike)
  const timeValue = Math.max(0, currentBid - intrinsic)
  const moneyness = optType === 'PE'
    ? (strike - spot) / spot * 100
    : (spot - strike) / spot * 100

  let delta: number
  if (optType === 'PE') {
    delta = -(0.50 + moneyness * 0.05)
    delta = Math.max(-0.90, Math.min(-0.10, delta))
  } else {
    delta = 0.50 + moneyness * 0.05
    delta = Math.max(0.10, Math.min(0.90, delta))
  }

  const pnlPerPt = Math.abs(delta) * lotSize
  const pnlPer10pt = pnlPerPt * 10

  let dailyDecay: number, tomorrowPrice: number
  if (dte <= 0) {
    dailyDecay = timeValue; tomorrowPrice = intrinsic
  } else if (dte === 1) {
    dailyDecay = timeValue * 0.35; tomorrowPrice = Math.max(0, currentBid - dailyDecay)
  } else {
    const ratio = Math.sqrt((dte - 1) / dte)
    tomorrowPrice = currentBid * ratio
    dailyDecay = currentBid - tomorrowPrice
  }
  const decayPct = currentBid > 0 ? (dailyDecay / currentBid) * 100 : 0

  return { dte, strike, optType, moneyness, intrinsic, timeValue, delta, dailyDecay, decayPct, tomorrowPrice, pnlPerPt, pnlPer10pt }
}

function OptionMetricsDisplay({ symbol, bid, spot, lotSize, direction }: {
  symbol: string; bid: number | null; spot: number | null; lotSize: number; direction: string
}) {
  const om = estimateOptionMetrics(symbol, bid, spot, lotSize)
  if (!om) return null
  const itmLabel = om.moneyness > 0.5 ? 'ITM' : om.moneyness < -0.5 ? 'OTM' : 'ATM'
  const itmColor = om.moneyness > 0.5 ? 'var(--bull)' : om.moneyness < -0.5 ? 'var(--bear)' : 'var(--text2)'
  const breakeven = om.optType === 'PE' ? om.strike - (bid ?? 0) : om.strike + (bid ?? 0)
  const beDistance = spot ? Math.abs(spot - breakeven) : 0
  const bePct = spot ? (beDistance / spot * 100) : 0
  const beLabel = om.optType === 'PE' ? `≤₹${breakeven.toFixed(0)}` : `≥₹${breakeven.toFixed(0)}`

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', fontSize: '11px', marginTop: '2px' }}>
      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ color: itmColor, fontWeight: 700 }}>
          {itmLabel} {om.moneyness > 0 ? '+' : ''}{om.moneyness.toFixed(1)}%
        </span>
        <span style={{ color: 'var(--text2)' }}>
          δ{Math.abs(om.delta).toFixed(2)}
        </span>
        <span style={{ color: 'var(--text2)', fontWeight: 600 }}>
          ₹{om.pnlPerPt.toFixed(0)}/pt
        </span>
        <span style={{ color: 'var(--text3)' }}>
          10pt=₹{Math.round(om.pnlPer10pt).toLocaleString('en-IN')}
        </span>
      </div>
      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ color: 'var(--bear)' }}>
          θ -₹{(om.dailyDecay * lotSize).toFixed(0)}/day
        </span>
        <span style={{ color: 'var(--text3)' }}>
          {om.dte}d to exp
        </span>
        <span style={{ color: 'var(--text3)' }}>
          BE {beLabel} ({bePct.toFixed(1)}%)
        </span>
      </div>
    </div>
  )
}

// ── Positions HUD ────────────────────────────────────────────────────────

// ── Auto Strategy Config ─────────────────────────────────────────────────

interface AutoStrategyConfig {
  // Exit triggers
  n50Flip: boolean
  profitTarget: number | null
  stopLoss: number | null
  trailEnabled: boolean
  trailTriggerPnl: number
  trailPct: number
  maxHoldEnabled: boolean
  maxHoldMin: number
  noProfitEnabled: boolean
  noProfitMin: number
  // N50 prediction filter
  n50MinConf: number
  n50MinProb: number
  // Pattern filter
  patternEnabled: boolean
  patternStore: string
  patternMinProb: number
  patternMinMove: number
  patternExitEnabled: boolean
  patternExitProb: number
  // Technical filters
  rsiEnabled: boolean
  rsiOverbought: number
  rsiOversold: number
  vwapEnabled: boolean
  emaEnabled: boolean
  // Order type
  orderType: 'LIMIT' | 'MARKET'
}

const DEFAULT_AUTO_STRATEGY: AutoStrategyConfig = {
  n50Flip: true, profitTarget: null, stopLoss: null,
  trailEnabled: false, trailTriggerPnl: 200, trailPct: 45,
  maxHoldEnabled: false, maxHoldMin: 60, noProfitEnabled: false, noProfitMin: 10,
  n50MinConf: 0, n50MinProb: 0,
  patternEnabled: false, patternStore: 'pat5', patternMinProb: 60, patternMinMove: 0,
  patternExitEnabled: false, patternExitProb: 70,
  rsiEnabled: false, rsiOverbought: 70, rsiOversold: 30,
  vwapEnabled: false, emaEnabled: false,
  orderType: 'LIMIT',
}

function loadAutoStrategy(sym: string): AutoStrategyConfig {
  try {
    const raw = localStorage.getItem(`auto-strat:${sym}`)
    if (raw) return { ...DEFAULT_AUTO_STRATEGY, ...JSON.parse(raw) }
  } catch { /* ignore */ }
  return { ...DEFAULT_AUTO_STRATEGY }
}

function saveAutoStrategy(sym: string, cfg: AutoStrategyConfig) {
  try { localStorage.setItem(`auto-strat:${sym}`, JSON.stringify(cfg)) } catch { /* ignore */ }
}

function clearAutoStrategy(sym: string) {
  try { localStorage.removeItem(`auto-strat:${sym}`); localStorage.removeItem(`auto-armed:${sym}`) } catch { /* ignore */ }
}

function AutoStrategySection({ label, open, onToggle, children }: {
  label: string; open: boolean; onToggle: () => void; children: React.ReactNode
}) {
  return (
    <div style={{ borderBottom: `1px solid ${CYB.glowBorder}` }}>
      <button onClick={onToggle} style={{
        width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '6px 0', background: 'none', border: 'none', cursor: 'pointer',
        fontFamily: 'inherit', fontSize: '8px', fontWeight: 700, letterSpacing: '0.12em',
        color: CYB.glow,
      }}>
        <span>{label}</span>
        <span style={{ fontSize: '9px', opacity: 0.6 }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && <div style={{ paddingBottom: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>{children}</div>}
    </div>
  )
}

function CfgRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px' }}>
      <span style={{ fontSize: '9px', color: 'var(--text2)', whiteSpace: 'nowrap' }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>{children}</div>
    </div>
  )
}

function CfgToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button onClick={onToggle} style={{
      width: '28px', height: '14px', borderRadius: '7px', border: 'none', cursor: 'pointer',
      background: on ? CYB.glow : 'rgba(255,255,255,0.12)', position: 'relative', transition: 'background 0.2s',
    }}>
      <span style={{
        position: 'absolute', top: '2px', left: on ? '14px' : '2px', width: '10px', height: '10px',
        borderRadius: '50%', background: on ? 'var(--bg)' : 'var(--text3)', transition: 'left 0.2s',
      }} />
    </button>
  )
}

function CfgNum({ value, onChange, min, max, step, width }: {
  value: number; onChange: (v: number) => void; min: number; max: number; step: number; width?: string
}) {
  return (
    <input type="number" value={value} min={min} max={max} step={step}
      onChange={e => onChange(parseFloat(e.target.value) || min)}
      style={{
        width: width ?? '52px', fontSize: '9px', fontFamily: 'inherit',
        padding: '2px 4px', borderRadius: '2px', textAlign: 'right',
        background: 'var(--bg)', color: 'var(--text)', border: `1px solid ${CYB.glowBorder}`,
        outline: 'none',
      }}
    />
  )
}

function CfgSelect({ value, onChange, options }: {
  value: string; onChange: (v: string) => void; options: { v: string; l: string }[]
}) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)} style={{
      fontSize: '9px', fontFamily: 'inherit', padding: '2px 4px', borderRadius: '2px',
      background: 'var(--bg)', color: 'var(--text)', border: `1px solid ${CYB.glowBorder}`,
      outline: 'none',
    }}>
      {options.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
    </select>
  )
}

function PositionExitButton({ pos, onStatus, n50 }: {
  pos: Position
  onStatus: (msg: string, ok: boolean) => void
  n50?: N50State | null
}) {
  const [mode, setMode] = useState<'closed' | 'open' | 'limit'>('closed')
  const [price, setPrice] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const autoKey = `auto-armed:${pos.buySymbol}`
  const [autoArmed, setAutoArmedRaw] = useState(() => {
    try { return localStorage.getItem(autoKey) === '1' } catch { return false }
  })
  const [strat, setStratRaw] = useState<AutoStrategyConfig>(() => loadAutoStrategy(pos.buySymbol))
  const setStrat = useCallback((fn: (prev: AutoStrategyConfig) => AutoStrategyConfig) => {
    setStratRaw(prev => { const next = fn(prev); saveAutoStrategy(pos.buySymbol, next); return next })
  }, [pos.buySymbol])
  const setAutoArmed = useCallback((v: boolean) => {
    setAutoArmedRaw(v)
    try { if (v) localStorage.setItem(autoKey, '1'); else localStorage.removeItem(autoKey) } catch {}
  }, [autoKey])
  const [showConfirmAuto, setShowConfirmAuto] = useState(false)
  const [showConfirmDisarm, setShowConfirmDisarm] = useState(false)
  const [autoPulse, setAutoPulse] = useState(true)
  const autoFiredRef = useRef(false)
  const autoArmedRef = useRef(false)
  const peakPnlRef = useRef(0)
  const armedAtRef = useRef(0)
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({ exit: true })

  const isNifty = pos.buySymbol.startsWith('NIFTY')
  const toggleSection = (k: string) => setOpenSections(p => ({ ...p, [k]: !p[k] }))

  useEffect(() => { autoArmedRef.current = autoArmed }, [autoArmed])
  useEffect(() => { if (autoArmed) armedAtRef.current = Date.now() }, [autoArmed])

  useEffect(() => {
    if (!autoArmed) return
    const iv = setInterval(() => setAutoPulse(p => !p), 600)
    return () => clearInterval(iv)
  }, [autoArmed])

  // Track peak P&L for trail stop
  useEffect(() => {
    if (!autoArmed) { peakPnlRef.current = 0; return }
    const pnl = pos.pnl ?? 0
    if (pnl > peakPnlRef.current) peakPnlRef.current = pnl
  }, [autoArmed, pos.pnl])

  // Auto-exit engine: evaluates all strategy triggers
  useEffect(() => {
    if (!autoArmed || autoFiredRef.current || !autoArmedRef.current) return
    const pnl = pos.pnl ?? 0
    const heldMs = Date.now() - armedAtRef.current
    const heldMin = heldMs / 60_000
    let reason = ''

    // N50 flip
    if (strat.n50Flip && n50?.composite) {
      const dir = n50.composite.direction
      let n50Pass = true
      if (strat.n50MinConf > 0 && (n50.composite.confidence ?? 0) * 100 < strat.n50MinConf) n50Pass = false
      if (strat.n50MinProb > 0) {
        const prob = pos.direction === 'BULL' ? n50.composite.bearProb : n50.composite.bullProb
        if (prob * 100 < strat.n50MinProb) n50Pass = false
      }
      if (n50Pass && dir !== null && dir !== pos.direction) reason = `N50 flipped ${dir}`
    }

    // Profit target
    if (!reason && strat.profitTarget !== null && pnl >= strat.profitTarget) {
      reason = `TP ₹${strat.profitTarget} hit (P&L ₹${Math.round(pnl)})`
    }

    // Stop loss
    if (!reason && strat.stopLoss !== null && pnl <= -strat.stopLoss) {
      reason = `SL ₹${strat.stopLoss} hit (P&L ₹${Math.round(pnl)})`
    }

    // Trail stop
    if (!reason && strat.trailEnabled && peakPnlRef.current >= strat.trailTriggerPnl) {
      const trailFloor = peakPnlRef.current * (strat.trailPct / 100)
      if (pnl < trailFloor) reason = `Trail stop — peak ₹${Math.round(peakPnlRef.current)}, floor ₹${Math.round(trailFloor)}`
    }

    // Max hold
    if (!reason && strat.maxHoldEnabled && heldMin >= strat.maxHoldMin) {
      reason = `Max hold ${strat.maxHoldMin}m reached`
    }

    // No profit
    if (!reason && strat.noProfitEnabled && heldMin >= strat.noProfitMin && peakPnlRef.current <= 0) {
      reason = `No profit after ${strat.noProfitMin}m`
    }

    // Pattern exit
    // Note: pattern data not available on Position object — would need SSE stock data
    // Skipped for now; pattern filters apply to entry gating in backtest

    if (reason) {
      autoFiredRef.current = true
      setAutoArmed(false)
      autoArmedRef.current = false
      onStatus(`Auto-exit: ${reason}`, true)
      handleSell(strat.orderType)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoArmed, pos.pnl, n50?.composite?.direction, n50?.composite?.confidence])

  useEffect(() => {
    return () => { autoArmedRef.current = false }
  }, [])

  async function handleSell(orderType: 'LIMIT' | 'MARKET', limitPrice?: number) {
    if (submitting) return
    setSubmitting(true)
    try {
      if (isNifty) {
        const body: Record<string, unknown> = {
          tradingsymbol: pos.buySymbol, transaction_type: 'SELL', lotSize: pos.lotSize,
          order_type: orderType,
        }
        if (limitPrice) body.price = limitPrice
        const res = await fetch('/api/nifty50/order', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        if (data.ok) onStatus(`${orderType} SELL ${data.order_id} @ ₹${data.price}`, true)
        else onStatus(data.error ?? 'Exit failed', false)
      } else {
        const p = limitPrice ?? parseFloat(price)
        if (!p || p <= 0) { onStatus('Enter a valid price', false); setSubmitting(false); return }
        const res = await fetch('/api/positions/exit', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol: pos.buySymbol, quantity: pos.lotSize, price: p }),
        })
        const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        if (data.ok) onStatus(`SELL ${data.order_id} @ ₹${p}`, true)
        else onStatus(data.error ?? 'Exit failed', false)
      }
      setMode('closed'); setPrice('')
    } catch (err) { onStatus(String(err), false) }
    finally { setSubmitting(false) }
  }

  const btnStyle = (bg: string, fg: string, border?: string) => ({
    fontSize: '7px', fontWeight: 700 as const, fontFamily: 'inherit',
    padding: '2px 6px', borderRadius: '2px', cursor: submitting ? 'not-allowed' as const : 'pointer' as const,
    background: bg, color: fg, border: border ?? 'none',
    opacity: submitting ? 0.5 : 1, letterSpacing: '0.05em',
  })

  function doDisarm() {
    setAutoArmed(false)
    clearAutoStrategy(pos.buySymbol)
    peakPnlRef.current = 0
    autoArmedRef.current = false
    autoFiredRef.current = false
    setShowConfirmDisarm(false)
    onStatus('Auto-exit disarmed', true)
  }

  // Count active triggers for armed badge
  const activeTriggers: string[] = []
  if (strat.n50Flip) activeTriggers.push('N50')
  if (strat.profitTarget !== null) activeTriggers.push(`TP₹${strat.profitTarget}`)
  if (strat.stopLoss !== null) activeTriggers.push(`SL₹${strat.stopLoss}`)
  if (strat.trailEnabled) activeTriggers.push(`TRL${strat.trailPct}%`)
  if (strat.maxHoldEnabled) activeTriggers.push(`${strat.maxHoldMin}m`)
  if (strat.noProfitEnabled) activeTriggers.push('NP')

  if (autoArmed) {
    const pnl = pos.pnl ?? 0
    return (
      <>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', alignItems: 'flex-start' }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: '4px',
            fontSize: '7px', fontWeight: 700, letterSpacing: '0.1em',
            color: CYB.glow, padding: '2px 8px', borderRadius: '2px',
            background: CYB.glowDim, border: `1px solid ${CYB.glowBorder}`,
            opacity: autoPulse ? 1 : 0.5, transition: 'opacity 0.3s',
          }}>
            AUTO {activeTriggers.join(' · ')}
            <button onClick={() => setShowConfirmDisarm(true)} style={{
              marginLeft: '2px', background: CYB.redDim, border: `1px solid ${CYB.redGlow}`,
              color: CYB.redGlow, cursor: 'pointer', fontSize: '7px', fontFamily: 'inherit',
              fontWeight: 700, padding: '1px 5px', borderRadius: '2px',
            }}>DISARM</button>
          </span>
          {strat.profitTarget !== null && pnl > 0 && (
            <span style={{ fontSize: '7px', color: CYB.glow, opacity: 0.7 }}>
              TP {Math.round((pnl / strat.profitTarget) * 100)}%
            </span>
          )}
          {strat.trailEnabled && peakPnlRef.current >= strat.trailTriggerPnl && (
            <span style={{ fontSize: '7px', color: 'var(--mixed)', opacity: 0.7 }}>
              trail peak ₹{Math.round(peakPnlRef.current)} floor ₹{Math.round(peakPnlRef.current * strat.trailPct / 100)}
            </span>
          )}
        </div>
        {showConfirmDisarm && (
          <div style={{
            position: 'fixed', inset: 0, zIndex: 100,
            background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <div style={{
              background: 'var(--bg)', border: `1px solid ${CYB.glow}`,
              borderRadius: '8px', padding: '20px', maxWidth: '320px', textAlign: 'center',
            }}>
              <div style={{ fontSize: '11px', fontWeight: 700, color: CYB.glow, marginBottom: '8px', letterSpacing: '0.1em' }}>
                DISARM AUTO-EXIT?
              </div>
              <div style={{ fontSize: '10px', color: 'var(--text2)', marginBottom: '16px', lineHeight: '1.5' }}>
                Cancel auto strategy on {pos.buySymbol}. Active: {activeTriggers.join(', ')}.
              </div>
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
                <button onClick={doDisarm}
                  style={{ ...btnStyle(CYB.glow, 'var(--bg)'), fontSize: '9px', padding: '4px 12px' }}>DISARM</button>
                <button onClick={() => setShowConfirmDisarm(false)}
                  style={{ ...btnStyle('transparent', 'var(--text3)', '1px solid var(--border)'), fontSize: '9px', padding: '4px 12px' }}>KEEP</button>
              </div>
            </div>
          </div>
        )}
      </>
    )
  }

  if (mode === 'closed') {
    return (
      <button onClick={() => setMode('open')} style={btnStyle(CYB.redDim, CYB.redGlow, `1px solid ${CYB.redGlow}`)}>
        EXIT
      </button>
    )
  }

  if (mode === 'limit') {
    return (
      <div style={{ display: 'flex', gap: '3px', alignItems: 'center' }}>
        <input type="number" step="0.05" placeholder="₹" value={price}
          onChange={e => setPrice(e.target.value)}
          style={{
            width: '52px', fontSize: '9px', fontFamily: 'inherit',
            padding: '2px 4px', borderRadius: '2px',
            background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)',
          }}
        />
        <button onClick={() => handleSell('LIMIT', parseFloat(price))} disabled={submitting}
          style={btnStyle(CYB.redGlow, 'var(--bg)')}>SELL</button>
        <button onClick={() => setMode('open')}
          style={btnStyle('transparent', 'var(--text3)', '1px solid var(--border)')}>←</button>
      </div>
    )
  }

  return (
    <>
      <div style={{ display: 'flex', gap: '3px', alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={() => setShowConfirmAuto(true)}
          style={btnStyle(CYB.glowDim, CYB.glow, `1px solid ${CYB.glowBorder}`)}>AUTO</button>
        <button onClick={() => setMode('limit')}
          style={btnStyle('rgba(234,179,8,0.15)', 'var(--mixed)', '1px solid rgba(234,179,8,0.3)')}>LIMIT</button>
        <button onClick={() => handleSell('LIMIT')} disabled={submitting}
          style={btnStyle(CYB.redGlow, 'var(--bg)')}>SELL@BID</button>
        <button onClick={() => setMode('closed')}
          style={btnStyle('transparent', 'var(--text3)', '1px solid var(--border)')}>X</button>
      </div>
      {showConfirmAuto && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 100,
          background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '16px',
        }}>
          <div style={{
            background: 'var(--bg)', border: `1px solid ${CYB.glow}`,
            borderRadius: '8px', padding: '16px', width: '100%', maxWidth: '380px',
            maxHeight: '85vh', overflowY: 'auto',
          }}>
            <div style={{ fontSize: '11px', fontWeight: 700, color: CYB.glow, marginBottom: '4px', letterSpacing: '0.12em', textAlign: 'center' }}>
              AUTO-EXIT STRATEGY
            </div>
            <div style={{ fontSize: '9px', color: 'var(--text3)', marginBottom: '12px', textAlign: 'center' }}>
              {pos.buySymbol} · {pos.direction} · lot {pos.lotSize}
            </div>

            {/* ── EXIT TRIGGERS ── */}
            <AutoStrategySection label="EXIT TRIGGERS" open={openSections.exit ?? true} onToggle={() => toggleSection('exit')}>
              <CfgRow label="N50 prediction flip">
                <CfgToggle on={strat.n50Flip} onToggle={() => setStrat(s => ({ ...s, n50Flip: !s.n50Flip }))} />
              </CfgRow>
              <CfgRow label="Take profit ₹">
                <input type="number" step="50" min="0" placeholder="off"
                  value={strat.profitTarget ?? ''} onChange={e => {
                    const v = e.target.value ? parseFloat(e.target.value) : null
                    setStrat(s => ({ ...s, profitTarget: v && v > 0 ? v : null }))
                  }}
                  style={{
                    width: '60px', fontSize: '9px', fontFamily: 'inherit', padding: '2px 4px',
                    borderRadius: '2px', textAlign: 'right', background: 'var(--bg)',
                    color: 'var(--text)', border: `1px solid ${CYB.glowBorder}`, outline: 'none',
                  }}
                />
              </CfgRow>
              <CfgRow label="Stop loss ₹">
                <input type="number" step="50" min="0" placeholder="off"
                  value={strat.stopLoss ?? ''} onChange={e => {
                    const v = e.target.value ? parseFloat(e.target.value) : null
                    setStrat(s => ({ ...s, stopLoss: v && v > 0 ? v : null }))
                  }}
                  style={{
                    width: '60px', fontSize: '9px', fontFamily: 'inherit', padding: '2px 4px',
                    borderRadius: '2px', textAlign: 'right', background: 'var(--bg)',
                    color: 'var(--text)', border: `1px solid ${CYB.glowBorder}`, outline: 'none',
                  }}
                />
              </CfgRow>
              <CfgRow label="Trail stop">
                <CfgToggle on={strat.trailEnabled} onToggle={() => setStrat(s => ({ ...s, trailEnabled: !s.trailEnabled }))} />
              </CfgRow>
              {strat.trailEnabled && (
                <>
                  <CfgRow label="  trigger at ₹">
                    <CfgNum value={strat.trailTriggerPnl} onChange={v => setStrat(s => ({ ...s, trailTriggerPnl: v }))} min={10} max={5000} step={50} />
                  </CfgRow>
                  <CfgRow label="  trail %">
                    <CfgNum value={strat.trailPct} onChange={v => setStrat(s => ({ ...s, trailPct: v }))} min={5} max={95} step={5} />
                  </CfgRow>
                </>
              )}
              <CfgRow label="Max hold (min)">
                <CfgToggle on={strat.maxHoldEnabled} onToggle={() => setStrat(s => ({ ...s, maxHoldEnabled: !s.maxHoldEnabled }))} />
                {strat.maxHoldEnabled && <CfgNum value={strat.maxHoldMin} onChange={v => setStrat(s => ({ ...s, maxHoldMin: v }))} min={1} max={480} step={5} />}
              </CfgRow>
              <CfgRow label="No profit exit (min)">
                <CfgToggle on={strat.noProfitEnabled} onToggle={() => setStrat(s => ({ ...s, noProfitEnabled: !s.noProfitEnabled }))} />
                {strat.noProfitEnabled && <CfgNum value={strat.noProfitMin} onChange={v => setStrat(s => ({ ...s, noProfitMin: v }))} min={1} max={120} step={1} />}
              </CfgRow>
            </AutoStrategySection>

            {/* ── N50 PREDICTION FILTER ── */}
            <AutoStrategySection label="N50 PREDICTION FILTER" open={openSections.n50 ?? false} onToggle={() => toggleSection('n50')}>
              <div style={{ fontSize: '8px', color: 'var(--text3)', lineHeight: '1.4', marginBottom: '4px' }}>
                Require min confidence/probability before N50 flip triggers exit
              </div>
              <CfgRow label="Min confidence %">
                <CfgNum value={strat.n50MinConf} onChange={v => setStrat(s => ({ ...s, n50MinConf: v }))} min={0} max={100} step={5} />
              </CfgRow>
              <CfgRow label="Min opposing prob %">
                <CfgNum value={strat.n50MinProb} onChange={v => setStrat(s => ({ ...s, n50MinProb: v }))} min={0} max={95} step={5} />
              </CfgRow>
            </AutoStrategySection>

            {/* ── PATTERN FILTER ── */}
            <AutoStrategySection label="PATTERN FILTER" open={openSections.pattern ?? false} onToggle={() => toggleSection('pattern')}>
              <CfgRow label="Pattern entry gate">
                <CfgToggle on={strat.patternEnabled} onToggle={() => setStrat(s => ({ ...s, patternEnabled: !s.patternEnabled }))} />
              </CfgRow>
              {strat.patternEnabled && (
                <>
                  <CfgRow label="Store">
                    <CfgSelect value={strat.patternStore} onChange={v => setStrat(s => ({ ...s, patternStore: v }))}
                      options={[{ v: 'pat5', l: 'pat5' }, { v: 'pat15', l: 'pat15' }, { v: 'pat30v2', l: 'pat30v2' }, { v: 'pat30_5', l: 'pat30→5' }, { v: 'pat60_20', l: 'pat60→20' }]} />
                  </CfgRow>
                  <CfgRow label="Min prob %">
                    <CfgNum value={strat.patternMinProb} onChange={v => setStrat(s => ({ ...s, patternMinProb: v }))} min={50} max={95} step={5} />
                  </CfgRow>
                  <CfgRow label="Min move %">
                    <CfgNum value={strat.patternMinMove} onChange={v => setStrat(s => ({ ...s, patternMinMove: v }))} min={0} max={2} step={0.05} width="60px" />
                  </CfgRow>
                </>
              )}
              <CfgRow label="Pattern exit gate">
                <CfgToggle on={strat.patternExitEnabled} onToggle={() => setStrat(s => ({ ...s, patternExitEnabled: !s.patternExitEnabled }))} />
              </CfgRow>
              {strat.patternExitEnabled && (
                <CfgRow label="Exit prob %">
                  <CfgNum value={strat.patternExitProb} onChange={v => setStrat(s => ({ ...s, patternExitProb: v }))} min={50} max={95} step={5} />
                </CfgRow>
              )}
            </AutoStrategySection>

            {/* ── TECHNICAL FILTERS ── */}
            <AutoStrategySection label="TECHNICAL FILTERS" open={openSections.tech ?? false} onToggle={() => toggleSection('tech')}>
              <div style={{ fontSize: '8px', color: 'var(--text3)', lineHeight: '1.4', marginBottom: '4px' }}>
                Informational — shown in armed badge. Filter logic requires stock-level data feed.
              </div>
              <CfgRow label="RSI filter">
                <CfgToggle on={strat.rsiEnabled} onToggle={() => setStrat(s => ({ ...s, rsiEnabled: !s.rsiEnabled }))} />
              </CfgRow>
              {strat.rsiEnabled && (
                <>
                  <CfgRow label="  overbought">
                    <CfgNum value={strat.rsiOverbought} onChange={v => setStrat(s => ({ ...s, rsiOverbought: v }))} min={50} max={95} step={5} />
                  </CfgRow>
                  <CfgRow label="  oversold">
                    <CfgNum value={strat.rsiOversold} onChange={v => setStrat(s => ({ ...s, rsiOversold: v }))} min={5} max={50} step={5} />
                  </CfgRow>
                </>
              )}
              <CfgRow label="VWAP alignment">
                <CfgToggle on={strat.vwapEnabled} onToggle={() => setStrat(s => ({ ...s, vwapEnabled: !s.vwapEnabled }))} />
              </CfgRow>
              <CfgRow label="EMA crossover">
                <CfgToggle on={strat.emaEnabled} onToggle={() => setStrat(s => ({ ...s, emaEnabled: !s.emaEnabled }))} />
              </CfgRow>
            </AutoStrategySection>

            {/* ── ORDER TYPE ── */}
            <AutoStrategySection label="ORDER EXECUTION" open={openSections.order ?? false} onToggle={() => toggleSection('order')}>
              <CfgRow label="Order type">
                <CfgSelect value={strat.orderType} onChange={v => setStrat(s => ({ ...s, orderType: v as 'LIMIT' | 'MARKET' }))}
                  options={[{ v: 'LIMIT', l: 'LIMIT (best bid)' }, { v: 'MARKET', l: 'MARKET' }]} />
              </CfgRow>
            </AutoStrategySection>

            {/* ── ARM / CANCEL ── */}
            <div style={{ marginTop: '12px', display: 'flex', gap: '8px', justifyContent: 'center' }}>
              <button onClick={() => {
                if (!strat.n50Flip && strat.profitTarget === null && strat.stopLoss === null
                    && !strat.trailEnabled && !strat.maxHoldEnabled && !strat.noProfitEnabled) {
                  onStatus('Enable at least one exit trigger', false); return
                }
                saveAutoStrategy(pos.buySymbol, strat)
                setAutoArmed(true); autoArmedRef.current = true
                setShowConfirmAuto(false); setMode('closed'); autoFiredRef.current = false
                peakPnlRef.current = Math.max(0, pos.pnl ?? 0)
                armedAtRef.current = Date.now()
                onStatus(`Auto armed: ${activeTriggers.join(' + ')}`, true)
              }}
                style={{ ...btnStyle(CYB.glow, 'var(--bg)'), fontSize: '10px', padding: '6px 20px' }}>ARM</button>
              <button onClick={() => setShowConfirmAuto(false)}
                style={{ ...btnStyle('transparent', 'var(--text3)', '1px solid var(--border)'), fontSize: '10px', padding: '6px 20px' }}>CANCEL</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function PositionCard({ pos, n50, stocks }: { pos: Position; n50?: N50State | null; stocks?: StockEntry[] }) {
  const [exitStatus, setExitStatus] = useState<{ msg: string; ok: boolean } | null>(null)
  const prevPnlRef = useRef<number | null>(null)
  const [pnlFlash, setPnlFlash] = useState<'up' | 'down' | null>(null)

  useEffect(() => {
    const cur = pos.pnl ?? 0
    if (prevPnlRef.current !== null && cur !== prevPnlRef.current) {
      setPnlFlash(cur > prevPnlRef.current ? 'up' : 'down')
      const t = setTimeout(() => setPnlFlash(null), 800)
      return () => clearTimeout(t)
    }
    prevPnlRef.current = cur
  }, [pos.pnl])

  useEffect(() => { prevPnlRef.current = pos.pnl ?? 0 }, [pos.pnl])

  const pnl = pos.pnl ?? 0
  const pnlColor = pnl >= 0 ? 'var(--bull)' : 'var(--bear)'
  const dirColor = pos.direction === 'BULL' ? 'var(--bull)' : 'var(--bear)'
  const stockLabel = pos.stock.replace('NSE:', '')
  const heldStr = pos.heldMin >= 60 ? `${(pos.heldMin / 60).toFixed(1)}h` : `${Math.round(pos.heldMin)}m`
  const predSupports = n50?.composite?.direction === pos.direction
  const profitable = pnl > 0
  const spotStock = stocks?.find(s => s.name === stockLabel || s.name === pos.stock.replace('NSE:', ''))
  const isNiftyPos = stockLabel === 'NIFTY' || pos.buySymbol.startsWith('NIFTY')
  const spot = spotStock?.ltp ?? (isNiftyPos ? (n50?.niftySpot ?? null) : null)

  return (
    <div style={{
      padding: '10px 12px', borderRadius: '4px',
      background: 'rgba(0,0,0,0.2)',
      border: `1px solid ${pos.isExiting ? (profitable && predSupports ? CYB.glow : CYB.redGlow) : CYB.glowBorder}`,
      display: 'flex', flexDirection: 'column', gap: '5px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '12px', fontWeight: 700, color: dirColor }}>
          {pos.direction === 'BULL' ? '▲' : '▼'}
        </span>
        <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
          {pos.buySymbol}
        </span>
        {pos.isExiting && (
          profitable && predSupports
            ? <span style={{ fontSize: '8px', fontWeight: 700, color: CYB.glow, letterSpacing: '0.1em' }}>N50 HOLD</span>
            : <span style={{ fontSize: '8px', fontWeight: 700, color: CYB.redGlow, letterSpacing: '0.1em' }}>ALERT</span>
        )}
        <PositionExitButton pos={pos} onStatus={(msg, ok) => setExitStatus({ msg, ok })} n50={n50} />
      </div>
      <div style={{ display: 'flex', gap: '10px', fontSize: '11px', flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ color: 'var(--text3)' }}>{stockLabel}{spot ? ` ₹${spot.toFixed(1)}` : ''}</span>
        <span style={{
          fontWeight: 700, fontSize: '12px', color: pnlColor, transition: 'text-shadow 0.3s',
          textShadow: pnlFlash === 'up' ? '0 0 8px rgba(34,197,94,0.6)' : pnlFlash === 'down' ? '0 0 8px rgba(239,68,68,0.6)' : 'none',
        }}>{pnl >= 0 ? '+' : ''}₹{pnl.toLocaleString('en-IN')}</span>
        <span style={{ color: 'var(--text3)' }}>
          pk ₹{pos.peak.toLocaleString('en-IN')}
        </span>
        <span style={{ color: 'var(--text3)' }}>
          ₹{pos.buyEntry}→{pos.currentBid != null ? `₹${pos.currentBid}` : '—'}
        </span>
        <span style={{ color: 'var(--text3)' }}>
          {pos.lotSize}×{heldStr}
        </span>
      </div>
      <OptionMetricsDisplay symbol={pos.buySymbol} bid={pos.currentBid} spot={spot} lotSize={pos.lotSize} direction={pos.direction} />
      {n50?.composite?.status === 'ready' && (
        <div style={{ display: 'flex', gap: '6px', fontSize: '8px', color: 'var(--text3)' }}>
          <span>N50</span>
          <span style={{
            fontWeight: 700,
            color: n50.composite.direction === 'BULL' ? 'var(--bull)' : n50.composite.direction === 'BEAR' ? 'var(--bear)' : 'var(--text3)',
          }}>
            {n50.composite.direction ?? '—'} {n50.composite.predictedMove >= 0 ? '+' : ''}{n50.composite.predictedMove.toFixed(3)}%
          </span>
          <span style={{
            color: predSupports ? 'var(--bull)' : 'var(--bear)',
            fontWeight: 600,
          }}>
            {predSupports ? 'ALIGNED' : 'OPPOSED'}
          </span>
        </div>
      )}
      {exitStatus && (
        <div style={{ fontSize: '9px', color: exitStatus.ok ? 'var(--bull)' : 'var(--bear)', padding: '2px 0' }}>
          {exitStatus.msg}
          <button onClick={() => setExitStatus(null)} style={{
            marginLeft: '8px', background: 'none', border: 'none', color: 'inherit',
            cursor: 'pointer', fontSize: '8px', fontFamily: 'inherit',
          }}>dismiss</button>
        </div>
      )}
    </div>
  )
}

interface SyncedPosition {
  tradingsymbol: string
  quantity: number
  averagePrice: number
  lastPrice: number
  pnl: number
  optType: string
  direction: string
  bestBid: number | null
  bestAsk: number | null
}

function PositionsHUD({ positions, capital, posConvictions, n50, onPositionsUpdate, stocks, role = 'admin' }: {
  positions: Position[]
  capital: CapitalData | null
  posConvictions: { stock: StockEntry; conviction: ConvictionResult }[]
  n50?: N50State | null
  onPositionsUpdate?: (updater: (prev: Position[]) => Position[]) => void
  stocks?: StockEntry[]
  role?: string
}) {
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<{ positions: SyncedPosition[]; ts: number } | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [syncExpanded, setSyncExpanded] = useState(false)

  async function handleSync() {
    if (syncing) return
    setSyncing(true)
    setSyncError(null)
    try {
      const res = await fetch('/api/positions/sync', { method: 'POST' })
      const data = await res.json()
      if (data.ok) {
        setSyncResult({ positions: data.positions, ts: data.syncedAt })
        if (onPositionsUpdate && data.positions.length > 0) {
          const syncMap = new Map<string, SyncedPosition>()
          for (const sp of data.positions as SyncedPosition[]) syncMap.set(sp.tradingsymbol, sp)
          onPositionsUpdate(prev => prev.map(p => {
            const sp = syncMap.get(p.buySymbol)
            if (!sp) return p
            const newBid = sp.bestBid ?? sp.lastPrice
            const isSingleLeg = p.source === 'zerodha' || !p.sellSymbol
            const rawPnl = isSingleLeg
              ? (newBid - p.buyEntry) * p.lotSize
              : p.pnl
            return {
              ...p,
              currentBid: newBid,
              pnl: rawPnl != null ? Math.round(rawPnl) : p.pnl,
              peak: Math.max(p.peak, rawPnl ?? 0),
            }
          }))
        }
      } else {
        setSyncError(data.error ?? 'Sync failed')
      }
    } catch (err) {
      setSyncError(String(err))
    } finally { setSyncing(false) }
  }

  const totalPnl = positions.reduce((sum, p) => sum + (p.pnl ?? 0), 0)
  const totalPeak = positions.reduce((sum, p) => sum + (p.peak ?? 0), 0)
  const realizedToday = capital?.realizedToday ?? 0

  const matchedStocks = new Set(posConvictions.map(pc => pc.stock.name))
  const unmatchedPositions = positions.filter(p => !matchedStocks.has(p.stock))

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: '8px',
      padding: '12px', borderRadius: '6px',
      background: CYB.panel,
      border: `1px solid ${CYB.glowBorder}`,
      backgroundImage: CYB.scanline,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <SysHeader label="NETRUNNER" sub={`${positions.length} active`} />
          <button onClick={handleSync} disabled={syncing} style={{
            fontSize: '7px', fontWeight: 700, fontFamily: 'inherit',
            padding: '2px 6px', borderRadius: '2px',
            cursor: syncing ? 'not-allowed' : 'pointer',
            background: CYB.glowDim, color: CYB.glow,
            border: `1px solid ${CYB.glowBorder}`,
            opacity: syncing ? 0.5 : 1, letterSpacing: '0.05em',
          }}>{syncing ? 'SYNCING...' : 'SYNC'}</button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '10px' }}>
          {positions.length > 0 && <>
            <span style={{ color: 'var(--text3)' }}>
              P&L <span style={{ fontWeight: 700, color: totalPnl >= 0 ? 'var(--bull)' : 'var(--bear)' }}>
                {totalPnl >= 0 ? '+' : ''}₹{totalPnl.toLocaleString('en-IN')}
              </span>
            </span>
            <span style={{ color: 'var(--text3)' }}>
              peak <span style={{ fontWeight: 600, color: 'var(--text2)' }}>₹{totalPeak.toLocaleString('en-IN')}</span>
            </span>
          </>}
          {capital && (
            <span style={{ color: 'var(--text3)' }}>
              net <span style={{ fontWeight: 700, color: 'var(--text)' }}>₹{capital.net.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>
            </span>
          )}
          {realizedToday !== 0 && (
            <span style={{ color: realizedToday >= 0 ? 'var(--bull)' : 'var(--bear)', fontWeight: 600 }}>
              today {realizedToday >= 0 ? '+' : ''}₹{Math.abs(realizedToday).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
            </span>
          )}
        </div>
      </div>

      {syncError && (
        <div style={{ fontSize: '9px', color: 'var(--bear)', padding: '2px 0' }}>
          Sync error: {syncError}
          <button onClick={() => setSyncError(null)} style={{
            marginLeft: '6px', background: 'none', border: 'none', color: 'inherit',
            cursor: 'pointer', fontSize: '8px', fontFamily: 'inherit',
          }}>dismiss</button>
        </div>
      )}

      {syncResult && (
        <div style={{
          padding: syncExpanded ? '6px 8px' : '3px 8px', borderRadius: '4px',
          background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.15)',
          fontSize: '9px', color: 'var(--text3)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}
            onClick={() => setSyncExpanded(p => !p)}>
            <span style={{ fontSize: '7px', color: 'var(--text3)' }}>{syncExpanded ? '▼' : '▶'}</span>
            <span style={{ fontWeight: 700, color: CYB.glow, letterSpacing: '0.1em', fontSize: '7px' }}>SYNCED</span>
            <span style={{ fontSize: '8px', color: 'var(--text3)' }}>{syncResult.positions.length} pos</span>
            <button onClick={(e) => { e.stopPropagation(); setSyncResult(null); setSyncExpanded(false) }} style={{
              marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text3)',
              cursor: 'pointer', fontSize: '8px', fontFamily: 'inherit',
            }}>×</button>
          </div>
          {syncExpanded && <>
            {syncResult.positions.length === 0 && (
              <div style={{ color: 'var(--text3)', fontStyle: 'italic', marginTop: '4px' }}>No open NFO option positions on Zerodha</div>
            )}
            {syncResult.positions.map(sp => (
              <div key={sp.tradingsymbol} style={{
                display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap',
                padding: '2px 0', borderBottom: '1px solid rgba(255,255,255,0.03)',
              }}>
                <span style={{ fontWeight: 700, color: sp.direction === 'BULL' ? 'var(--bull)' : 'var(--bear)' }}>
                  {sp.direction === 'BULL' ? '▲' : '▼'}
                </span>
                <span style={{ fontWeight: 600, color: 'var(--text2)' }}>{sp.tradingsymbol}</span>
                <span>qty:{sp.quantity}</span>
                <span>avg:₹{sp.averagePrice.toFixed(2)}</span>
                <span>ltp:₹{sp.lastPrice.toFixed(2)}</span>
                <span style={{ fontWeight: 600, color: sp.pnl >= 0 ? 'var(--bull)' : 'var(--bear)' }}>
                  {sp.pnl >= 0 ? '+' : ''}₹{sp.pnl.toFixed(0)}
                </span>
                {sp.bestBid != null && <span>bid:₹{sp.bestBid}</span>}
              </div>
            ))}
          </>}
        </div>
      )}

      {positions.length > 0 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))',
          gap: '8px',
        }}>
          {unmatchedPositions.map(pos => (
            <PositionCard key={pos.buySymbol} pos={pos} n50={n50} stocks={stocks} />
          ))}
          {posConvictions.map(({ stock, conviction }) => (
            <ConvictionCard key={stock.name} stock={stock} conviction={conviction} positions={positions} n50={n50} role={role} />
          ))}
        </div>
      )}
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

// ── Telegram Settings Panel ──────────────────────────────────────────────────

const TG_CATEGORY_META: { key: string; label: string; section: string; desc: string }[] = [
  // Startup / Shutdown
  { key: 'startup',       label: 'Startup',           section: 'Startup & Shutdown', desc: 'Bot started, config summary, restart position list' },
  { key: 'shutdown',      label: 'Shutdown',          section: 'Startup & Shutdown', desc: 'Bot stopped (SIGINT)' },
  { key: 'market_hours',  label: 'Market Open/Close', section: 'Startup & Shutdown', desc: 'Market opened / market closed transitions' },
  { key: 'holidays',      label: 'Holiday Alerts',    section: 'Startup & Shutdown', desc: 'Upcoming NSE holidays (7-day lookahead)' },
  // Trades
  { key: 'entries',       label: 'Trade Entries',      section: 'Trades',            desc: 'New spread entries with debit, patterns, gate status' },
  { key: 'exits',         label: 'Trade Exits',        section: 'Trades',            desc: 'Auto-exits with P&L, reason, peak' },
  { key: 'exit_alerts',   label: 'Exit Alerts',        section: 'Trades',            desc: 'Zerodha positions needing manual exit action' },
  // Account
  { key: 'position_sync', label: 'Position Sync',      section: 'Account',           desc: 'Zerodha positions synced to bot tracking' },
  { key: 'capital',       label: 'Capital/Margin',     section: 'Account',           desc: 'Account balance, margin utilisation, P&L' },
  // Monitoring
  { key: 'watchlist',     label: 'Watchlist',          section: 'Monitoring',        desc: 'Periodic stock status summaries' },
  { key: 'walls',         label: 'Wall Alerts',        section: 'Monitoring',        desc: 'Order book wall breaks, wall watch summaries' },
  { key: 'patterns',      label: 'Pattern Signals',    section: 'Monitoring',        desc: 'Bootstrap status, pattern gate blocks' },
  { key: 'pat30m_virtual',label: 'Pat30m Virtual',     section: 'Monitoring',        desc: 'Virtual 30-min pattern entries, exits, watch updates' },
  // Infrastructure
  { key: 'auth',          label: 'Authentication',     section: 'Infrastructure',    desc: 'Kite auth success/failure, re-login attempts' },
  { key: 'websocket',     label: 'WebSocket',          section: 'Infrastructure',    desc: 'WS connect/disconnect, watchdog reconnects' },
  { key: 'errors',        label: 'Errors',             section: 'Infrastructure',    desc: 'Startup failures, critical uncaught errors' },
  // GT Strategy
  { key: 'gt_entries',    label: 'GT Entries',          section: 'GT Strategy',      desc: 'Game theory strategy entries' },
  { key: 'gt_exits',      label: 'GT Exits',            section: 'GT Strategy',      desc: 'Game theory strategy exits' },
  { key: 'gt_watchlist',  label: 'GT Watchlist',        section: 'GT Strategy',      desc: 'GT credibility + regime watchlist' },
  { key: 'gt_alerts',     label: 'GT Alerts',           section: 'GT Strategy',      desc: 'GT soft/hard loss, bid spikes' },
]

function TelegramSettingsPanel({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<{ enabled: boolean; categories: Record<string, boolean> } | null>(null)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/settings/telegram').then(r => r.json()).then(setSettings).catch(() => {})
  }, [])

  async function save(patch: { enabled?: boolean; categories?: Record<string, boolean> }) {
    setSaving(true); setMsg(null)
    try {
      const res = await fetch('/api/settings/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const data = await res.json()
      if (data.ok) {
        setSettings(data.settings)
        setMsg('Saved')
        setTimeout(() => setMsg(null), 2000)
      } else {
        setMsg(data.error ?? 'Save failed')
      }
    } catch (err) { setMsg(String(err)) }
    finally { setSaving(false) }
  }

  function toggleAll(on: boolean) {
    if (!settings) return
    const cats: Record<string, boolean> = {}
    for (const c of TG_CATEGORY_META) cats[c.key] = on
    save({ categories: cats })
  }

  function toggleSection(section: string, on: boolean) {
    if (!settings) return
    const cats: Record<string, boolean> = {}
    for (const c of TG_CATEGORY_META) {
      if (c.section === section) cats[c.key] = on
    }
    save({ categories: cats })
  }

  if (!settings) return (
    <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text3)', fontSize: '11px' }}>Loading...</div>
  )

  const sections = [...new Set(TG_CATEGORY_META.map(c => c.section))]

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100,
      background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '16px',
    }} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{
        background: 'var(--bg)', border: `1px solid ${CYB.glowBorder}`, borderRadius: '8px',
        width: '100%', maxWidth: '480px', maxHeight: '85vh', overflow: 'auto',
        backgroundImage: CYB.scanline,
      }}>
        {/* Header */}
        <div style={{
          padding: '14px 16px', borderBottom: `1px solid ${CYB.glowBorder}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          position: 'sticky', top: 0, background: 'var(--bg)', zIndex: 1,
        }}>
          <SysHeader label="TELEGRAM" sub="notification settings" />
          <button onClick={onClose} style={{
            background: 'none', border: '1px solid var(--border)', borderRadius: '3px',
            color: 'var(--text3)', cursor: 'pointer', fontSize: '10px', fontFamily: 'inherit',
            padding: '3px 8px',
          }}>ESC</button>
        </div>

        {/* Master toggle */}
        <div style={{
          padding: '12px 16px', borderBottom: `1px solid ${CYB.glowBorder}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div>
            <div style={{ fontSize: '11px', fontWeight: 700, color: settings.enabled ? CYB.glow : 'var(--text3)' }}>
              {settings.enabled ? 'NOTIFICATIONS ON' : 'NOTIFICATIONS OFF'}
            </div>
            <div style={{ fontSize: '9px', color: 'var(--text3)', marginTop: '2px' }}>
              Master switch — disables all Telegram messages
            </div>
          </div>
          <button onClick={() => save({ enabled: !settings.enabled })} disabled={saving} style={{
            padding: '4px 12px', borderRadius: '4px', cursor: 'pointer', fontFamily: 'inherit',
            fontSize: '10px', fontWeight: 700, border: 'none',
            background: settings.enabled ? CYB.glow : 'var(--bg3)',
            color: settings.enabled ? 'var(--bg)' : 'var(--text3)',
          }}>{settings.enabled ? 'ON' : 'OFF'}</button>
        </div>

        {/* Quick actions */}
        {settings.enabled && (
          <div style={{ padding: '8px 16px', display: 'flex', gap: '6px', borderBottom: `1px solid ${CYB.glowBorder}` }}>
            <button onClick={() => toggleAll(true)} disabled={saving} style={{
              ...btnStyle, padding: '3px 8px', fontSize: '9px', cursor: 'pointer',
            }}>ALL ON</button>
            <button onClick={() => toggleAll(false)} disabled={saving} style={{
              ...btnStyle, padding: '3px 8px', fontSize: '9px', cursor: 'pointer',
            }}>ALL OFF</button>
            <button onClick={() => {
              const essential: Record<string, boolean> = {}
              for (const c of TG_CATEGORY_META) essential[c.key] = false
              essential.entries = true; essential.exits = true; essential.exit_alerts = true
              essential.errors = true; essential.capital = true
              save({ categories: essential })
            }} disabled={saving} style={{
              ...btnStyle, padding: '3px 8px', fontSize: '9px', cursor: 'pointer', color: CYB.glow, borderColor: CYB.glowBorder,
            }}>ESSENTIALS ONLY</button>
          </div>
        )}

        {/* Category sections */}
        {settings.enabled && sections.map(section => {
          const cats = TG_CATEGORY_META.filter(c => c.section === section)
          const allOn = cats.every(c => settings.categories[c.key] !== false)
          const allOff = cats.every(c => settings.categories[c.key] === false)

          return (
            <div key={section} style={{ borderBottom: `1px solid ${CYB.glowBorder}` }}>
              <div style={{
                padding: '8px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                background: 'rgba(0,0,0,0.15)',
              }}>
                <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.1em', color: 'var(--text2)' }}>
                  {section.toUpperCase()}
                </span>
                <button onClick={() => toggleSection(section, !allOn)} disabled={saving} style={{
                  fontSize: '8px', fontFamily: 'inherit', padding: '2px 6px', borderRadius: '2px',
                  cursor: 'pointer', border: `1px solid ${CYB.glowBorder}`,
                  background: allOn ? CYB.glowDim : 'transparent',
                  color: allOn ? CYB.glow : 'var(--text3)',
                }}>{allOn ? 'ALL ON' : allOff ? 'ALL OFF' : 'MIXED'}</button>
              </div>
              {cats.map(cat => (
                <div key={cat.key} style={{
                  padding: '6px 16px 6px 24px',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '10px', fontWeight: 600, color: settings.categories[cat.key] !== false ? 'var(--text)' : 'var(--text3)' }}>
                      {cat.label}
                    </div>
                    <div style={{ fontSize: '8px', color: 'var(--text3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {cat.desc}
                    </div>
                  </div>
                  <button
                    onClick={() => save({ categories: { [cat.key]: settings.categories[cat.key] === false } })}
                    disabled={saving}
                    style={{
                      width: '36px', height: '18px', borderRadius: '9px', border: 'none',
                      cursor: 'pointer', position: 'relative', flexShrink: 0,
                      background: settings.categories[cat.key] !== false ? CYB.glow : 'var(--bg3)',
                      transition: 'background 0.2s',
                    }}
                  >
                    <div style={{
                      width: '14px', height: '14px', borderRadius: '50%',
                      background: 'var(--bg)', position: 'absolute', top: '2px',
                      left: settings.categories[cat.key] !== false ? '20px' : '2px',
                      transition: 'left 0.2s',
                    }} />
                  </button>
                </div>
              ))}
            </div>
          )
        })}

        {/* Status */}
        {msg && (
          <div style={{
            padding: '8px 16px', fontSize: '10px', textAlign: 'center',
            color: msg === 'Saved' ? 'var(--bull)' : 'var(--bear)',
          }}>{msg}</div>
        )}
      </div>
    </div>
  )
}

// ── HeroPanel ────────────────────────────────────────────────────────────────

type HeroStateLocal = NonNullable<N50State['hero']>
type HeroPositionLocal = NonNullable<HeroStateLocal['position']>
type HeroLegLocal = HeroPositionLocal['legs'][number]

function HeroLegRow({ leg }: { leg: HeroLegLocal }) {
  const pnlPct = leg.entryPremium > 0 ? ((leg.currentPremium - leg.entryPremium) / leg.entryPremium * 100) : 0
  const isOpen = leg.status === 'OPEN'
  const legColor = leg.label === 'NEAR' ? '#4ecdc4' : leg.label === 'MID' ? '#ffd93d' : '#ff6b6b'
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '40px 1fr auto auto auto auto', gap: '4px 8px', alignItems: 'center', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      <span style={{ fontSize: '8px', fontWeight: 700, color: legColor, background: `${legColor}18`, borderRadius: '3px', padding: '1px 4px', textAlign: 'center' }}>{leg.label}</span>
      <span style={{ fontSize: '9px', color: 'var(--text2)', fontFamily: 'monospace' }}>{leg.symbol.slice(-12)}</span>
      <span style={{ fontSize: '9px', color: 'var(--text2)', fontFamily: 'monospace' }}>₹{leg.entryPremium.toFixed(1)}</span>
      <span style={{ fontSize: '9px', color: isOpen ? 'var(--text1)' : 'var(--text3)', fontFamily: 'monospace' }}>{isOpen ? `₹${leg.currentPremium.toFixed(1)}` : `₹${(leg.exitPremium ?? leg.currentPremium).toFixed(1)}`}</span>
      <span style={{ fontSize: '9px', fontWeight: 600, color: pnlPct >= 0 ? 'var(--bull)' : 'var(--bear)', fontFamily: 'monospace' }}>{pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(1)}%</span>
      <span style={{ fontSize: '8px', color: isOpen ? '#4ecdc4' : 'var(--text3)', fontFamily: 'monospace' }}>{isOpen ? '●' : leg.exitReason?.slice(0, 6) ?? 'DONE'}</span>
    </div>
  )
}

function HeroPanel({ hero, role, onArm, onDisarm, onReset }: {
  hero: HeroStateLocal
  role: string
  onArm: () => void
  onDisarm: () => void
  onReset: () => void
}) {
  const pos = hero.position
  const stats = hero.stats
  const winRate = stats.trades > 0 ? Math.round(stats.wins / stats.trades * 100) : 0
  const tierColor = pos?.momTier === 'TIGHT' ? '#ff6b6b' : pos?.momTier === 'MID' ? '#ffd93d' : '#4ecdc4'
  const dirColor = pos?.direction === 'BULL' ? 'var(--bull)' : 'var(--bear)'
  const openLegs = pos?.legs.filter(l => l.status === 'OPEN') ?? []
  const heldMin = pos ? Math.round((Date.now() - pos.entryTs) / 60000) : 0
  const recentLog = [...hero.log].reverse().slice(0, 6)

  return (
    <div style={{ background: 'var(--bg2)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px', padding: '12px 14px', fontFamily: 'monospace' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.12em', color: hero.armed ? '#4ecdc4' : 'var(--text3)' }}>
            //SYSLOG/OPTION/HERO
          </span>
          <span style={{ fontSize: '8px', padding: '1px 6px', borderRadius: '3px', background: hero.armed ? 'rgba(78,205,196,0.15)' : 'rgba(255,255,255,0.06)', color: hero.armed ? '#4ecdc4' : 'var(--text3)', border: `1px solid ${hero.armed ? 'rgba(78,205,196,0.3)' : 'rgba(255,255,255,0.1)'}` }}>
            {hero.armed ? 'ARMED' : 'DISARMED'}
          </span>
          {pos && (
            <span style={{ fontSize: '8px', color: tierColor, padding: '1px 5px', border: `1px solid ${tierColor}60`, borderRadius: '3px' }}>
              {pos.momTier} TIER
            </span>
          )}
        </div>
        {role !== 'viewer' && (
          <div style={{ display: 'flex', gap: '4px' }}>
            <button onClick={onReset} style={{ fontSize: '8px', padding: '2px 6px', borderRadius: '3px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: 'var(--text3)', cursor: 'pointer' }}>RESET</button>
            {hero.armed
              ? <button onClick={onDisarm} style={{ fontSize: '8px', padding: '2px 8px', borderRadius: '3px', background: 'rgba(255,107,107,0.15)', border: '1px solid rgba(255,107,107,0.3)', color: '#ff6b6b', cursor: 'pointer' }}>DISARM</button>
              : <button onClick={onArm} style={{ fontSize: '8px', padding: '2px 8px', borderRadius: '3px', background: 'rgba(78,205,196,0.15)', border: '1px solid rgba(78,205,196,0.3)', color: '#4ecdc4', cursor: 'pointer' }}>ARM</button>
            }
          </div>
        )}
      </div>

      {/* Stats row */}
      <div style={{ display: 'flex', gap: '16px', marginBottom: '10px', padding: '6px 8px', background: 'rgba(255,255,255,0.03)', borderRadius: '4px' }}>
        <span style={{ fontSize: '9px', color: 'var(--text3)' }}>trades <span style={{ color: 'var(--text1)' }}>{stats.trades}</span></span>
        <span style={{ fontSize: '9px', color: 'var(--text3)' }}>win% <span style={{ color: winRate >= 50 ? 'var(--bull)' : 'var(--bear)' }}>{winRate}%</span></span>
        <span style={{ fontSize: '9px', color: 'var(--text3)' }}>P&amp;L <span style={{ color: stats.pnl >= 0 ? 'var(--bull)' : 'var(--bear)', fontWeight: 600 }}>₹{stats.pnl >= 0 ? '+' : ''}{Math.round(stats.pnl)}</span></span>
        <span style={{ fontSize: '9px', color: 'var(--text3)' }}>closed <span style={{ color: 'var(--text2)' }}>{hero.closedPositions.length}</span></span>
      </div>

      {/* Active position */}
      {pos ? (
        <div style={{ marginBottom: '10px' }}>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '6px' }}>
            <span style={{ fontSize: '9px', fontWeight: 700, color: dirColor }}>{pos.direction}</span>
            <span style={{ fontSize: '9px', color: 'var(--text3)' }}>entry ₹{pos.entrySpot.toFixed(0)}</span>
            <span style={{ fontSize: '9px', color: 'var(--text3)' }}>held {heldMin}m</span>
            <span style={{ fontSize: '9px', color: 'var(--text3)' }}>GT {pos.gtScoreAtEntry.toFixed(1)}</span>
            <span style={{ fontSize: '9px', color: 'var(--text3)' }}>phase {pos.phaseAtEntry}</span>
            <span style={{ fontSize: '9px', color: pos.totalPnl >= 0 ? 'var(--bull)' : 'var(--bear)', fontWeight: 600, marginLeft: 'auto' }}>₹{pos.totalPnl >= 0 ? '+' : ''}{Math.round(pos.totalPnl)}</span>
          </div>
          <div style={{ display: 'flex', gap: '4px', marginBottom: '6px' }}>
            {['NEAR','MID','FAR'].map(label => {
              const leg = pos.legs.find(l => l.label === label)
              if (!leg) return null
              const lColor = label === 'NEAR' ? '#4ecdc4' : label === 'MID' ? '#ffd93d' : '#ff6b6b'
              return (
                <span key={label} style={{ fontSize: '8px', padding: '1px 4px', borderRadius: '3px', background: leg.status === 'OPEN' ? `${lColor}15` : 'rgba(255,255,255,0.04)', color: leg.status === 'OPEN' ? lColor : 'var(--text3)', border: `1px solid ${leg.status === 'OPEN' ? lColor + '40' : 'rgba(255,255,255,0.06)'}` }}>
                  {leg.status === 'OPEN' ? '●' : '✗'} {label}
                </span>
              )
            })}
            <span style={{ fontSize: '8px', color: 'var(--text3)', marginLeft: 'auto' }}>{openLegs.length}/3 open</span>
          </div>
          {pos.legs.map(leg => <HeroLegRow key={leg.label} leg={leg} />)}
        </div>
      ) : (
        <div style={{ padding: '10px 0', fontSize: '9px', color: 'var(--text3)', textAlign: 'center', letterSpacing: '0.1em' }}>
          {hero.armed ? '// watching for setup' : '// disarmed — arm to enable auto-entry'}
        </div>
      )}

      {/* Recent closed */}
      {hero.closedPositions.length > 0 && (
        <div style={{ marginBottom: '8px' }}>
          <div style={{ fontSize: '8px', color: 'var(--text3)', letterSpacing: '0.08em', marginBottom: '4px' }}>RECENT CLOSED</div>
          {hero.closedPositions.slice(-3).reverse().map(cp => {
            const winLoss = cp.totalPnl >= 0
            return (
              <div key={cp.id} style={{ display: 'flex', gap: '8px', fontSize: '8px', padding: '2px 0', color: 'var(--text3)' }}>
                <span style={{ color: cp.direction === 'BULL' ? 'var(--bull)' : 'var(--bear)' }}>{cp.direction}</span>
                <span>{new Date(cp.entryTs).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })}</span>
                <span style={{ color: winLoss ? 'var(--bull)' : 'var(--bear)', fontWeight: 600 }}>₹{cp.totalPnl >= 0 ? '+' : ''}{Math.round(cp.totalPnl)}</span>
                <span style={{ marginLeft: 'auto' }}>{cp.legs.filter(l => l.status === 'EXITED').map(l => l.exitReason?.slice(0, 4)).join(' ')}</span>
              </div>
            )
          })}
        </div>
      )}

      {/* Log */}
      {recentLog.length > 0 && (
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '8px' }}>
          <div style={{ fontSize: '8px', color: 'var(--text3)', letterSpacing: '0.08em', marginBottom: '4px' }}>LOG</div>
          {recentLog.map((entry, i) => {
            const actColor = entry.act === 'ENTRY' ? 'var(--bull)' : entry.act === 'EXIT_ALL' || entry.act === 'EXIT_LEG' ? '#ff6b6b' : entry.act === 'ERR' ? '#ff6b6b' : entry.act === 'TIER_CHANGE' ? '#ffd93d' : 'var(--text3)'
            const t = new Date(entry.ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Kolkata' })
            return (
              <div key={i} style={{ display: 'flex', gap: '6px', fontSize: '8px', padding: '1px 0', color: 'var(--text3)', fontFamily: 'monospace' }}>
                <span style={{ color: 'var(--text3)', opacity: 0.5, flexShrink: 0 }}>{t}</span>
                <span style={{ color: actColor, fontWeight: 600, flexShrink: 0 }}>{entry.act}</span>
                <span style={{ color: 'var(--text2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.msg}</span>
                {entry.pnl != null && <span style={{ color: entry.pnl >= 0 ? 'var(--bull)' : 'var(--bear)', marginLeft: 'auto', flexShrink: 0 }}>₹{entry.pnl >= 0 ? '+' : ''}{Math.round(entry.pnl)}</span>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Main ─────────────────────────────────────────────────────────────────────

export default function ConvictionClient({ role = 'admin' }: { role?: string }) {
  const router = useRouter()
  const [stocks, setStocks] = useState<StockEntry[]>([])
  const [positions, setPositions] = useState<Position[]>([])
  const [capital, setCapital] = useState<CapitalData | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [status, setStatus] = useState<'connecting' | 'live' | 'stale'>('connecting')
  const [filter, setFilter] = useState<'all' | 'strong' | 'partial' | 'positions' | 'nifty50'>('nifty50')
  const [n50, setN50] = useState<N50State | null>(null)
  const [n50Fut, setN50Fut] = useState<any | null>(null)
  const [orderState, setOrderState] = useState<OrderState>({ confirm: null, status: null, ordering: false })
  const [showTgSettings, setShowTgSettings] = useState(false)
  const esRef = useRef<EventSource | null>(null)

  // AT state comes from server via n50.autoTrader — no client state needed
  const at: ATState = n50?.autoTrader ?? AT_DEFAULT

  // Poll N50 + N50 Futures when in nifty50 mode
  useEffect(() => {
    if (filter !== 'nifty50') return
    let cancelled = false
    const poll = () => {
      fetch('/api/nifty50').then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      }).then(data => {
        if (!cancelled && data && !data.error) setN50(data)
      }).catch(() => {})
      fetch('/api/niftyfut').then(r => {
        if (!r.ok) return
        return r.json()
      }).then(data => {
        if (!cancelled && data && !data.error) setN50Fut(data)
      }).catch(() => {})
    }
    poll()
    const iv = setInterval(poll, 6_000)
    return () => {
      cancelled = true
      clearInterval(iv)
      setN50(null)
      setN50Fut(null)
      setOrderState(s => s.ordering ? s : { confirm: null, status: s.status, ordering: false })
    }
  }, [filter])

  const handleATAction = useCallback(async (action: 'ARM' | 'DISARM') => {
    try {
      const res = await fetch('/api/nifty50/autotrade', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const data = await res.json()
      if (data.mode) setN50(prev => prev ? { ...prev, autoTrader: data } : prev)
    } catch {}
  }, [])

  const handleHeroAction = useCallback(async (action: 'ARM' | 'DISARM' | 'RESET') => {
    try {
      const res = await fetch('/api/nifty50/hero', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const data = await res.json()
      if (data && !data.error) setN50(prev => prev ? { ...prev, hero: data } : prev)
    } catch {}
  }, [])

  useEffect(() => {
    function connect() {
      const es = new EventSource('/api/stream')
      esRef.current = es
      es.onopen = () => setStatus('connecting')
      es.onmessage = (e) => {
        let msg: any
        try { msg = JSON.parse(e.data) } catch { return }
        if (msg.type === 'snapshot') {
          setStocks(msg.stocks)
          setPositions(msg.positions ?? [])
          if (msg.capital) setCapital(msg.capital)
          setUpdatedAt(msg.updatedAt)
          setStatus('live')
        } else if (msg.type === 'prices') {
          setStocks(prev => prev.length === 0 ? prev : prev.map(s => {
            const p = msg.prices[s.name]
            return p ? { ...s, ltp: p.ltp, signal: p.signal, confirmCount: p.confirmCount, cdZ: p.cdZ, trend: p.trend, imbalance: p.imbalance } : s
          }))
          if (msg.positions) setPositions(msg.positions)
          if (msg.capital) setCapital(msg.capital)
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
    if (filter === 'positions') return positions.some(p => p.stock === stock.name)
    if (!conviction.qualified) return false
    if (filter === 'nifty50') return NIFTY50_SET.has(stock.name)
    if (filter === 'strong') return conviction.score >= 0.7
    if (filter === 'partial') return conviction.score >= 0.45
    return true
  })

  const posStocks = positions.map(p => p.stock)
  const posConvictions = convictions.filter(({ stock }) => posStocks.includes(stock.name))
  const unmatchedPositions = positions.filter(p => !posConvictions.some(pc => pc.stock.name === p.stock))

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' })
    router.push('/')
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <header style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexWrap: 'wrap', gap: '6px', padding: '8px 12px',
        borderBottom: '1px solid var(--border)', background: 'var(--bg2)',
        position: 'sticky', top: 0, zIndex: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
          <a href="/dashboard" style={{ fontWeight: 700, fontSize: '14px', letterSpacing: '-0.02em', color: 'var(--text)', textDecoration: 'none' }}>Z</a>
          <span style={{ color: 'var(--text3)', fontSize: '9px' }}>/</span>
          <span style={{ fontSize: '11px', color: 'var(--accent)', letterSpacing: '0.05em', fontWeight: 700 }}>CONVICTION</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
          {[{ href: '/dashboard', label: '📊' }, { href: '/dashboard/backtest', label: 'BT' }, { href: '/dashboard/conviction-crude', label: 'CRUDE ▶' }, { href: '/dashboard/live', label: '◉' }].map(l => (
            <a key={l.href} href={l.href} style={{ ...btnStyle, padding: '3px 6px', fontSize: '10px' }}>{l.label}</a>
          ))}
          <button onClick={() => setShowTgSettings(true)} style={{ ...btnStyle, cursor: 'pointer', padding: '3px 6px', fontSize: '10px' }} title="Telegram">TG</button>
          <ThemeToggle />
          <button onClick={handleLogout} style={{ ...btnStyle, cursor: 'pointer', padding: '3px 6px', fontSize: '9px' }}>OUT</button>
        </div>
      </header>

      {/* Status + filters */}
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
          <span style={{ fontSize: '9px', color: 'var(--text3)' }}>
            {filtered.length}stk · {convictions.filter(c => c.conviction.qualified).length}/{stocks.length}q · {convictions.filter(c => c.conviction.score >= 0.7 && c.conviction.qualified).length}s
            {filter === 'nifty50' && n50 ? ` · ${n50.coverageCount}/50` : ''}
          </span>
        </div>
        <div style={{ display: 'flex', gap: '3px', flexWrap: 'wrap' }}>
          {(['all', 'nifty50', 'strong', 'partial', 'positions'] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)} style={{
              ...btnStyle, padding: '3px 8px', fontSize: '9px',
              background: filter === f ? (f === 'nifty50' ? 'var(--mixed)' : 'var(--accent)') : 'transparent',
              color: filter === f ? 'var(--bg)' : f === 'nifty50' ? 'var(--mixed)' : 'var(--text3)',
              border: filter === f ? 'none' : `1px solid ${f === 'nifty50' ? 'var(--mixed)' : 'var(--border)'}`,
              fontWeight: f === 'nifty50' ? 700 : undefined,
            }}>
              {f === 'all' ? 'ALL' : f === 'nifty50' ? 'N50' : f === 'strong' ? 'STR' : f === 'partial' ? '≥P' : 'POS'}
            </button>
          ))}
        </div>
      </div>

      {/* N50 draggable panels — N50Fut, Oracle/GT, SysLog, Chain+EW, Contracts */}
      {filter === 'nifty50' && (
        <div style={{ padding: '8px 10px 0' }}>
          <DraggablePanelLayout
            storageKey="zd-n50-panels"
            isAdmin={role === 'admin'}
            gap={8}
            panels={([
              {
                id: 'n50fut',
                visible: true,
                node: (() => {
                  const f = n50Fut
                  const S2 = { bull: 'var(--bull)', bear: 'var(--bear)', text2: 'var(--text2)', text3: 'var(--text3)', border: 'var(--border)' }
                  const dc = (d: string | null) => d === 'BULL' ? S2.bull : d === 'BEAR' ? S2.bear : S2.text2
                  const fp = (v: number, d = 2) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`
                  const panel: React.CSSProperties = { background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: '6px', padding: '10px 12px' }
                  const lbl: React.CSSProperties = { fontSize: '9px', color: S2.text2, letterSpacing: '1px', textTransform: 'uppercase' as const, marginBottom: '6px' }

                  if (!f) return (
                    <div style={panel}>
                      <div style={lbl}>NIFTY FUTURES</div>
                      <div style={{ fontSize: '10px', color: S2.text3 }}>Loading futures data…</div>
                    </div>
                  )

                  const comp = f.composite ?? {}
                  const v2 = f.v2 ?? null
                  const pa = f.phaseAnalysis ?? null
                  const ots = f.otsState ?? null
                  const flow = v2?.flowState ?? null
                  const spot = f.spot ?? 0
                  const dir: string | null = comp.direction ?? null
                  const cdZ: number | null = flow?.cdZScore ?? null
                  const cusum: string | null = flow?.cusumAlarm ?? null
                  const v2Dir: string | null = v2?.prediction?.direction ?? null
                  const v2Bull: number = v2?.prediction?.bullProb ?? 0.5
                  const otsAction: string = ots?.decision?.action ?? 'WAIT'
                  const otsPos = ots?.position ?? null
                  const borderColor = dir === 'BULL' ? 'rgba(34,197,94,0.35)' : dir === 'BEAR' ? 'rgba(239,68,68,0.35)' : 'var(--border)'

                  return (
                    <div style={{ ...panel, border: `1px solid ${borderColor}` }}>
                      {/* Header row */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
                          <span style={{ fontSize: '9px', color: 'var(--text2)', letterSpacing: '1px', textTransform: 'uppercase' }}>NIFTY FUTURES</span>
                          <span style={{ fontSize: '13px', fontWeight: 700, color: dc(dir) }}>{dir ?? '—'}</span>
                          <span style={{ fontSize: '14px', fontWeight: 900, color: dc(dir) }}>{spot > 0 ? spot.toFixed(0) : '—'}</span>
                        </div>
                        <div style={{ display: 'flex', gap: '6px', alignItems: 'center', fontSize: '10px' }}>
                          <span style={{ color: S2.text3 }}>{f.futureSymbol ?? 'NF'}</span>
                          <span style={{ color: f.marketOpen ? 'var(--bull)' : S2.text3, fontSize: '8px' }}>{f.marketOpen ? '●' : '○'}</span>
                        </div>
                      </div>

                      {/* Signal row: oracle + V2 + flow */}
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '6px', fontSize: '10px', marginBottom: '8px' }}>
                        <div style={{ padding: '4px 6px', background: 'rgba(255,255,255,0.03)', borderRadius: '4px' }}>
                          <div style={{ fontSize: '8px', color: S2.text3 }}>ORACLE</div>
                          <div style={{ color: dc(dir), fontWeight: 700 }}>{dir ?? '—'}</div>
                          <div style={{ color: S2.text2, fontSize: '9px' }}>{fp(comp.predictedMove ?? 0)}</div>
                        </div>
                        <div style={{ padding: '4px 6px', background: 'rgba(255,255,255,0.03)', borderRadius: '4px' }}>
                          <div style={{ fontSize: '8px', color: S2.text3 }}>V2</div>
                          <div style={{ color: dc(v2Dir), fontWeight: 700 }}>{v2Dir ?? '—'}</div>
                          <div style={{ color: S2.text2, fontSize: '9px' }}>{v2Bull > 0.5 ? 'B' : 'S'}{Math.round(Math.abs(v2Bull - 0.5) * 200)}%</div>
                        </div>
                        <div style={{ padding: '4px 6px', background: 'rgba(255,255,255,0.03)', borderRadius: '4px' }}>
                          <div style={{ fontSize: '8px', color: S2.text3 }}>CD·Z</div>
                          <div style={{ color: cdZ != null ? dc(cdZ > 0.5 ? 'BULL' : cdZ < -0.5 ? 'BEAR' : null) : S2.text3, fontWeight: 700 }}>
                            {cdZ != null ? `${cdZ >= 0 ? '+' : ''}${cdZ.toFixed(2)}σ` : '—'}
                          </div>
                          {cusum && <div style={{ color: dc(cusum), fontSize: '9px' }}>⚡{cusum}</div>}
                        </div>
                        <div style={{ padding: '4px 6px', background: 'rgba(255,255,255,0.03)', borderRadius: '4px' }}>
                          <div style={{ fontSize: '8px', color: S2.text3 }}>REGIME</div>
                          <div style={{ color: S2.text2, fontWeight: 700, fontSize: '9px' }}>{f.metaRegime?.regime ?? '—'}</div>
                          <div style={{ color: S2.text3, fontSize: '8px' }}>{f.metaRegime ? `${Math.round((f.metaRegime.confidence ?? 0) * 100)}%` : ''}</div>
                        </div>
                      </div>

                      {/* Phase row */}
                      {pa && (
                        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '8px', padding: '5px 7px', background: 'rgba(255,255,255,0.02)', borderRadius: '4px', border: '1px solid var(--border)' }}>
                          <span style={{ fontSize: '9px', color: S2.text3, width: '36px' }}>PHASE</span>
                          <span style={{ fontWeight: 700, fontSize: '11px', color: pa.phase === 'START' ? '#eab308' : pa.phase === 'MID' ? 'var(--bull)' : pa.phase === 'END' ? 'var(--bear)' : S2.text3 }}>
                            {pa.phase}
                          </span>
                          <span style={{ fontSize: '9px', color: S2.text2 }}>{Math.round(pa.phaseConfidence * 100)}%</span>
                          <span style={{ fontSize: '9px', color: pa.stability === 'STABLE' ? 'var(--bull)' : pa.stability === 'NOISY' ? 'var(--bear)' : '#eab308' }}>σ={pa.featureMaxStd?.toFixed(2) ?? '—'}</span>
                          <span style={{ fontSize: '9px', color: pa.cdVelRoCLabel === 'ACCELERATING' ? 'var(--bull)' : pa.cdVelRoCLabel === 'DECELERATING' ? 'var(--bear)' : S2.text2 }}>{pa.cdVelRoCLabel ?? pa.cdVelTrend}</span>
                          <span style={{ fontSize: '9px', color: pa.obiCdAlignment === 'HIDDEN' ? '#eab308' : pa.obiCdAlignment === 'VISIBLE' ? 'var(--bull)' : S2.text2 }}>r={(pa.obiCdCorr ?? 0) >= 0 ? '+' : ''}{(pa.obiCdCorr ?? 0).toFixed(2)}</span>
                          <span style={{ fontSize: '9px', color: pa.knnConsistency === 'ALIGNED' ? 'var(--bull)' : pa.knnConsistency === 'MIXED' ? '#eab308' : S2.text3 }}>{pa.knnConsistencyDetail ?? pa.knnConsistency}</span>
                        </div>
                      )}

                      {/* OPT TRADE SYS row */}
                      {ots && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', padding: '5px 7px', background: otsAction === 'ENTER' ? 'rgba(34,197,94,0.06)' : otsAction === 'EXIT_STOP' ? 'rgba(239,68,68,0.06)' : 'rgba(255,255,255,0.02)', borderRadius: '4px', border: `1px solid ${otsAction === 'ENTER' ? 'rgba(34,197,94,0.25)' : otsAction === 'EXIT_STOP' ? 'rgba(239,68,68,0.25)' : 'var(--border)'}` }}>
                          <span style={{ fontSize: '9px', color: S2.text3, width: '36px' }}>OTS</span>
                          <span style={{ fontWeight: 700, fontSize: '10px', color: otsAction === 'ENTER' ? 'var(--bull)' : otsAction.startsWith('EXIT') ? 'var(--bear)' : otsAction === 'TIGHTEN' ? '#eab308' : S2.text2 }}>
                            {otsAction}
                          </span>
                          {otsPos && (
                            <>
                              <span style={{ fontSize: '9px', color: dc(otsPos.direction) }}>{otsPos.direction} {otsPos.strike}{otsPos.optType}</span>
                              <span style={{ fontSize: '9px', color: (otsPos.pnl ?? 0) >= 0 ? 'var(--bull)' : 'var(--bear)' }}>
                                ₹{(otsPos.pnl ?? 0) >= 0 ? '+' : ''}{Math.round(otsPos.pnl ?? 0)}
                              </span>
                            </>
                          )}
                          <span style={{ fontSize: '9px', color: S2.text3, marginLeft: 'auto' }}>{ots.decision?.reason?.slice(0, 50)}</span>
                        </div>
                      )}
                    </div>
                  )
                })(),
              },
              {
                id: 'oracle_gt',
                visible: true,
                node: (
                  <div style={{ display: 'grid', gridTemplateColumns: role === 'admin' && n50 ? 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))' : '1fr', gap: '8px' }}>
                    <N50CommandCenter n50={n50} role={role} />
                    {role === 'admin' && n50 && <N50GTPanel n50={n50} />}
                  </div>
                ),
              },
              {
                id: 'sys_log',
                visible: !!n50,
                node: n50 ? (
                  <N50SysLog
                    entries={n50.sysLog ?? []}
                    at={at}
                    onArm={role !== 'viewer' ? () => handleATAction('ARM') : () => {}}
                    onDisarm={role !== 'viewer' ? () => handleATAction('DISARM') : () => {}}
                    restricted={role === 'viewer'}
                  />
                ) : null,
              },
              {
                id: 'hero',
                visible: !!n50?.hero,
                node: n50?.hero ? (
                  <HeroPanel
                    hero={n50.hero}
                    role={role}
                    onArm={() => handleHeroAction('ARM')}
                    onDisarm={() => handleHeroAction('DISARM')}
                    onReset={() => handleHeroAction('RESET')}
                  />
                ) : null,
              },
              {
                id: 'chain_ew',
                visible: !!(n50?.oiAnalytics || n50?.elliottWave || n50?.elliottWaveByTF),
                node: (n50?.oiAnalytics || n50?.elliottWave || n50?.elliottWaveByTF) ? (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: '8px' }}>
                    {n50?.oiAnalytics && <N50ChainPanel n50={n50} />}
                    {(n50?.elliottWave || n50?.elliottWaveByTF) && <N50EWPanel n50={n50!} />}
                  </div>
                ) : null,
              },
              {
                id: 'contracts',
                visible: role !== 'viewer',
                node: role !== 'viewer' ? (
                  <N50ContractsCompact n50={n50} orderState={orderState} setOrderState={setOrderState} />
                ) : null,
              },
            ] satisfies PanelDef[])}
          />
        </div>
      )}

      {/* Positions HUD — shown in all filter views except 'positions' tab */}
      {filter !== 'positions' && role !== 'viewer' && (
        <div style={{ padding: '8px 10px 0' }}>
          <PositionsHUD positions={positions} capital={capital} posConvictions={posConvictions} n50={n50} onPositionsUpdate={setPositions} stocks={stocks} role={role} />
        </div>
      )}
      {filter !== 'positions' && role === 'viewer' && (
        <div style={{
          margin: '8px 10px 0', padding: '8px 12px',
          background: `${CYB.panel}`,
          border: `1px solid rgba(255,0,60,0.2)`, borderRadius: '6px',
          display: 'flex', alignItems: 'center', gap: '10px',
          boxShadow: '0 0 8px rgba(255,0,60,0.05)',
        }}>
          <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.15em', color: CYB.redGlow, fontFamily: 'monospace' }}>
            ⛔ RESTRICTED
          </span>
          <span style={{ fontSize: '8px', color: 'var(--text3)', fontFamily: 'monospace', opacity: 0.7 }}>
            {'// positions + capital require elevated clearance'}
          </span>
        </div>
      )}

      {/* Main grid */}
      <div style={{
        padding: '8px 10px', flex: 1,
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(min(320px, 100%), 1fr))',
        gap: '10px',
        alignItems: 'start',
      }}>
        {filtered.length === 0 && (
          <div style={{ gridColumn: '1 / -1', textAlign: 'center', padding: '60px 0', color: 'var(--text3)', fontSize: '12px' }}>
            {status === 'connecting' ? 'Connecting to data stream...' : 'No stocks match this filter'}
          </div>
        )}
        {filter === 'positions' && role !== 'viewer' && unmatchedPositions.map(pos => (
          <PositionCard key={pos.buySymbol} pos={pos} n50={n50} stocks={stocks} />
        ))}
        {filtered
          .filter(({ stock }) => filter === 'positions' || !posStocks.includes(stock.name))
          .map(({ stock, conviction }) => (
            <ConvictionCard key={stock.name} stock={stock} conviction={conviction} positions={positions} n50={n50} role={role} />
          ))}
      </div>

      {showTgSettings && <TelegramSettingsPanel onClose={() => setShowTgSettings(false)} />}
    </div>
  )
}
