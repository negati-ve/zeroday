import fs from 'fs'
import path from 'path'
import type { StockState, StockStateFile } from './stockState'
import { readStockState } from './stockState'
import { getISTHourMin, getNextTradingDay } from './tradingCalendar'
import { kiteGetHistorical } from './kite'

// ── NIFTY 50 Constituents (May 2026) ───────────────────────────────────────

export const NIFTY50_STOCKS = [
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
] as const

const FEATURES_PER_STOCK = 6
const VEC_DIM = NIFTY50_STOCKS.length * FEATURES_PER_STOCK

// Approximate NIFTY 50 free-float market-cap weights (%, May 2026)
// Source: niftyindices.com — updated semi-annually, stable ±0.5% between reviews
export const NIFTY50_WEIGHTS: Record<string, number> = {
  HDFCBANK: 13.1, RELIANCE: 8.8, ICICIBANK: 8.3, INFY: 6.1, TCS: 4.4,
  BHARTIARTL: 4.0, ITC: 3.9, LT: 3.5, SBIN: 3.1, AXISBANK: 2.5,
  KOTAKBANK: 2.4, 'M&M': 2.2, HCLTECH: 2.0, SUNPHARMA: 1.9, BAJFINANCE: 1.8,
  TITAN: 1.7, MARUTI: 1.6, NTPC: 1.5, TATASTEEL: 1.4, ULTRACEMCO: 1.4,
  ADANIENT: 1.3, HINDUNILVR: 1.3, POWERGRID: 1.3, ONGC: 1.2, COALINDIA: 1.1,
  WIPRO: 1.1, JSWSTEEL: 1.0, BAJAJFINSV: 1.0, GRASIM: 1.0, TRENT: 0.9,
  INDIGO: 0.9, NESTLEIND: 0.8, TATACONSUM: 0.8, 'BAJAJ-AUTO': 0.8,
  APOLLOHOSP: 0.8, ASIANPAINT: 0.8, CIPLA: 0.7, TECHM: 0.7, BEL: 0.7,
  DRREDDY: 0.7, ADANIPORTS: 0.7, ETERNAL: 0.6, HDFCLIFE: 0.6, SBILIFE: 0.6,
  HINDALCO: 0.6, SHRIRAMFIN: 0.5, EICHERMOT: 0.5, JIOFIN: 0.4, MAXHEALTH: 0.4,
  TMPV: 0.3, LODHA: 0.3, INDUSINDBK: 0.3, MANKIND: 0.3, PRESTIGE: 0.2,
  DIXON: 0.2, BPCL: 0.2,
}

const HEAVYWEIGHT_THRESHOLD = 2.0
export const NIFTY50_HEAVYWEIGHTS = NIFTY50_STOCKS.filter(s => (NIFTY50_WEIGHTS[s] ?? 0) >= HEAVYWEIGHT_THRESHOLD)

function getWeight(stock: string): number {
  return NIFTY50_WEIGHTS[stock] ?? (100 / NIFTY50_STOCKS.length)
}


const PATTERN_FILE = path.join('/workspace/option-trader', 'nifty50-patterns.json')
const SNAPSHOT_INTERVAL_MS = 60_000
const MAX_SNAPSHOTS = 120
const MAX_PATTERNS = 1000
const OUTCOME_HORIZON_MS = 20 * 60_000
const TEMPERATURE = 0.10
const KNN_K = 10
const QUERY_DECAY = 0.05
const MIN_PATTERNS_FOR_PREDICTION = 10
const PERSIST_INTERVAL_MS = 5 * 60_000

// ── Types ──────────────────────────────────────────────────────────────────

interface Snapshot {
  ts: number
  vec: number[]
  niftyProxy: number
  stockCount: number
}

interface N50Pattern {
  ts: number
  vec: number[]
  niftyProxy: number
  outcome20: number | null
  sessionDay: string
  dim: number
}

interface Store {
  snapshots: Snapshot[]
  patterns: N50Pattern[]
  lastSnapshotTs: number
  lastPersistTs: number
  sessionDay: string | null
  sessionPrices: Record<string, number>
  ewPivots: EWPivot[]
  lastEWTs: number
  ewPivotsByTF: Partial<Record<string, EWPivot[]>>
  lastEWTsByTF: Partial<Record<string, number>>
}

export interface N50Prediction {
  predictedMove: number
  bullProb: number
  bearProb: number
  topSim: number
  confidence: number
  nResolved: number
  direction: 'BULL' | 'BEAR' | null
  status: 'ready' | 'warming' | 'no_data'
}

export interface N50Technicals {
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
  heavyweights?: {
    bullPct: number
    bearPct: number
    neutPct: number
    totalWeight: number
  }
}

export interface N50Composite {
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

export interface N50State {
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
  sysLog?: SysLogEntry[]
  niftySpot?: number
  heavyweights?: HeavyweightDetail[]
  elliottWave?: ElliottWaveState | null
  elliottWaveByTF?: Partial<Record<string, ElliottWaveState>>
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

const NIFTY_EW_TF_CONFIG: Record<string, { kiteInterval: string; lookbackDays: number; refreshMs: number; zigzagThresh: number }> = {
  '15m': { kiteInterval: '15minute', lookbackDays: 3,    refreshMs: 15*60_000,      zigzagThresh: 0.003 },
  '1h':  { kiteInterval: '60minute', lookbackDays: 10,   refreshMs: 60*60_000,      zigzagThresh: 0.005 },
  '4h':  { kiteInterval: '60minute', lookbackDays: 30,   refreshMs: 60*60_000,      zigzagThresh: 0.008 },
  '1d':  { kiteInterval: 'day',      lookbackDays: 180,  refreshMs: 4*60*60_000,    zigzagThresh: 0.015 },
  '1w':  { kiteInterval: 'week',     lookbackDays: 730,  refreshMs: 12*60*60_000,   zigzagThresh: 0.03  },
  '1M':  { kiteInterval: 'month',    lookbackDays: 1825, refreshMs: 24*60*60_000,   zigzagThresh: 0.05  },
}
const NIFTY_TOKEN = 256265

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

async function fetchNiftyEWCandlesTF(tf: string, kiteInterval: string, lookbackDays: number): Promise<EWCandle[]> {
  try {
    const now = Date.now()
    const istNow = new Date(now + 5.5 * 3600_000)
    const from = new Date(istNow.getTime() - lookbackDays * 24 * 3600_000)
    const fmt = (d: Date) => d.toISOString().slice(0, 10) + ' ' +
      String(d.getUTCHours()).padStart(2,'0') + ':' + String(d.getUTCMinutes()).padStart(2,'0') + ':00'
    const raw = await Promise.race([
      kiteGetHistorical(NIFTY_TOKEN, kiteInterval as Parameters<typeof kiteGetHistorical>[1], fmt(from), fmt(istNow)),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('EW fetch timeout')), 15_000)),
    ])
    return raw.map(c => ({ ts: new Date(c.date).getTime(), open: c.open, high: c.high, low: c.low, close: c.close }))
  } catch { return [] }
}

function computeElliottWave(
  pivots: EWPivot[],
  spot: number,
  composite: { direction: string | null; bullProb: number; bearProb: number; confidence?: number }
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
  const orcConf = composite.confidence ?? 0
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

export interface HeavyweightDetail {
  name: string
  weight: number
  ltp: number
  trend: string
  cdZ: number
  signal: string
  vwap: string
  pat30v2Bull: number
  pat30v2Bear: number
}

// ── SysLog Types ──────────────────────────────────────────────────────────

export interface SysLogEntry {
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
  targetHit?: boolean
  targetHitTs?: number | null
}

// ── Day-Ahead Prediction Types ────────────────────────────────────────────

export interface DayPrediction {
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

export interface DayResolutionLog {
  captureDay: string
  targetDay: string
  predictedMove: number
  predictedDirection: 'BULL' | 'BEAR' | null
  actualProxy20: number
  correct: boolean
  error: number
  resolvedAt: number
}

export interface DayPredictionState {
  prediction: DayPrediction | null
  recentLog: DayResolutionLog[]
  patternCount: number
  resolvedCount: number
}

// ── Singleton Store ────────────────────────────────────────────────────────

let store: Store = {
  snapshots: [],
  patterns: [],
  lastSnapshotTs: 0,
  lastPersistTs: 0,
  sessionDay: null,
  sessionPrices: {},
  ewPivots: [],
  lastEWTs: 0,
  ewPivotsByTF: {},
  lastEWTsByTF: {},
}

let loaded = false

// ── Day-Ahead Store ───────────────────────────────────────────────────────

const DAY_PATTERN_FILE = path.join('/workspace/option-trader', 'nifty50-day-patterns.json')
const DAY_CAPTURE_HOUR = 15
const DAY_CAPTURE_MINUTE = 0
const DAY_RESOLVE_HOUR = 9
const DAY_RESOLVE_MINUTE = 35
const DAY_KNN_K = 15
const DAY_MIN_PATTERNS = 5
const DAY_TEMPERATURE = 0.5
const MAX_DAY_PATTERNS = 500

interface DayClosingPattern {
  captureDay: string
  captureTs: number
  vec: number[]
  niftyProxy: number
  targetDay: string
  outcomeProxy: number | null
  dim: number
}

interface DayStore {
  patterns: DayClosingPattern[]
  latestPrediction: DayPrediction | null
  resolutionLog: DayResolutionLog[]
  savedAt: number
}

let dayStore: DayStore = {
  patterns: [],
  latestPrediction: null,
  resolutionLog: [],
  savedAt: 0,
}
let dayStoreLoaded = false

// ── SysLog Store ──────────────────────────────────────────────────────────

const SYSLOG_FILE = path.join('/workspace/option-trader', 'nifty50-syslog.json')
const SYSLOG_CYCLE_MS = 20 * 60_000
const MAX_SYSLOG_ENTRIES = 200

interface SysLogStore {
  entries: SysLogEntry[]
  lastCycleTs: number
}

let sysLogStore: SysLogStore = { entries: [], lastCycleTs: 0 }
let sysLogLoaded = false

function ensureSysLogLoaded() {
  if (sysLogLoaded) return
  sysLogLoaded = true
  try {
    const raw = fs.readFileSync(SYSLOG_FILE, 'utf8')
    const saved = JSON.parse(raw) as Partial<SysLogStore>
    if (Array.isArray(saved.entries)) sysLogStore.entries = saved.entries.slice(-MAX_SYSLOG_ENTRIES)
    if (saved.lastCycleTs) sysLogStore.lastCycleTs = saved.lastCycleTs
  } catch { /* no file yet */ }
}

function persistSysLog() {
  try {
    fs.writeFileSync(SYSLOG_FILE, JSON.stringify({
      entries: sysLogStore.entries.slice(-MAX_SYSLOG_ENTRIES),
      lastCycleTs: sysLogStore.lastCycleTs,
      savedAt: Date.now(),
    }))
  } catch { /* ignore */ }
}

export function updateSysLog(composite: N50Composite, niftySpot: number): SysLogEntry[] {
  ensureSysLogLoaded()
  const now = Date.now()
  const ist = getISTHourMin(now)
  const mins = ist.hour * 60 + ist.minute
  const inWindow = mins >= 9 * 60 + 20 && mins <= 15 * 60 + 30

  let changed = false
  for (const entry of sysLogStore.entries) {
    if (entry.resolved) continue
    const spotDiff = niftySpot - entry.niftySpotAtPred
    const currentMove = entry.niftySpotAtPred > 0 ? (spotDiff / entry.niftySpotAtPred) * 100 : 0
    const moveDir = entry.predMove > 0 ? 'BULL' : entry.predMove < 0 ? 'BEAR' : null

    // Track peak move in predicted direction during the 20-min window
    if (!entry.targetHit && niftySpot > 0 && moveDir) {
      const prev = entry.peakMove ?? 0
      if (moveDir === 'BULL' && currentMove > prev) { entry.peakMove = currentMove; changed = true }
      else if (moveDir === 'BEAR' && currentMove < prev) { entry.peakMove = currentMove; changed = true }

      // Check if predicted target was reached at any point
      if (moveDir === 'BULL' && currentMove >= entry.predMove) {
        entry.targetHit = true; entry.targetHitTs = now; changed = true
      } else if (moveDir === 'BEAR' && currentMove <= entry.predMove) {
        entry.targetHit = true; entry.targetHitTs = now; changed = true
      }
    }

    // Resolve: at +20 min OR immediately on target hit
    const timeUp = now - entry.cycleTs >= SYSLOG_CYCLE_MS
    if (!timeUp && !entry.targetHit) continue
    entry.outcomeMove = currentMove
    entry.outcomeDir = spotDiff > 0 ? 'BULL' : spotDiff < 0 ? 'BEAR' : null
    entry.niftySpotAtOutcome = niftySpot
    entry.resolved = true
    const effectiveDir = entry.predDir ?? moveDir
    entry.correct = effectiveDir !== null && (
      entry.targetHit === true || effectiveDir === entry.outcomeDir
    )
    changed = true
  }
  if (changed) {
    persistSysLog()
    // Reset cycle timer so a new prediction starts immediately after early resolution
    const lastEntry = sysLogStore.entries[sysLogStore.entries.length - 1]
    if (lastEntry?.resolved && lastEntry.targetHit && now - lastEntry.cycleTs < SYSLOG_CYCLE_MS) {
      sysLogStore.lastCycleTs = 0
    }
  }

  if (inWindow && now - sysLogStore.lastCycleTs >= SYSLOG_CYCLE_MS && composite.status === 'ready' && niftySpot > 0) {
    const currentDay = new Date(now + 5.5 * 3600_000).toISOString().slice(0, 10)
    sysLogStore.entries.push({
      cycleTs: now,
      cycleTime: `${String(ist.hour).padStart(2, '0')}:${String(ist.minute).padStart(2, '0')}`,
      predMove: composite.predictedMove,
      predDir: composite.direction,
      predConf: composite.confidence,
      predBullProb: composite.bullProb,
      predBearProb: composite.bearProb,
      niftySpotAtPred: niftySpot,
      predSpot: niftySpot * (1 + composite.predictedMove / 100),
      outcomeMove: null,
      outcomeDir: null,
      niftySpotAtOutcome: null,
      resolved: false,
      correct: null,
      sessionDay: currentDay,
      peakMove: null,
      targetHit: false,
      targetHitTs: null,
    })
    if (sysLogStore.entries.length > MAX_SYSLOG_ENTRIES) {
      sysLogStore.entries = sysLogStore.entries.slice(-MAX_SYSLOG_ENTRIES)
    }
    sysLogStore.lastCycleTs = now
    persistSysLog()
  }

  return sysLogStore.entries.slice(-30)
}

function ensureLoaded() {
  if (loaded) return
  loaded = true
  try {
    const raw = fs.readFileSync(PATTERN_FILE, 'utf8')
    const saved = JSON.parse(raw) as { patterns?: N50Pattern[] }
    if (Array.isArray(saved.patterns)) {
      store.patterns = saved.patterns.slice(-MAX_PATTERNS)
    }
  } catch { /* no file yet */ }
}

function persist() {
  try {
    fs.writeFileSync(PATTERN_FILE, JSON.stringify({
      patterns: store.patterns.slice(-MAX_PATTERNS),
      savedAt: Date.now(),
    }))
    store.lastPersistTs = Date.now()
  } catch { /* ignore */ }
}

// ── Feature Extraction ─────────────────────────────────────────────────────

function extractStockFeatures(s: StockState): number[] {
  const pats = [s.pat30_5, s.pat60_20, s.pat30v2].filter(Boolean) as { bull: number; bear: number }[]
  let patSignedProb = 0
  if (pats.length > 0) {
    const avgBull = pats.reduce((a, p) => a + p.bull, 0) / pats.length
    const avgBear = pats.reduce((a, p) => a + p.bear, 0) / pats.length
    const dominant = Math.max(avgBull, avgBear) / 100
    patSignedProb = avgBull > avgBear ? dominant : -dominant
  }

  return [
    patSignedProb,
    Math.max(-1, Math.min(1, (s.cdZ ?? 0) / 3)),
    s.imbalance ?? 0,
    s.indicators?.emaCrossover === 'BULL' ? 1 : s.indicators?.emaCrossover === 'BEAR' ? -1 : 0,
    s.indicators?.vwapAlign === 'BULL' ? 1 : s.indicators?.vwapAlign === 'BEAR' ? -1 : 0,
    s.cosineBull ?? 0,
  ]
}

function buildFeatureVector(stocks: Record<string, StockState>): { vec: number[]; count: number } {
  const vec: number[] = []
  let count = 0
  for (const name of NIFTY50_STOCKS) {
    const s = stocks[name]
    if (s && s.ltp > 0) {
      vec.push(...extractStockFeatures(s))
      count++
    } else {
      vec.push(0, 0, 0, 0, 0, 0)
    }
  }
  return { vec, count }
}

// ── Technical Aggregates ───────────────────────────────────────────────────

function computeTechAggregates(stocks: Record<string, StockState>): N50Technicals {
  let rsiWSum = 0, rsiW = 0
  let atrPctWSum = 0, atrW = 0
  let vwapBullW = 0, vwapBearW = 0, vwapTotalW = 0
  let emaBullW = 0, emaBearW = 0, emaTotalW = 0
  let cdZWSum = 0, cdZW = 0
  let cusumBullW = 0, cusumBearW = 0
  let imbWSum = 0, aggWSum = 0, flowW = 0
  let trendBullW = 0, trendBearW = 0, trendTotalW = 0
  let pat60BullW = 0, pat60BearW = 0, pat60MoveW = 0, pat60W = 0
  let hwBullW = 0, hwBearW = 0, hwNeutW = 0, hwTotalW = 0

  for (const name of NIFTY50_STOCKS) {
    const s = stocks[name]
    if (!s || s.ltp <= 0) continue
    const w = getWeight(name)

    if (s.indicators) {
      if (s.indicators.rsi != null) { rsiWSum += s.indicators.rsi * w; rsiW += w }
      if (s.indicators.atrPct != null) { atrPctWSum += s.indicators.atrPct * w; atrW += w }
      if (s.indicators.vwapAlign === 'BULL') vwapBullW += w
      else if (s.indicators.vwapAlign === 'BEAR') vwapBearW += w
      if (s.indicators.vwapAlign) vwapTotalW += w
      if (s.indicators.emaCrossover === 'BULL') emaBullW += w
      else if (s.indicators.emaCrossover === 'BEAR') emaBearW += w
      if (s.indicators.emaCrossover) emaTotalW += w
    }

    if (s.cdZ != null && s.cdZ !== 0) { cdZWSum += s.cdZ * w; cdZW += w }
    if (s.cusumBull) cusumBullW += w
    if (s.cusumBear) cusumBearW += w
    if (s.imbalance != null) { imbWSum += s.imbalance * w; flowW += w }
    if (s.aggRatio != null) { aggWSum += s.aggRatio * w }

    if (s.trend === 'BULL') trendBullW += w
    else if (s.trend === 'BEAR') trendBearW += w
    if (s.trend) trendTotalW += w

    if (s.pat60_20) {
      pat60BullW += s.pat60_20.bull * w
      pat60BearW += s.pat60_20.bear * w
      pat60MoveW += s.pat60_20.move * w
      pat60W += w
    }

    if ((NIFTY50_WEIGHTS[name] ?? 0) >= HEAVYWEIGHT_THRESHOLD) {
      hwTotalW += w
      if (s.trend === 'BULL') hwBullW += w
      else if (s.trend === 'BEAR') hwBearW += w
      else hwNeutW += w
    }
  }

  return {
    avgRsi: rsiW > 0 ? rsiWSum / rsiW : null,
    avgAtrPct: atrW > 0 ? atrPctWSum / atrW : null,
    vwapBullPct: vwapTotalW > 0 ? Math.round((vwapBullW / vwapTotalW) * 100) : 0,
    vwapBearPct: vwapTotalW > 0 ? Math.round((vwapBearW / vwapTotalW) * 100) : 0,
    emaBullPct: emaTotalW > 0 ? Math.round((emaBullW / emaTotalW) * 100) : 0,
    emaBearPct: emaTotalW > 0 ? Math.round((emaBearW / emaTotalW) * 100) : 0,
    avgCdZ: cdZW > 0 ? cdZWSum / cdZW : 0,
    cusumBullCount: cusumBullW,
    cusumBearCount: cusumBearW,
    avgImbalance: flowW > 0 ? imbWSum / flowW : 0,
    avgAggRatio: flowW > 0 ? aggWSum / flowW : 0,
    trendBullPct: trendTotalW > 0 ? Math.round((trendBullW / trendTotalW) * 100) : 0,
    trendBearPct: trendTotalW > 0 ? Math.round((trendBearW / trendTotalW) * 100) : 0,
    stocksWithIndicators: Math.max(1, Math.round(rsiW + atrW + vwapTotalW + emaTotalW) / 4),
    pat60_20: pat60W > 0 ? {
      avgBull: Math.round(pat60BullW / pat60W),
      avgBear: Math.round(pat60BearW / pat60W),
      avgMove: pat60MoveW / pat60W,
      n: Math.round(pat60W),
    } : null,
    heavyweights: {
      bullPct: hwTotalW > 0 ? Math.round((hwBullW / hwTotalW) * 100) : 0,
      bearPct: hwTotalW > 0 ? Math.round((hwBearW / hwTotalW) * 100) : 0,
      neutPct: hwTotalW > 0 ? Math.round((hwNeutW / hwTotalW) * 100) : 0,
      totalWeight: Math.round(hwTotalW),
    },
  }
}

function computeComposite(
  prediction: N50Prediction,
  tech: N50Technicals,
): N50Composite {
  // Technical bull score: aggregate directional signal from technicals (range 0..1)
  // Each component contributes a weighted vote
  const votes: { score: number; weight: number }[] = []

  // VWAP alignment: strong directional signal
  if (tech.vwapBullPct + tech.vwapBearPct > 0) {
    votes.push({ score: tech.vwapBullPct / (tech.vwapBullPct + tech.vwapBearPct), weight: 1.0 })
  }

  // EMA crossover: trend direction
  if (tech.emaBullPct + tech.emaBearPct > 0) {
    votes.push({ score: tech.emaBullPct / (tech.emaBullPct + tech.emaBearPct), weight: 1.0 })
  }

  // 5-min trend: momentum direction
  if (tech.trendBullPct + tech.trendBearPct > 0) {
    votes.push({ score: tech.trendBullPct / (tech.trendBullPct + tech.trendBearPct), weight: 0.8 })
  }

  // RSI: >55 bullish, <45 bearish (normalized to 0..1)
  if (tech.avgRsi != null) {
    votes.push({ score: Math.max(0, Math.min(1, (tech.avgRsi - 30) / 40)), weight: 0.7 })
  }

  // CD Z-score: positive = bull (sigmoid mapping)
  if (tech.avgCdZ !== 0) {
    const cdSig = 1 / (1 + Math.exp(-tech.avgCdZ))
    votes.push({ score: cdSig, weight: 1.2 })
  }

  // CUSUM alarms: strong directional evidence
  if (tech.cusumBullCount > 0 || tech.cusumBearCount > 0) {
    const total = tech.cusumBullCount + tech.cusumBearCount
    votes.push({ score: tech.cusumBullCount / total, weight: 1.5 })
  }

  // OBI (avg imbalance): -1..+1 → 0..1
  if (Math.abs(tech.avgImbalance) > 0.01) {
    votes.push({ score: (tech.avgImbalance + 1) / 2, weight: 0.6 })
  }

  // Aggression ratio: -1..+1 → 0..1
  if (Math.abs(tech.avgAggRatio) > 0.01) {
    votes.push({ score: (tech.avgAggRatio + 1) / 2, weight: 0.5 })
  }

  // Pat60_20 aggregate: per-stock 60-min lookback, 20-min outcome patterns
  if (tech.pat60_20) {
    votes.push({ score: tech.pat60_20.avgBull / 100, weight: 1.0 })
  }

  let techBullScore = 0.5
  if (votes.length > 0) {
    const totalW = votes.reduce((s, v) => s + v.weight, 0)
    techBullScore = votes.reduce((s, v) => s + v.score * v.weight, 0) / totalW
  }

  // Blend pattern KNN prediction with technical aggregate
  // Pattern weight scales with confidence and resolved count
  const patternReady = prediction.status === 'ready' && prediction.nResolved >= MIN_PATTERNS_FOR_PREDICTION
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

  const blendedBull = totalWeight > 0
    ? (patternWeight * prediction.bullProb + techWeight * techBullScore) / totalWeight
    : 0.5
  const blendedBear = 1 - blendedBull

  // Blended move: weighted combination of pattern move and tech-implied move
  // Median 20-min NIFTY |move| ≈ 0.05%, P90 ≈ 0.16%. Scale tech signal to this range.
  const TYPICAL_MOVE = 0.08
  const patMove = patternReady ? prediction.predictedMove : 0
  const techDeviation = (techBullScore - 0.5) * 2
  const techImpliedMove = techDeviation * TYPICAL_MOVE
  const blendedMove = totalWeight > 0
    ? (patternWeight * patMove + techWeight * techImpliedMove) / totalWeight
    : techImpliedMove

  const conf = patternReady
    ? prediction.confidence * (0.7 + 0.3 * Math.abs(techBullScore - 0.5) * 2)
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

// ── NIFTY Proxy ────────────────────────────────────────────────────────────

function getISTDay(ts: number): string {
  return new Date(ts + 5.5 * 3600_000).toISOString().slice(0, 10)
}

function resetSession(ts: number, stocks: Record<string, StockState>) {
  store.sessionDay = getISTDay(ts)
  store.sessionPrices = {}
  store.snapshots = []
  for (const name of NIFTY50_STOCKS) {
    const s = stocks[name]
    if (s && s.ltp > 0) store.sessionPrices[name] = s.ltp
  }
}

function computeProxy(stocks: Record<string, StockState>): number {
  let sum = 0, count = 0
  for (const name of NIFTY50_STOCKS) {
    const s = stocks[name]
    if (!s || s.ltp <= 0) continue
    const open = store.sessionPrices[name]
    if (!open || open <= 0) continue
    sum += (s.ltp - open) / open
    count++
  }
  return count > 0 ? (sum / count) * 100 : 0
}

// ── Cosine Similarity ──────────────────────────────────────────────────────

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

// ── 60-min Query Vector ────────────────────────────────────────────────────

function build60mQuery(): number[] | null {
  if (store.snapshots.length === 0) return null

  const now = store.snapshots[store.snapshots.length - 1].ts
  const window = store.snapshots.filter(s => now - s.ts <= 60 * 60_000)
  if (window.length === 0) return null

  const query = new Array(VEC_DIM).fill(0)
  let totalWeight = 0

  for (const snap of window) {
    const age = (now - snap.ts) / 60_000
    const w = Math.exp(-QUERY_DECAY * age)
    for (let i = 0; i < VEC_DIM; i++) {
      query[i] += w * snap.vec[i]
    }
    totalWeight += w
  }

  if (totalWeight > 0) {
    for (let i = 0; i < VEC_DIM; i++) query[i] /= totalWeight
  }

  return query
}

// ── QKV Attention ──────────────────────────────────────────────────────────

function queryAttention(queryVec: number[]): N50Prediction {
  const resolved = store.patterns.filter(p => p.outcome20 !== null && p.dim === VEC_DIM)

  if (resolved.length < MIN_PATTERNS_FOR_PREDICTION) {
    return {
      predictedMove: 0, bullProb: 0.5, bearProb: 0.5,
      topSim: 0, confidence: 0, nResolved: resolved.length,
      direction: null, status: resolved.length === 0 ? 'no_data' : 'warming',
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

  let predictedMove = 0
  let bullWeight = 0, bearWeight = 0
  for (let i = 0; i < topK.length; i++) {
    const outcome = resolved[topK[i].i].outcome20!
    predictedMove += weights[i] * outcome
    if (outcome > 0) bullWeight += weights[i]
    else if (outcome < 0) bearWeight += weights[i]
  }

  const total = bullWeight + bearWeight
  const bullProb = total > 0 ? bullWeight / total : 0.5
  const bearProb = 1 - bullProb

  return {
    predictedMove,
    bullProb,
    bearProb,
    topSim: topK[0].sim,
    confidence: weights[0],
    nResolved: resolved.length,
    direction: bullProb >= 0.55 ? 'BULL' : bearProb >= 0.55 ? 'BEAR' : null,
    status: 'ready',
  }
}

// ── Outcome Resolution ─────────────────────────────────────────────────────

function resolveOutcomes() {
  const now = Date.now()
  for (const pattern of store.patterns) {
    if (pattern.outcome20 !== null) continue
    if (now - pattern.ts < OUTCOME_HORIZON_MS) continue

    // Only resolve within the same session to prevent cross-day proxy mismatch
    if (pattern.sessionDay !== store.sessionDay) continue

    const targetTs = pattern.ts + OUTCOME_HORIZON_MS
    const futureSnap = store.snapshots.find(s => s.ts >= targetTs)
    if (!futureSnap) continue

    pattern.outcome20 = futureSnap.niftyProxy - pattern.niftyProxy
  }
}

// ── Day-Ahead Prediction Logic ─────────────────────────────────────────────

function ensureDayStoreLoaded() {
  if (dayStoreLoaded) return
  dayStoreLoaded = true
  try {
    const raw = fs.readFileSync(DAY_PATTERN_FILE, 'utf8')
    const saved = JSON.parse(raw) as Partial<DayStore>
    if (Array.isArray(saved.patterns)) dayStore.patterns = saved.patterns.slice(-MAX_DAY_PATTERNS)
    if (saved.latestPrediction) dayStore.latestPrediction = saved.latestPrediction
    if (Array.isArray(saved.resolutionLog)) dayStore.resolutionLog = saved.resolutionLog
  } catch { /* no file yet */ }
}

function persistDayStore() {
  try {
    fs.writeFileSync(DAY_PATTERN_FILE, JSON.stringify({
      patterns: dayStore.patterns.slice(-MAX_DAY_PATTERNS),
      latestPrediction: dayStore.latestPrediction,
      resolutionLog: dayStore.resolutionLog,
      savedAt: Date.now(),
    }))
  } catch { /* ignore */ }
}

function queryDayAttention(queryVec: number[]): DayPrediction {
  const resolved = dayStore.patterns.filter(p => p.outcomeProxy !== null && p.dim === VEC_DIM)

  if (resolved.length < DAY_MIN_PATTERNS) {
    return {
      predictedMove: 0, bullProb: 0.5, bearProb: 0.5,
      topSim: 0, confidence: 0, nResolved: resolved.length,
      direction: null, status: resolved.length === 0 ? 'no_data' : 'warming',
      captureDay: '', targetDay: '',
    }
  }

  const sims = resolved.map(p => cosineSim(queryVec, p.vec))
  const indexed = sims.map((sim, i) => ({ sim, i }))
  indexed.sort((a, b) => b.sim - a.sim)
  const topK = indexed.slice(0, Math.min(DAY_KNN_K, resolved.length))

  const maxSim = topK[0].sim
  const expScores = topK.map(t => Math.exp((t.sim - maxSim) / DAY_TEMPERATURE))
  const sumExp = expScores.reduce((a, b) => a + b, 0)
  const weights = expScores.map(e => e / sumExp)

  let predictedMove = 0
  let bullWeight = 0, bearWeight = 0
  for (let i = 0; i < topK.length; i++) {
    const outcome = resolved[topK[i].i].outcomeProxy!
    predictedMove += weights[i] * outcome
    if (outcome > 0) bullWeight += weights[i]
    else if (outcome < 0) bearWeight += weights[i]
  }

  const total = bullWeight + bearWeight
  const bullProb = total > 0 ? bullWeight / total : 0.5
  const bearProb = 1 - bullProb

  return {
    predictedMove, bullProb, bearProb,
    topSim: topK[0].sim, confidence: weights[0], nResolved: resolved.length,
    direction: bullProb >= 0.55 ? 'BULL' : bearProb >= 0.55 ? 'BEAR' : null,
    status: 'ready',
    captureDay: '', targetDay: '',
  }
}

function captureClosingSnapshot(queryVec: number[], proxy: number, currentDay: string) {
  const targetDay = getNextTradingDay(currentDay)

  dayStore.patterns.push({
    captureDay: currentDay, captureTs: Date.now(),
    vec: queryVec, niftyProxy: proxy,
    targetDay, outcomeProxy: null, dim: VEC_DIM,
  })
  if (dayStore.patterns.length > MAX_DAY_PATTERNS) {
    dayStore.patterns = dayStore.patterns.slice(-MAX_DAY_PATTERNS)
  }

  const pred = queryDayAttention(queryVec)
  dayStore.latestPrediction = {
    ...pred, captureDay: currentDay, targetDay,
  }
  persistDayStore()
}

function resolveYesterdayPrediction(proxy: number, currentDay: string) {
  const pending = dayStore.patterns.find(
    p => p.targetDay === currentDay && p.outcomeProxy === null
  )
  if (!pending) return

  pending.outcomeProxy = proxy

  if (dayStore.latestPrediction && dayStore.latestPrediction.targetDay === currentDay) {
    const pred = dayStore.latestPrediction
    const actualDir = proxy > 0 ? 'BULL' : proxy < 0 ? 'BEAR' : null
    const correct = pred.direction !== null && pred.direction === actualDir

    dayStore.resolutionLog.push({
      captureDay: pending.captureDay,
      targetDay: currentDay,
      predictedMove: pred.predictedMove,
      predictedDirection: pred.direction,
      actualProxy20: proxy,
      correct,
      error: Math.abs(pred.predictedMove - proxy),
      resolvedAt: Date.now(),
    })

    if (dayStore.resolutionLog.length > 100) {
      dayStore.resolutionLog = dayStore.resolutionLog.slice(-100)
    }
  }
  persistDayStore()
}

function getDayPredictionState(): DayPredictionState {
  return {
    prediction: dayStore.latestPrediction,
    recentLog: dayStore.resolutionLog.slice(-20),
    patternCount: dayStore.patterns.length,
    resolvedCount: dayStore.patterns.filter(p => p.outcomeProxy !== null).length,
  }
}

// ── Main Entry Point ───────────────────────────────────────────────────────

export function getN50State(): N50State {
  ensureLoaded()

  const stateFile = readStockState()
  if (!stateFile) {
    return emptyState()
  }

  const stocks = stateFile.stocks
  const now = stateFile.updatedAt || Date.now()
  const currentDay = getISTDay(now)

  if (store.sessionDay !== currentDay) {
    resetSession(now, stocks)
  }

  // Seed session prices for stocks not yet seen
  for (const name of NIFTY50_STOCKS) {
    if (!store.sessionPrices[name] && stocks[name]?.ltp > 0) {
      store.sessionPrices[name] = stocks[name].ltp
    }
  }

  const { vec, count } = buildFeatureVector(stocks)
  const proxy = computeProxy(stocks)

  // Take snapshot if interval elapsed
  if (now - store.lastSnapshotTs >= SNAPSHOT_INTERVAL_MS && count >= 5) {
    const snapshot: Snapshot = { ts: now, vec, niftyProxy: proxy, stockCount: count }
    store.snapshots.push(snapshot)
    if (store.snapshots.length > MAX_SNAPSHOTS) {
      store.snapshots = store.snapshots.slice(-MAX_SNAPSHOTS)
    }
    store.lastSnapshotTs = now
  }

  resolveOutcomes()

  const queryVec = build60mQuery()

  // Store pattern using the smoothed query vector (not instantaneous) so
  // stored keys match the representation used at query time
  if (queryVec && now - store.lastSnapshotTs < SNAPSHOT_INTERVAL_MS * 2) {
    const lastPattern = store.patterns[store.patterns.length - 1]
    const shouldStore = !lastPattern || now - lastPattern.ts >= SNAPSHOT_INTERVAL_MS
    if (shouldStore) {
      store.patterns.push({ ts: now, vec: queryVec, niftyProxy: proxy, outcome20: null, sessionDay: currentDay, dim: VEC_DIM })
      if (store.patterns.length > MAX_PATTERNS) {
        store.patterns = store.patterns.slice(-MAX_PATTERNS)
      }
    }
  }
  const prediction = queryVec ? queryAttention(queryVec) : {
    predictedMove: 0, bullProb: 0.5, bearProb: 0.5,
    topSim: 0, confidence: 0, nResolved: 0,
    direction: null as 'BULL' | 'BEAR' | null, status: 'no_data' as const,
  }

  // Persist periodically
  if (now - store.lastPersistTs >= PERSIST_INTERVAL_MS) {
    persist()
  }

  // Compute bull/bear stock percentages
  let bullStocks = 0, bearStocks = 0, totalStocks = 0
  for (const name of NIFTY50_STOCKS) {
    const s = stocks[name]
    if (!s) continue
    totalStocks++
    const pats = [s.pat30_5, s.pat60_20, s.pat30v2].filter(Boolean) as { bull: number; bear: number }[]
    if (pats.length === 0) continue
    const avgBull = pats.reduce((a, p) => a + p.bull, 0) / pats.length
    const avgBear = pats.reduce((a, p) => a + p.bear, 0) / pats.length
    if (avgBull > avgBear) bullStocks++
    else bearStocks++
  }

  const minutesAccumulated = store.snapshots.length > 1
    ? Math.round((store.snapshots[store.snapshots.length - 1].ts - store.snapshots[0].ts) / 60_000)
    : 0

  // ── Day-ahead prediction ────────────────────────────────────────────────
  ensureDayStoreLoaded()
  const wallClock = Date.now()
  const ist = getISTHourMin(wallClock)

  const closingCapturedToday = dayStore.patterns.some(p => p.captureDay === currentDay)

  const resolvedToday = dayStore.resolutionLog.some(
    r => r.targetDay === currentDay
  ) || !dayStore.patterns.some(p => p.targetDay === currentDay && p.outcomeProxy === null)

  if (!resolvedToday && (ist.hour > DAY_RESOLVE_HOUR || (ist.hour === DAY_RESOLVE_HOUR && ist.minute >= DAY_RESOLVE_MINUTE))) {
    resolveYesterdayPrediction(proxy, currentDay)
  }

  if (!closingCapturedToday && queryVec && count >= 10
      && (ist.hour > DAY_CAPTURE_HOUR || (ist.hour === DAY_CAPTURE_HOUR && ist.minute >= DAY_CAPTURE_MINUTE))) {
    captureClosingSnapshot(queryVec, proxy, currentDay)
  }

  const technicals = computeTechAggregates(stocks)
  const composite = computeComposite(prediction, technicals)

  const hwDetail: HeavyweightDetail[] = []
  for (const name of NIFTY50_HEAVYWEIGHTS) {
    const s = stocks[name]
    if (!s || s.ltp <= 0) continue
    hwDetail.push({
      name,
      weight: NIFTY50_WEIGHTS[name] ?? 0,
      ltp: s.ltp,
      trend: s.trend ?? 'NEUTRAL',
      cdZ: s.cdZ ?? 0,
      signal: s.signal ?? 'NEUTRAL',
      vwap: s.indicators?.vwapAlign ?? 'NEUTRAL',
      pat30v2Bull: s.pat30v2?.bull ?? 50,
      pat30v2Bear: s.pat30v2?.bear ?? 50,
    })
  }
  hwDetail.sort((a, b) => b.weight - a.weight)

  // EW refresh — fire-and-forget, timestamps stamped before firing
  const tfsToRefresh = Object.keys(NIFTY_EW_TF_CONFIG).filter(
    tf => now - (store.lastEWTsByTF[tf] ?? 0) >= NIFTY_EW_TF_CONFIG[tf].refreshMs
  )
  if (tfsToRefresh.length > 0) {
    for (const tf of tfsToRefresh) store.lastEWTsByTF[tf] = now
    Promise.all(tfsToRefresh.map(async tf => {
      const cfg = NIFTY_EW_TF_CONFIG[tf]
      try {
        let candles = await fetchNiftyEWCandlesTF(tf, cfg.kiteInterval, cfg.lookbackDays)
        if (tf === '4h') candles = resampleTo4H(candles)
        if (candles.length >= 5) {
          store.ewPivotsByTF[tf] = findZigZagPivots(candles, cfg.zigzagThresh)
          if (tf === '15m') store.ewPivots = store.ewPivotsByTF[tf]!
        }
      } catch { /* ignore */ }
    })).catch(() => {})
  }

  const elliottWave = store.ewPivots.length >= 4 ? computeElliottWave(store.ewPivots, proxy, composite) : null
  const elliottWaveByTF: Partial<Record<string, ElliottWaveState>> = {}
  for (const tf of Object.keys(NIFTY_EW_TF_CONFIG)) {
    const pivots = store.ewPivotsByTF[tf]
    if (pivots && pivots.length >= 4) {
      elliottWaveByTF[tf] = computeElliottWave(pivots, proxy, composite)
    }
  }

  return {
    prediction,
    technicals,
    composite,
    snapshotCount: store.snapshots.length,
    patternCount: store.patterns.length,
    resolvedCount: store.patterns.filter(p => p.outcome20 !== null).length,
    niftyProxy: proxy,
    bullStockPct: totalStocks > 0 ? Math.round((bullStocks / totalStocks) * 100) : 0,
    bearStockPct: totalStocks > 0 ? Math.round((bearStocks / totalStocks) * 100) : 0,
    coverageCount: count,
    minutesAccumulated,
    dayPrediction: getDayPredictionState(),
    heavyweights: hwDetail,
    elliottWave,
    elliottWaveByTF,
  }
}

export function persistN50() {
  persist()
}

function emptyState(): N50State {
  ensureDayStoreLoaded()
  const emptyPred: N50Prediction = {
    predictedMove: 0, bullProb: 0.5, bearProb: 0.5,
    topSim: 0, confidence: 0, nResolved: 0,
    direction: null, status: 'no_data',
  }
  return {
    prediction: emptyPred,
    technicals: {
      avgRsi: null, avgAtrPct: null,
      vwapBullPct: 0, vwapBearPct: 0,
      emaBullPct: 0, emaBearPct: 0,
      avgCdZ: 0, cusumBullCount: 0, cusumBearCount: 0,
      avgImbalance: 0, avgAggRatio: 0,
      trendBullPct: 0, trendBearPct: 0,
      stocksWithIndicators: 0, pat60_20: null,
    },
    composite: {
      predictedMove: 0, bullProb: 0.5, bearProb: 0.5,
      direction: null, confidence: 0, status: 'no_data',
      components: { patternWeight: 0, techWeight: 0, patternBullProb: 0.5, techBullScore: 0.5 },
    },
    snapshotCount: 0, patternCount: 0, resolvedCount: 0,
    niftyProxy: 0, bullStockPct: 0, bearStockPct: 0,
    coverageCount: 0, minutesAccumulated: 0,
    dayPrediction: getDayPredictionState(),
  }
}
