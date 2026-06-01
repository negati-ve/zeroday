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
// On Tuesday (NIFTY weekly expiry), cheap OTM options can go 10x if the market
// moves enough. This panel suggests the best candidates based on composite signals.

interface ZeroHeroCandidate {
  rank: number
  strike: number
  type: 'CE' | 'PE'
  ltp: number
  distancePts: number        // how many pts OTM from current spot
  requiredMovePct: number    // % move from spot needed to touch ITM
  heroTarget: number         // 10× LTP = the "hero" price
  signalScore: number        // composite signal alignment (higher = better)
  oiStr: string              // formatted OI
  ceOI?: number
  peOI?: number
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
  fmtNumFn: (v: number) => string,
): ZeroHeroCandidate[] {
  if (!chain?.oiAnalytics || spot <= 0 || !direction) return []

  const strikes: any[] = chain.oiAnalytics.strikes
  const candidates: ZeroHeroCandidate[] = []

  // Signal alignment score per candidate (max 5 components)
  const flowDir = flowCdZ != null ? (flowCdZ > 0.5 ? 'BULL' : flowCdZ < -0.5 ? 'BEAR' : null) : null
  const patDir = patBullProb > 0.55 ? 'BULL' : patBullProb < 0.45 ? 'BEAR' : null

  let baseScore = 1.5 // oracle always counts (it determines direction)
  if (v2Dir === direction) baseScore += 1.0
  if (flowDir === direction) baseScore += 1.0
  if (cusumAlarm === direction) baseScore += 0.5
  if (patDir === direction) baseScore += 0.5

  for (const row of strikes) {
    if (direction === 'BULL') {
      // OTM calls: strike > spot
      if (row.strike <= spot) continue
      const ltp = row.ceLtp
      if (ltp <= 0 || ltp > 90) continue

      const requiredMovePct = (row.strike - spot) / spot * 100
      if (requiredMovePct > 3.5) continue  // too far OTM — lottery territory, skip

      // Distance sweet spot: 0.5-2% OTM is best for zero-hero leverage
      const distPenalty = Math.max(0, requiredMovePct - 1.5) * 0.4
      const priceMult = ltp <= 8 ? 1.3 : ltp <= 25 ? 1.1 : ltp <= 50 ? 0.9 : 0.7
      const signalScore = baseScore * priceMult / (1 + distPenalty)

      candidates.push({
        rank: 0,
        strike: row.strike,
        type: 'CE',
        ltp,
        distancePts: row.strike - spot,
        requiredMovePct,
        heroTarget: Math.round(ltp * 10),
        signalScore,
        oiStr: fmtNumFn(row.ceOI),
        ceOI: row.ceOI,
      })
    } else {
      // OTM puts: strike < spot
      if (row.strike >= spot) continue
      const ltp = row.peLtp
      if (ltp <= 0 || ltp > 90) continue

      const requiredMovePct = (spot - row.strike) / spot * 100
      if (requiredMovePct > 3.5) continue

      const distPenalty = Math.max(0, requiredMovePct - 1.5) * 0.4
      const priceMult = ltp <= 8 ? 1.3 : ltp <= 25 ? 1.1 : ltp <= 50 ? 0.9 : 0.7
      const signalScore = baseScore * priceMult / (1 + distPenalty)

      candidates.push({
        rank: 0,
        strike: row.strike,
        type: 'PE',
        ltp,
        distancePts: spot - row.strike,
        requiredMovePct,
        heroTarget: Math.round(ltp * 10),
        signalScore,
        oiStr: fmtNumFn(row.peOI),
        peOI: row.peOI,
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
  metaRegime: MetaRegime | null; v2: V2 | null
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

  const zeroHeroCandidates = computeZeroHero(
    s.spot, s.chain, effectiveDir, v2Dir, flowCdZ, cusumAlarm, patBullProb, effectivePredMove, fmtNum
  )

  // Days to expiry in IST
  const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
  const expiryStr = s.chain?.expiry ?? ''
  const daysToExpiry = expiryStr
    ? Math.round((new Date(expiryStr + 'T00:00:00+05:30').getTime() - new Date(todayIST + 'T00:00:00+05:30').getTime()) / 86400000)
    : 99
  const isExpiryDay = daysToExpiry === 0

  // Signal count for header display
  const zeroHeroSignalCount = (() => {
    let n = effectiveDir ? 1 : 0  // oracle
    if (v2Dir === effectiveDir) n++
    const fd = flowCdZ != null ? (flowCdZ > 0.5 ? 'BULL' : flowCdZ < -0.5 ? 'BEAR' : null) : null
    if (fd === effectiveDir) n++
    if (cusumAlarm === effectiveDir) n++
    const pd = patBullProb > 0.55 ? 'BULL' : patBullProb < 0.45 ? 'BEAR' : null
    if (pd === effectiveDir) n++
    return n
  })()

  return (
    <div style={base}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <div>
          <span style={{ fontSize: '14px', fontWeight: 'bold' }}>NIFTY50 FUTURES — CONVICTION</span>
          <span style={{ marginLeft: '12px', color: s.marketOpen ? S.bull : S.neutral, fontSize: '10px' }}>
            {s.marketOpen ? '● MARKET OPEN' : '○ CLOSED'}
          </span>
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
            zeroHeroCandidates.length > 0 && isExpiryDay
              ? (effectiveDir === 'BULL' ? 'rgba(0,255,136,0.6)' : effectiveDir === 'BEAR' ? 'rgba(255,68,68,0.6)' : S.border)
              : S.border
          }`,
          marginBottom: '10px',
        }}>
          {/* Panel header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
            <div style={{ ...label, marginBottom: 0 }}>
              ⚡ ZERO HERO
              {' · '}
              {isExpiryDay
                ? <span style={{ color: effectiveDir ? dirColor(effectiveDir) : S.text2, fontWeight: 'bold' }}>EXPIRY TODAY</span>
                : <span>EXPIRY IN {daysToExpiry}d ({expiryStr})</span>}
            </div>
            <div style={{ fontSize: '10px', display: 'flex', gap: '8px' }}>
              <span style={{ color: S.text2 }}>dir:&nbsp;
                <span style={{ color: dirColor(effectiveDir) }}>{effectiveDir ?? 'NO DIR'}</span>
              </span>
              <span style={{ color: S.text2 }}>signals:&nbsp;
                <span style={{ color: zeroHeroSignalCount >= 4 ? S.bull : zeroHeroSignalCount >= 2 ? S.text : S.bear }}>
                  {zeroHeroSignalCount}/5
                </span>
              </span>
            </div>
          </div>

          {!isExpiryDay && daysToExpiry <= 3 && (
            <div style={{ fontSize: '9px', color: S.text2, marginBottom: '6px', fontStyle: 'italic' }}>
              Pre-expiry setup view · prices will be cheaper on expiry day · higher OTM = more leverage but less likely
            </div>
          )}

          {effectiveDir === null ? (
            <div style={{ fontSize: '10px', color: S.text2, padding: '8px 0' }}>
              No clear directional bias from oracle — Zero Hero requires a direction signal.
            </div>
          ) : zeroHeroCandidates.length === 0 ? (
            <div style={{ fontSize: '10px', color: S.text2, padding: '8px 0' }}>
              No suitable OTM options found in chain (all too expensive or too far OTM).
            </div>
          ) : (
            <>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '10px' }}>
                  <thead>
                    <tr style={{ color: S.text2, borderBottom: `1px solid ${S.border}` }}>
                      <th style={{ textAlign: 'center', padding: '2px 4px' }}>#</th>
                      <th style={{ textAlign: 'right', padding: '2px 6px' }}>STRIKE</th>
                      <th style={{ textAlign: 'center', padding: '2px 4px' }}>TYPE</th>
                      <th style={{ textAlign: 'right', padding: '2px 6px' }}>ZERO ₹</th>
                      <th style={{ textAlign: 'right', padding: '2px 6px' }}>HERO 10× ₹</th>
                      <th style={{ textAlign: 'right', padding: '2px 6px' }}>NEED</th>
                      <th style={{ textAlign: 'right', padding: '2px 6px' }}>ORACLE</th>
                      <th style={{ textAlign: 'center', padding: '2px 6px' }}>OI</th>
                      <th style={{ textAlign: 'center', padding: '2px 6px' }}>SIG</th>
                    </tr>
                  </thead>
                  <tbody>
                    {zeroHeroCandidates.map((c) => {
                      const isTop = c.rank === 1
                      const oracleMove = effectivePredMove
                      const coverageRatio = Math.abs(oracleMove) > 0 ? Math.abs(oracleMove) / c.requiredMovePct : 0
                      // Stars: normalize signalScore (max theoretical ~4.7) to 5 stars
                      const starsFilled = Math.min(5, Math.round(c.signalScore / 4.7 * 5))
                      const stars = '★'.repeat(starsFilled) + '☆'.repeat(5 - starsFilled)
                      const starsColor = starsFilled >= 4 ? S.bull : starsFilled >= 2 ? '#aaa' : S.text2
                      return (
                        <tr key={`${c.strike}-${c.type}`} style={{
                          borderBottom: `1px solid ${S.border}`,
                          background: isTop ? (effectiveDir === 'BULL' ? 'rgba(0,255,136,0.04)' : 'rgba(255,68,68,0.04)') : undefined,
                        }}>
                          <td style={{ textAlign: 'center', padding: '2px 4px', color: isTop ? S.text : S.text2, fontWeight: isTop ? 'bold' : undefined }}>
                            {isTop ? '🎯' : `#${c.rank}`}
                          </td>
                          <td style={{ textAlign: 'right', padding: '2px 6px', fontWeight: isTop ? 'bold' : undefined }}>
                            {c.strike}
                          </td>
                          <td style={{ textAlign: 'center', padding: '2px 4px', color: c.type === 'CE' ? '#ff8866' : '#66aaff' }}>
                            {c.type}
                          </td>
                          <td style={{ textAlign: 'right', padding: '2px 6px', color: S.text, fontWeight: isTop ? 'bold' : undefined }}>
                            ₹{c.ltp.toFixed(1)}
                          </td>
                          <td style={{ textAlign: 'right', padding: '2px 6px', color: c.type === 'CE' ? S.bear : S.bull, fontWeight: 'bold' }}>
                            ₹{c.heroTarget}
                          </td>
                          <td style={{ textAlign: 'right', padding: '2px 6px', color: S.text2 }}>
                            {c.type === 'CE' ? '▲' : '▼'}{c.requiredMovePct.toFixed(2)}%
                          </td>
                          <td style={{ textAlign: 'right', padding: '2px 6px', color: dirColor(effectiveDir) }}>
                            {fmtPct(oracleMove)}
                            {coverageRatio > 0 && (
                              <span style={{ color: S.text2, fontSize: '9px', marginLeft: '2px' }}>
                                ({Math.round(coverageRatio * 100)}%)
                              </span>
                            )}
                          </td>
                          <td style={{ textAlign: 'center', padding: '2px 6px', color: S.text2, fontSize: '9px' }}>
                            {c.oiStr}
                          </td>
                          <td style={{ textAlign: 'center', padding: '2px 6px', color: starsColor, fontSize: '11px', letterSpacing: '0px' }}>
                            {stars}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {/* Top pick summary */}
              {(() => {
                const top = zeroHeroCandidates[0]
                const coveragePct = Math.abs(effectivePredMove) > 0
                  ? Math.round(Math.abs(effectivePredMove) / top.requiredMovePct * 100)
                  : 0
                return (
                  <div style={{
                    marginTop: '8px', padding: '6px 8px',
                    background: 'rgba(255,255,255,0.03)', borderRadius: '4px',
                    fontSize: '10px', color: S.text2, lineHeight: '1.6',
                  }}>
                    <span style={{ color: S.text, fontWeight: 'bold' }}>🎯 Pick: </span>
                    <span style={{ color: top.type === 'CE' ? '#ff8866' : '#66aaff' }}>
                      {top.strike} {top.type}
                    </span>
                    {' @ '}
                    <span style={{ color: S.text }}>₹{top.ltp.toFixed(1)}</span>
                    {' → 10× = '}
                    <span style={{ color: top.type === 'CE' ? S.bear : S.bull, fontWeight: 'bold' }}>₹{top.heroTarget}</span>
                    {' if NIFTY '}
                    {effectiveDir === 'BULL' ? 'rises above ' : 'drops below '}
                    <span style={{ fontWeight: 'bold' }}>{top.strike}</span>
                    {' ('}
                    <span style={{ color: S.text2 }}>
                      {top.distancePts.toFixed(0)} pts · {top.requiredMovePct.toFixed(2)}% needed
                    </span>
                    {')'}
                    {coveragePct > 0 && (
                      <span style={{ color: coveragePct >= 80 ? S.bull : coveragePct >= 40 ? '#aaa' : S.bear }}>
                        {' · oracle covers '}{coveragePct}% of required move
                      </span>
                    )}
                    {zeroHeroSignalCount >= 4 && (
                      <span style={{ color: S.bull }}> · ✓ high conviction</span>
                    )}
                  </div>
                )
              })()}

              {/* Signal breakdown */}
              <div style={{ marginTop: '6px', fontSize: '9px', color: S.text2, display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                <span>oracle<span style={{ color: effectiveDir ? dirColor(effectiveDir) : S.text2 }}>✓</span></span>
                <span>v2<span style={{ color: v2Dir === effectiveDir ? S.bull : S.bear }}>{v2Dir === effectiveDir ? '✓' : '✗'}</span></span>
                <span>flow<span style={{
                  color: (flowCdZ != null && ((flowCdZ > 0.5 && effectiveDir === 'BULL') || (flowCdZ < -0.5 && effectiveDir === 'BEAR'))) ? S.bull : S.bear
                }}>{(flowCdZ != null && ((flowCdZ > 0.5 && effectiveDir === 'BULL') || (flowCdZ < -0.5 && effectiveDir === 'BEAR'))) ? '✓' : '✗'}</span></span>
                <span>cusum<span style={{ color: cusumAlarm === effectiveDir ? S.bull : S.text2 }}>{cusumAlarm === effectiveDir ? '✓' : '·'}</span></span>
                <span>pat<span style={{ color: (patBullProb > 0.55 && effectiveDir === 'BULL') || (patBullProb < 0.45 && effectiveDir === 'BEAR') ? S.bull : S.text2 }}>
                  {(patBullProb > 0.55 && effectiveDir === 'BULL') || (patBullProb < 0.45 && effectiveDir === 'BEAR') ? '✓' : '·'}
                </span></span>
                {kb && <span style={{ color: S.text2 }}>oracle adj {fmtPct(kb.correctedMove)} (bias {fmtPct(kb.bias, 3)})</span>}
              </div>
            </>
          )}
        </div>
      )}

      {/* Footer */}
      <div style={{ marginTop: '10px', fontSize: '9px', color: S.text2, textAlign: 'right' }}>
        token={s.futureToken} · patterns={s.patternCount} · resolved={s.resolvedCount} · {s.minutesAccumulated}min
      </div>
    </div>
  )
}
