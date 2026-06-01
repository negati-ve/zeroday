'use client'
import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import ThemeToggle from '@/components/ThemeToggle'

// ── Types ─────────────────────────────────────────────────────────────────────

interface BTCPrediction {
  predictedMove: number; bullProb: number; bearProb: number
  topSim: number; confidence: number; nResolved: number
  direction: 'BULL' | 'BEAR' | null
  status: 'ready' | 'warming' | 'no_data'
  h5: { predictedMove: number; bullProb: number; bearProb: number } | null
  h15: { predictedMove: number; bullProb: number; bearProb: number } | null
  h20: { predictedMove: number; bullProb: number; bearProb: number } | null
}

interface BTCComposite {
  predictedMove: number; bullProb: number; bearProb: number
  direction: 'BULL' | 'BEAR' | null; confidence: number
  status: 'ready' | 'warming' | 'no_data'
  components: { patternWeight: number; techWeight: number; patternBullProb: number; techBullScore: number }
}

interface BTCTechnicals {
  rsi: number | null; emaShort: number | null; emaLong: number | null
  emaCrossover: 'BULL' | 'BEAR' | null; vwap: number | null
  vwapAlign: 'BULL' | 'BEAR' | null; atr: number | null; atrPct: number | null
  momentum1m: number; momentum5m: number
  sessionHigh: number; sessionLow: number; rangePosition: number
}

interface BTCFlowState {
  cumDelta: number; cdZScore: number; aggressionRatio: number
  cusumPos: number; cusumNeg: number; cusumAlarm: 'BULL' | 'BEAR' | null
  fundingRate: number | null; markPrice: number | null; openInterest: number | null
}

interface BTCV2 {
  prediction: BTCPrediction; sessionKey: 'asia' | 'london' | 'ny'
  sessionPatternCount: number; flowState: BTCFlowState | null
  featureVec: number[]; kalmanVelocity: number
}

interface BTCOptionRow {
  strike: number; callOI: number; callLtp: number; putLtp: number; putOI: number
  callVolume: number; putVolume: number; expiry: string
}

interface BTCOIAnalytics {
  strikes: BTCOptionRow[]; pcr: number; maxPainStrike: number
  atmStrike: number; totalCallOI: number; totalPutOI: number; expiry: string
}

interface BTCSysLogEntry {
  cycleTs: number; cycleTime: string; predMove: number
  predDir: 'BULL' | 'BEAR' | null; predConf: number
  predBullProb: number; predBearProb: number
  spotAtPred: number; predSpot: number
  outcomeMove: number | null; outcomeDir: 'BULL' | 'BEAR' | null
  spotAtOutcome: number | null; resolved: boolean; correct: boolean | null
  sessionDay: string; peakMove: number | null; liveMove: number | null; liveSpot: number | null
  kalmanVelAtPred?: number
}

interface BTCTradeEntry {
  id: string
  openTs: number; openTime: string
  closeTs: number | null; closeTime: string | null
  dir: 'BULL' | 'BEAR'
  entrySpot: number; closeSpot: number | null
  pnlPct: number | null; peakPct: number
  exitReason: 'trail' | 'stop' | 'vel_rev' | 'pat_flip' | 'time' | null
  entryVel: number; entryConf: number; entryBullProb: number
  entryCdZ: number; sessionKey: string
}

interface BitcoinState {
  spot: number; markPrice: number | null; fundingRate: number | null; openInterest: number | null
  prediction: BTCPrediction; technicals: BTCTechnicals; composite: BTCComposite
  snapshotCount: number; patternCount: number; resolvedCount: number; minutesAccumulated: number
  sysLog: BTCSysLogEntry[]; oiAnalytics: BTCOIAnalytics | null
  flow: BTCFlowState | null; v2: BTCV2 | null
  depth: { buy: { price: number; qty: number }[]; sell: { price: number; qty: number }[] } | null
  symbol: string
  activeTrade: BTCTradeEntry | null
  tradeLog: BTCTradeEntry[]
}

// ── Style palette ─────────────────────────────────────────────────────────────

const S = {
  bull: '#00ff88', bear: '#ff4444', neutral: '#888',
  bg: 'var(--bg)', panel: 'var(--card-bg)', text: 'var(--text)',
  text2: 'var(--text2)', border: 'var(--border)', font: "'Courier New', monospace",
  orange: '#f7931a',   // Bitcoin orange
}

function dirColor(d: 'BULL' | 'BEAR' | null) {
  return d === 'BULL' ? S.bull : d === 'BEAR' ? S.bear : S.neutral
}
function fmtPct(v: number, d = 2) { return `${v >= 0 ? '+' : ''}${v.toFixed(d)}%` }
function fmtNum(v: number) {
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(2)}B`
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(2)}M`
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(2)}K`
  return v.toFixed(2)
}
function fmtUSD(v: number) {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`
  return `$${v.toFixed(0)}`
}

// ── Kalman Bias Estimator (same as N50FUT) ────────────────────────────────────

interface KalmanBiasState {
  bias: number; P: number; innovVar: number
  correctedMove: number; sigma: number
  nResolved: number; rmse: number; hitRate: number
}

function computeKalmanBias(sysLog: BTCSysLogEntry[], rawPredMove: number): KalmanBiasState | null {
  const resolved = [...sysLog]
    .filter(e => e.resolved && e.outcomeMove != null)
    .sort((a, b) => a.cycleTs - b.cycleTs)
  if (resolved.length < 5) return null

  const Q = 1e-5
  let x = 0, P = 0.01
  let innovVarEMA = 0.04
  const alpha = 0.25
  let sumSq = 0, hitCount = 0

  for (const e of resolved) {
    const innov = e.outcomeMove! - e.predMove
    innovVarEMA = alpha * innov * innov + (1 - alpha) * innovVarEMA
    const R = Math.max(innovVarEMA, 1e-5)
    const Ppred = P + Q
    const K = Ppred / (Ppred + R)
    x = x + K * (innov - x)
    P = (1 - K) * Ppred
    sumSq += innov * innov
    if (Math.abs(innov) < 0.3) hitCount++  // within ±0.3%
  }

  const n = resolved.length
  const R = Math.max(innovVarEMA, 1e-5)
  return {
    bias: x, P, innovVar: R,
    correctedMove: rawPredMove + x,
    sigma: Math.sqrt(P + R),
    nResolved: n, rmse: Math.sqrt(sumSq / n), hitRate: hitCount / n,
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

const SESSION_EMOJI: Record<string, string> = { asia: '🌏', london: '🇬🇧', ny: '🗽' }
const SESSION_LABEL: Record<string, string> = {
  asia: '00-08 UTC · Asian session',
  london: '08-16 UTC · London session',
  ny: '16-24 UTC · NY session',
}

export default function BitcoinConvictionClient({ role }: { role: string }) {
  const router = useRouter()
  const [state, setState] = useState<BitcoinState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastFetch, setLastFetch] = useState(0)
  const [loading, setLoading] = useState(true)

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch('/api/bitcoin', { cache: 'no-store' })
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
  const lbl: React.CSSProperties = {
    fontSize: '9px', color: S.text2, letterSpacing: '1px',
    textTransform: 'uppercase', marginBottom: '4px',
  }

  if (loading) return (
    <div style={base}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <span style={{ fontSize: '14px', fontWeight: 'bold' }}>
          <span style={{ color: S.orange }}>₿</span> BITCOIN — CONVICTION
        </span>
        <ThemeToggle />
      </div>
      <div style={{ color: S.text2 }}>Loading…</div>
    </div>
  )

  if (error || !state) return (
    <div style={base}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <span style={{ fontSize: '14px', fontWeight: 'bold' }}>
          <span style={{ color: S.orange }}>₿</span> BITCOIN — CONVICTION
        </span>
        <ThemeToggle />
      </div>
      <div style={{ color: S.bear }}>Error: {error ?? 'no data'}</div>
    </div>
  )

  const s = state
  const comp = s.composite
  const pred = s.prediction
  const tech = s.technicals
  const v2 = s.v2
  const flow = s.flow
  const age = lastFetch ? Math.round((Date.now() - lastFetch) / 1000) : 0
  const kb = computeKalmanBias(s.sysLog, comp.predictedMove)

  // Funding rate sentiment: positive = longs pay shorts = crowded long = bearish signal
  const frColor = s.fundingRate != null
    ? (s.fundingRate > 0.01 ? S.bear : s.fundingRate < -0.01 ? S.bull : S.text2)
    : S.text2
  const frLabel = s.fundingRate != null
    ? (s.fundingRate > 0.01 ? 'longs paying (crowded long)' : s.fundingRate < -0.01 ? 'shorts paying (crowded short)' : 'neutral')
    : '—'

  const basis = (s.markPrice != null && s.spot > 0)
    ? ((s.markPrice - s.spot) / s.spot) * 100
    : null

  return (
    <div style={base}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap', gap: '6px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontSize: '14px', fontWeight: 'bold' }}>
            <span style={{ color: S.orange }}>₿</span> BITCOIN — CONVICTION
          </span>
          <a href="/dashboard" style={{ fontSize: '10px', color: S.text2, textDecoration: 'none' }}>← DASH</a>
          <a href="/dashboard/conviction-crude" style={{ fontSize: '10px', color: S.text2, textDecoration: 'none' }}>CRUDE</a>
          <a href="/dashboard/conviction-n50fut" style={{ fontSize: '10px', color: S.text2, textDecoration: 'none' }}>N50FUT</a>
        </div>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <span style={{ color: S.bull, fontSize: '10px' }}>● 24/7</span>
          <span style={{ color: S.text2, fontSize: '10px' }}>{age}s ago</span>
          <ThemeToggle />
        </div>
      </div>

      {/* Row 1: Spot / Composite / Pattern V1 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px', marginBottom: '10px' }}>

        {/* Spot */}
        <div style={card}>
          <div style={lbl}>SPOT / PERPETUAL</div>
          <div style={{ fontSize: '22px', fontWeight: 'bold', color: dirColor(comp.direction) }}>
            {s.spot > 0 ? fmtUSD(s.spot) : '—'}
          </div>
          {s.markPrice != null && (
            <div style={{ marginTop: '4px', fontSize: '11px', color: S.text2 }}>
              mark {fmtUSD(s.markPrice)}
              {basis != null && (
                <span style={{ marginLeft: '8px', color: basis > 0 ? S.bull : basis < 0 ? S.bear : S.text2 }}>
                  {basis > 0 ? '+' : ''}{basis.toFixed(3)}% basis
                </span>
              )}
            </div>
          )}
          {s.fundingRate != null && (
            <div style={{ marginTop: '4px', fontSize: '10px', color: frColor }}>
              funding {s.fundingRate >= 0 ? '+' : ''}{s.fundingRate.toFixed(4)}% · {frLabel}
            </div>
          )}
          {s.openInterest != null && (
            <div style={{ marginTop: '4px', fontSize: '10px', color: S.text2 }}>
              OI {fmtNum(s.openInterest)} BTC ≈ {fmtUSD(s.openInterest * s.spot)}
            </div>
          )}
          <div style={{ marginTop: '6px', fontSize: '11px', color: S.text2 }}>
            Hi {tech.sessionHigh > 0 ? fmtUSD(tech.sessionHigh) : '—'} ·
            Lo {tech.sessionLow > 0 ? fmtUSD(tech.sessionLow) : '—'}
          </div>
          {s.depth && s.depth.buy.length > 0 && (
            <div style={{ marginTop: '4px', fontSize: '11px' }}>
              <span style={{ color: S.bull }}>B {s.depth.buy[0]?.price?.toFixed(1)}</span>
              {' / '}
              <span style={{ color: S.bear }}>A {s.depth.sell[0]?.price?.toFixed(1)}</span>
            </div>
          )}
        </div>

        {/* Composite Oracle with Kalman */}
        <div style={card}>
          <div style={lbl}>COMPOSITE ORACLE{kb ? ' ⟳ KALMAN' : ''}</div>
          <div style={{ fontSize: '20px', fontWeight: 'bold', color: dirColor(kb ? (kb.correctedMove > 0 ? 'BULL' : kb.correctedMove < 0 ? 'BEAR' : null) : comp.direction) }}>
            {kb
              ? (kb.correctedMove > 0 ? 'BULL ▲' : kb.correctedMove < 0 ? 'BEAR ▼' : 'NEUTRAL')
              : (comp.direction ?? 'NEUTRAL')}
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
        </div>

        {/* Pattern Memory V1 */}
        <div style={card}>
          <div style={lbl}>PATTERN MEMORY (V1)</div>
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
              10m {fmtPct(pred.h5.predictedMove)} ·
              30m {fmtPct(pred.h15.predictedMove)} ·
              60m {fmtPct(pred.h20.predictedMove)}
            </div>
          )}
          <div style={{ marginTop: '4px', fontSize: '10px', color: S.text2 }}>
            snaps={s.snapshotCount} · resolved={s.resolvedCount}
          </div>
        </div>
      </div>

      {/* Row 2: V2 Oracle + Flow State */}
      {v2 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '10px' }}>
          <div style={card}>
            <div style={lbl}>ORACLE V2 · {SESSION_EMOJI[v2.sessionKey]} {v2.sessionKey.toUpperCase()}</div>
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
              {SESSION_LABEL[v2.sessionKey]}
            </div>
            <div style={{ marginTop: '2px', fontSize: '10px', color: S.text2 }}>
              kalman vel: {v2.kalmanVelocity.toFixed(3)} USD/min
            </div>
            {v2.prediction.status !== 'ready' && (
              <div style={{ marginTop: '4px', fontSize: '10px', color: S.text2 }}>
                {v2.prediction.nResolved < 3
                  ? `warming · ${v2.prediction.nResolved}/3 patterns`
                  : 'warming · accumulating…'}
              </div>
            )}
          </div>

          <div style={card}>
            <div style={lbl}>FLOW STATE · BINANCE PERP</div>
            {flow ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px', fontSize: '11px' }}>
                <div>ΔCD <span style={{ color: dirColor(flow.cumDelta > 0 ? 'BULL' : flow.cumDelta < 0 ? 'BEAR' : null) }}>{fmtNum(flow.cumDelta)} BTC</span></div>
                <div>cdZ <span style={{ color: dirColor(flow.cdZScore > 0.5 ? 'BULL' : flow.cdZScore < -0.5 ? 'BEAR' : null) }}>{flow.cdZScore.toFixed(2)}σ</span></div>
                <div>agg <span style={{ color: dirColor(flow.aggressionRatio > 0 ? 'BULL' : flow.aggressionRatio < 0 ? 'BEAR' : null) }}>{(flow.aggressionRatio * 100).toFixed(0)}%</span></div>
                <div>
                  {flow.cusumAlarm
                    ? <span style={{ color: dirColor(flow.cusumAlarm) }}>⚡CUSUM:{flow.cusumAlarm}</span>
                    : <span style={{ color: S.text2 }}>cusum: quiet</span>}
                </div>
                {flow.fundingRate != null && (
                  <>
                    <div style={{ color: S.text2 }}>funding</div>
                    <div style={{ color: frColor }}>{flow.fundingRate >= 0 ? '+' : ''}{flow.fundingRate.toFixed(4)}%</div>
                  </>
                )}
                {flow.openInterest != null && (
                  <>
                    <div style={{ color: S.text2 }}>OI</div>
                    <div>{fmtNum(flow.openInterest)} BTC</div>
                  </>
                )}
              </div>
            ) : (
              <div style={{ color: S.text2, fontSize: '11px' }}>No flow data — waiting for Binance agg trades…</div>
            )}
          </div>
        </div>
      )}

      {/* Row 3: Technicals */}
      <div style={card}>
        <div style={lbl}>TECHNICALS</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '6px', fontSize: '11px' }}>
          <div>RSI <span style={{ color: tech.rsi != null ? (tech.rsi > 60 ? S.bull : tech.rsi < 40 ? S.bear : S.text) : S.neutral }}>{tech.rsi?.toFixed(0) ?? '—'}</span></div>
          <div>EMA <span style={{ color: dirColor(tech.emaCrossover) }}>{tech.emaCrossover ?? 'FLAT'}</span></div>
          <div>VWAP <span style={{ color: dirColor(tech.vwapAlign) }}>{tech.vwapAlign ?? 'AT'}</span></div>
          <div>ATR% <span>{tech.atrPct != null ? fmtPct(tech.atrPct, 3) : '—'}</span></div>
          <div>1m <span style={{ color: dirColor(tech.momentum1m > 0 ? 'BULL' : tech.momentum1m < 0 ? 'BEAR' : null) }}>{fmtPct(tech.momentum1m * 100, 3)}</span></div>
          <div>5m <span style={{ color: dirColor(tech.momentum5m > 0 ? 'BULL' : tech.momentum5m < 0 ? 'BEAR' : null) }}>{fmtPct(tech.momentum5m * 100, 3)}</span></div>
          <div>VWAP$ <span style={{ color: dirColor(tech.vwapAlign) }}>{tech.vwap != null ? fmtUSD(tech.vwap) : '—'}</span></div>
          <div>rng <span style={{ color: S.text2 }}>{(tech.rangePosition * 100).toFixed(0)}%</span></div>
        </div>
      </div>

      {/* Prediction Log with Kalman Innovation Tracker */}
      {s.sysLog.length > 0 && (
        <div style={card}>
          {(() => {
            const resolved = s.sysLog.filter(e => e.resolved)
            const wr = resolved.length > 0 ? resolved.filter(e => e.correct).length / resolved.length : null
            const velBacked = resolved.filter(e => e.kalmanVelAtPred != null && Math.abs(e.kalmanVelAtPred) >= 5)
            const velWr = velBacked.length > 0 ? velBacked.filter(e => e.correct).length / velBacked.length : null
            return (
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '4px', flexWrap: 'wrap' }}>
                <span style={lbl}>PREDICTION LOG · INNOVATION TRACKER (last {s.sysLog.length})</span>
                {wr != null && <span style={{ fontSize: '10px', color: wr >= 0.5 ? S.bull : S.bear }}>dir WR {Math.round(wr * 100)}% ({resolved.length})</span>}
                {velWr != null && velBacked.length >= 3 && <span style={{ fontSize: '10px', color: S.orange }}>⚡vel≥5 WR {Math.round(velWr * 100)}% ({velBacked.length})</span>}
              </div>
            )
          })()}
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '10px' }}>
              <thead>
                <tr style={{ color: S.text2, borderBottom: `1px solid ${S.border}` }}>
                  <th style={{ textAlign: 'left', padding: '2px 6px' }}>Time</th>
                  <th style={{ textAlign: 'left', padding: '2px 6px' }}>Dir</th>
                  <th style={{ textAlign: 'right', padding: '2px 6px' }} title="Kalman velocity $/min at prediction time">Vel</th>
                  <th style={{ textAlign: 'right', padding: '2px 6px' }}>Pred</th>
                  <th style={{ textAlign: 'right', padding: '2px 6px' }}>Peak</th>
                  <th style={{ textAlign: 'right', padding: '2px 6px' }}>Actual</th>
                  <th style={{ textAlign: 'right', padding: '2px 6px' }} title="Innovation: actual − pred">Innov</th>
                  <th style={{ textAlign: 'center', padding: '2px 6px' }}>✓</th>
                </tr>
              </thead>
              <tbody>
                {[...s.sysLog].reverse().map((e, i) => {
                  const innov = (e.resolved && e.outcomeMove != null) ? (e.outcomeMove - e.predMove) : null
                  const sigma = kb?.sigma ?? 0.5  // BTC has larger moves — default sigma 0.5%
                  const absZ = innov != null ? Math.abs(innov) / sigma : 0
                  const innovColor = innov == null ? S.text2
                    : absZ > 1.5 ? (innov > 0 ? S.bull : S.bear)
                    : absZ > 0.5 ? (innov > 0 ? '#55cc88' : '#cc6666')
                    : S.text2
                  const vel = e.kalmanVelAtPred
                  const isVelBacked = vel != null && e.predDir != null
                    && ((e.predDir === 'BULL' && vel >= 3) || (e.predDir === 'BEAR' && vel <= -3))
                  const isVelStrong = vel != null && Math.abs(vel) >= 5
                  return (
                    <tr key={e.cycleTs} style={{ borderBottom: `1px solid ${S.border}`, opacity: i > 9 ? 0.6 : 1, background: isVelStrong ? 'rgba(247,147,26,0.04)' : undefined }}>
                      <td style={{ padding: '2px 6px' }}>{e.cycleTime}</td>
                      <td style={{ padding: '2px 6px', color: dirColor(e.predDir) }}>{e.predDir ?? '·'}</td>
                      <td style={{ padding: '2px 6px', textAlign: 'right', color: isVelStrong ? S.orange : isVelBacked ? '#aaa' : S.text2, fontSize: '9px' }}>
                        {vel != null ? `${vel >= 0 ? '+' : ''}${vel.toFixed(1)}` : '·'}
                      </td>
                      <td style={{ padding: '2px 6px', textAlign: 'right', color: dirColor(e.predDir) }}>{fmtPct(e.predMove)}</td>
                      <td style={{ padding: '2px 6px', textAlign: 'right', color: e.peakMove != null && Math.abs(e.peakMove) > 0.2 ? (e.peakMove > 0 ? S.bull : S.bear) : S.text2, fontSize: '9px' }}>
                        {e.peakMove != null ? fmtPct(e.peakMove) : '·'}
                      </td>
                      <td style={{ padding: '2px 6px', textAlign: 'right', color: dirColor(e.outcomeDir) }}>
                        {e.outcomeMove != null ? fmtPct(e.outcomeMove) : (e.liveMove != null ? `~${fmtPct(e.liveMove)}` : '…')}
                      </td>
                      <td style={{ padding: '2px 6px', textAlign: 'right', color: innovColor }}>
                        {innov != null ? `${fmtPct(innov)} ${absZ > 0.5 ? `(${absZ.toFixed(1)}σ)` : ''}` : '·'}
                      </td>
                      <td style={{ padding: '2px 6px', textAlign: 'center' }}>
                        {!e.resolved ? '…' : e.correct === true ? <span style={{ color: S.bull }}>✓</span> : e.correct === false ? <span style={{ color: S.bear }}>✗</span> : '·'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
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
              Kalman calibration: {s.sysLog.filter(e => e.resolved).length}/5 resolved entries needed ·
              syslog writes every 15min · resolves at 60min
            </div>
          )}
        </div>
      )}

      {/* Active Trade + Trade History */}
      <div style={{ display: 'grid', gridTemplateColumns: s.activeTrade ? '1fr 2fr' : '1fr', gap: '10px', marginBottom: '10px' }}>

        {/* Active trade card */}
        {s.activeTrade && (() => {
          const t = s.activeTrade
          const sign = t.dir === 'BULL' ? 1 : -1
          const livePnl = s.spot > 0 && t.entrySpot > 0
            ? ((s.spot - t.entrySpot) / t.entrySpot) * 100 * sign : null
          const pnlColor = livePnl == null ? S.text2 : livePnl >= 0 ? S.bull : S.bear
          const heldMin = Math.round((Date.now() - t.openTs) / 60_000)
          return (
            <div style={{ ...card, border: `1px solid ${t.dir === 'BULL' ? 'rgba(0,255,136,0.5)' : 'rgba(255,68,68,0.5)'}`, background: t.dir === 'BULL' ? 'rgba(0,255,136,0.04)' : 'rgba(255,68,68,0.04)' }}>
              <div style={lbl}>● ACTIVE TRADE</div>
              <div style={{ fontSize: '18px', fontWeight: 'bold', color: t.dir === 'BULL' ? S.bull : S.bear }}>
                {t.dir === 'BULL' ? '▲ LONG' : '▼ SHORT'}
              </div>
              <div style={{ marginTop: '6px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px', fontSize: '11px' }}>
                <div>entry <span style={{ color: S.text }}>{fmtUSD(t.entrySpot)}</span></div>
                <div>held <span style={{ color: S.text2 }}>{heldMin}m</span></div>
                {livePnl != null && (
                  <div style={{ gridColumn: '1 / -1' }}>
                    live P&L <span style={{ color: pnlColor, fontWeight: 700, fontSize: '13px' }}>{fmtPct(livePnl)}</span>
                    {t.peakPct > 0 && <span style={{ color: S.text2, marginLeft: '8px', fontSize: '10px' }}>peak {fmtPct(t.peakPct)}</span>}
                  </div>
                )}
                <div>vel@entry <span style={{ color: t.dir === 'BULL' ? S.bull : S.bear }}>{t.entryVel >= 0 ? '+' : ''}{t.entryVel.toFixed(1)} $/m</span></div>
                <div>conf <span style={{ color: S.text2 }}>{(t.entryConf * 100).toFixed(0)}%</span></div>
                <div>cdZ@entry <span style={{ color: t.entryCdZ > 0 ? S.bull : t.entryCdZ < 0 ? S.bear : S.text2 }}>{t.entryCdZ >= 0 ? '+' : ''}{t.entryCdZ.toFixed(2)}σ</span></div>
                <div style={{ color: S.text2, fontSize: '10px' }}>{t.openTime} · {t.sessionKey}</div>
              </div>
              <div style={{ marginTop: '6px', fontSize: '9px', color: S.text2 }}>
                stop −0.5% · trail at peak≥0.2%→50% · vel rev exit · 90m max
              </div>
            </div>
          )
        })()}

        {/* Trade history */}
        <div style={card}>
          <div style={lbl}>TRADE HISTORY</div>
          {(() => {
            const closed = s.tradeLog.filter(t => t.pnlPct != null)
            const wins   = closed.filter(t => (t.pnlPct ?? 0) > 0).length
            const wr     = closed.length > 0 ? wins / closed.length : null
            const avgWin  = closed.filter(t => (t.pnlPct ?? 0) > 0).reduce((s, t) => s + (t.pnlPct ?? 0), 0) / Math.max(1, wins)
            const avgLoss = closed.filter(t => (t.pnlPct ?? 0) <= 0).reduce((s, t) => s + (t.pnlPct ?? 0), 0) / Math.max(1, closed.length - wins)
            return (
              <>
                {wr != null && (
                  <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '6px', fontSize: '11px' }}>
                    <span>WR <span style={{ color: wr >= 0.5 ? S.bull : S.bear, fontWeight: 700 }}>{Math.round(wr * 100)}%</span> ({wins}/{closed.length})</span>
                    {wins > 0 && <span>avg win <span style={{ color: S.bull }}>{fmtPct(avgWin)}</span></span>}
                    {closed.length > wins && <span>avg loss <span style={{ color: S.bear }}>{fmtPct(avgLoss)}</span></span>}
                  </div>
                )}
                {s.tradeLog.length === 0 ? (
                  <div style={{ fontSize: '10px', color: S.text2 }}>
                    No trades yet · waits for: pattern conf≥30% + bullProb≥58% + |kalman vel|≥$3/min
                  </div>
                ) : (
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '10px' }}>
                      <thead>
                        <tr style={{ color: S.text2, borderBottom: `1px solid ${S.border}` }}>
                          <th style={{ textAlign: 'left', padding: '2px 4px' }}>Time</th>
                          <th style={{ textAlign: 'left', padding: '2px 4px' }}>Dir</th>
                          <th style={{ textAlign: 'right', padding: '2px 4px' }}>Vel</th>
                          <th style={{ textAlign: 'right', padding: '2px 4px' }}>Peak</th>
                          <th style={{ textAlign: 'right', padding: '2px 4px' }}>P&L</th>
                          <th style={{ textAlign: 'left', padding: '2px 4px' }}>Exit</th>
                        </tr>
                      </thead>
                      <tbody>
                        {s.tradeLog.map(t => {
                          const pnl = t.pnlPct
                          const pnlColor = pnl == null ? S.text2 : pnl > 0 ? S.bull : S.bear
                          const exitLabel: Record<string, string> = {
                            trail: '🎯trail', stop: '🛑stop', vel_rev: '⚡vel↩',
                            pat_flip: '🔄flip', time: '⏱time',
                          }
                          return (
                            <tr key={t.id} style={{ borderBottom: `1px solid ${S.border}` }}>
                              <td style={{ padding: '2px 4px', color: S.text2 }}>{t.openTime}</td>
                              <td style={{ padding: '2px 4px', color: t.dir === 'BULL' ? S.bull : S.bear }}>{t.dir === 'BULL' ? '▲' : '▼'}</td>
                              <td style={{ padding: '2px 4px', textAlign: 'right', color: t.dir === 'BULL' ? S.bull : S.bear }}>{t.entryVel >= 0 ? '+' : ''}{t.entryVel.toFixed(1)}</td>
                              <td style={{ padding: '2px 4px', textAlign: 'right', color: t.peakPct > 0.1 ? S.bull : S.text2 }}>{fmtPct(t.peakPct)}</td>
                              <td style={{ padding: '2px 4px', textAlign: 'right', fontWeight: 700, color: pnlColor }}>{pnl != null ? fmtPct(pnl) : '…'}</td>
                              <td style={{ padding: '2px 4px', color: S.text2, fontSize: '9px' }}>{t.exitReason ? (exitLabel[t.exitReason] ?? t.exitReason) : '…'}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )
          })()}
        </div>
      </div>

      {/* Deribit Option Chain */}
      {s.oiAnalytics && (
        <div style={card}>
          <div style={lbl}>OPTION CHAIN OI · DERIBIT BTC · {s.oiAnalytics.expiry}</div>
          <div style={{ fontSize: '10px', color: S.text2, marginBottom: '6px', display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            <span>PCR {s.oiAnalytics.pcr.toFixed(2)}</span>
            <span>MaxPain ★{fmtUSD(s.oiAnalytics.maxPainStrike)}</span>
            <span>ATM {fmtUSD(s.oiAnalytics.atmStrike)}</span>
            <span style={{ color: S.bear }}>Total Call OI {fmtNum(s.oiAnalytics.totalCallOI)} BTC</span>
            <span style={{ color: S.bull }}>Total Put OI {fmtNum(s.oiAnalytics.totalPutOI)} BTC</span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '10px' }}>
              <thead>
                <tr style={{ color: S.text2, borderBottom: `1px solid ${S.border}` }}>
                  <th style={{ textAlign: 'right', padding: '2px 6px' }}>Call OI</th>
                  <th style={{ textAlign: 'right', padding: '2px 6px' }}>Call $</th>
                  <th style={{ textAlign: 'center', padding: '2px 8px', fontWeight: 'bold' }}>STRIKE</th>
                  <th style={{ textAlign: 'left', padding: '2px 6px' }}>Put $</th>
                  <th style={{ textAlign: 'left', padding: '2px 6px' }}>Put OI</th>
                </tr>
              </thead>
              <tbody>
                {s.oiAnalytics.strikes.map(row => {
                  const isAtm = row.strike === s.oiAnalytics!.atmStrike
                  const isMaxPain = row.strike === s.oiAnalytics!.maxPainStrike
                  return (
                    <tr key={row.strike} style={{
                      borderBottom: `1px solid ${S.border}`,
                      background: isAtm ? 'rgba(255,255,255,0.04)' : undefined,
                      fontWeight: isAtm ? 'bold' : undefined,
                    }}>
                      <td style={{ textAlign: 'right', padding: '2px 6px', color: S.bear }}>{fmtNum(row.callOI)}</td>
                      <td style={{ textAlign: 'right', padding: '2px 6px', color: S.bear }}>
                        {row.callLtp > 0 ? fmtUSD(row.callLtp) : '—'}
                      </td>
                      <td style={{ textAlign: 'center', padding: '2px 8px' }}>
                        {isMaxPain ? '★' : ''}{fmtUSD(row.strike)}
                      </td>
                      <td style={{ textAlign: 'left', padding: '2px 6px', color: S.bull }}>
                        {row.putLtp > 0 ? fmtUSD(row.putLtp) : '—'}
                      </td>
                      <td style={{ textAlign: 'left', padding: '2px 6px', color: S.bull }}>{fmtNum(row.putOI)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Depth */}
      {s.depth && s.depth.buy.length > 0 && (
        <div style={card}>
          <div style={lbl}>ORDER BOOK DEPTH (Binance Perp · 5 levels)</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', fontSize: '10px' }}>
            <div>
              <div style={{ color: S.bull, marginBottom: '4px' }}>BIDS</div>
              {s.depth.buy.map((l, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '1px 0' }}>
                  <span style={{ color: S.bull }}>{l.price.toFixed(1)}</span>
                  <span style={{ color: S.text2 }}>{l.qty.toFixed(3)}</span>
                </div>
              ))}
            </div>
            <div>
              <div style={{ color: S.bear, marginBottom: '4px' }}>ASKS</div>
              {s.depth.sell.map((l, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '1px 0' }}>
                  <span style={{ color: S.bear }}>{l.price.toFixed(1)}</span>
                  <span style={{ color: S.text2 }}>{l.qty.toFixed(3)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <div style={{ marginTop: '10px', fontSize: '9px', color: S.text2, textAlign: 'right' }}>
        {s.symbol} · patterns={s.patternCount} · resolved={s.resolvedCount} · {s.minutesAccumulated}min acc
      </div>

    </div>
  )
}
