'use client'
import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import ThemeToggle from '@/components/ThemeToggle'

// ── Minimal types matching NiftyFutState ──────────────────────────────────────

interface HorizonPrediction { predictedMove: number; bullProb: number; bearProb: number }

interface NiftyPrediction {
  predictedMove: number; bullProb: number; bearProb: number
  topSim: number; confidence: number; nResolved: number
  direction: 'BULL' | 'BEAR' | null
  status: 'ready' | 'warming' | 'no_data'
  h5: HorizonPrediction | null; h15: HorizonPrediction | null; h20: HorizonPrediction | null
}

interface NiftyComposite {
  predictedMove: number; bullProb: number; bearProb: number
  direction: 'BULL' | 'BEAR' | null; confidence: number
  status: 'ready' | 'warming' | 'no_data'
  components: { patternWeight: number; techWeight: number; patternBullProb: number; techBullScore: number }
}

interface NiftyTechnicals {
  rsi: number | null; emaShort: number | null; emaLong: number | null
  emaCrossover: 'BULL' | 'BEAR' | null; vwap: number | null
  vwapAlign: 'BULL' | 'BEAR' | null; atr: number | null; atrPct: number | null
  momentum1m: number; momentum5m: number
  sessionHigh: number; sessionLow: number; rangePosition: number
  volume: number; oi: number
}

interface FlowState {
  cumDelta: number; cdZScore: number; aggressionRatio: number
  cusumPos: number; cusumNeg: number; cusumAlarm: 'BULL' | 'BEAR' | null
}

interface V2 {
  prediction: NiftyPrediction; sessionKey: string; sessionPatternCount: number
  flowState: FlowState | null; featureVec: number[]; kalmanVelocity: number
}

interface MetaRegime {
  regime: string; confidence: number; avgCdZ: number; avgObi: number
  divergenceScore: number; momentumSlope: number
}

interface PhaseAnalysis {
  phase: 'START' | 'MID' | 'END' | 'UNKNOWN'
  phaseConfidence: number
  stability: 'STABLE' | 'TRANSITIONING' | 'NOISY'
  stabilityScore: number
  cdVelTrend: 'RISING' | 'FLAT' | 'FALLING'
  cdVelSlope: number
  obiCdAlignment: 'HIDDEN' | 'VISIBLE' | 'NEUTRAL'
  regimeDurationMin: number
  trendDirection: 'BULL' | 'BEAR' | null
}

interface OTSPosition {
  id: string; entryTs: number; entryTime: string
  direction: 'BULL' | 'BEAR'; optType: 'CE' | 'PE'; strike: number
  lots: number; lotSize: number
  entryPrice: number; currentPrice: number
  target: number; stopLoss: number; dynamicStop: number
  pnl: number; peakPnl: number; peakPrice: number; holdingMins: number
  phaseAtEntry: string; stabilityAtEntry: string; obiAlignAtEntry: string
  entrySignalScore: number
  status: 'OPEN' | 'CLOSED'
  exitTime?: string; exitPrice?: number; exitReason?: string; closedPnl?: number
}

interface OTSDecision {
  action: 'WAIT' | 'ENTER' | 'STAY' | 'TIGHTEN' | 'EXIT_TARGET' | 'EXIT_STOP' | 'EXIT_PHASE'
  reason: string; signalScore: number; signals: string[]
  direction?: 'BULL' | 'BEAR'
  suggestedStrike?: number; suggestedType?: 'CE' | 'PE'; suggestedEntryLtp?: number
  target?: number; stopLoss?: number
}

interface OTSStats {
  totalTrades: number; wins: number; winRate: number; totalPnl: number
  bestTrade: number; worstTrade: number; avgTrade: number
}

interface OTSState {
  position: OTSPosition | null; history: OTSPosition[]; decision: OTSDecision; stats: OTSStats
}

interface SysLogEntry {
  cycleTs: number; cycleTime: string; predMove: number
  predDir: 'BULL' | 'BEAR' | null; predConf: number
  predBullProb: number; predBearProb: number
  spotAtPred: number; predSpot: number
  outcomeMove: number | null; outcomeDir: 'BULL' | 'BEAR' | null
  spotAtOutcome: number | null; resolved: boolean; correct: boolean | null
  sessionDay: string; peakMove?: number | null; targetHit?: boolean
  liveMove?: number | null; liveSpot?: number | null
  optStrike?: number | null; optType?: 'CE' | 'PE' | null
  optSymbol?: string | null; optEntry?: number | null; optTarget?: number | null
}

// ── Zero Hero ────────────────────────────────────────────────────────────────
// On expiry day (Tuesday NIFTY weekly), cheap OTM options can go 10× if the
// market moves enough. This panel ranks candidates and provides deep context:
// entry recommendation, realistic profit ladder, move aggressiveness, and
// Jane Street / MM defence awareness.

interface ZeroHeroCandidate {
  rank: number
  strike: number
  type: 'CE' | 'PE'
  ltp: number
  distancePts: number
  requiredMovePct: number
  heroTarget: number         // 10× LTP
  t2x: number                // 2× LTP (first partial exit)
  t5x: number                // 5× LTP
  signalScore: number
  oiStr: string
  ceOI?: number
  peOI?: number
  // New: aggressiveness context
  coverageRatio: number      // oracle move / required move
  isMovingNow: boolean       // 1m momentum already in direction
  limitSuggestion: number    // recommended limit entry price
  estimatedDelta: number     // rough delta estimate (0.05–0.35 OTM)
}

// Aggressiveness of the CURRENT move (not just prediction)
interface MoveAggressiveness {
  label: 'EXPLOSIVE' | 'BUILDING' | 'PREDICTED' | 'STALLING' | 'AGAINST_FLOW'
  color: string
  detail: string
  entryAdvice: string
  riskNote: string
}

function computeMoveAggressiveness(
  direction: 'BULL' | 'BEAR' | null,
  mom1m: number,         // fractional (e.g. 0.003 = 0.3%)
  mom5m: number,
  flowCdZ: number | null,
  cusumAlarm: 'BULL' | 'BEAR' | null,
  v2Dir: 'BULL' | 'BEAR' | null,
  daysToExpiry: number,
): MoveAggressiveness {
  if (!direction) return { label: 'STALLING', color: '#888', detail: 'No directional signal', entryAdvice: 'Wait for direction confirmation.', riskNote: '' }

  const isBull = direction === 'BULL'
  const mom1mDir = mom1m > 0.0015 ? 'BULL' : mom1m < -0.0015 ? 'BEAR' : null
  const mom5mDir = mom5m > 0.001 ? 'BULL' : mom5m < -0.001 ? 'BEAR' : null
  const cdAligned = flowCdZ != null && ((isBull && flowCdZ > 0.8) || (!isBull && flowCdZ < -0.8))
  const cusumAligned = cusumAlarm === direction
  const mom1mAligned = mom1mDir === direction
  const mom5mAligned = mom5mDir === direction
  const bothMomAligned = mom1mAligned && mom5mAligned

  // Against flow: oracle says one way, but live momentum is clearly the other
  if ((isBull && mom1m < -0.002) || (!isBull && mom1m > 0.002)) {
    return {
      label: 'AGAINST_FLOW', color: '#ff4444',
      detail: `Oracle ${direction} but 1m momentum is ${mom1m > 0 ? 'bullish' : 'bearish'} — divergence`,
      entryAdvice: 'WAIT — counter-momentum entry is dangerous. Jane Street will be selling into your panic buy.',
      riskNote: '⚠️ High risk: MM algos exploit directional confusion. Skip or reduce size significantly.',
    }
  }

  // Explosive: move in progress + CD + CUSUM all aligned
  if (bothMomAligned && cdAligned && cusumAligned) {
    return {
      label: 'EXPLOSIVE', color: '#00ff88',
      detail: `Price moving ${direction.toLowerCase()}, CD buying, CUSUM regime — all 4 signals aligned`,
      entryAdvice: daysToExpiry === 0
        ? 'Enter now at market — expiry gamma is high, small extra move = large option payoff.'
        : 'Enter at last traded price or 0.5 above ask. Move in progress.',
      riskNote: 'Best setup. Market makers widen spreads on strong moves — still pay max ₹1–2 above LTP.',
    }
  }

  // Building: momentum + CD aligned but no CUSUM (regime not yet confirmed)
  if (mom1mAligned && cdAligned) {
    return {
      label: 'BUILDING', color: '#eab308',
      detail: `1m momentum + CD aligned ${direction}, CUSUM pending`,
      entryAdvice: 'Use limit order at LTP or 1pt above. Set alert for CUSUM confirmation before adding size.',
      riskNote: 'Medium risk. Move may stall at next HVN / OI wall. Size down to 50% allocation.',
    }
  }

  // Only 5m momentum aligned (but 1m stalling)
  if (mom5mAligned && !mom1mAligned) {
    return {
      label: 'BUILDING', color: '#cc9900',
      detail: `5m trend ${direction} but 1m momentum slowing — potential pullback entry`,
      entryAdvice: 'Wait for 1m momentum to realign. If it does, enter on the next push.',
      riskNote: 'MM algos sell premium when momentum slows. Theta is highest in OTM strikes — time is against you.',
    }
  }

  // Predicted only: oracle says direction but no live momentum
  return {
    label: 'PREDICTED', color: '#888888',
    detail: `Oracle predicts ${direction} but no live momentum or flow confirmation yet`,
    entryAdvice: daysToExpiry === 0
      ? 'On expiry day, patterns alone are unreliable without price moving. Wait for first sign of momentum.'
      : 'Watch for 1m momentum confirmation. Do not enter on prediction alone.',
    riskNote: '⚠️ Jane Street and HFTs price this scenario into the premium. You are paying for a prediction, not a move.',
  }
}

function computeZeroHero(
  spot: number,
  chain: any | null,
  direction: 'BULL' | 'BEAR' | null,
  v2Dir: 'BULL' | 'BEAR' | null,
  flowCdZ: number | null,
  cusumAlarm: 'BULL' | 'BEAR' | null,
  patBullProb: number,
  predMove: number,
  mom1m: number,
  mom5m: number,
  daysToExpiry: number,
  fmtNumFn: (v: number) => string,
): ZeroHeroCandidate[] {
  if (!chain?.oiAnalytics || spot <= 0 || !direction) return []

  const strikes: any[] = chain.oiAnalytics.strikes
  const candidates: ZeroHeroCandidate[] = []

  const flowDir = flowCdZ != null ? (flowCdZ > 0.5 ? 'BULL' : flowCdZ < -0.5 ? 'BEAR' : null) : null
  const patDir = patBullProb > 0.55 ? 'BULL' : patBullProb < 0.45 ? 'BEAR' : null
  const mom1mDir = mom1m > 0.0015 ? 'BULL' : mom1m < -0.0015 ? 'BEAR' : null

  // Signal score (max 5.5)
  let baseScore = 1.5
  if (v2Dir === direction) baseScore += 1.0
  if (flowDir === direction) baseScore += 1.0
  if (cusumAlarm === direction) baseScore += 0.5
  if (patDir === direction) baseScore += 0.5
  if (mom1mDir === direction) baseScore += 1.0  // live momentum bonus

  for (const row of strikes) {
    if (direction === 'BULL') {
      if (row.strike <= spot) continue
      const ltp = row.ceLtp
      if (ltp <= 0 || ltp > 90) continue
      const requiredMovePct = (row.strike - spot) / spot * 100
      if (requiredMovePct > 3.5) continue

      const distPenalty = Math.max(0, requiredMovePct - 1.5) * 0.4
      const priceMult = ltp <= 8 ? 1.3 : ltp <= 25 ? 1.1 : ltp <= 50 ? 0.9 : 0.7
      const signalScore = baseScore * priceMult / (1 + distPenalty)
      // Delta estimate: rough log-normal proxy; 0.5 at ATM, decays with moneyness
      const moneyness = (spot - row.strike) / spot  // negative = OTM call
      const estimatedDelta = Math.max(0.04, 0.5 + moneyness * 8)

      candidates.push({
        rank: 0, strike: row.strike, type: 'CE', ltp,
        distancePts: row.strike - spot, requiredMovePct,
        heroTarget: Math.round(ltp * 10),
        t2x: Math.round(ltp * 2 * 10) / 10,
        t5x: Math.round(ltp * 5),
        signalScore,
        oiStr: fmtNumFn(row.ceOI), ceOI: row.ceOI,
        coverageRatio: Math.abs(predMove) > 0 ? Math.abs(predMove) / requiredMovePct : 0,
        isMovingNow: mom1mDir === 'BULL',
        limitSuggestion: Math.round((ltp + 0.5) * 2) / 2,  // nearest 0.5 above LTP
        estimatedDelta,
      })
    } else {
      if (row.strike >= spot) continue
      const ltp = row.peLtp
      if (ltp <= 0 || ltp > 90) continue
      const requiredMovePct = (spot - row.strike) / spot * 100
      if (requiredMovePct > 3.5) continue

      const distPenalty = Math.max(0, requiredMovePct - 1.5) * 0.4
      const priceMult = ltp <= 8 ? 1.3 : ltp <= 25 ? 1.1 : ltp <= 50 ? 0.9 : 0.7
      const signalScore = baseScore * priceMult / (1 + distPenalty)
      const moneyness = (row.strike - spot) / spot  // negative = OTM put
      const estimatedDelta = Math.max(0.04, 0.5 + moneyness * 8)

      candidates.push({
        rank: 0, strike: row.strike, type: 'PE', ltp,
        distancePts: spot - row.strike, requiredMovePct,
        heroTarget: Math.round(ltp * 10),
        t2x: Math.round(ltp * 2 * 10) / 10,
        t5x: Math.round(ltp * 5),
        signalScore,
        oiStr: fmtNumFn(row.peOI), peOI: row.peOI,
        coverageRatio: Math.abs(predMove) > 0 ? Math.abs(predMove) / requiredMovePct : 0,
        isMovingNow: mom1mDir === 'BEAR',
        limitSuggestion: Math.round((ltp + 0.5) * 2) / 2,
        estimatedDelta,
      })
    }
  }

  return candidates
    .sort((a, b) => b.signalScore - a.signalScore)
    .slice(0, 4)
    .map((c, i) => ({ ...c, rank: i + 1 }))
}

// ── Kalman Bias Estimator ─────────────────────────────────────────────────────
// Tracks systematic prediction error (bias) across resolved syslog entries.
// innovation_t = actualMove_t − predMove_t
// Kalman state = E[innovation] = expected residual = oracle's systematic drift
// correctedMove = rawPred + bias   |   sigma = sqrt(P + R) = 1-σ prediction interval

interface KalmanBiasState {
  bias: number          // estimated systematic residual: positive = oracle under-predicts
  P: number             // posterior variance of bias estimate
  innovVar: number      // adaptive measurement noise R (EMA of innovation²)
  correctedMove: number // rawPredMove + bias
  sigma: number         // 1-sigma prediction uncertainty = sqrt(P + R)
  nResolved: number
  rmse: number          // root mean squared error over resolved history
  hitRate: number       // fraction of entries where |innovation| < 0.3%
}

function computeKalmanBias(sysLog: SysLogEntry[], rawPredMove: number): KalmanBiasState | null {
  const resolved = [...sysLog]
    .filter(e => e.resolved && e.outcomeMove != null)
    .sort((a, b) => a.cycleTs - b.cycleTs)
  if (resolved.length < 5) return null

  // Kalman parameters
  const Q = 1e-5   // process noise — bias drifts slowly
  let x = 0        // state: expected innovation
  let P = 0.01     // initial state variance

  // Adaptive R: EMA of innovation² so noisy periods lower gain automatically
  let innovVarEMA = 0.04
  const alpha = 0.25

  let sumSq = 0
  let hitCount = 0

  for (const e of resolved) {
    const innov = e.outcomeMove! - e.predMove

    // Update adaptive measurement noise
    innovVarEMA = alpha * innov * innov + (1 - alpha) * innovVarEMA
    const R = Math.max(innovVarEMA, 1e-5)

    // Kalman predict
    const Ppred = P + Q

    // Kalman update
    const K = Ppred / (Ppred + R)
    x = x + K * (innov - x)
    P = (1 - K) * Ppred

    sumSq += innov * innov
    if (Math.abs(innov) < 0.003) hitCount++   // within ±0.3%
  }

  const n = resolved.length
  const R = Math.max(innovVarEMA, 1e-5)

  return {
    bias: x,
    P,
    innovVar: R,
    correctedMove: rawPredMove + x,
    sigma: Math.sqrt(P + R),
    nResolved: n,
    rmse: Math.sqrt(sumSq / n),
    hitRate: hitCount / n,
  }
}

interface NiftyFutState {
  prediction: NiftyPrediction; technicals: NiftyTechnicals; composite: NiftyComposite
  snapshotCount: number; patternCount: number; resolvedCount: number
  proxy: number; minutesAccumulated: number
  sysLog: SysLogEntry[]; chain: any | null
  spot: number; futureSymbol: string; futureToken: number
  marketOpen: boolean; pat20Con: any | null; p20cSysLog: any[]
  elliottWave: any | null; elliottWaveByTF: Record<string, any>
  metaRegime: MetaRegime | null; v2: V2 | null; phaseAnalysis: PhaseAnalysis | null; otsState: OTSState | null
  depth?: { buy: { price: number; quantity: number; orders: number }[]; sell: { price: number; quantity: number; orders: number }[] }
}

// ── Style palette ─────────────────────────────────────────────────────────────

const S = {
  bull: '#00ff88',
  bear: '#ff4444',
  neutral: '#888',
  bg: 'var(--bg)',
  panel: 'var(--card-bg)',
  text: 'var(--text)',
  text2: 'var(--text2)',
  border: 'var(--border)',
  font: "'Courier New', monospace",
}

function dirColor(d: 'BULL' | 'BEAR' | null) {
  return d === 'BULL' ? S.bull : d === 'BEAR' ? S.bear : S.neutral
}

function fmtPct(v: number, d = 2) {
  return `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`
}

function fmtNum(v: number) {
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)}K`
  return v.toFixed(1)
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function N50FutConvictionClient({ role }: { role: string }) {
  const router = useRouter()
  const [state, setState] = useState<NiftyFutState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastFetch, setLastFetch] = useState(0)
  const [loading, setLoading] = useState(true)

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch('/api/niftyfut', { cache: 'no-store' })
      if (res.status === 401) { router.push('/'); return }
      if (!res.ok) { setError(`HTTP ${res.status}`); return }
      const data = await res.json()
      setState(data)
      setError(null)
      setLastFetch(Date.now())
    } catch (e: any) {
      setError(e?.message ?? 'fetch failed')
    } finally {
      setLoading(false)
    }
  }, [router])

  useEffect(() => {
    fetchState()
    const id = setInterval(fetchState, 4000)
    return () => clearInterval(id)
  }, [fetchState])

  const base: React.CSSProperties = {
    minHeight: '100vh', background: S.bg, color: S.text,
    fontFamily: S.font, fontSize: '12px', padding: '12px',
  }

  const card: React.CSSProperties = {
    background: S.panel, border: `1px solid ${S.border}`,
    borderRadius: '6px', padding: '12px', marginBottom: '10px',
  }

  const label: React.CSSProperties = {
    fontSize: '9px', color: S.text2, letterSpacing: '1px',
    textTransform: 'uppercase', marginBottom: '4px',
  }

  if (loading) {
    return (
      <div style={base}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <span style={{ fontSize: '14px', fontWeight: 'bold' }}>NIFTY50 FUTURES — CONVICTION</span>
          <ThemeToggle />
        </div>
        <div style={{ color: S.text2 }}>Loading…</div>
      </div>
    )
  }

  if (error || !state) {
    return (
      <div style={base}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <span style={{ fontSize: '14px', fontWeight: 'bold' }}>NIFTY50 FUTURES — CONVICTION</span>
          <ThemeToggle />
        </div>
        <div style={{ color: S.bear }}>Error: {error ?? 'no data'}</div>
      </div>
    )
  }

  const s = state
  const comp = s.composite
  const pred = s.prediction
  const tech = s.technicals
  const v2 = s.v2
  const flow = v2?.flowState ?? null
  const mr = s.metaRegime
  const pa  = s.phaseAnalysis
  const ots = s.otsState

  const age = lastFetch ? Math.round((Date.now() - lastFetch) / 1000) : 0
  const kb = computeKalmanBias(s.sysLog, comp.predictedMove)

  // ── Zero Hero computation ──────────────────────────────────────────────────
  const effectiveDir: 'BULL' | 'BEAR' | null = kb
    ? (kb.correctedMove > 0.01 ? 'BULL' : kb.correctedMove < -0.01 ? 'BEAR' : null)
    : comp.direction
  const effectivePredMove = kb ? kb.correctedMove : comp.predictedMove
  const v2Dir = v2?.prediction.direction ?? null
  const flowCdZ = (v2?.flowState?.cdZScore) ?? null
  const cusumAlarm = (v2?.flowState?.cusumAlarm) ?? null
  const patBullProb = pred.bullProb

  const mom1m = tech.momentum1m ?? 0
  const mom5m = tech.momentum5m ?? 0

  // Days to expiry in IST
  const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
  const expiryStr = s.chain?.expiry ?? ''
  const daysToExpiry = expiryStr
    ? Math.round((new Date(expiryStr + 'T00:00:00+05:30').getTime() - new Date(todayIST + 'T00:00:00+05:30').getTime()) / 86400000)
    : 99
  const isExpiryDay = daysToExpiry === 0

  const zeroHeroCandidates = computeZeroHero(
    s.spot, s.chain, effectiveDir, v2Dir, flowCdZ, cusumAlarm, patBullProb,
    effectivePredMove, mom1m, mom5m, daysToExpiry, fmtNum
  )

  const moveAgg = computeMoveAggressiveness(
    effectiveDir, mom1m, mom5m, flowCdZ, cusumAlarm, v2Dir, daysToExpiry
  )

  // Signal count for header display
  const zeroHeroSignalCount = (() => {
    let n = effectiveDir ? 1 : 0  // oracle
    if (v2Dir === effectiveDir) n++
    const fd = flowCdZ != null ? (flowCdZ > 0.5 ? 'BULL' : flowCdZ < -0.5 ? 'BEAR' : null) : null
    if (fd === effectiveDir) n++
    if (cusumAlarm === effectiveDir) n++
    const pd = patBullProb > 0.55 ? 'BULL' : patBullProb < 0.45 ? 'BEAR' : null
    if (pd === effectiveDir) n++
    const md = mom1m > 0.0015 ? 'BULL' : mom1m < -0.0015 ? 'BEAR' : null
    if (md === effectiveDir) n++
    return n
  })()

  return (
    <div style={base}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap', gap: '6px' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
            <span style={{ fontSize: '14px', fontWeight: 'bold' }}>NIFTY50 FUTURES — CONVICTION</span>
            <span style={{ color: s.marketOpen ? S.bull : S.neutral, fontSize: '10px' }}>
              {s.marketOpen ? '● MARKET OPEN' : '○ CLOSED'}
            </span>
          </div>
          <div style={{ display: 'flex', gap: '6px', marginTop: '4px' }}>
            {[
              { href: '/dashboard/conviction', label: '◀ N50 STOCKS' },
              { href: '/dashboard/conviction-crude', label: 'CRUDE ▶' },
            ].map(l => (
              <a key={l.href} href={l.href} style={{
                fontSize: '9px', color: S.text2, textDecoration: 'none',
                padding: '2px 7px', border: `1px solid ${S.border}`,
                borderRadius: '3px', letterSpacing: '0.06em',
                fontFamily: S.font,
              }}>{l.label}</a>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <span style={{ color: S.text2, fontSize: '10px' }}>{age}s ago</span>
          <ThemeToggle />
        </div>
      </div>

      {/* Main row: spot + composite + pattern */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px', marginBottom: '10px' }}>

        {/* Spot */}
        <div style={card}>
          <div style={label}>SPOT / FUTURES</div>
          <div style={{ fontSize: '22px', fontWeight: 'bold', color: dirColor(comp.direction) }}>
            {s.spot > 0 ? s.spot.toFixed(1) : '—'}
          </div>
          <div style={{ color: S.text2, marginTop: '4px' }}>{s.futureSymbol || 'NIFTY'}</div>
          <div style={{ color: comp.direction ? dirColor(comp.direction) : S.text2, marginTop: '4px' }}>
            proxy {fmtPct(s.proxy)}
          </div>
          <div style={{ marginTop: '6px', color: S.text2, fontSize: '11px' }}>
            Hi {tech.sessionHigh > 0 ? tech.sessionHigh.toFixed(0) : '—'} ·
            Lo {tech.sessionLow > 0 ? tech.sessionLow.toFixed(0) : '—'}
          </div>
          {s.depth && s.depth.buy.length > 0 && (
            <div style={{ marginTop: '6px', fontSize: '11px' }}>
              <span style={{ color: S.bull }}>B {s.depth.buy[0]?.price?.toFixed(1)}</span>
              {' / '}
              <span style={{ color: S.bear }}>A {s.depth.sell[0]?.price?.toFixed(1)}</span>
            </div>
          )}
        </div>

        {/* Composite Oracle */}
        <div style={card}>
          <div style={label}>COMPOSITE ORACLE{kb ? ' ⟳ KALMAN' : ''}</div>
          <div style={{ fontSize: '20px', fontWeight: 'bold', color: dirColor(kb ? (kb.correctedMove > 0 ? 'BULL' : kb.correctedMove < 0 ? 'BEAR' : null) : comp.direction) }}>
            {kb ? (kb.correctedMove > 0 ? 'BULL ▲' : kb.correctedMove < 0 ? 'BEAR ▼' : 'NEUTRAL') : (comp.direction ?? 'NEUTRAL')}
          </div>
          <div style={{ marginTop: '6px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px', fontSize: '11px' }}>
            <div>raw <span style={{ color: dirColor(comp.direction) }}>{fmtPct(comp.predictedMove)}</span></div>
            <div>conf <span style={{ color: S.text }}>{(comp.confidence * 100).toFixed(0)}%</span></div>
            {kb ? (
              <>
                <div>adj <span style={{ color: dirColor(kb.correctedMove > 0 ? 'BULL' : kb.correctedMove < 0 ? 'BEAR' : null) }}>{fmtPct(kb.correctedMove)}</span></div>
                <div style={{ color: S.text2 }}>±{kb.sigma.toFixed(3)}%σ</div>
                <div style={{ color: kb.bias > 0.01 ? S.bull : kb.bias < -0.01 ? S.bear : S.text2 }}>
                  bias {fmtPct(kb.bias, 3)} {Math.abs(kb.bias) > 0.01 ? (kb.bias > 0 ? 'cold' : 'hot') : '·'}
                </div>
                <div style={{ color: S.text2 }}>n={kb.nResolved}</div>
              </>
            ) : (
              <>
                <div style={{ color: S.bull }}>bull {(comp.bullProb * 100).toFixed(0)}%</div>
                <div style={{ color: S.bear }}>bear {(comp.bearProb * 100).toFixed(0)}%</div>
              </>
            )}
          </div>
          {kb && (
            <div style={{ marginTop: '4px', fontSize: '10px', color: S.text2, display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <span>rmse={fmtPct(kb.rmse, 3)}</span>
              <span>hit±0.3%: {Math.round(kb.hitRate * 100)}%</span>
              <span style={{ color: S.bull }}>bull {(comp.bullProb * 100).toFixed(0)}%</span>
              <span style={{ color: S.bear }}>bear {(comp.bearProb * 100).toFixed(0)}%</span>
            </div>
          )}
          <div style={{ marginTop: '4px', fontSize: '10px', color: S.text2 }}>status: {comp.status}</div>
          {mr && (
            <div style={{ marginTop: '4px', fontSize: '10px', color: dirColor(mr.avgCdZ > 0 ? 'BULL' : mr.avgCdZ < 0 ? 'BEAR' : null) }}>
              regime: {mr.regime} ({(mr.confidence * 100).toFixed(0)}%)
            </div>
          )}
        </div>

        {/* Pattern Memory */}
        <div style={card}>
          <div style={label}>PATTERN MEMORY (V1)</div>
          <div style={{ fontSize: '18px', fontWeight: 'bold', color: dirColor(pred.direction) }}>
            {pred.direction ?? (pred.status === 'no_data' ? 'NO DATA' : 'NEUTRAL')}
          </div>
          <div style={{ marginTop: '6px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px', fontSize: '11px' }}>
            <div>n={pred.nResolved}</div>
            <div>sim {pred.topSim.toFixed(2)}</div>
            <div style={{ color: S.bull }}>bull {(pred.bullProb * 100).toFixed(0)}%</div>
            <div style={{ color: S.bear }}>bear {(pred.bearProb * 100).toFixed(0)}%</div>
          </div>
          {pred.h5 && pred.h15 && pred.h20 && (
            <div style={{ marginTop: '6px', fontSize: '10px', color: S.text2 }}>
              5m {fmtPct(pred.h5.predictedMove)} ·
              15m {fmtPct(pred.h15.predictedMove)} ·
              20m {fmtPct(pred.h20.predictedMove)}
            </div>
          )}
          <div style={{ marginTop: '4px', fontSize: '10px', color: S.text2 }}>
            snaps={s.snapshotCount} · resolved={s.resolvedCount}
          </div>
        </div>
      </div>

      {/* V2 Oracle + Flow State */}
      {v2 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '10px' }}>
          <div style={card}>
            <div style={label}>ORACLE V2 ({v2.sessionKey?.toUpperCase()})</div>
            <div style={{ fontSize: '18px', fontWeight: 'bold', color: dirColor(v2.prediction.direction) }}>
              {v2.prediction.direction ?? 'NEUTRAL'}
            </div>
            <div style={{ marginTop: '6px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px', fontSize: '11px' }}>
              <div>move <span style={{ color: dirColor(v2.prediction.direction) }}>{fmtPct(v2.prediction.predictedMove)}</span></div>
              <div>n={v2.sessionPatternCount}</div>
              <div style={{ color: S.bull }}>bull {(v2.prediction.bullProb * 100).toFixed(0)}%</div>
              <div style={{ color: S.bear }}>bear {(v2.prediction.bearProb * 100).toFixed(0)}%</div>
            </div>
            <div style={{ marginTop: '4px', fontSize: '10px', color: S.text2 }}>
              kalman vel: {v2.kalmanVelocity.toFixed(2)} pts/min
            </div>
          </div>

          {flow && (
            <div style={card}>
              <div style={label}>FLOW STATE (from bot)</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px', fontSize: '11px' }}>
                <div>CD <span style={{ color: dirColor(flow.cumDelta > 0 ? 'BULL' : flow.cumDelta < 0 ? 'BEAR' : null) }}>{fmtNum(flow.cumDelta)}</span></div>
                <div>cdZ <span style={{ color: dirColor(flow.cdZScore > 0.5 ? 'BULL' : flow.cdZScore < -0.5 ? 'BEAR' : null) }}>{flow.cdZScore.toFixed(2)}σ</span></div>
                <div>agg <span style={{ color: dirColor(flow.aggressionRatio > 0 ? 'BULL' : flow.aggressionRatio < 0 ? 'BEAR' : null) }}>{(flow.aggressionRatio * 100).toFixed(0)}%</span></div>
                <div>
                  {flow.cusumAlarm
                    ? <span style={{ color: dirColor(flow.cusumAlarm) }}>⚡CUSUM:{flow.cusumAlarm}</span>
                    : <span style={{ color: S.text2 }}>cusum: quiet</span>}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── ORACLE PHASE ANALYSIS ── always rendered, shows WARMING when insufficient data */}
      {(() => {
        const phaseColor = (ph: string) =>
          ph === 'START' ? '#eab308' :
          ph === 'MID'   ? S.bull :
          ph === 'END'   ? S.bear : S.neutral
        const trendArrow = (t: string) =>
          t === 'RISING' ? '▲' : t === 'FALLING' ? '▼' : '—'
        const alignIcon = (a: string) =>
          a === 'HIDDEN' ? '🫥' : a === 'VISIBLE' ? '👁' : '〰️'
        const stabilityBadge = (s: string) =>
          s === 'STABLE' ? { color: S.bull, label: 'STABLE' } :
          s === 'TRANSITIONING' ? { color: '#eab308', label: 'TRANSIT' } :
          { color: S.bear, label: 'NOISY' }

        if (!pa) {
          return (
            <div style={{ ...card, marginBottom: '10px' }}>
              <div style={label}>ORACLE PHASE ANALYSIS</div>
              <div style={{ fontSize: '10px', color: S.text2, padding: '6px 0' }}>
                Warming — need 5+ V2 session patterns. {v2 ? `Session: ${v2.sessionKey} (${v2.sessionPatternCount} resolved)` : 'V2 not ready.'}
              </div>
            </div>
          )
        }

        const sb = stabilityBadge(pa.stability)
        const phaseInterpretation = pa.phase === 'START'
          ? (pa.obiCdAlignment === 'HIDDEN'
            ? 'Kyle accumulation: CD diverging from book — institution in hidden phase. Early entry, expect expansion.'
            : 'Momentum just building. cdVelZ rising. Enter with trend, tight stop.')
          : pa.phase === 'MID'
          ? (pa.obiCdAlignment === 'VISIBLE'
            ? 'Stackelberg markup: OBI aligned with CD — visible institutional flow. Ride with trend, trail stops.'
            : 'Sustained regime, stable signals. Core position phase — stay in unless CD fades.')
          : pa.phase === 'END'
          ? (pa.cdVelTrend === 'FALLING'
            ? 'CD momentum fading — regime exhausting. Consider target-and-exit, not adding.'
            : `Long-running regime (${pa.regimeDurationMin}m). Reversal risk elevated. Tighten exits.`)
          : 'Insufficient data or CHOP — no phase signal.'

        return (
          <div style={{ ...card, marginBottom: '10px', border: `1px solid ${phaseColor(pa.phase)}44` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
              <div style={label}>ORACLE PHASE ANALYSIS</div>
              {pa.trendDirection && (
                <span style={{ fontSize: '9px', color: dirColor(pa.trendDirection), padding: '1px 5px', border: `1px solid ${dirColor(pa.trendDirection)}55`, borderRadius: '3px' }}>
                  {pa.trendDirection}
                </span>
              )}
            </div>

            {/* Phase label + confidence */}
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '8px' }}>
              <span style={{ fontSize: '22px', fontWeight: 900, color: phaseColor(pa.phase), letterSpacing: '-0.02em' }}>
                {pa.phase}
              </span>
              <span style={{ fontSize: '11px', color: S.text2 }}>
                {(pa.phaseConfidence * 100).toFixed(0)}% conf
              </span>
              {pa.regimeDurationMin > 0 && (
                <span style={{ fontSize: '10px', color: S.text2 }}>{pa.regimeDurationMin}m in regime</span>
              )}
            </div>

            {/* Signal grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px', fontSize: '11px', marginBottom: '8px' }}>
              <div>
                <span style={{ color: S.text2, fontSize: '9px' }}>STABILITY</span><br />
                <span style={{ color: sb.color, fontWeight: 'bold' }}>{sb.label}</span>
                <span style={{ color: S.text2, fontSize: '9px' }}> {(pa.stabilityScore * 100).toFixed(0)}%</span>
              </div>
              <div>
                <span style={{ color: S.text2, fontSize: '9px' }}>cdVEL TREND</span><br />
                <span style={{ color: pa.cdVelTrend === 'RISING' ? S.bull : pa.cdVelTrend === 'FALLING' ? S.bear : S.neutral, fontWeight: 'bold' }}>
                  {trendArrow(pa.cdVelTrend)} {pa.cdVelTrend}
                </span>
              </div>
              <div>
                <span style={{ color: S.text2, fontSize: '9px' }}>OBI·CD ALIGN</span><br />
                <span style={{ color: pa.obiCdAlignment === 'HIDDEN' ? '#eab308' : pa.obiCdAlignment === 'VISIBLE' ? S.bull : S.text2, fontWeight: 'bold' }}>
                  {alignIcon(pa.obiCdAlignment)} {pa.obiCdAlignment}
                </span>
              </div>
            </div>

            {/* Interpretation */}
            <div style={{ fontSize: '9px', color: '#99aaaa', lineHeight: 1.5, padding: '5px 7px', background: 'rgba(255,255,255,0.03)', borderRadius: '4px', borderLeft: `2px solid ${phaseColor(pa.phase)}66` }}>
              {phaseInterpretation}
            </div>
          </div>
        )
      })()}

      {/* Technicals */}
      <div style={card}>
        <div style={label}>TECHNICALS</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '6px', fontSize: '11px' }}>
          <div>RSI <span style={{ color: tech.rsi != null ? (tech.rsi > 60 ? S.bull : tech.rsi < 40 ? S.bear : S.text) : S.neutral }}>{tech.rsi?.toFixed(0) ?? '—'}</span></div>
          <div>EMA <span style={{ color: dirColor(tech.emaCrossover) }}>{tech.emaCrossover ?? 'FLAT'}</span></div>
          <div>VWAP <span style={{ color: dirColor(tech.vwapAlign) }}>{tech.vwapAlign ?? 'AT'}</span></div>
          <div>ATR% <span>{tech.atrPct != null ? fmtPct(tech.atrPct * 100, 3) : '—'}</span></div>
          <div>1m <span style={{ color: dirColor(tech.momentum1m > 0 ? 'BULL' : tech.momentum1m < 0 ? 'BEAR' : null) }}>{fmtPct(tech.momentum1m * 100, 3)}</span></div>
          <div>5m <span style={{ color: dirColor(tech.momentum5m > 0 ? 'BULL' : tech.momentum5m < 0 ? 'BEAR' : null) }}>{fmtPct(tech.momentum5m * 100, 3)}</span></div>
          <div>Vol <span>{fmtNum(tech.volume)}</span></div>
          <div>OI <span>{fmtNum(tech.oi)}</span></div>
        </div>
      </div>

      {/* Sys Log */}
      {s.sysLog.length > 0 && (
        <div style={card}>
          <div style={label}>PREDICTION LOG · INNOVATION TRACKER (last {s.sysLog.length})</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '10px' }}>
              <thead>
                <tr style={{ color: S.text2, borderBottom: `1px solid ${S.border}` }}>
                  <th style={{ textAlign: 'left', padding: '2px 6px' }}>Time</th>
                  <th style={{ textAlign: 'left', padding: '2px 6px' }}>Dir</th>
                  <th style={{ textAlign: 'right', padding: '2px 6px' }}>Pred</th>
                  <th style={{ textAlign: 'right', padding: '2px 6px' }}>Actual</th>
                  <th style={{ textAlign: 'right', padding: '2px 6px' }} title="Innovation: actual − pred. Colour = |z| in σ units.">Innov</th>
                  <th style={{ textAlign: 'right', padding: '2px 6px' }}>Spot</th>
                  <th style={{ textAlign: 'center', padding: '2px 6px' }}>✓</th>
                </tr>
              </thead>
              <tbody>
                {[...s.sysLog].reverse().map((e, i) => {
                  const innov = (e.resolved && e.outcomeMove != null) ? (e.outcomeMove - e.predMove) : null
                  // z-score: how surprising was this innovation relative to typical noise?
                  const sigma = kb?.sigma ?? 0.01
                  const absZ = innov != null ? Math.abs(innov) / sigma : 0
                  const innovColor = innov == null ? S.text2
                    : absZ > 1.5 ? (innov > 0 ? S.bull : S.bear)   // large surprise
                    : absZ > 0.5 ? (innov > 0 ? '#55cc88' : '#cc6666')  // moderate
                    : S.text2   // within noise
                  return (
                    <tr key={e.cycleTs} style={{ borderBottom: `1px solid ${S.border}`, opacity: i > 9 ? 0.6 : 1 }}>
                      <td style={{ padding: '2px 6px' }}>{e.cycleTime}</td>
                      <td style={{ padding: '2px 6px', color: dirColor(e.predDir) }}>{e.predDir ?? '·'}</td>
                      <td style={{ padding: '2px 6px', textAlign: 'right', color: dirColor(e.predDir) }}>{fmtPct(e.predMove)}</td>
                      <td style={{ padding: '2px 6px', textAlign: 'right', color: dirColor(e.outcomeDir) }}>
                        {e.outcomeMove != null ? fmtPct(e.outcomeMove) : (e.liveMove != null ? `~${fmtPct(e.liveMove)}` : '…')}
                      </td>
                      <td style={{ padding: '2px 6px', textAlign: 'right', color: innovColor }}>
                        {innov != null ? `${fmtPct(innov)} ${absZ > 0.5 ? `(${absZ.toFixed(1)}σ)` : ''}` : '·'}
                      </td>
                      <td style={{ padding: '2px 6px', textAlign: 'right' }}>{e.spotAtPred.toFixed(0)}</td>
                      <td style={{ padding: '2px 6px', textAlign: 'center' }}>
                        {!e.resolved ? '…' : e.correct === true ? <span style={{ color: S.bull }}>✓</span> : e.correct === false ? <span style={{ color: S.bear }}>✗</span> : '·'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Kalman summary row */}
          {kb ? (
            <div style={{ marginTop: '8px', padding: '6px 8px', background: 'rgba(255,255,255,0.03)', borderRadius: '4px', fontSize: '10px', display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
              <span style={{ color: S.text2, fontSize: '9px', letterSpacing: '1px' }}>KALMAN</span>
              <span>n={kb.nResolved}</span>
              <span>
                bias <span style={{ color: kb.bias > 0.01 ? S.bull : kb.bias < -0.01 ? S.bear : S.text2 }}>
                  {fmtPct(kb.bias, 3)}
                </span>
                <span style={{ color: S.text2 }}> {Math.abs(kb.bias) > 0.01 ? (kb.bias > 0 ? '(oracle cold)' : '(oracle hot)') : '(unbiased)'}</span>
              </span>
              <span>P={kb.P.toExponential(1)}</span>
              <span>σ=±{kb.sigma.toFixed(3)}%</span>
              <span>RMSE={fmtPct(kb.rmse, 3)}</span>
              <span>hit±0.3%: {Math.round(kb.hitRate * 100)}%</span>
            </div>
          ) : (
            <div style={{ marginTop: '6px', fontSize: '10px', color: S.text2 }}>
              Kalman calibration: {s.sysLog.filter(e => e.resolved).length}/5 resolved entries needed
            </div>
          )}
        </div>
      )}

      {/* OI Chain */}
      {s.chain?.oiAnalytics && (
        <div style={card}>
          <div style={label}>OPTION CHAIN OI (expiry: {s.chain.expiry})</div>
          <div style={{ fontSize: '10px', color: S.text2, marginBottom: '6px' }}>
            PCR {s.chain.oiAnalytics.pcr.toFixed(2)} ·
            MaxPain {s.chain.oiAnalytics.maxPainStrike} ·
            Pull {s.chain.oiAnalytics.maxPainPull ?? 0}%
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '10px' }}>
              <thead>
                <tr style={{ color: S.text2, borderBottom: `1px solid ${S.border}` }}>
                  <th style={{ textAlign: 'right', padding: '2px 6px' }}>CE OI</th>
                  <th style={{ textAlign: 'right', padding: '2px 6px' }}>CE LTP</th>
                  <th style={{ textAlign: 'center', padding: '2px 8px', fontWeight: 'bold' }}>STRIKE</th>
                  <th style={{ textAlign: 'left', padding: '2px 6px' }}>PE LTP</th>
                  <th style={{ textAlign: 'left', padding: '2px 6px' }}>PE OI</th>
                </tr>
              </thead>
              <tbody>
                {s.chain.oiAnalytics.strikes.map((row: any) => {
                  const isAtm = row.strike === s.chain!.atmStrike
                  const isMaxPain = row.strike === s.chain!.oiAnalytics!.maxPainStrike
                  return (
                    <tr key={row.strike} style={{
                      borderBottom: `1px solid ${S.border}`,
                      background: isAtm ? 'rgba(255,255,255,0.04)' : undefined,
                      fontWeight: isAtm ? 'bold' : undefined,
                    }}>
                      <td style={{ textAlign: 'right', padding: '2px 6px', color: S.bear }}>
                        {fmtNum(row.ceOI)}
                      </td>
                      <td style={{ textAlign: 'right', padding: '2px 6px', color: S.bear }}>
                        {row.ceLtp > 0 ? row.ceLtp.toFixed(1) : '—'}
                      </td>
                      <td style={{ textAlign: 'center', padding: '2px 8px' }}>
                        {isMaxPain ? '★' : ''}{row.strike}
                      </td>
                      <td style={{ textAlign: 'left', padding: '2px 6px', color: S.bull }}>
                        {row.peLtp > 0 ? row.peLtp.toFixed(1) : '—'}
                      </td>
                      <td style={{ textAlign: 'left', padding: '2px 6px', color: S.bull }}>
                        {fmtNum(row.peOI)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ⚡ Zero Hero Panel */}
      {s.chain?.oiAnalytics && (
        <div style={{
          ...card,
          border: `1px solid ${
            moveAgg.label === 'EXPLOSIVE'
              ? (effectiveDir === 'BULL' ? 'rgba(0,255,136,0.7)' : 'rgba(255,68,68,0.7)')
              : moveAgg.label === 'BUILDING'
              ? 'rgba(234,179,8,0.5)'
              : moveAgg.label === 'AGAINST_FLOW'
              ? 'rgba(255,68,68,0.6)'
              : S.border
          }`,
          marginBottom: '10px',
        }}>

          {/* ── Panel Header ── */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px', flexWrap: 'wrap', gap: '4px' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ ...label, marginBottom: 0, fontSize: '10px', fontWeight: 'bold', color: S.text }}>⚡ ZERO HERO</span>
                {isExpiryDay
                  ? <span style={{ fontSize: '10px', fontWeight: 'bold', color: effectiveDir ? dirColor(effectiveDir) : S.text2, padding: '2px 6px', background: effectiveDir === 'BULL' ? 'rgba(0,255,136,0.12)' : effectiveDir === 'BEAR' ? 'rgba(255,68,68,0.12)' : 'transparent', borderRadius: '3px' }}>EXPIRY TODAY</span>
                  : <span style={{ fontSize: '9px', color: S.text2 }}>exp {expiryStr} ({daysToExpiry}d)</span>}
              </div>
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', fontSize: '10px' }}>
              <span style={{ color: S.text2 }}>dir: <span style={{ color: dirColor(effectiveDir), fontWeight: 'bold' }}>{effectiveDir ?? '—'}</span></span>
              <span style={{ color: zeroHeroSignalCount >= 4 ? S.bull : zeroHeroSignalCount >= 2 ? '#aaa' : S.bear }}>sig: {zeroHeroSignalCount}/6</span>
            </div>
          </div>

          {/* ── Move Aggressiveness Bar ── */}
          <div style={{
            padding: '8px 10px', borderRadius: '5px', marginBottom: '8px',
            background: moveAgg.label === 'EXPLOSIVE' ? 'rgba(0,255,136,0.07)'
              : moveAgg.label === 'BUILDING' ? 'rgba(234,179,8,0.07)'
              : moveAgg.label === 'AGAINST_FLOW' ? 'rgba(255,68,68,0.10)'
              : 'rgba(255,255,255,0.03)',
            border: `1px solid ${moveAgg.color}44`,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
              <span style={{
                fontSize: '10px', fontWeight: 900, letterSpacing: '0.08em',
                color: moveAgg.color, padding: '1px 6px',
                background: `${moveAgg.color}18`, borderRadius: '3px',
              }}>{moveAgg.label}</span>
              <span style={{ fontSize: '10px', color: S.text2 }}>{moveAgg.detail}</span>
            </div>
            {/* Live momentum bars */}
            <div style={{ display: 'flex', gap: '12px', fontSize: '10px', marginBottom: '4px' }}>
              <span style={{ color: S.text2 }}>1m <span style={{ color: dirColor(mom1m > 0.001 ? 'BULL' : mom1m < -0.001 ? 'BEAR' : null), fontWeight: 'bold' }}>{fmtPct(mom1m * 100, 3)}</span></span>
              <span style={{ color: S.text2 }}>5m <span style={{ color: dirColor(mom5m > 0.001 ? 'BULL' : mom5m < -0.001 ? 'BEAR' : null), fontWeight: 'bold' }}>{fmtPct(mom5m * 100, 3)}</span></span>
              {flowCdZ != null && <span style={{ color: S.text2 }}>CD <span style={{ color: dirColor(flowCdZ > 0.5 ? 'BULL' : flowCdZ < -0.5 ? 'BEAR' : null), fontWeight: 'bold' }}>{flowCdZ.toFixed(2)}σ</span></span>}
              {cusumAlarm && <span style={{ fontWeight: 'bold', color: dirColor(cusumAlarm) }}>⚡CUSUM:{cusumAlarm}</span>}
            </div>
            <div style={{ fontSize: '9px', color: moveAgg.label === 'AGAINST_FLOW' ? '#ff8888' : moveAgg.label === 'PREDICTED' ? '#999' : '#88cc88', lineHeight: 1.5 }}>
              <span style={{ fontWeight: 'bold' }}>Entry: </span>{moveAgg.entryAdvice}
            </div>
            {moveAgg.riskNote && (
              <div style={{ fontSize: '9px', color: moveAgg.label === 'EXPLOSIVE' ? '#00cc77' : '#cc8800', marginTop: '2px', lineHeight: 1.5 }}>
                {moveAgg.riskNote}
              </div>
            )}
          </div>

          {effectiveDir === null ? (
            <div style={{ fontSize: '10px', color: S.text2, padding: '8px 0' }}>
              No directional signal — Zero Hero needs a direction. Oracle is neutral.
            </div>
          ) : zeroHeroCandidates.length === 0 ? (
            <div style={{ fontSize: '10px', color: S.text2, padding: '8px 0' }}>
              No suitable OTM options found (all too expensive or too far OTM).
            </div>
          ) : (
            <>
              {/* ── Candidate Table ── */}
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '10px' }}>
                  <thead>
                    <tr style={{ color: S.text2, borderBottom: `1px solid ${S.border}`, fontSize: '9px', letterSpacing: '0.06em' }}>
                      <th style={{ textAlign: 'center', padding: '3px 4px' }}>#</th>
                      <th style={{ textAlign: 'right', padding: '3px 6px' }}>STRIKE</th>
                      <th style={{ textAlign: 'right', padding: '3px 6px' }}>ENTRY</th>
                      <th style={{ textAlign: 'right', padding: '3px 6px' }}>LIMIT</th>
                      <th style={{ textAlign: 'right', padding: '3px 6px' }}>2× / 5× / 10×</th>
                      <th style={{ textAlign: 'right', padding: '3px 6px' }}>NEED</th>
                      <th style={{ textAlign: 'right', padding: '3px 6px' }}>CVRG</th>
                      <th style={{ textAlign: 'center', padding: '3px 6px' }}>Δ≈</th>
                      <th style={{ textAlign: 'center', padding: '3px 6px' }}>SIG</th>
                    </tr>
                  </thead>
                  <tbody>
                    {zeroHeroCandidates.map((c) => {
                      const isTop = c.rank === 1
                      const coveragePct = Math.round(c.coverageRatio * 100)
                      const coverageColor = coveragePct >= 100 ? S.bull : coveragePct >= 60 ? '#eab308' : S.bear
                      const starsFilled = Math.min(6, Math.round(c.signalScore / 5.5 * 6))
                      const stars = '★'.repeat(starsFilled) + '☆'.repeat(6 - starsFilled)
                      const starsColor = starsFilled >= 5 ? S.bull : starsFilled >= 3 ? '#aaa' : S.text2
                      const typeColor = c.type === 'CE' ? '#ff8866' : '#66aaff'
                      return (
                        <tr key={`${c.strike}-${c.type}`} style={{
                          borderBottom: `1px solid ${S.border}`,
                          background: isTop ? (effectiveDir === 'BULL' ? 'rgba(0,255,136,0.05)' : 'rgba(255,68,68,0.05)') : undefined,
                        }}>
                          <td style={{ textAlign: 'center', padding: '3px 4px', fontWeight: isTop ? 'bold' : undefined }}>
                            {isTop ? '🎯' : `#${c.rank}`}
                          </td>
                          <td style={{ textAlign: 'right', padding: '3px 6px', fontWeight: isTop ? 'bold' : undefined, color: typeColor }}>
                            {c.strike} {c.type}
                          </td>
                          <td style={{ textAlign: 'right', padding: '3px 6px', fontWeight: isTop ? 'bold' : undefined }}>
                            ₹{c.ltp.toFixed(1)}
                          </td>
                          <td style={{ textAlign: 'right', padding: '3px 6px', color: '#eab308', fontWeight: 'bold' }}>
                            ₹{c.limitSuggestion.toFixed(1)}
                          </td>
                          <td style={{ textAlign: 'right', padding: '3px 6px' }}>
                            <span style={{ color: '#aaa' }}>₹{c.t2x.toFixed(0)}</span>
                            <span style={{ color: S.text2 }}> / </span>
                            <span style={{ color: '#eab308' }}>₹{c.t5x}</span>
                            <span style={{ color: S.text2 }}> / </span>
                            <span style={{ color: typeColor, fontWeight: 'bold' }}>₹{c.heroTarget}</span>
                          </td>
                          <td style={{ textAlign: 'right', padding: '3px 6px', color: S.text2 }}>
                            {c.type === 'CE' ? '▲' : '▼'}{c.requiredMovePct.toFixed(2)}%
                          </td>
                          <td style={{ textAlign: 'right', padding: '3px 6px', color: coverageColor, fontWeight: 'bold' }}>
                            {coveragePct > 0 ? `${coveragePct}%` : '—'}
                          </td>
                          <td style={{ textAlign: 'center', padding: '3px 6px', color: S.text2 }}>
                            {c.estimatedDelta.toFixed(2)}
                          </td>
                          <td style={{ textAlign: 'center', padding: '3px 6px', color: starsColor, fontSize: '10px', letterSpacing: '-1px' }}>
                            {stars}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {/* ── Top pick deep-dive ── */}
              {(() => {
                const top = zeroHeroCandidates[0]
                const coveragePct = Math.round(top.coverageRatio * 100)
                const ptsNeeded = top.distancePts.toFixed(0)
                const isMoving = top.isMovingNow
                return (
                  <div style={{
                    marginTop: '8px', padding: '8px 10px',
                    background: 'rgba(255,255,255,0.03)', borderRadius: '5px',
                    fontSize: '10px', lineHeight: '1.6',
                    border: `1px solid ${isMoving ? (effectiveDir === 'BULL' ? 'rgba(0,255,136,0.25)' : 'rgba(255,68,68,0.25)') : 'rgba(255,255,255,0.05)'}`,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', flexWrap: 'wrap', marginBottom: '4px' }}>
                      <span style={{ fontWeight: 'bold', color: S.text }}>🎯 TOP PICK:</span>
                      <span style={{ color: top.type === 'CE' ? '#ff8866' : '#66aaff', fontWeight: 'bold', fontSize: '12px' }}>{top.strike} {top.type}</span>
                      <span style={{ color: S.text }}>@ ₹{top.ltp.toFixed(1)}</span>
                      {isMoving && <span style={{ color: moveAgg.color, fontWeight: 'bold', fontSize: '9px', padding: '1px 5px', background: `${moveAgg.color}18`, borderRadius: '3px' }}>MOVING NOW</span>}
                    </div>
                    <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '4px' }}>
                      <span style={{ color: S.text2 }}>Entry limit: <span style={{ color: '#eab308', fontWeight: 'bold' }}>₹{top.limitSuggestion.toFixed(1)}</span></span>
                      <span style={{ color: S.text2 }}>Need: <span style={{ color: S.text }}>+{ptsNeeded} pts ({top.requiredMovePct.toFixed(2)}%)</span></span>
                      <span style={{ color: S.text2 }}>Delta≈: <span style={{ color: S.text }}>{top.estimatedDelta.toFixed(2)}</span></span>
                    </div>
                    <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '4px' }}>
                      <span style={{ color: S.text2 }}>Profit ladder:</span>
                      <span>2× <span style={{ color: '#aaa', fontWeight: 'bold' }}>₹{top.t2x.toFixed(0)}</span></span>
                      <span>5× <span style={{ color: '#eab308', fontWeight: 'bold' }}>₹{top.t5x}</span></span>
                      <span>10× <span style={{ color: top.type === 'CE' ? '#ff8866' : '#66aaff', fontWeight: 'bold' }}>₹{top.heroTarget}</span></span>
                    </div>
                    <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', fontSize: '9px', color: S.text2 }}>
                      <span>Oracle coverage: <span style={{ color: coveragePct >= 100 ? S.bull : coveragePct >= 60 ? '#eab308' : S.bear, fontWeight: 'bold' }}>{coveragePct > 0 ? `${coveragePct}%` : '—'}</span>
                        {coveragePct >= 100 ? ' ✓ oracle predicts full move' : coveragePct >= 60 ? ' — partial, needs momentum' : ' — move bigger than predicted'}
                      </span>
                    </div>
                  </div>
                )
              })()}

              {/* ── Jane Street Context ── */}
              <div style={{
                marginTop: '6px', padding: '6px 8px',
                background: 'rgba(255,255,255,0.02)', borderRadius: '4px',
                fontSize: '9px', color: S.text2, lineHeight: 1.5,
                borderLeft: '2px solid rgba(255,200,0,0.3)',
              }}>
                <span style={{ color: '#cc9900', fontWeight: 'bold' }}>⚠ MM DEFENCE (Jane Street / HFT): </span>
                Option market makers price these OTM options precisely. Bid-ask spread on cheap OTM options is typically ₹0.5–1 (10–30% of premium).
                They widen spreads when momentum builds — <span style={{ color: moveAgg.label === 'EXPLOSIVE' ? S.bull : '#cc9900' }}>
                  {moveAgg.label === 'EXPLOSIVE' ? 'move is in progress — buy immediately, spread will widen further' :
                   moveAgg.label === 'BUILDING' ? 'use limit order, avoid chasing' :
                   moveAgg.label === 'AGAINST_FLOW' ? 'counter-trend = they are selling to you at high IV, avoid' :
                   'wait for price to move first — buying prediction = paying inflated IV'}
                </span>.
                On expiry day, gamma is highest — even a 20pt move in the last hour can 3-5× a well-placed OTM option.
              </div>

              {/* ── Signal breakdown ── */}
              <div style={{ marginTop: '6px', fontSize: '9px', color: S.text2, display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                <span>oracle<span style={{ color: effectiveDir ? dirColor(effectiveDir) : S.text2 }}>✓</span></span>
                <span>v2<span style={{ color: v2Dir === effectiveDir ? S.bull : S.bear }}>{v2Dir === effectiveDir ? '✓' : '✗'}</span></span>
                <span>flow<span style={{ color: (flowCdZ != null && ((flowCdZ > 0.5 && effectiveDir === 'BULL') || (flowCdZ < -0.5 && effectiveDir === 'BEAR'))) ? S.bull : S.bear }}>
                  {(flowCdZ != null && ((flowCdZ > 0.5 && effectiveDir === 'BULL') || (flowCdZ < -0.5 && effectiveDir === 'BEAR'))) ? '✓' : '✗'}
                </span></span>
                <span>cusum<span style={{ color: cusumAlarm === effectiveDir ? S.bull : S.text2 }}>{cusumAlarm === effectiveDir ? '✓' : '·'}</span></span>
                <span>pat<span style={{ color: (patBullProb > 0.55 && effectiveDir === 'BULL') || (patBullProb < 0.45 && effectiveDir === 'BEAR') ? S.bull : S.text2 }}>
                  {(patBullProb > 0.55 && effectiveDir === 'BULL') || (patBullProb < 0.45 && effectiveDir === 'BEAR') ? '✓' : '·'}
                </span></span>
                <span>mom<span style={{ color: (mom1m > 0.001 && effectiveDir === 'BULL') || (mom1m < -0.001 && effectiveDir === 'BEAR') ? S.bull : S.text2 }}>
                  {(mom1m > 0.001 && effectiveDir === 'BULL') || (mom1m < -0.001 && effectiveDir === 'BEAR') ? '✓' : '·'}
                </span></span>
                {kb && <span style={{ color: S.text2 }}>adj {fmtPct(kb.correctedMove)} (bias {fmtPct(kb.bias, 3)})</span>}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── OPT TRADE SYS — Paper Trading Panel ── always rendered ── */}
      {(() => {
        const dec   = ots?.decision
        const pos   = ots?.position ?? null
        const stats = ots?.stats

        const actionColor = (a: string) =>
          a === 'ENTER'       ? S.bull :
          a === 'EXIT_TARGET' ? '#00ccff' :
          a === 'EXIT_STOP'   ? S.bear :
          a === 'EXIT_PHASE'  ? '#ff8800' :
          a === 'TIGHTEN'     ? '#eab308' :
          a === 'STAY'        ? S.bull :
          S.text2

        const pnlColor = (v: number) => v > 0 ? S.bull : v < 0 ? S.bear : S.text2

        const fmtRs = (v: number) =>
          `${v >= 0 ? '+' : ''}₹${Math.abs(v).toFixed(0)}`

        // target/stop bar: pct of range from stop to target that current price fills
        const PriceBar = ({ pos }: { pos: OTSPosition }) => {
          const range = pos.target - pos.stopLoss
          if (range <= 0) return null
          const fill  = Math.max(0, Math.min(1, (pos.currentPrice - pos.stopLoss) / range))
          const dsFill = Math.max(0, Math.min(1, (pos.dynamicStop - pos.stopLoss) / range))
          return (
            <div style={{ position: 'relative', height: '6px', background: '#2a1a1a', borderRadius: '3px', marginTop: '6px', marginBottom: '2px' }}>
              {/* dynamic stop marker */}
              <div style={{ position: 'absolute', left: `${dsFill * 100}%`, top: 0, width: '2px', height: '100%', background: '#ff8800', borderRadius: '1px' }} title={`DynStop ₹${pos.dynamicStop.toFixed(1)}`} />
              {/* price fill */}
              <div style={{ position: 'absolute', left: 0, top: 0, width: `${fill * 100}%`, height: '100%', background: fill > 0.6 ? S.bull : fill > 0.3 ? '#eab308' : S.bear, borderRadius: '3px', opacity: 0.8 }} />
            </div>
          )
        }

        return (
          <div style={{ ...card, marginBottom: '10px', border: `1px solid ${pos ? (pos.pnl >= 0 ? 'rgba(0,255,136,0.3)' : 'rgba(255,68,68,0.3)') : 'rgba(255,255,255,0.1)'}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <span style={{ ...label, marginBottom: 0 }}>OPT TRADE SYS · PAPER ({pos?.lots ?? 5} lots)</span>
              {stats && stats.totalTrades > 0 && (
                <span style={{ fontSize: '9px', color: pnlColor(stats.totalPnl) }}>
                  {stats.totalTrades}T · {Math.round(stats.winRate * 100)}%WR · {fmtRs(stats.totalPnl)}
                </span>
              )}
            </div>

            {/* Decision banner */}
            {dec && (
              <div style={{ padding: '6px 8px', borderRadius: '4px', marginBottom: '8px',
                background: `${actionColor(dec.action)}12`, border: `1px solid ${actionColor(dec.action)}44` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '2px' }}>
                  <span style={{ fontSize: '11px', fontWeight: 900, color: actionColor(dec.action), letterSpacing: '0.06em' }}>
                    {dec.action.replace('_', ' ')}
                  </span>
                  <span style={{ fontSize: '9px', color: S.text2 }}>score {dec.signalScore}/6</span>
                </div>
                <div style={{ fontSize: '9px', color: '#aab', lineHeight: 1.5 }}>{dec.reason}</div>
                {dec.signals.length > 0 && (
                  <div style={{ marginTop: '3px', display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
                    {dec.signals.map(sig => (
                      <span key={sig} style={{ fontSize: '8px', padding: '1px 4px', background: 'rgba(255,255,255,0.06)', borderRadius: '2px', color: S.text2 }}>{sig}</span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Open position */}
            {pos ? (
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '4px' }}>
                  <span style={{ fontSize: '12px', fontWeight: 'bold', color: dirColor(pos.direction) }}>
                    {pos.direction} {pos.strike}{pos.optType}
                  </span>
                  <span style={{ fontSize: '14px', fontWeight: 900, color: pnlColor(pos.pnl) }}>
                    {fmtRs(pos.pnl)}
                  </span>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '4px', fontSize: '10px', marginBottom: '4px' }}>
                  <div><span style={{ color: S.text2 }}>entry</span> ₹{pos.entryPrice.toFixed(1)}</div>
                  <div><span style={{ color: S.text2 }}>now</span> <span style={{ color: pnlColor(pos.currentPrice - pos.entryPrice) }}>₹{pos.currentPrice.toFixed(1)}</span></div>
                  <div><span style={{ color: S.text2 }}>tgt</span> <span style={{ color: S.bull }}>₹{pos.target.toFixed(1)}</span></div>
                  <div><span style={{ color: S.text2 }}>stop</span> <span style={{ color: S.bear }}>₹{pos.stopLoss.toFixed(1)}</span></div>
                  <div><span style={{ color: S.text2 }}>peak</span> {fmtRs(pos.peakPnl)}</div>
                  <div><span style={{ color: S.text2 }}>dynStp</span> <span style={{ color: '#ff8800' }}>₹{pos.dynamicStop.toFixed(1)}</span></div>
                  <div><span style={{ color: S.text2 }}>held</span> {pos.holdingMins}m</div>
                  <div><span style={{ color: S.text2 }}>sig</span> {pos.entrySignalScore}/6</div>
                </div>

                <PriceBar pos={pos} />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '8px', color: S.text2 }}>
                  <span>stop ₹{pos.stopLoss.toFixed(0)}</span>
                  <span>entry ₹{pos.entryPrice.toFixed(0)}</span>
                  <span>target ₹{pos.target.toFixed(0)}</span>
                </div>

                <div style={{ marginTop: '5px', fontSize: '8px', color: S.text2 }}>
                  phase@entry: {pos.phaseAtEntry} · align: {pos.obiAlignAtEntry} · stab: {pos.stabilityAtEntry}
                </div>
              </div>
            ) : (
              <div style={{ fontSize: '10px', color: S.text2, padding: '4px 0' }}>
                No open position
                {dec?.action === 'WAIT' && dec.direction && (
                  <span style={{ color: S.text2 }}> — watching {dec.direction}</span>
                )}
              </div>
            )}

            {/* Trade history */}
            {ots && ots.history.length > 0 && (
              <div style={{ marginTop: '8px' }}>
                <div style={{ fontSize: '9px', color: S.text2, marginBottom: '4px', letterSpacing: '0.05em' }}>HISTORY</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  {ots.history.filter(h => h.status === 'CLOSED').slice(0, 6).map(h => (
                    <div key={h.id} style={{ display: 'flex', gap: '8px', fontSize: '9px', alignItems: 'center' }}>
                      <span style={{ color: S.text2, minWidth: '32px' }}>{h.entryTime}</span>
                      <span style={{ color: dirColor(h.direction), minWidth: '48px' }}>{h.direction} {h.optType}</span>
                      <span style={{ color: S.text2, minWidth: '38px' }}>{h.strike}</span>
                      <span style={{ color: pnlColor(h.closedPnl ?? 0), fontWeight: 'bold', minWidth: '60px' }}>{fmtRs(h.closedPnl ?? 0)}</span>
                      <span style={{ color: S.text2, fontSize: '8px' }}>{h.exitReason}</span>
                    </div>
                  ))}
                </div>
                {stats && stats.totalTrades > 0 && (
                  <div style={{ marginTop: '5px', display: 'flex', gap: '10px', fontSize: '9px', color: S.text2 }}>
                    <span>avg {fmtRs(stats.avgTrade)}</span>
                    <span>best {fmtRs(stats.bestTrade)}</span>
                    <span>worst {fmtRs(stats.worstTrade)}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })()}

      {/* Footer */}
      <div style={{ marginTop: '10px', fontSize: '9px', color: S.text2, textAlign: 'right' }}>
        token={s.futureToken} · patterns={s.patternCount} · resolved={s.resolvedCount} · {s.minutesAccumulated}min
      </div>
    </div>
  )
}
