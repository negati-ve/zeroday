import fs from 'fs'
import path from 'path'
import { IndicatorEngine, type IndicatorValues } from './indicators'
import { kiteGetLTP, kiteGetQuote, kiteGetHistorical } from './kite'
import { getNiftyContracts, fetchNiftyChainOI, getCachedNiftyOI, type NiftyOIAnalytics, type NiftyContracts } from './niftyContracts'
import { getISTHourMin } from './tradingCalendar'

// ── Constants ─────────────────────────────────────────────────────────────────

// Pat20Con: rolling Gaussian KDE over pat-20m bullProb predictions
const P20C_SIGMA_MS  = 5 * 60_000    // 5-min Gaussian kernel σ
const P20C_WIN_MS    = 20 * 60_000   // 20-min rolling history window
const P20C_VEL_BOOST = 3.5           // velocity→probability boost factor
const P20C_SAMPLE_MS = 30_000        // min interval between buffer entries
const P20C_BUF_MAX   = 60            // buffer capacity (60 × 30s = 30 min)

const VEC_DIM = 12
const MAX_PATTERNS = 500
const MAX_SNAPSHOTS = 120
const SNAPSHOT_INTERVAL_MS = 60_000
const OUTCOME_5_MS = 5 * 60_000
const OUTCOME_15_MS = 15 * 60_000
const OUTCOME_20_MS = 20 * 60_000
const TEMPERATURE = 0.15
const KNN_K = 20
const MIN_PATTERNS = 10
const PERSIST_INTERVAL_MS = 5 * 60_000
const SYSLOG_CYCLE_MS = 20 * 60_000
const MAX_SYSLOG = 200
const MAX_P20C_SWINGS = 100
const TYPICAL_MOVE = 0.1   // NIFTY typically moves 0.1% per 20m

// ── V2 constants ──────────────────────────────────────────────────────────────
const VEC_DIM_V2 = 14
const MAX_PATTERNS_V2 = 300
const MIN_PATTERNS_V2 = 3
const CUSUM_H = 0.01             // NIFTY volatility is higher — wider threshold
const KALMAN_Q_PRICE = 5.0       // NIFTY at ~24000 has 3× crude's absolute noise
const KALMAN_Q_VEL   = 0.02
const KALMAN_R       = 4.0
const V2_PERSIST_INTERVAL_MS = 5 * 60_000

// NSE trading hours: 9:15 AM – 3:30 PM IST
const NSE_OPEN_HOUR  = 9
const NSE_OPEN_MIN   = 15
const NSE_CLOSE_HOUR = 15
const NSE_CLOSE_MIN  = 30

// ── Types ─────────────────────────────────────────────────────────────────────

interface Snapshot {
  ts: number
  vec: number[]
  price: number
  proxy: number
}

interface NiftyPattern {
  ts: number
  vec: number[]
  price: number
  proxy: number
  outcome5: number | null
  outcome15: number | null
  outcome20: number | null
  sessionDay: string
}

interface NiftyStore {
  snapshots: Snapshot[]
  patterns: NiftyPattern[]
  lastSnapshotTs: number
  lastPersistTs: number
  sessionDay: string | null
  sessionOpen: number
  sessionHigh: number
  sessionLow: number
  priceHistory: { ts: number; price: number }[]
}

export interface HorizonPrediction {
  predictedMove: number
  bullProb: number
  bearProb: number
}

export interface NiftyPrediction {
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

export interface NiftyTechnicals {
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

export interface NiftyComposite {
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

// ── Elliott Wave Types ────────────────────────────────────────────────────────

export interface EWPivot {
  ts: number
  price: number
  type: 'H' | 'L'
  wave: '?' | '0' | '1' | '2' | '3' | '4' | '5' | 'A' | 'B' | 'C'
  timeStr: string
}

export interface EWLevel {
  price: number
  label: string
  role: 'support' | 'resistance' | 'target'
}

export interface ElliottWaveState {
  pattern: 'IMPULSE_BULL' | 'IMPULSE_BEAR' | 'CORRECTIVE_BULL' | 'CORRECTIVE_BEAR' | 'UNKNOWN'
  currentWave: string
  pivots: EWPivot[]
  levels: EWLevel[]
  primaryTarget: number | null
  invalidation: number | null
  confidence: number
  combinedBias: 'STRONG_BULL' | 'BULL' | 'NEUTRAL' | 'BEAR' | 'STRONG_BEAR'
  combinedNote: string
  updatedAt: number
}

// ── Elliott Wave Algorithm ────────────────────────────────────────────────────

interface EWCandle {
  ts: number; open: number; high: number; low: number; close: number
}

function findZigZagPivots(candles: EWCandle[], minMovePct = 0.003): EWPivot[] {
  const pivots: EWPivot[] = []
  if (candles.length < 4) return pivots

  const fmtTs = (ts: number) => {
    const d = new Date(ts + 5.5 * 3600_000)
    return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`
  }

  let leg: 'UP' | 'DOWN' = candles[1].close >= candles[0].close ? 'UP' : 'DOWN'
  let extPrice = leg === 'UP' ? candles[0].high : candles[0].low
  let extTs = candles[0].ts

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]
    if (leg === 'UP') {
      if (c.high > extPrice) { extPrice = c.high; extTs = c.ts }
      if (c.close < extPrice * (1 - minMovePct)) {
        pivots.push({ ts: extTs, price: extPrice, type: 'H', wave: '?', timeStr: fmtTs(extTs) })
        leg = 'DOWN'; extPrice = c.low; extTs = c.ts
      }
    } else {
      if (c.low < extPrice) { extPrice = c.low; extTs = c.ts }
      if (c.close > extPrice * (1 + minMovePct)) {
        pivots.push({ ts: extTs, price: extPrice, type: 'L', wave: '?', timeStr: fmtTs(extTs) })
        leg = 'UP'; extPrice = c.high; extTs = c.ts
      }
    }
  }
  if (pivots.length > 0) {
    const last = pivots[pivots.length - 1]
    if (Math.abs(extPrice - last.price) / last.price > minMovePct * 0.4) {
      pivots.push({ ts: extTs, price: extPrice, type: leg === 'UP' ? 'H' : 'L', wave: '?', timeStr: fmtTs(extTs) })
    }
  }
  return pivots
}

function fibLevel(from: number, to: number, ratio: number): number {
  return from + (to - from) * ratio
}

interface WaveFit {
  pattern: ElliottWaveState['pattern']
  currentWave: string
  pivots: EWPivot[]
  primaryTarget: number | null
  invalidation: number | null
  levels: EWLevel[]
  score: number
}

function tryFitImpulse(seq: EWPivot[], bull: boolean): WaveFit | null {
  const startType = bull ? 'L' : 'H'
  if (seq[0].type !== startType) return null
  if (seq.length < 3) return null

  const up = bull ? 1 : -1
  const p = seq

  if (p[1].type === startType) return null
  const w1 = (p[1].price - p[0].price) * up
  if (w1 <= 0) return null

  let score = 0
  const labels: string[] = p.map((_,i) => i === 0 ? '0' : '?')
  labels[1] = '1'

  if (p.length < 3) return { pattern: bull ? 'IMPULSE_BULL' : 'IMPULSE_BEAR', currentWave: '2', pivots: applyLabels(p, labels), primaryTarget: null, invalidation: p[0].price, levels: [], score }

  const w2_retrace = (p[1].price - p[2].price) * up / w1
  if (w2_retrace <= 0 || w2_retrace >= 1.0) return null
  labels[2] = '2'
  if (w2_retrace >= 0.382 - 0.08 && w2_retrace <= 0.618 + 0.08) score += 1

  if (p.length < 4) {
    const w3start = p[2].price
    const tgt = w3start + w1 * 1.618 * up
    return { pattern: bull ? 'IMPULSE_BULL' : 'IMPULSE_BEAR', currentWave: '3', pivots: applyLabels(p, labels), primaryTarget: tgt, invalidation: p[0].price, levels: buildImpulseLevels(p, up, w1), score }
  }

  const w3 = (p[3].price - p[2].price) * up
  if (p[3].type === startType) return null
  if ((p[3].price - p[1].price) * up <= 0) return null
  labels[3] = '3'
  score += 1
  const w1_w3_ratio = w3 / w1
  if (w1_w3_ratio >= 1.4 && w1_w3_ratio <= 2.0) score += 1

  if (p.length < 5) {
    return { pattern: bull ? 'IMPULSE_BULL' : 'IMPULSE_BEAR', currentWave: '4', pivots: applyLabels(p, labels), primaryTarget: fibLevel(p[3].price, p[2].price, 0.382), invalidation: p[1].price, levels: buildImpulseLevels(p, up, w1), score }
  }

  const w4_retrace = (p[3].price - p[4].price) * up / w3
  if (p[4].type !== startType) return null
  if ((p[4].price - p[1].price) * up < 0) return null
  labels[4] = '4'
  if (w4_retrace >= 0.236 - 0.05 && w4_retrace <= 0.382 + 0.08) score += 1

  if (p.length < 6) {
    const w5tgt = p[4].price + w1 * up
    return { pattern: bull ? 'IMPULSE_BULL' : 'IMPULSE_BEAR', currentWave: '5', pivots: applyLabels(p, labels), primaryTarget: w5tgt, invalidation: p[1].price, levels: buildImpulseLevels(p, up, w1), score }
  }

  if (p[5].type === startType) return null
  labels[5] = '5'
  score += 1
  if (p.length > 6) labels[6] = 'A'
  if (p.length > 7) labels[7] = 'B'
  if (p.length > 8) labels[8] = 'C'

  const isAfter5 = p.length > 6
  const corrDir = bull ? 'CORRECTIVE_BEAR' : 'CORRECTIVE_BULL'
  const cwv = p.length === 6 ? '5' : p.length === 7 ? 'A' : p.length === 8 ? 'B' : 'C'
  return { pattern: isAfter5 ? corrDir as ElliottWaveState['pattern'] : bull ? 'IMPULSE_BULL' : 'IMPULSE_BEAR', currentWave: cwv, pivots: applyLabels(p, labels), primaryTarget: null, invalidation: p[1].price, levels: buildImpulseLevels(p, up, w1), score }
}

type WaveLabel = EWPivot['wave']
function applyLabels(pivots: EWPivot[], labels: string[]): EWPivot[] {
  return pivots.map((p, i) => ({ ...p, wave: (labels[i] ?? '?') as WaveLabel }))
}

function buildImpulseLevels(p: EWPivot[], up: number, w1: number): EWLevel[] {
  const levels: EWLevel[] = []
  if (p.length >= 3) {
    levels.push({ price: fibLevel(p[1].price, p[0].price, 0.382), label: '38.2% W2', role: 'support' })
    levels.push({ price: fibLevel(p[1].price, p[0].price, 0.618), label: '61.8% W2', role: 'support' })
  }
  if (p.length >= 4) {
    levels.push({ price: p[2].price + w1 * 1.618 * up, label: '1.618 W3', role: 'target' })
    levels.push({ price: p[2].price + w1 * 2.618 * up, label: '2.618 W3', role: 'target' })
  }
  if (p.length >= 6) {
    levels.push({ price: fibLevel(p[3].price, p[4].price, 0.382), label: '38.2% W4', role: 'support' })
    levels.push({ price: p[4].price + w1 * up, label: 'W5=W1 tgt', role: 'target' })
  }
  return levels
}

const EW_TF_CONFIG: Record<string, { kiteInterval: string; lookbackDays: number; refreshMs: number; zigzagThresh: number }> = {
  '15m': { kiteInterval: '15minute', lookbackDays: 3,    refreshMs: 15 * 60_000,         zigzagThresh: 0.003 },
  '1h':  { kiteInterval: '60minute', lookbackDays: 10,   refreshMs: 60 * 60_000,         zigzagThresh: 0.005 },
  '4h':  { kiteInterval: '60minute', lookbackDays: 30,   refreshMs: 60 * 60_000,         zigzagThresh: 0.008 },
  '1d':  { kiteInterval: 'day',      lookbackDays: 180,  refreshMs: 4 * 60 * 60_000,     zigzagThresh: 0.015 },
  '1w':  { kiteInterval: 'week',     lookbackDays: 730,  refreshMs: 12 * 60 * 60_000,    zigzagThresh: 0.03  },
  '1M':  { kiteInterval: 'month',    lookbackDays: 1825, refreshMs: 24 * 60 * 60_000,    zigzagThresh: 0.05  },
}

function resampleTo4H(candles: EWCandle[]): EWCandle[] {
  const out: EWCandle[] = []
  for (let i = 0; i < candles.length; i += 4) {
    const chunk = candles.slice(i, Math.min(i + 4, candles.length))
    if (chunk.length === 0) continue
    out.push({
      ts: chunk[0].ts,
      open: chunk[0].open,
      high: Math.max(...chunk.map(c => c.high)),
      low: Math.min(...chunk.map(c => c.low)),
      close: chunk[chunk.length - 1].close,
    })
  }
  return out
}

async function fetchEWCandlesTF(token: number, kiteInterval: string, lookbackDays: number): Promise<EWCandle[]> {
  try {
    const now = Date.now()
    const istNow = new Date(now + 5.5 * 3600_000)
    const from = new Date(istNow.getTime() - lookbackDays * 24 * 3600_000)
    const fmt = (d: Date) => d.toISOString().slice(0, 10) + ' ' +
      String(d.getUTCHours()).padStart(2,'0') + ':' + String(d.getUTCMinutes()).padStart(2,'0') + ':00'
    const raw = await Promise.race([
      kiteGetHistorical(token, kiteInterval as Parameters<typeof kiteGetHistorical>[1], fmt(from), fmt(istNow)),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('EW fetch timeout')), 15_000)),
    ])
    return raw.map(c => ({ ts: new Date(c.date).getTime(), open: c.open, high: c.high, low: c.low, close: c.close }))
  } catch { return [] }
}

function computeElliottWave(
  pivots: EWPivot[],
  spot: number,
  composite: NiftyComposite
): ElliottWaveState {
  const unknown: ElliottWaveState = {
    pattern: 'UNKNOWN', currentWave: '?', pivots: pivots.slice(-6),
    levels: [], primaryTarget: null, invalidation: null, confidence: 0,
    combinedBias: 'NEUTRAL', combinedNote: 'Insufficient pivot data for wave analysis',
    updatedAt: Date.now(),
  }
  if (pivots.length < 4) return unknown

  const fits: WaveFit[] = []
  for (let start = Math.max(0, pivots.length - 9); start <= pivots.length - 3; start++) {
    const seq = pivots.slice(start)
    const bf = tryFitImpulse(seq, true)
    if (bf) fits.push(bf)
    const bb = tryFitImpulse(seq, false)
    if (bb) fits.push(bb)
  }

  if (fits.length === 0) return unknown

  const best = fits.sort((a, b) => b.score - a.score)[0]
  const confidence = Math.min(0.9, best.score / 5)

  const orcDir = composite.direction
  const orcConf = composite.confidence
  const wv = best.currentWave
  const isBullImpulse = best.pattern === 'IMPULSE_BULL'
  const isBearImpulse = best.pattern === 'IMPULSE_BEAR'
  const isCorrectiveBear = best.pattern === 'CORRECTIVE_BEAR'
  const isCorrectiveBull = best.pattern === 'CORRECTIVE_BULL'

  let combinedBias: ElliottWaveState['combinedBias'] = 'NEUTRAL'
  let combinedNote = ''

  if (isBullImpulse && wv === '3') {
    combinedBias = orcDir === 'BULL' ? 'STRONG_BULL' : 'BULL'
    combinedNote = orcDir === 'BULL' ? 'Wave 3 impulse + oracle BULL — momentum phase, high conviction long' : 'Wave 3 impulse building — oracle diverges, watch for CD confirmation'
  } else if (isBullImpulse && wv === '5') {
    combinedBias = orcDir === 'BULL' ? 'BULL' : orcDir === 'BEAR' ? 'BEAR' : 'NEUTRAL'
    combinedNote = orcDir === 'BEAR' ? 'Wave 5 terminal + oracle BEAR — exhaustion reversal setup' : 'Wave 5 in progress — target hit likely before reversal'
  } else if (isBullImpulse && wv === '4') {
    combinedBias = orcDir === 'BULL' ? 'BULL' : 'NEUTRAL'
    combinedNote = 'Wave 4 correction — pullback in bull impulse, awaiting Wave 5 bounce'
  } else if (isBullImpulse && wv === '2') {
    combinedBias = orcDir === 'BEAR' ? 'BEAR' : 'NEUTRAL'
    combinedNote = 'Wave 2 retracement — early bull impulse, oracle may flag short-term weakness'
  } else if (isBearImpulse && wv === '3') {
    combinedBias = orcDir === 'BEAR' ? 'STRONG_BEAR' : 'BEAR'
    combinedNote = orcDir === 'BEAR' ? 'Wave 3 bear impulse + oracle BEAR — distribution phase, high conviction short' : 'Wave 3 bear impulse — oracle diverges, watch selling pressure in CD'
  } else if (isBearImpulse && wv === '5') {
    combinedBias = orcDir === 'BEAR' ? 'BEAR' : orcDir === 'BULL' ? 'BULL' : 'NEUTRAL'
    combinedNote = orcDir === 'BULL' ? 'Wave 5 bear terminal + oracle BULL — potential bottom/reversal' : 'Wave 5 bear in progress — downside target near'
  } else if (isBearImpulse && wv === '4') {
    combinedBias = orcDir === 'BEAR' ? 'BEAR' : 'NEUTRAL'
    combinedNote = 'Wave 4 bear correction — retracement in downtrend, Wave 5 lower likely'
  } else if (isCorrectiveBear) {
    combinedBias = orcDir === 'BEAR' ? 'BEAR' : 'NEUTRAL'
    combinedNote = `ABC correction (${wv}) following bull impulse — watch for C-wave completion`
  } else if (isCorrectiveBull) {
    combinedBias = orcDir === 'BULL' ? 'BULL' : 'NEUTRAL'
    combinedNote = `ABC correction (${wv}) following bear impulse — watch for C-wave completion`
  } else {
    combinedNote = `${best.pattern.replace('_', ' ').toLowerCase()} — wave ${wv} in progress`
  }

  if (orcConf > 0.4 && combinedBias === 'BULL') combinedBias = 'STRONG_BULL'
  if (orcConf > 0.4 && combinedBias === 'BEAR') combinedBias = 'STRONG_BEAR'

  return {
    pattern: best.pattern,
    currentWave: best.currentWave,
    pivots: best.pivots.slice(-7),
    levels: best.levels,
    primaryTarget: best.primaryTarget,
    invalidation: best.invalidation,
    confidence,
    combinedBias,
    combinedNote,
    updatedAt: Date.now(),
  }
}

// ── SysLog types ──────────────────────────────────────────────────────────────

export interface SysLogExtend {
  ts: number
  cycleTime: string
  spotAtExtend: number
  prevPredMove: number
  optEntry?: number | null
  optTarget?: number | null
}

export interface NiftySysLogEntry {
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
  repeatCount?: number
  extends?: SysLogExtend[]
  originalOptEntry?: number | null
}

// ── P20C Swing Log ────────────────────────────────────────────────────────────

export interface P20CSwingEntry {
  id: number
  startTs: number
  startTime: string
  direction: 'BULL' | 'BEAR'
  scaledAtStart: number
  spotAtStart: number
  sessionDay: string
  optStrike: number | null
  optType: 'CE' | 'PE' | null
  optSymbol: string | null
  optEntry: number | null
  resolved: boolean
  endTs: number | null
  endTime: string | null
  scaledAtEnd: number | null
  spotAtEnd: number | null
  durationMin: number | null
  outcomeMove: number | null
  correct: boolean | null
  optExit: number | null
  pnlGross: number | null
  pnlNet: number | null
}

// ── Pat20Con ─────────────────────────────────────────────────────────────────

interface P20CEntry { ts: number; bullProb: number }

export interface Pat20Con {
  smoothed: number
  effective: number
  velocity: number
  acceleration: number
  direction: 'BULL' | 'BEAR' | null
  strength: number
}

function computePat20Con(buf: P20CEntry[], now: number): Pat20Con | null {
  const win = buf.filter(e => now - e.ts <= P20C_WIN_MS)
  if (win.length < 3) return null

  const sig2 = 2 * P20C_SIGMA_MS * P20C_SIGMA_MS
  const kde = (t: number): number => {
    let sw = 0, swp = 0
    for (const e of win) {
      const w = Math.exp(-((t - e.ts) ** 2) / sig2)
      sw += w; swp += w * e.bullProb
    }
    return sw > 1e-12 ? swp / sw : 0.5
  }

  const s0 = kde(now)
  const s2 = kde(now - 2 * 60_000)
  const s4 = kde(now - 4 * 60_000)

  const v0 = (s0 - s2) / 2
  const v2 = (s2 - s4) / 2
  const acc = v0 - v2
  const vc  = Math.max(-0.05, Math.min(0.05, v0))
  const eff = Math.max(0, Math.min(1, s0 + vc * P20C_VEL_BOOST))

  return {
    smoothed: s0,
    effective: eff,
    velocity: v0,
    acceleration: acc,
    direction: eff > 0.58 ? 'BULL' : eff < 0.42 ? 'BEAR' : null,
    strength: Math.min(1, Math.abs(eff - 0.5) * 5),
  }
}

// ── NiftyChain (compatible with CrudeChain shape for UI reuse) ────────────────

export interface NiftyFutChain {
  calls: { tradingsymbol: string; strike: number; expiry: string; instrumentType: 'CE'; product: string }[]
  puts: { tradingsymbol: string; strike: number; expiry: string; instrumentType: 'PE'; product: string }[]
  spotEstimate: number
  expiry: string
  product: string
  lotSize: number
  strikeStep: number
  atmStrike: number
  oiAnalytics?: NiftyOIAnalytics
}

export interface NiftyFlowState {
  cumDelta:        number
  cdZScore:        number
  aggressionRatio: number
  cusumPos:        number
  cusumNeg:        number
  cusumAlarm:      'BULL' | 'BEAR' | null
}

// ── V2 types ──────────────────────────────────────────────────────────────────

export type NSESession = 'morning' | 'afternoon' | 'evening'

interface PatternV2 {
  ts: number
  vec: number[]
  price: number
  sessionKey: NSESession
  sessionDay: string
  outcome5:  number | null
  outcome15: number | null
  outcome20: number | null
  detrended5:  number | null
  detrended15: number | null
  detrended20: number | null
}

interface KalmanState {
  x: [number, number]
  P: [[number, number], [number, number]]
  initialised: boolean
}

export interface NiftyV2 {
  prediction:          NiftyPrediction
  sessionKey:          NSESession
  sessionPatternCount: number
  flowState:           NiftyFlowState | null
  featureVec:          number[]
  kalmanVelocity:      number
}

// ── Meta-Regime types ─────────────────────────────────────────────────────────

export interface MetaRegimeData {
  regime: 'ACCUMULATION' | 'MARKUP' | 'DISTRIBUTION' | 'MARKDOWN' | 'CHOP' | 'UNKNOWN'
  confidence: number
  avgCdZ: number
  avgObi: number
  divergenceScore: number
  momentumSlope: number
}

// ── Main NiftyFutState export type ────────────────────────────────────────────

export interface NiftyFutState {
  prediction: NiftyPrediction
  technicals: NiftyTechnicals
  composite: NiftyComposite
  snapshotCount: number
  patternCount: number
  resolvedCount: number
  proxy: number
  minutesAccumulated: number
  sysLog: NiftySysLogEntry[]
  chain: NiftyFutChain | null
  spot: number
  futureSymbol: string
  futureToken: number
  marketOpen: boolean
  pat20Con: Pat20Con | null
  p20cSysLog: P20CSwingEntry[]
  elliottWave: ElliottWaveState | null
  elliottWaveByTF: Partial<Record<string, ElliottWaveState>>
  metaRegime: MetaRegimeData | null
  v2: NiftyV2 | null
  depth?: {
    buy: { price: number; quantity: number; orders: number }[]
    sell: { price: number; quantity: number; orders: number }[]
  }
}

// ── Singleton State ───────────────────────────────────────────────────────────

function freshStore(): NiftyStore {
  return {
    snapshots: [],
    patterns: [],
    lastSnapshotTs: 0,
    lastPersistTs: 0,
    sessionDay: null,
    sessionOpen: 0,
    sessionHigh: 0,
    sessionLow: Infinity,
    priceHistory: [],
  }
}

interface ProductState {
  store: NiftyStore
  indicatorEngine: IndicatorEngine
  engineWarmed: boolean
  warmingPromise: Promise<void> | null
  loaded: boolean
  lastWarmTs: number
  sysLogStore: { entries: NiftySysLogEntry[]; lastCycleTs: number }
  sysLogLoaded: boolean
  p20cBuf: P20CEntry[]
  p20cLastTs: number
  p20cBufLoaded: boolean
  p20cBufLastPersistTs: number
  lastOIAnalytics: NiftyOIAnalytics | null
  p20cSwingStore: { entries: P20CSwingEntry[]; nextId: number }
  p20cSwingLoaded: boolean
  ewPivots: EWPivot[]
  lastEWTs: number
  ewPivotsByTF: Partial<Record<string, EWPivot[]>>
  lastEWTsByTF: Partial<Record<string, number>>
  patternsV2: { morning: PatternV2[]; afternoon: PatternV2[]; evening: PatternV2[] }
  patternsV2Loaded: boolean
  patternsV2LastPersistTs: number
  lastV2SnapshotTs: number
  kalman: KalmanState
  kalmanLastTs: number
  lastFlowState: NiftyFlowState | null
  lastFlowStateAt: number
  instrumentToken: number
}

// Single product state for NIFTY (no Map needed)
let _niftyProductState: ProductState | null = null

function getNiftyProductState(): ProductState {
  if (!_niftyProductState) {
    _niftyProductState = {
      store: freshStore(),
      indicatorEngine: new IndicatorEngine({ emaShortPeriod: 9, emaLongPeriod: 21, rsiPeriod: 14, atrPeriod: 14 }),
      engineWarmed: false,
      warmingPromise: null,
      loaded: false,
      lastWarmTs: 0,
      sysLogStore: { entries: [], lastCycleTs: 0 },
      sysLogLoaded: false,
      p20cBuf: [],
      p20cLastTs: 0,
      p20cBufLoaded: false,
      p20cBufLastPersistTs: 0,
      lastOIAnalytics: null,
      p20cSwingStore: { entries: [], nextId: 1 },
      p20cSwingLoaded: false,
      ewPivots: [],
      lastEWTs: 0,
      ewPivotsByTF: {},
      lastEWTsByTF: {},
      patternsV2: { morning: [], afternoon: [], evening: [] },
      patternsV2Loaded: false,
      patternsV2LastPersistTs: 0,
      lastV2SnapshotTs: 0,
      kalman: { x: [0, 0], P: [[100, 0], [0, 1]], initialised: false },
      kalmanLastTs: 0,
      lastFlowState: null,
      lastFlowStateAt: 0,
      instrumentToken: 0,
    }
  }
  return _niftyProductState
}

// ── Persistence ───────────────────────────────────────────────────────────────

const BASE_DIR = '/workspace/option-trader'

function patternFile(): string {
  return path.join(BASE_DIR, 'niftyfut-patterns.json')
}

function sysLogFile(): string {
  return path.join(BASE_DIR, 'niftyfut-syslog.json')
}

function p20cBufFile(): string {
  return path.join(BASE_DIR, 'niftyfut-p20cbuf.json')
}

function p20cSwingFile(): string {
  return path.join(BASE_DIR, 'niftyfut-p20csyslog.json')
}

function patternsV2File(sessionKey: NSESession): string {
  return path.join(BASE_DIR, `niftyfut-v2-${sessionKey}.json`)
}

function ensureLoaded(ps: ProductState) {
  if (ps.loaded) return
  ps.loaded = true
  try {
    const raw = fs.readFileSync(patternFile(), 'utf8')
    const saved = JSON.parse(raw) as { patterns?: NiftyPattern[] }
    if (Array.isArray(saved.patterns)) {
      ps.store.patterns = saved.patterns
        .filter(p => Array.isArray(p.vec) && p.vec.length >= 12)
        .slice(-MAX_PATTERNS)
        .map(p => ({
          ...p,
          outcome5: p.outcome5 ?? null,
          outcome15: p.outcome15 ?? null,
          outcome20: p.outcome20 ?? null,
        }))
    }
  } catch { /* no file yet */ }
}

function persist(ps: ProductState) {
  try {
    fs.writeFileSync(patternFile(), JSON.stringify({
      patterns: ps.store.patterns.slice(-MAX_PATTERNS),
      savedAt: Date.now(),
    }))
    ps.store.lastPersistTs = Date.now()
  } catch { /* ignore */ }
}

function ensureSysLogLoaded(ps: ProductState) {
  if (ps.sysLogLoaded) return
  ps.sysLogLoaded = true
  try {
    const raw = fs.readFileSync(sysLogFile(), 'utf8')
    const saved = JSON.parse(raw) as Partial<typeof ps.sysLogStore>
    if (Array.isArray(saved.entries)) {
      const seen = new Set<number>()
      ps.sysLogStore.entries = saved.entries.filter((e: { cycleTs: number }) => {
        if (seen.has(e.cycleTs)) return false
        seen.add(e.cycleTs)
        return true
      }).slice(-MAX_SYSLOG)
    }
    if (saved.lastCycleTs) ps.sysLogStore.lastCycleTs = saved.lastCycleTs
  } catch { /* no file yet */ }
}

function persistSysLog(ps: ProductState) {
  try {
    fs.writeFileSync(sysLogFile(), JSON.stringify({
      entries: ps.sysLogStore.entries.slice(-MAX_SYSLOG),
      lastCycleTs: ps.sysLogStore.lastCycleTs,
      savedAt: Date.now(),
    }))
  } catch { /* ignore */ }
}

function ensureP20CBufLoaded(ps: ProductState) {
  if (ps.p20cBufLoaded) return
  ps.p20cBufLoaded = true
  try {
    const raw = fs.readFileSync(p20cBufFile(), 'utf8')
    const saved = JSON.parse(raw) as { buf?: P20CEntry[]; lastTs?: number }
    if (Array.isArray(saved.buf)) {
      const cutoff = Date.now() - P20C_WIN_MS
      ps.p20cBuf = saved.buf.filter(e => e.ts >= cutoff).slice(-P20C_BUF_MAX)
      if (saved.lastTs) ps.p20cLastTs = saved.lastTs
    }
  } catch { /* no file yet */ }
}

function persistP20CBuf(ps: ProductState) {
  try {
    fs.writeFileSync(p20cBufFile(), JSON.stringify({
      buf: ps.p20cBuf,
      lastTs: ps.p20cLastTs,
      savedAt: Date.now(),
    }))
    ps.p20cBufLastPersistTs = Date.now()
  } catch { /* ignore */ }
}

// ── Warm indicators from historical data ──────────────────────────────────────

async function warmIndicators(ps: ProductState, instrumentToken: number) {
  const now = Date.now()
  if (ps.engineWarmed && now - ps.lastWarmTs < 300_000) return

  try {
    const istNow = new Date(now + 5.5 * 3600_000)
    const from = new Date(istNow.getTime() - 4 * 3600_000)
    const fromStr = from.toISOString().slice(0, 10) + ' ' +
      String(from.getUTCHours()).padStart(2, '0') + ':' + String(from.getUTCMinutes()).padStart(2, '0') + ':00'
    const toStr = istNow.toISOString().slice(0, 10) + ' ' +
      String(istNow.getUTCHours()).padStart(2, '0') + ':' + String(istNow.getUTCMinutes()).padStart(2, '0') + ':00'

    const candles = await kiteGetHistorical(instrumentToken, 'minute', fromStr, toStr)

    if (candles.length > 0) {
      ps.indicatorEngine = new IndicatorEngine({ emaShortPeriod: 9, emaLongPeriod: 21, rsiPeriod: 14, atrPeriod: 14 })
      for (const c of candles) {
        const ts = new Date(c.date).getTime()
        ps.indicatorEngine.update(ts, c.close, c.volume)
      }
      ps.engineWarmed = true
      ps.lastWarmTs = now
    }
  } catch (err) {
    console.error('[niftyFut] warm indicators failed:', err instanceof Error ? err.message : err)
  }
}

// ── Depth Features ───────────────────────────────────────────────────────────

interface DepthFeatures {
  obi: number
  mpEdgeTicks: number
  depthAsymm: number
  qpoBalance: number
}

function computeDepthFeatures(depth: { buy: { price: number; quantity: number; orders: number }[]; sell: { price: number; quantity: number; orders: number }[] }): DepthFeatures {
  const bids = depth.buy.filter(l => l.quantity > 0)
  const asks = depth.sell.filter(l => l.quantity > 0)

  if (bids.length === 0 || asks.length === 0) {
    return { obi: 0, mpEdgeTicks: 0, depthAsymm: 0, qpoBalance: 0 }
  }

  const bidQty = bids.reduce((s, l) => s + l.quantity, 0)
  const askQty = asks.reduce((s, l) => s + l.quantity, 0)
  const totalQty = bidQty + askQty
  const obi = totalQty > 0 ? (bidQty - askQty) / totalQty : 0

  const bestBid = bids[0], bestAsk = asks[0]
  const mid = (bestBid.price + bestAsk.price) / 2
  const microPrice = (bestAsk.price * bestBid.quantity + bestBid.price * bestAsk.quantity)
    / (bestBid.quantity + bestAsk.quantity)
  const tickSize = bestAsk.price - bestBid.price || 1
  const mpEdgeTicks = (microPrice - mid) / tickSize

  const depthAsymm = totalQty > 0 ? (bidQty - askQty) / totalQty : 0

  const bidQpo = bestBid.orders > 0 ? bestBid.quantity / bestBid.orders : 0
  const askQpo = bestAsk.orders > 0 ? bestAsk.quantity / bestAsk.orders : 0
  const qpoSum = bidQpo + askQpo
  const qpoBalance = qpoSum > 0 ? (bidQpo - askQpo) / qpoSum : 0

  return { obi, mpEdgeTicks, depthAsymm, qpoBalance }
}

// ── Feature Vector (12-dim) ───────────────────────────────────────────────────

function buildFeatureVector(
  price: number,
  ind: IndicatorValues,
  tech: NiftyTechnicals,
  depth?: { buy: { price: number; quantity: number; orders: number }[]; sell: { price: number; quantity: number; orders: number }[] },
): number[] {
  const c = (v: number, scale = 1) =>
    Math.max(-1, Math.min(1, Number.isFinite(v) ? v * scale : 0))

  const df = depth ? computeDepthFeatures(depth) : { obi: 0, mpEdgeTicks: 0, depthAsymm: 0, qpoBalance: 0 }

  return [
    c(df.obi),
    c(df.mpEdgeTicks, 0.5),
    c(df.depthAsymm),
    c(df.qpoBalance),
    c(tech.momentum1m, 200),
    c(tech.momentum5m, 100),
    c(ind.rsi != null ? (ind.rsi - 50) / 50 : 0),
    c(tech.emaCrossover === 'BULL' ? 1 : tech.emaCrossover === 'BEAR' ? -1 : 0),
    c(tech.vwapAlign === 'BULL' ? 1 : tech.vwapAlign === 'BEAR' ? -1 : 0),
    c(tech.rangePosition * 2 - 1),
    c(ind.atrPct != null ? (ind.atrPct - 0.3) / 0.3 : 0),
    0,
  ]
}

// ── Meta-Regime Classifier ────────────────────────────────────────────────────

function _linSlope(ys: number[]): number {
  const n = ys.length
  if (n < 2) return 0
  const meanX = (n - 1) / 2
  const meanY = ys.reduce((a, b) => a + b, 0) / n
  let num = 0, den = 0
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (ys[i] - meanY)
    den += (i - meanX) ** 2
  }
  return den > 0 ? num / den : 0
}

export function computeNiftyMetaRegime(patterns: NiftyPattern[], n = 60): MetaRegimeData {
  const slice = patterns.slice(-n)
  if (slice.length < 5) return { regime: 'UNKNOWN', confidence: 0, avgCdZ: 0, avgObi: 0, divergenceScore: 0, momentumSlope: 0 }

  const cdZVals  = slice.map(p => p.vec[5] ?? 0)
  const obiVals  = slice.map(p => p.vec[0] ?? 0)
  const momVals  = slice.map(p => p.vec[4] ?? 0)

  const avgCdZ = cdZVals.reduce((a, b) => a + b, 0) / slice.length
  const avgObi = obiVals.reduce((a, b) => a + b, 0) / slice.length
  const momentumSlope = _linSlope(momVals)

  const cdZThresh = 0.15
  let divergenceCount = 0
  for (let i = 0; i < slice.length; i++) {
    const cdZ = cdZVals[i], obi = obiVals[i]
    if (Math.abs(cdZ) > cdZThresh && Math.sign(cdZ) !== Math.sign(obi)) divergenceCount++
  }
  const divergenceScore = divergenceCount / slice.length

  const resolved = slice.filter(p => p.outcome20 !== null)
  let bullBias = 0.5, bearBias = 0.5
  if (resolved.length > 0) {
    bullBias = resolved.filter(p => p.outcome20! > 0).length / resolved.length
    bearBias = 1 - bullBias
  }

  const cdBull = avgCdZ > 0.15
  const cdBear = avgCdZ < -0.15
  const obiBull = avgObi > 0.12
  const obiBear = avgObi < -0.12

  let regime: MetaRegimeData['regime']
  if (!cdBull && !cdBear) {
    regime = 'CHOP'
  } else if (cdBull) {
    regime = obiBull ? 'MARKUP' : 'ACCUMULATION'
  } else {
    regime = obiBear ? 'MARKDOWN' : 'DISTRIBUTION'
  }

  const confidence = Math.min(1, (Math.abs(avgCdZ) / 0.4) * Math.abs(bullBias - bearBias))

  return { regime, confidence, avgCdZ, avgObi, divergenceScore, momentumSlope }
}

// ── NSE Session classifier ────────────────────────────────────────────────────

export function getNSESession(istHour: number, istMinute: number): NSESession {
  const mins = istHour * 60 + istMinute
  if (mins < 12 * 60) return 'morning'
  if (mins < 14 * 60) return 'afternoon'
  return 'evening'
}

// ── Kalman filter (constant-velocity model) ───────────────────────────────────

function kalmanUpdate(ks: KalmanState, price: number, dtMinutes: number): void {
  if (!ks.initialised) {
    ks.x = [price, 0]
    ks.P = [[KALMAN_R, 0], [0, KALMAN_Q_VEL]]
    ks.initialised = true
    return
  }
  const dt = Math.max(0.016, Math.min(dtMinutes, 10))

  const xp0 = ks.x[0] + ks.x[1] * dt
  const xp1 = ks.x[1]
  const P00 = ks.P[0][0] + dt * (ks.P[0][1] + ks.P[1][0]) + dt * dt * ks.P[1][1] + KALMAN_Q_PRICE
  const P01 = ks.P[0][1] + dt * ks.P[1][1]
  const P10 = ks.P[1][0] + dt * ks.P[1][1]
  const P11 = ks.P[1][1] + KALMAN_Q_VEL

  const S = P00 + KALMAN_R
  const K0 = P00 / S
  const K1 = P10 / S
  const innov = price - xp0

  ks.x = [xp0 + K0 * innov, xp1 + K1 * innov]
  ks.P = [
    [P00 - K0 * P00, P01 - K0 * P01],
    [P10 - K1 * P00, P11 - K1 * P10],
  ]
}

// ── V2 feature vector (14-dim) ────────────────────────────────────────────────

function buildFeatureVectorV2(
  price:          number,
  ind:            IndicatorValues,
  tech:           NiftyTechnicals,
  istHour:        number,
  istMinute:      number,
  flowState:      NiftyFlowState | null,
  depth?:         { buy: { price: number; quantity: number; orders: number }[]; sell: { price: number; quantity: number; orders: number }[] },
  kalmanVelocity: number = 0,
): number[] {
  const c = (v: number, scale = 1) =>
    Math.max(-1, Math.min(1, Number.isFinite(v) ? v * scale : 0))

  let obi = 0, mpEdgeTicks = 0, spreadTicks = 0, qpoBalance = 0
  if (depth) {
    const bids = depth.buy.filter(l => l.quantity > 0)
    const asks = depth.sell.filter(l => l.quantity > 0)
    if (bids.length > 0 && asks.length > 0) {
      const bestBid = bids[0], bestAsk = asks[0]
      const bidQty = bids.reduce((s, l) => s + l.quantity, 0)
      const askQty = asks.reduce((s, l) => s + l.quantity, 0)
      const totalQty = bidQty + askQty
      obi = totalQty > 0 ? (bidQty - askQty) / totalQty : 0
      const mid = (bestBid.price + bestAsk.price) / 2
      const micro = (bestAsk.price * bestBid.quantity + bestBid.price * bestAsk.quantity) / (bestBid.quantity + bestAsk.quantity)
      const tickSz = Math.max(1, bestAsk.price - bestBid.price)
      mpEdgeTicks = (micro - mid) / tickSz
      spreadTicks = Math.min(1, (bestAsk.price - bestBid.price) / tickSz / 5) * 2 - 1
      const bidQpo = bestBid.orders > 0 ? bestBid.quantity / bestBid.orders : 0
      const askQpo = bestAsk.orders > 0 ? bestAsk.quantity / bestAsk.orders : 0
      const qpoSum = bidQpo + askQpo
      qpoBalance = qpoSum > 0 ? (bidQpo - askQpo) / qpoSum : 0
    }
  }

  // NSE session: 9:15 AM – 3:30 PM (375 min)
  const minsFromOpen = istHour * 60 + istMinute - NSE_OPEN_HOUR * 60 - NSE_OPEN_MIN
  const sessionDuration = (NSE_CLOSE_HOUR * 60 + NSE_CLOSE_MIN) - (NSE_OPEN_HOUR * 60 + NSE_OPEN_MIN)
  const timeOfDay = c(minsFromOpen / sessionDuration * 2 - 1)

  const cdZ       = flowState ? c(flowState.cdZScore, 0.33)  : c(tech.momentum5m, 100)
  const aggrRatio = flowState ? c(flowState.aggressionRatio) : c(tech.momentum1m, 200)
  const cusumNet  = flowState
    ? c((flowState.cusumPos - flowState.cusumNeg) / (CUSUM_H * 2))
    : 0

  return [
    c(cdZ),
    c(mpEdgeTicks, 0.5),
    c(spreadTicks),
    c(qpoBalance),
    c(tech.momentum1m, 200),
    c(tech.momentum5m, 100),
    c(ind.rsi != null ? (ind.rsi - 50) / 50 : 0),
    c(tech.emaCrossover === 'BULL' ? 1 : tech.emaCrossover === 'BEAR' ? -1 : 0),
    c(tech.vwapAlign === 'BULL' ? 1 : tech.vwapAlign === 'BEAR' ? -1 : 0),
    c(tech.rangePosition * 2 - 1),
    c(ind.atrPct != null ? (ind.atrPct - 0.3) / 0.3 : 0),
    timeOfDay,
    c(aggrRatio),
    c(cusumNet),
    c(kalmanVelocity / 20),                                           // 14: Kalman velocity (±₹20/min → ±1)
  ]
}

// ── V2 outcome resolution (with de-trended outcomes) ─────────────────────────

function resolveOutcomesV2(patterns: PatternV2[], snapshots: Snapshot[], kalmanVelocity: number) {
  const now = Date.now()
  for (const p of patterns) {
    if (p.outcome5 === null && now - p.ts >= OUTCOME_5_MS) {
      const snap = snapshots.find(s => s.ts >= p.ts + OUTCOME_5_MS)
      if (snap) {
        p.outcome5 = ((snap.price - p.price) / p.price) * 100
        p.detrended5 = p.outcome5 - kalmanVelocity / p.price * 5
      }
    }
    if (p.outcome15 === null && now - p.ts >= OUTCOME_15_MS) {
      const snap = snapshots.find(s => s.ts >= p.ts + OUTCOME_15_MS)
      if (snap) {
        p.outcome15 = ((snap.price - p.price) / p.price) * 100
        p.detrended15 = p.outcome15 - kalmanVelocity / p.price * 15
      }
    }
    if (p.outcome20 === null && now - p.ts >= OUTCOME_20_MS) {
      const snap = snapshots.find(s => s.ts >= p.ts + OUTCOME_20_MS)
      if (snap) {
        p.outcome20 = ((snap.price - p.price) / p.price) * 100
        p.detrended20 = p.outcome20 - kalmanVelocity / p.price * 20
      }
    }
  }
}

// ── V2 KNN query ──────────────────────────────────────────────────────────────

function queryAttentionV2(queryVec: number[], sessionPatterns: PatternV2[]): NiftyPrediction {
  const vecNorm = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  const resolved = sessionPatterns.filter(p => p.outcome20 !== null && p.outcome20 !== 0 && vecNorm(p.vec) > 0.1)
  if (resolved.length < MIN_PATTERNS_V2) {
    return {
      predictedMove: 0, bullProb: 0.5, bearProb: 0.5,
      topSim: 0, confidence: 0, nResolved: resolved.length,
      direction: null, status: resolved.length === 0 ? 'no_data' : 'warming',
      h5: null, h15: null, h20: null,
    }
  }

  const sims = resolved.map(p => cosineSim(queryVec, p.vec))
  const indexed = sims.map((sim, i) => ({ sim, i })).sort((a, b) => b.sim - a.sim)
  const topK = indexed.slice(0, Math.min(KNN_K, resolved.length))
  const maxSim = topK[0].sim
  const expScores = topK.map(t => Math.exp((t.sim - maxSim) / TEMPERATURE))
  const sumExp = expScores.reduce((a, b) => a + b, 0)
  const weights = expScores.map(e => e / sumExp)

  function queryHorizonV2(
    horizon: 'outcome5' | 'outcome15' | 'outcome20',
    detrendedKey: 'detrended5' | 'detrended15' | 'detrended20',
  ): { predictedMove: number; bullProb: number; bearProb: number } {
    let predictedMove = 0, bullW = 0, bearW = 0, totalW = 0
    for (let i = 0; i < topK.length; i++) {
      const pat = resolved[topK[i].i]
      const outcome = pat[detrendedKey] ?? pat[horizon]
      if (outcome === null) continue
      predictedMove += weights[i] * outcome
      totalW += weights[i]
      if (outcome > 0) bullW += weights[i]
      else if (outcome < 0) bearW += weights[i]
    }
    if (totalW > 0) predictedMove /= totalW
    const total = bullW + bearW
    return { predictedMove, bullProb: total > 0 ? bullW / total : 0.5, bearProb: total > 0 ? bearW / total : 0.5 }
  }

  const h5  = queryHorizonV2('outcome5',  'detrended5')
  const h15 = queryHorizonV2('outcome15', 'detrended15')
  const h20 = queryHorizonV2('outcome20', 'detrended20')

  return {
    predictedMove: h20.predictedMove, bullProb: h20.bullProb, bearProb: h20.bearProb,
    topSim: topK[0].sim, confidence: weights[0], nResolved: resolved.length,
    direction: h20.bullProb >= 0.55 ? 'BULL' : h20.bearProb >= 0.55 ? 'BEAR' : null,
    status: 'ready', h5, h15, h20,
  }
}

// ── V2 persistence ────────────────────────────────────────────────────────────

function ensurePatternsV2Loaded(ps: ProductState) {
  if (ps.patternsV2Loaded) return
  ps.patternsV2Loaded = true
  for (const key of ['morning', 'afternoon', 'evening'] as NSESession[]) {
    try {
      const raw = fs.readFileSync(patternsV2File(key), 'utf8')
      const saved = JSON.parse(raw) as { patterns?: PatternV2[] }
      if (Array.isArray(saved.patterns)) {
        ps.patternsV2[key] = saved.patterns
          .filter(p => Array.isArray(p.vec) && p.vec.length === VEC_DIM_V2)
          .slice(-MAX_PATTERNS_V2)
      }
    } catch { /* no file yet */ }
  }
}

function persistPatternsV2(ps: ProductState) {
  for (const key of ['morning', 'afternoon', 'evening'] as NSESession[]) {
    try {
      fs.writeFileSync(patternsV2File(key), JSON.stringify({
        patterns: ps.patternsV2[key].slice(-MAX_PATTERNS_V2),
        savedAt: Date.now(),
      }))
    } catch { /* ignore */ }
  }
  ps.patternsV2LastPersistTs = Date.now()
}

// ── Cosine Similarity ─────────────────────────────────────────────────────────

function cosineSim(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]
    magA += a[i] * a[i]
    magB += b[i] * b[i]
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB)
  return denom > 1e-10 ? dot / denom : 0
}

// ── KNN Query ────────────────────────────────────────────────────────────────

interface HorizonResult {
  predictedMove: number
  bullProb: number
  bearProb: number
}

function queryHorizon(
  weights: number[],
  topK: { sim: number; i: number }[],
  resolved: NiftyPattern[],
  horizon: 'outcome5' | 'outcome15' | 'outcome20',
): HorizonResult {
  let predictedMove = 0, bullWeight = 0, bearWeight = 0, totalW = 0
  for (let i = 0; i < topK.length; i++) {
    const outcome = resolved[topK[i].i][horizon]
    if (outcome === null) continue
    predictedMove += weights[i] * outcome
    totalW += weights[i]
    if (outcome > 0) bullWeight += weights[i]
    else if (outcome < 0) bearWeight += weights[i]
  }
  if (totalW > 0) predictedMove /= totalW
  const total = bullWeight + bearWeight
  return {
    predictedMove,
    bullProb: total > 0 ? bullWeight / total : 0.5,
    bearProb: total > 0 ? bearWeight / total : 0.5,
  }
}

function queryAttention(queryVec: number[], store: NiftyStore): NiftyPrediction {
  const resolved = store.patterns.filter(p => p.outcome20 !== null && p.outcome20 !== 0 && Math.sqrt(p.vec.reduce((s: number, x: number) => s + x * x, 0)) > 0.1)

  if (resolved.length < MIN_PATTERNS) {
    return {
      predictedMove: 0, bullProb: 0.5, bearProb: 0.5,
      topSim: 0, confidence: 0, nResolved: resolved.length,
      direction: null, status: resolved.length === 0 ? 'no_data' : 'warming',
      h5: null, h15: null, h20: null,
    }
  }

  const sims = resolved.map(p => cosineSim(queryVec, p.vec))
  const indexed = sims.map((sim, i) => ({ sim, i }))
  indexed.sort((a, b) => b.sim - a.sim)
  const topK = indexed.slice(0, Math.min(KNN_K, resolved.length))

  const maxSim = topK[0].sim
  const expScores = topK.map(t => Math.exp((t.sim - maxSim) / TEMPERATURE))
  const sumExp = expScores.reduce((a, b) => a + b, 0)
  const weights = expScores.map(e => e / sumExp)

  const h5  = queryHorizon(weights, topK, resolved, 'outcome5')
  const h15 = queryHorizon(weights, topK, resolved, 'outcome15')
  const h20 = queryHorizon(weights, topK, resolved, 'outcome20')

  return {
    predictedMove: h20.predictedMove, bullProb: h20.bullProb, bearProb: h20.bearProb,
    topSim: topK[0].sim, confidence: weights[0], nResolved: resolved.length,
    direction: h20.bullProb >= 0.55 ? 'BULL' : h20.bearProb >= 0.55 ? 'BEAR' : null,
    status: 'ready',
    h5, h15, h20,
  }
}

// ── Outcome Resolution ────────────────────────────────────────────────────────

function resolveOutcomes(store: NiftyStore) {
  const now = Date.now()
  for (const pattern of store.patterns) {
    if (pattern.sessionDay !== store.sessionDay) continue

    if (pattern.outcome5 === null && now - pattern.ts >= OUTCOME_5_MS) {
      const snap = store.snapshots.find(s => s.ts >= pattern.ts + OUTCOME_5_MS)
      if (snap) pattern.outcome5 = ((snap.price - pattern.price) / pattern.price) * 100
    }

    if (pattern.outcome15 === null && now - pattern.ts >= OUTCOME_15_MS) {
      const snap = store.snapshots.find(s => s.ts >= pattern.ts + OUTCOME_15_MS)
      if (snap) pattern.outcome15 = ((snap.price - pattern.price) / pattern.price) * 100
    }

    if (pattern.outcome20 === null && now - pattern.ts >= OUTCOME_20_MS) {
      const snap = store.snapshots.find(s => s.ts >= pattern.ts + OUTCOME_20_MS)
      if (snap) pattern.outcome20 = ((snap.price - pattern.price) / pattern.price) * 100
    }
  }
}

// ── Composite Blending ────────────────────────────────────────────────────────

function computeComposite(prediction: NiftyPrediction, tech: NiftyTechnicals): NiftyComposite {
  const votes: { score: number; weight: number }[] = []

  if (tech.vwapAlign) {
    votes.push({ score: tech.vwapAlign === 'BULL' ? 1 : 0, weight: 1.2 })
  }

  if (tech.emaCrossover) {
    votes.push({ score: tech.emaCrossover === 'BULL' ? 1 : 0, weight: 1.0 })
  }

  if (tech.rsi != null) {
    votes.push({ score: Math.max(0, Math.min(1, (tech.rsi - 30) / 40)), weight: 0.8 })
  }

  if (Math.abs(tech.momentum5m) > 0.0005) {
    votes.push({ score: tech.momentum5m > 0 ? 1 : 0, weight: 1.0 })
  }

  if (tech.sessionHigh > tech.sessionLow) {
    votes.push({ score: tech.rangePosition, weight: 0.6 })
  }

  if (Math.abs(tech.momentum1m) > 0.0002) {
    votes.push({ score: tech.momentum1m > 0 ? 1 : 0, weight: 0.5 })
  }

  let techBullScore = 0.5
  if (votes.length > 0) {
    const totalW = votes.reduce((s, v) => s + v.weight, 0)
    techBullScore = votes.reduce((s, v) => s + v.score * v.weight, 0) / totalW
  }

  const patternReady = prediction.status === 'ready' && prediction.nResolved >= MIN_PATTERNS
  const patternWeight = patternReady ? 0.5 + 0.2 * Math.min(1, prediction.confidence / 0.3) : 0
  const techWeight = votes.length >= 3 ? 1 - patternWeight : 0
  const totalWeight = patternWeight + techWeight

  if (totalWeight === 0) {
    return {
      predictedMove: 0, bullProb: 0.5, bearProb: 0.5,
      direction: null, confidence: 0, status: 'no_data',
      components: { patternWeight: 0, techWeight: 0, patternBullProb: 0.5, techBullScore: 0.5 },
    }
  }

  const blendedBull = (patternWeight * prediction.bullProb + techWeight * techBullScore) / totalWeight
  const blendedBear = 1 - blendedBull

  const patMove = patternReady ? prediction.predictedMove : 0
  const techDeviation = (techBullScore - 0.5) * 2
  const techImpliedMove = techDeviation * TYPICAL_MOVE
  const blendedMove = (patternWeight * patMove + techWeight * techImpliedMove) / totalWeight

  let horizonBonus = 0
  if (patternReady && prediction.h5 && prediction.h15 && prediction.h20) {
    const s5 = Math.sign(prediction.h5.predictedMove)
    const s15 = Math.sign(prediction.h15.predictedMove)
    const s20 = Math.sign(prediction.h20.predictedMove)
    if (s5 === s15 && s15 === s20 && s20 !== 0) horizonBonus = 0.15
  }

  const conf = patternReady
    ? prediction.confidence * (0.7 + 0.3 * Math.abs(techBullScore - 0.5) * 2) + horizonBonus
    : Math.abs(techBullScore - 0.5) * 2

  return {
    predictedMove: blendedMove,
    bullProb: blendedBull,
    bearProb: blendedBear,
    direction: blendedBull >= 0.55 ? 'BULL' : blendedBear >= 0.55 ? 'BEAR' : null,
    confidence: Math.min(1, conf),
    status: patternReady || votes.length >= 3 ? 'ready' : votes.length > 0 ? 'warming' : 'no_data',
    components: {
      patternWeight: totalWeight > 0 ? patternWeight / totalWeight : 0,
      techWeight: totalWeight > 0 ? techWeight / totalWeight : 0,
      patternBullProb: prediction.bullProb,
      techBullScore,
    },
  }
}

// ── P20C Swing persistence ────────────────────────────────────────────────────

function ensureP20CSwingLoaded(ps: ProductState) {
  if (ps.p20cSwingLoaded) return
  ps.p20cSwingLoaded = true
  try {
    const raw = fs.readFileSync(p20cSwingFile(), 'utf8')
    const saved = JSON.parse(raw) as { entries?: P20CSwingEntry[] }
    if (Array.isArray(saved.entries)) {
      ps.p20cSwingStore.entries = saved.entries.slice(-MAX_P20C_SWINGS)
      ps.p20cSwingStore.nextId = saved.entries.reduce((m, e) => Math.max(m, (e.id ?? 0) + 1), 1)
    }
  } catch {}
}

function persistP20CSwing(ps: ProductState) {
  try {
    fs.writeFileSync(p20cSwingFile(), JSON.stringify({ entries: ps.p20cSwingStore.entries }, null, 2))
  } catch {}
}

// ── P20C Swing update ─────────────────────────────────────────────────────────

async function updateP20CSysLog(
  ps: ProductState,
  pat20Con: Pat20Con | null,
  composite: NiftyComposite,
  spot: number,
  chain: NiftyFutChain | null
): Promise<P20CSwingEntry[]> {
  ensureP20CSwingLoaded(ps)
  const now = Date.now()
  const ist = getISTHourMin(now)
  const mins = ist.hour * 60 + ist.minute
  const inWindow = mins >= NSE_OPEN_HOUR * 60 + NSE_OPEN_MIN && mins <= NSE_CLOSE_HOUR * 60 + NSE_CLOSE_MIN
  const fmtTime = `${String(ist.hour).padStart(2, '0')}:${String(ist.minute).padStart(2, '0')}`
  const currentDay = new Date(now + 5.5 * 3600_000).toISOString().slice(0, 10)
  const lotSize = 65

  const currentDir = pat20Con?.direction ?? null
  const scaled = pat20Con ? (pat20Con.effective - 0.5) * 2 : 0

  const openSwing = ps.p20cSwingStore.entries.findLast(e => !e.resolved) ?? null
  let changed = false

  if (openSwing && currentDir !== openSwing.direction) {
    const spotDiff = spot - openSwing.spotAtStart
    const outcomeMove = openSwing.spotAtStart > 0 ? (spotDiff / openSwing.spotAtStart) * 100 : 0
    const correct = openSwing.direction === 'BULL' ? spotDiff > 0 : spotDiff < 0

    let optExit: number | null = null
    if (openSwing.optSymbol) {
      try {
        const ltpData = await kiteGetLTP([`NFO:${openSwing.optSymbol}`])
        const ltp = ltpData[`NFO:${openSwing.optSymbol}`]?.last_price ?? 0
        if (ltp > 0) optExit = ltp
      } catch {}
    }

    let pnlGross: number | null = null
    let pnlNet: number | null = null
    if (openSwing.optEntry != null && optExit != null) {
      // NSE option fees: brokerage ₹40 + STT 0.05% sell + GST 18%
      const buyT  = openSwing.optEntry * lotSize
      const sellT = optExit * lotSize
      const brokerage = 40
      const stt = sellT * 0.0005
      const gst = brokerage * 0.18
      const fees = brokerage + stt + gst
      pnlGross = (optExit - openSwing.optEntry) * lotSize
      pnlNet = pnlGross - fees
    }

    openSwing.resolved   = true
    openSwing.endTs      = now
    openSwing.endTime    = fmtTime
    openSwing.scaledAtEnd = scaled
    openSwing.spotAtEnd  = spot
    openSwing.durationMin = Math.round((now - openSwing.startTs) / 60_000)
    openSwing.outcomeMove = outcomeMove
    openSwing.correct    = correct
    openSwing.optExit    = optExit
    openSwing.pnlGross   = pnlGross
    openSwing.pnlNet     = pnlNet
    changed = true
  }

  const oracleAligned = composite.direction === currentDir
    && Math.abs(composite.predictedMove) >= 0.06
    && composite.confidence >= 0.25
  const stillOpen = ps.p20cSwingStore.entries.findLast(e => !e.resolved)
  if (inWindow && currentDir && !stillOpen && spot > 0 && oracleAligned) {
    let optEntry: number | null = null
    let optStrike: number | null = null
    let optType: 'CE' | 'PE' | null = null
    let optSymbol: string | null = null

    if (chain) {
      const optList = currentDir === 'BULL' ? chain.calls : chain.puts
      const atmOpt  = optList.find(o => o.strike === chain.atmStrike)
      if (atmOpt) {
        try {
          const ltpData = await kiteGetLTP([`NFO:${atmOpt.tradingsymbol}`])
          const ltp = ltpData[`NFO:${atmOpt.tradingsymbol}`]?.last_price ?? 0
          if (ltp > 0) {
            optEntry  = ltp
            optStrike = chain.atmStrike
            optType   = currentDir === 'BULL' ? 'CE' : 'PE'
            optSymbol = atmOpt.tradingsymbol
          }
        } catch {}
      }
    }

    ps.p20cSwingStore.entries.push({
      id: ps.p20cSwingStore.nextId++,
      startTs: now, startTime: fmtTime,
      direction: currentDir,
      scaledAtStart: scaled,
      spotAtStart: spot,
      sessionDay: currentDay,
      optStrike, optType, optSymbol, optEntry,
      resolved: false,
      endTs: null, endTime: null, scaledAtEnd: null, spotAtEnd: null,
      durationMin: null, outcomeMove: null, correct: null,
      optExit: null, pnlGross: null, pnlNet: null,
    })
    if (ps.p20cSwingStore.entries.length > MAX_P20C_SWINGS)
      ps.p20cSwingStore.entries = ps.p20cSwingStore.entries.slice(-MAX_P20C_SWINGS)
    changed = true
  }

  if (changed) persistP20CSwing(ps)
  return ps.p20cSwingStore.entries.slice(-30)
}

// ── SysLog ────────────────────────────────────────────────────────────────────

interface OptInfo { strike: number; type: 'CE' | 'PE'; symbol: string; entryLtp: number }

async function updateSysLog(ps: ProductState, composite: NiftyComposite, spot: number, chain: NiftyFutChain | null): Promise<NiftySysLogEntry[]> {
  ensureSysLogLoaded(ps)
  const sysLogStore = ps.sysLogStore
  const now = Date.now()
  const ist = getISTHourMin(now)
  const mins = ist.hour * 60 + ist.minute
  const inWindow = mins >= NSE_OPEN_HOUR * 60 + NSE_OPEN_MIN && mins <= NSE_CLOSE_HOUR * 60 + NSE_CLOSE_MIN

  const dirProb = Math.max(composite.bullProb, composite.bearProb)
  const hasConviction = composite.confidence >= 0.20 || dirProb >= 0.65 || Math.abs(composite.predictedMove) >= 0.08

  let changed = false
  let entryToExtend: NiftySysLogEntry | null = null

  for (const entry of sysLogStore.entries) {
    if (entry.resolved) continue
    const spotDiff = spot - entry.spotAtPred
    const currentMove = entry.spotAtPred > 0 ? (spotDiff / entry.spotAtPred) * 100 : 0
    const moveDir = entry.predMove > 0 ? 'BULL' : entry.predMove < 0 ? 'BEAR' : null

    if (spot > 0) { entry.liveMove = currentMove; entry.liveSpot = spot; changed = true }
    if (!entry.targetHit && spot > 0 && moveDir) {
      const prev = entry.peakMove ?? 0
      if (moveDir === 'BULL' && currentMove > prev) { entry.peakMove = currentMove; changed = true }
      else if (moveDir === 'BEAR' && currentMove < prev) { entry.peakMove = currentMove; changed = true }

      if (moveDir === 'BULL' && currentMove >= entry.predMove) {
        entry.targetHit = true; entry.targetHitTs = now; changed = true
      } else if (moveDir === 'BEAR' && currentMove <= entry.predMove) {
        entry.targetHit = true; entry.targetHitTs = now; changed = true
      }
    }

    const timeUp = now - entry.cycleTs >= SYSLOG_CYCLE_MS
    if (!timeUp && !entry.targetHit) continue

    const extDir = composite.direction ?? (composite.predictedMove > 0 ? 'BULL' : composite.predictedMove < 0 ? 'BEAR' : null)
    if (entry.targetHit && !timeUp && extDir === entry.predDir && composite.status === 'ready' && spot > 0) {
      entryToExtend = entry
      continue
    }

    entry.outcomeMove = currentMove
    entry.outcomeDir = spotDiff > 0 ? 'BULL' : spotDiff < 0 ? 'BEAR' : null
    entry.spotAtOutcome = spot
    entry.resolved = true

    if (!entry.targetHit && entry.extends && entry.extends.length > 0) {
      const originalSpot = entry.extends[0].spotAtExtend
      const overallMove = originalSpot > 0 ? (spot - originalSpot) / originalSpot * 100 : 0
      const overallInDir = entry.predDir === 'BULL' ? overallMove > 0 : entry.predDir === 'BEAR' ? overallMove < 0 : false
      if (overallInDir) entry.targetHit = true
    }

    const effectiveDir = entry.predDir ?? moveDir
    entry.correct = effectiveDir !== null && (entry.targetHit === true || effectiveDir === entry.outcomeDir)
    changed = true
  }

  if (entryToExtend) {
    const e = entryToExtend
    const fmtCycle = `${String(ist.hour).padStart(2, '0')}:${String(ist.minute).padStart(2, '0')}`

    if (!e.extends) e.extends = []
    if (e.extends.length === 0 && e.originalOptEntry == null) {
      e.originalOptEntry = e.optEntry ?? null
    }
    e.extends.push({
      ts: now,
      cycleTime: fmtCycle,
      spotAtExtend: e.spotAtPred,
      prevPredMove: e.predMove,
    })
    e.repeatCount = (e.repeatCount ?? 1) + 1

    let newOptEntry: number | null = null
    let newOptTarget: number | null = null
    const extDir = composite.direction ?? (composite.predictedMove > 0 ? 'BULL' : 'BEAR')
    if (chain) {
      const atm = chain.atmStrike
      const optList = extDir === 'BULL' ? chain.calls : chain.puts
      const atmOpt = optList.find(o => o.strike === atm)
      if (atmOpt) {
        try {
          const ltpKey = `NFO:${atmOpt.tradingsymbol}`
          const ltpData = await kiteGetLTP([ltpKey])
          const ltp = ltpData[ltpKey]?.last_price ?? 0
          if (ltp > 0) {
            newOptEntry = ltp
            newOptTarget = ltp + Math.abs(composite.predictedMove / 100) * spot * 0.45
            e.optStrike = atm
            e.optType = extDir === 'BULL' ? 'CE' : 'PE'
            e.optSymbol = atmOpt.tradingsymbol
          }
        } catch { /* skip */ }
      }
    }

    e.spotAtPred = spot
    e.predMove = composite.predictedMove
    e.predSpot = spot * (1 + composite.predictedMove / 100)
    e.predConf = composite.confidence
    e.predBullProb = composite.bullProb
    e.predBearProb = composite.bearProb
    e.peakMove = null
    e.liveMove = 0
    e.liveSpot = spot
    e.targetHit = false
    e.targetHitTs = null
    e.cycleTs = now
    e.optEntry = newOptEntry
    e.optTarget = newOptTarget
    sysLogStore.lastCycleTs = now
    changed = true
  }

  if (changed) {
    persistSysLog(ps)
    if (!entryToExtend) {
      const lastEntry = sysLogStore.entries[sysLogStore.entries.length - 1]
      if (lastEntry?.resolved && lastEntry.targetHit && now - lastEntry.cycleTs < SYSLOG_CYCLE_MS) {
        sysLogStore.lastCycleTs = 0
      }
    }
  }

  if (inWindow && now - sysLogStore.lastCycleTs >= SYSLOG_CYCLE_MS && composite.status === 'ready' && spot > 0 && hasConviction) {
    const currentDay = new Date(now + 5.5 * 3600_000).toISOString().slice(0, 10)

    sysLogStore.lastCycleTs = now

    let optInfo: OptInfo | null = null
    const optDir = composite.direction ?? (composite.predictedMove > 0 ? 'BULL' : composite.predictedMove < 0 ? 'BEAR' : null)
    if (chain && optDir) {
      const atm = chain.atmStrike
      const optList = optDir === 'BULL' ? chain.calls : chain.puts
      const atmOpt = optList.find(o => o.strike === atm)
      if (atmOpt) {
        try {
          const ltpKey = `NFO:${atmOpt.tradingsymbol}`
          const ltpData = await kiteGetLTP([ltpKey])
          const entryLtp = ltpData[ltpKey]?.last_price ?? 0
          if (entryLtp > 0) {
            optInfo = { strike: atm, type: optDir === 'BULL' ? 'CE' : 'PE', symbol: atmOpt.tradingsymbol, entryLtp }
          }
        } catch { /* option LTP unavailable */ }
      }
    }

    const optTarget = optInfo
      ? optInfo.entryLtp + Math.abs(composite.predictedMove / 100) * spot * 0.45
      : null

    sysLogStore.entries.push({
      cycleTs: now,
      cycleTime: `${String(ist.hour).padStart(2, '0')}:${String(ist.minute).padStart(2, '0')}`,
      predMove: composite.predictedMove,
      predDir: composite.direction ?? (composite.predictedMove > 0 ? 'BULL' : composite.predictedMove < 0 ? 'BEAR' : null),
      predConf: composite.confidence,
      predBullProb: composite.bullProb,
      predBearProb: composite.bearProb,
      spotAtPred: spot,
      predSpot: spot * (1 + composite.predictedMove / 100),
      outcomeMove: null,
      outcomeDir: null,
      spotAtOutcome: null,
      resolved: false,
      correct: null,
      sessionDay: currentDay,
      peakMove: null,
      targetHit: false,
      targetHitTs: null,
      optStrike: optInfo?.strike ?? null,
      optType: optInfo?.type ?? null,
      optSymbol: optInfo?.symbol ?? null,
      optEntry: optInfo?.entryLtp ?? null,
      optTarget,
      originalOptEntry: optInfo?.entryLtp ?? null,
    })
    if (sysLogStore.entries.length > MAX_SYSLOG) {
      sysLogStore.entries = sysLogStore.entries.slice(-MAX_SYSLOG)
    }
    persistSysLog(ps)
  }

  return sysLogStore.entries.slice(-30)
}

// ── State file reader ─────────────────────────────────────────────────────────

const NIFTY_FUT_STATE_FILE = path.join('/workspace/option-trader', 'nifty-fut-state.json')

function readNiftyFutTick(): {
  ltp: number; depth: any; volume: number; oi: number; cumDelta: number;
  cdZScore: number; aggressionRatio: number; cusumPos: number; cusumNeg: number;
  symbol: string; token: number
} | null {
  try {
    const raw = fs.readFileSync(NIFTY_FUT_STATE_FILE, 'utf8')
    const data = JSON.parse(raw)
    if (Date.now() - data.updatedAt > 120_000) return null  // stale > 2min
    return data
  } catch { return null }
}

// ── Main Entry Point ──────────────────────────────────────────────────────────

export async function getNiftyFutState(): Promise<NiftyFutState> {
  startBackgroundAccumulator()
  const ps = getNiftyProductState()
  const store = ps.store
  ensureLoaded(ps)
  ensureP20CBufLoaded(ps)

  const now = Date.now()
  const ist = getISTHourMin(now)
  const mins = ist.hour * 60 + ist.minute
  const marketOpen = mins >= NSE_OPEN_HOUR * 60 + NSE_OPEN_MIN && mins <= NSE_CLOSE_HOUR * 60 + NSE_CLOSE_MIN
  const currentDay = new Date(now + 5.5 * 3600_000).toISOString().slice(0, 10)

  // Read tick-by-tick data from bot's WebSocket feed (nifty-fut-state.json)
  let spot = 0
  let depth: NiftyFutState['depth'] | undefined
  let volume = 0
  let oi = 0
  let flowState: NiftyFlowState | null = null
  let futureSymbol = ''
  let futureToken = ps.instrumentToken

  const tick = readNiftyFutTick()
  if (tick && tick.ltp > 0) {
    spot = tick.ltp
    depth = tick.depth
    volume = tick.volume ?? 0
    oi = tick.oi ?? 0
    futureSymbol = tick.symbol ?? ''
    if (tick.token > 0) {
      ps.instrumentToken = tick.token
      futureToken = tick.token
    }
    if (typeof tick.cumDelta === 'number') {
      const alarm = tick.cusumPos >= CUSUM_H ? 'BULL'
        : tick.cusumNeg >= CUSUM_H ? 'BEAR' : null
      flowState = {
        cumDelta:        tick.cumDelta ?? 0,
        cdZScore:        tick.cdZScore ?? 0,
        aggressionRatio: tick.aggressionRatio ?? 0,
        cusumPos:        tick.cusumPos ?? 0,
        cusumNeg:        tick.cusumNeg ?? 0,
        cusumAlarm:      alarm,
      }
      ps.lastFlowState = flowState
      ps.lastFlowStateAt = Date.now()
    }
  }

  // Serve last-known flowState for up to 5 min when file is temporarily stale
  if (!flowState && ps.lastFlowState && Date.now() - ps.lastFlowStateAt < 5 * 60_000) {
    flowState = ps.lastFlowState
  }

  // Fallback: Kite REST API (when bot isn't running) — need symbol from instruments CSV
  if (spot <= 0) {
    try {
      // Try to get NIFTY futures from instruments if we have a token
      if (futureToken > 0) {
        const quoteKey = `NFO:${futureSymbol || 'NIFTY26JUNFUT'}`
        try {
          const quote = await kiteGetQuote([quoteKey])
          const q = quote[quoteKey]
          if (q) {
            spot = q.last_price
            depth = q.depth
            volume = q.volume ?? 0
            oi = q.oi ?? 0
          }
        } catch {
          const ltpData = await kiteGetLTP([`NFO:${futureSymbol || 'NIFTY26JUNFUT'}`])
          spot = ltpData[`NFO:${futureSymbol || 'NIFTY26JUNFUT'}`]?.last_price ?? 0
        }
      }
    } catch { /* both failed */ }
  }

  if (spot <= 0) return emptyState(marketOpen)

  // Warm indicators from historical data
  if ((!ps.engineWarmed || now - ps.lastWarmTs > 300_000) && futureToken > 0) {
    if (!ps.warmingPromise) {
      ps.warmingPromise = warmIndicators(ps, futureToken).finally(() => { ps.warmingPromise = null })
    }
    if (!ps.engineWarmed) {
      await ps.warmingPromise
    }
  }

  // Session management
  if (store.sessionDay !== currentDay) {
    // Drop stale unresolved patterns (zeroing poisons kNN with false flat outcomes)
    store.patterns = store.patterns.filter(
      p => p.sessionDay === currentDay || p.outcome20 !== null
    )
    for (const key of ['morning', 'afternoon', 'evening'] as NSESession[]) {
      ps.patternsV2[key] = ps.patternsV2[key].filter(
        p => p.sessionDay === currentDay || p.outcome20 !== null
      )
    }
    ps.kalman = { x: [0, 0], P: [[100, 0], [0, 1]], initialised: false }
    ps.kalmanLastTs = 0
    store.sessionDay = currentDay
    store.sessionOpen = spot
    store.sessionHigh = spot
    store.sessionLow = spot
    store.snapshots = []
    store.priceHistory = []
    ps.indicatorEngine.resetSession()
    persist(ps)
  }
  if (store.sessionOpen <= 0) store.sessionOpen = spot

  if (spot > store.sessionHigh) store.sessionHigh = spot
  if (spot < store.sessionLow || store.sessionLow === 0) store.sessionLow = spot

  const ind = ps.indicatorEngine.update(now, spot, volume)

  store.priceHistory.push({ ts: now, price: spot })
  const cutoff = now - 10 * 60_000
  store.priceHistory = store.priceHistory.filter(p => p.ts >= cutoff)

  const price1mAgo = store.priceHistory.findLast(p => p.ts <= now - 60_000)?.price ?? spot
  const price5mAgo = store.priceHistory.findLast(p => p.ts <= now - 5 * 60_000)?.price ?? spot
  const momentum1m = price1mAgo > 0 ? (spot - price1mAgo) / price1mAgo : 0
  const momentum5m = price5mAgo > 0 ? (spot - price5mAgo) / price5mAgo : 0

  const sessionHigh = store.sessionHigh
  const sessionLow = store.sessionLow
  const rangePosition = sessionHigh > sessionLow ? (spot - sessionLow) / (sessionHigh - sessionLow) : 0.5

  const technicals: NiftyTechnicals = {
    rsi: ind.rsi,
    emaShort: ind.emaShort,
    emaLong: ind.emaLong,
    emaCrossover: ind.emaShort != null && ind.emaLong != null
      ? ind.emaShort > ind.emaLong ? 'BULL' : ind.emaShort < ind.emaLong ? 'BEAR' : null
      : null,
    vwap: ind.vwap,
    vwapAlign: ind.vwap != null ? (spot > ind.vwap ? 'BULL' : spot < ind.vwap ? 'BEAR' : null) : null,
    atr: ind.atr,
    atrPct: ind.atrPct,
    momentum1m, momentum5m,
    sessionHigh, sessionLow, rangePosition,
    volume, oi,
  }

  const proxy = store.sessionOpen > 0 ? ((spot - store.sessionOpen) / store.sessionOpen) * 100 : 0
  const vec = buildFeatureVector(spot, ind, technicals, depth)

  if (marketOpen && now - store.lastSnapshotTs >= SNAPSHOT_INTERVAL_MS) {
    store.snapshots.push({ ts: now, vec, price: spot, proxy })
    if (store.snapshots.length > MAX_SNAPSHOTS) store.snapshots = store.snapshots.slice(-MAX_SNAPSHOTS)
    store.lastSnapshotTs = now

    store.patterns.push({ ts: now, vec, price: spot, proxy, outcome5: null, outcome15: null, outcome20: null, sessionDay: currentDay })
    if (store.patterns.length > MAX_PATTERNS) store.patterns = store.patterns.slice(-MAX_PATTERNS)
  }

  resolveOutcomes(store)

  // ── V2 Kalman + feature vector + session patterns ──────────────────────────
  ensurePatternsV2Loaded(ps)
  const istHM = getISTHourMin(now)
  const sessionKey = getNSESession(istHM.hour, istHM.minute)
  const dtMinutes = ps.kalmanLastTs > 0 ? (now - ps.kalmanLastTs) / 60_000 : 1
  kalmanUpdate(ps.kalman, spot, dtMinutes)
  ps.kalmanLastTs = now
  const kalmanVelocity = ps.kalman.x[1]

  const vecV2 = buildFeatureVectorV2(spot, ind, technicals, istHM.hour, istHM.minute, flowState, depth, kalmanVelocity)

  if (marketOpen && now - ps.lastV2SnapshotTs >= SNAPSHOT_INTERVAL_MS) {
    ps.lastV2SnapshotTs = now
    const buf = ps.patternsV2[sessionKey]
    buf.push({ ts: now, vec: vecV2, price: spot, sessionKey, sessionDay: currentDay,
      outcome5: null, outcome15: null, outcome20: null,
      detrended5: null, detrended15: null, detrended20: null })
    if (buf.length > MAX_PATTERNS_V2) ps.patternsV2[sessionKey] = buf.slice(-MAX_PATTERNS_V2)
  }

  resolveOutcomesV2(ps.patternsV2[sessionKey], store.snapshots, kalmanVelocity)

  const predV2 = queryAttentionV2(vecV2, ps.patternsV2[sessionKey])

  if (now - ps.patternsV2LastPersistTs >= V2_PERSIST_INTERVAL_MS) {
    persistPatternsV2(ps)
  }

  const v2: NiftyV2 = {
    prediction:          predV2,
    sessionKey,
    sessionPatternCount: ps.patternsV2[sessionKey].filter(p => p.outcome20 !== null).length,
    flowState,
    featureVec:          vecV2,
    kalmanVelocity,
  }

  const prediction = queryAttention(vec, store)

  if (prediction.nResolved >= 3 && now - ps.p20cLastTs >= P20C_SAMPLE_MS) {
    ps.p20cBuf.push({ ts: now, bullProb: prediction.h20?.bullProb ?? prediction.bullProb })
    if (ps.p20cBuf.length > P20C_BUF_MAX) ps.p20cBuf = ps.p20cBuf.slice(-P20C_BUF_MAX)
    ps.p20cLastTs = now
    if (now - ps.p20cBufLastPersistTs >= PERSIST_INTERVAL_MS) {
      persistP20CBuf(ps)
    }
  }
  const pat20Con = computePat20Con(ps.p20cBuf, now)

  if (now - store.lastPersistTs >= PERSIST_INTERVAL_MS) {
    persist(ps)
  }

  const composite = computeComposite(prediction, technicals)

  // Build NIFTY chain from OI analytics
  const niftyContracts = spot > 0 ? getNiftyContracts(spot) : null
  let chain: NiftyFutChain | null = null
  const cachedOI = getCachedNiftyOI()

  if (cachedOI && spot > 0) {
    const expiry = niftyContracts?.expiry ?? ''
    chain = {
      calls: cachedOI.strikes.map(s => ({
        tradingsymbol: s.ceSymbol,
        strike: s.strike,
        expiry,
        instrumentType: 'CE' as const,
        product: 'NFO',
      })),
      puts: cachedOI.strikes.map(s => ({
        tradingsymbol: s.peSymbol,
        strike: s.strike,
        expiry,
        instrumentType: 'PE' as const,
        product: 'NFO',
      })),
      spotEstimate: spot,
      expiry,
      product: 'NIFTY',
      lotSize: 65,
      strikeStep: 50,
      atmStrike: cachedOI.atmStrike,
      oiAnalytics: cachedOI,
    }
  } else if (niftyContracts && spot > 0) {
    // Build minimal chain from contracts (no OI data yet)
    const atm = Math.round(spot / 50) * 50
    chain = {
      calls: niftyContracts.bull.map(o => ({
        tradingsymbol: o.tradingsymbol,
        strike: o.strike,
        expiry: niftyContracts.expiry,
        instrumentType: 'CE' as const,
        product: 'NFO',
      })),
      puts: niftyContracts.bear.map(o => ({
        tradingsymbol: o.tradingsymbol,
        strike: o.strike,
        expiry: niftyContracts.expiry,
        instrumentType: 'PE' as const,
        product: 'NFO',
      })),
      spotEstimate: spot,
      expiry: niftyContracts.expiry,
      product: 'NIFTY',
      lotSize: 65,
      strikeStep: 50,
      atmStrike: atm,
    }
  }

  // Refresh OI in background
  if (niftyContracts) {
    fetchNiftyChainOI(niftyContracts).then(result => {
      if (result && chain) {
        chain.oiAnalytics = result
        ps.lastOIAnalytics = result
      }
    }).catch(() => {})
  }

  // Inject last-known OI analytics if chain exists but has no oiAnalytics
  if (chain && !chain.oiAnalytics && ps.lastOIAnalytics) {
    chain.oiAnalytics = ps.lastOIAnalytics
  }

  // Elliott Wave — refresh each timeframe on its own interval, fire-and-forget
  if (futureToken > 0) {
    const tfsToRefresh = Object.keys(EW_TF_CONFIG).filter(
      tf => now - (ps.lastEWTsByTF[tf] ?? 0) >= EW_TF_CONFIG[tf].refreshMs
    )
    if (tfsToRefresh.length > 0) {
      for (const tf of tfsToRefresh) ps.lastEWTsByTF[tf] = now
      const token = futureToken
      Promise.all(tfsToRefresh.map(async tf => {
        const cfg = EW_TF_CONFIG[tf]
        try {
          let candles = await fetchEWCandlesTF(token, cfg.kiteInterval, cfg.lookbackDays)
          if (tf === '4h') candles = resampleTo4H(candles)
          if (candles.length >= 5) {
            ps.ewPivotsByTF[tf] = findZigZagPivots(candles, cfg.zigzagThresh)
            if (tf === '15m') ps.ewPivots = ps.ewPivotsByTF[tf]!
          }
        } catch { /* ignore per-TF errors */ }
      })).catch(() => {})
    }
  }
  const elliottWave = ps.ewPivots.length >= 4 ? computeElliottWave(ps.ewPivots, spot, composite) : null
  const elliottWaveByTF: Partial<Record<string, ElliottWaveState>> = {}
  for (const tf of Object.keys(EW_TF_CONFIG)) {
    const pivots = ps.ewPivotsByTF[tf]
    if (pivots && pivots.length >= 4) {
      elliottWaveByTF[tf] = computeElliottWave(pivots, spot, composite)
    }
  }

  const sysLog     = await updateSysLog(ps, composite, spot, chain)
  const p20cSysLog = await updateP20CSysLog(ps, pat20Con, composite, spot, chain)

  const minutesAccumulated = store.snapshots.length > 1
    ? Math.round((store.snapshots[store.snapshots.length - 1].ts - store.snapshots[0].ts) / 60_000)
    : 0

  const metaRegime = store.patterns.length >= 5
    ? computeNiftyMetaRegime(store.patterns, 60)
    : null

  return {
    prediction, technicals, composite,
    snapshotCount: store.snapshots.length,
    patternCount: store.patterns.length,
    resolvedCount: store.patterns.filter(p => p.outcome20 !== null).length,
    proxy, minutesAccumulated, sysLog, p20cSysLog, chain,
    spot, futureSymbol, futureToken,
    marketOpen, depth, pat20Con, elliottWave, elliottWaveByTF, metaRegime, v2,
  }
}

// ── Background Accumulator ────────────────────────────────────────────────────

let _bgStarted = false

function startBackgroundAccumulator() {
  if (_bgStarted) return
  _bgStarted = true
  setInterval(async () => {
    try { await getNiftyFutState() } catch { /* ignore */ }
  }, 60_000)
}

function emptyState(marketOpen: boolean): NiftyFutState {
  return {
    prediction: { predictedMove: 0, bullProb: 0.5, bearProb: 0.5, topSim: 0, confidence: 0, nResolved: 0, direction: null, status: 'no_data', h5: null, h15: null, h20: null },
    technicals: { rsi: null, emaShort: null, emaLong: null, emaCrossover: null, vwap: null, vwapAlign: null, atr: null, atrPct: null, momentum1m: 0, momentum5m: 0, sessionHigh: 0, sessionLow: 0, rangePosition: 0.5, volume: 0, oi: 0 },
    composite: { predictedMove: 0, bullProb: 0.5, bearProb: 0.5, direction: null, confidence: 0, status: 'no_data', components: { patternWeight: 0, techWeight: 0, patternBullProb: 0.5, techBullScore: 0.5 } },
    snapshotCount: 0, patternCount: 0, resolvedCount: 0, proxy: 0, minutesAccumulated: 0,
    sysLog: [], p20cSysLog: [], chain: null, spot: 0, futureSymbol: '', futureToken: 0,
    marketOpen, pat20Con: null, elliottWave: null, elliottWaveByTF: {}, metaRegime: null, v2: null,
  }
}
