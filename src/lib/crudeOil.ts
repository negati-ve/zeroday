import fs from 'fs'
import path from 'path'
import { IndicatorEngine, type IndicatorValues } from './indicators'
import { kiteGetLTP, kiteGetQuote, kiteGetHistorical } from './kite'
import { getNearestCrudeFuture, getCrudeChain, type CrudeChain, type CrudeProduct } from './crudeContracts'
import { getISTHourMin } from './tradingCalendar'

// ── Constants ─────────────────────────────────────────────────────────────────

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
const TYPICAL_MOVE = 0.15

// MCX trading hours: 9:00 AM - 11:30 PM IST
const MCX_OPEN_HOUR = 9
const MCX_OPEN_MIN = 0
const MCX_CLOSE_HOUR = 23
const MCX_CLOSE_MIN = 30

// ── Types ─────────────────────────────────────────────────────────────────────

interface Snapshot {
  ts: number
  vec: number[]
  price: number
  proxy: number
}

interface CrudePattern {
  ts: number
  vec: number[]
  price: number
  proxy: number
  outcome5: number | null
  outcome15: number | null
  outcome20: number | null
  sessionDay: string
}

interface CrudeStore {
  snapshots: Snapshot[]
  patterns: CrudePattern[]
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

export interface CrudePrediction {
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

export interface CrudeTechnicals {
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
  rangePosition: number // 0 = at low, 1 = at high
  volume: number
  oi: number
}

export interface CrudeComposite {
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

export interface CrudeSysLogEntry {
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
  // Recommended option contract at time of signal
  optStrike?: number | null
  optType?: 'CE' | 'PE' | null
  optSymbol?: string | null
  optEntry?: number | null    // option ask price at signal time
  optTarget?: number | null   // estimated option price at predicted underlying target
}

export interface CrudeState {
  prediction: CrudePrediction
  technicals: CrudeTechnicals
  composite: CrudeComposite
  snapshotCount: number
  patternCount: number
  resolvedCount: number
  proxy: number
  minutesAccumulated: number
  sysLog: CrudeSysLogEntry[]
  chain: CrudeChain | null
  spot: number
  futureSymbol: string
  futureToken: number
  product: CrudeProduct
  marketOpen: boolean
  depth?: {
    buy: { price: number; quantity: number; orders: number }[]
    sell: { price: number; quantity: number; orders: number }[]
  }
}

// ── Singleton State ───────────────────────────────────────────────────────────

function freshStore(): CrudeStore {
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

// Per-product state to prevent cross-contamination
interface ProductState {
  store: CrudeStore
  indicatorEngine: IndicatorEngine
  engineWarmed: boolean
  warmingPromise: Promise<void> | null
  loaded: boolean
  lastWarmTs: number
  sysLogStore: { entries: CrudeSysLogEntry[]; lastCycleTs: number }
  sysLogLoaded: boolean
}

const productStates = new Map<CrudeProduct, ProductState>()

function getProductState(product: CrudeProduct): ProductState {
  let ps = productStates.get(product)
  if (!ps) {
    ps = {
      store: freshStore(),
      indicatorEngine: new IndicatorEngine({ emaShortPeriod: 9, emaLongPeriod: 21, rsiPeriod: 14, atrPeriod: 14 }),
      engineWarmed: false,
      warmingPromise: null,
      loaded: false,
      lastWarmTs: 0,
      sysLogStore: { entries: [], lastCycleTs: 0 },
      sysLogLoaded: false,
    }
    productStates.set(product, ps)
  }
  return ps
}

// ── Persistence ───────────────────────────────────────────────────────────────

function patternFileFor(product: CrudeProduct): string {
  return path.join('/workspace/option-trader', `crude-${product.toLowerCase()}-patterns.json`)
}

function sysLogFileFor(product: CrudeProduct): string {
  return path.join('/workspace/option-trader', `crude-${product.toLowerCase()}-syslog.json`)
}

function ensureLoaded(ps: ProductState, product: CrudeProduct) {
  if (ps.loaded) return
  ps.loaded = true
  try {
    const raw = fs.readFileSync(patternFileFor(product), 'utf8')
    const saved = JSON.parse(raw) as { patterns?: CrudePattern[] }
    if (Array.isArray(saved.patterns)) {
      // Drop old 8-dim patterns — feature semantics changed (depth dims 0-3 added)
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

function persist(ps: ProductState, product: CrudeProduct) {
  try {
    fs.writeFileSync(patternFileFor(product), JSON.stringify({
      patterns: ps.store.patterns.slice(-MAX_PATTERNS),
      savedAt: Date.now(),
    }))
    ps.store.lastPersistTs = Date.now()
  } catch { /* ignore */ }
}

function ensureSysLogLoaded(ps: ProductState, product: CrudeProduct) {
  if (ps.sysLogLoaded) return
  ps.sysLogLoaded = true
  try {
    const raw = fs.readFileSync(sysLogFileFor(product), 'utf8')
    const saved = JSON.parse(raw) as Partial<typeof ps.sysLogStore>
    if (Array.isArray(saved.entries)) ps.sysLogStore.entries = saved.entries.slice(-MAX_SYSLOG)
    if (saved.lastCycleTs) ps.sysLogStore.lastCycleTs = saved.lastCycleTs
  } catch { /* no file yet */ }
}

function persistSysLog(ps: ProductState, product: CrudeProduct) {
  try {
    fs.writeFileSync(sysLogFileFor(product), JSON.stringify({
      entries: ps.sysLogStore.entries.slice(-MAX_SYSLOG),
      lastCycleTs: ps.sysLogStore.lastCycleTs,
      savedAt: Date.now(),
    }))
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
    console.error('[crudeOil] warm indicators failed:', err instanceof Error ? err.message : err)
  }
}

// ── Depth Features ───────────────────────────────────────────────────────────

interface DepthFeatures {
  obi: number          // order book imbalance [-1, +1]
  mpEdgeTicks: number  // microprice edge in ticks
  depthAsymm: number   // total depth asymmetry [-1, +1]
  qpoBalance: number   // qty-per-order balance [-1, +1]
}

function computeDepthFeatures(depth: { buy: { price: number; quantity: number; orders: number }[]; sell: { price: number; quantity: number; orders: number }[] }): DepthFeatures {
  const bids = depth.buy.filter(l => l.quantity > 0)
  const asks = depth.sell.filter(l => l.quantity > 0)

  if (bids.length === 0 || asks.length === 0) {
    return { obi: 0, mpEdgeTicks: 0, depthAsymm: 0, qpoBalance: 0 }
  }

  // OBI — sum of qty across all levels
  const bidQty = bids.reduce((s, l) => s + l.quantity, 0)
  const askQty = asks.reduce((s, l) => s + l.quantity, 0)
  const totalQty = bidQty + askQty
  const obi = totalQty > 0 ? (bidQty - askQty) / totalQty : 0

  // Microprice edge — pressure-weighted fair price vs mid
  const bestBid = bids[0], bestAsk = asks[0]
  const mid = (bestBid.price + bestAsk.price) / 2
  const microPrice = (bestAsk.price * bestBid.quantity + bestBid.price * bestAsk.quantity)
    / (bestBid.quantity + bestAsk.quantity)
  const tickSize = bestAsk.price - bestBid.price || 1
  const mpEdgeTicks = (microPrice - mid) / tickSize

  // Depth asymmetry — total bid vs ask depth (all levels)
  const depthAsymm = totalQty > 0 ? (bidQty - askQty) / totalQty : 0

  // QPO balance — qty per order, institutional signal
  const bidQpo = bestBid.orders > 0 ? bestBid.quantity / bestBid.orders : 0
  const askQpo = bestAsk.orders > 0 ? bestAsk.quantity / bestAsk.orders : 0
  const qpoSum = bidQpo + askQpo
  const qpoBalance = qpoSum > 0 ? (bidQpo - askQpo) / qpoSum : 0

  return { obi, mpEdgeTicks, depthAsymm, qpoBalance }
}

// ── Feature Vector (12-dim, matches NSE pat60 Q/K/V architecture) ────────────
//
//  0  OBI              order book imbalance (depth)
//  1  mpEdge           microprice edge in ticks (depth)
//  2  depthAsymm       bid/ask total depth asymmetry (depth)
//  3  qpoBalance       qty-per-order balance (depth, institutional signal)
//  4  momentum1m       1-min price return
//  5  momentum5m       5-min price return
//  6  RSI              relative strength index, centered
//  7  EMA crossover    9/21 EMA alignment
//  8  VWAP alignment   price vs VWAP
//  9  range position   position within session range
// 10  ATR%             volatility normalized
// 11  OI momentum      open interest change signal (reserved)

function buildFeatureVector(
  price: number,
  ind: IndicatorValues,
  tech: CrudeTechnicals,
  depth?: { buy: { price: number; quantity: number; orders: number }[]; sell: { price: number; quantity: number; orders: number }[] },
): number[] {
  const c = (v: number, scale = 1) =>
    Math.max(-1, Math.min(1, Number.isFinite(v) ? v * scale : 0))

  const df = depth ? computeDepthFeatures(depth) : { obi: 0, mpEdgeTicks: 0, depthAsymm: 0, qpoBalance: 0 }

  return [
    c(df.obi),                                                // 0: OBI
    c(df.mpEdgeTicks, 0.5),                                    // 1: mpEdge ±2 ticks → ±1
    c(df.depthAsymm),                                          // 2: depth asymmetry
    c(df.qpoBalance),                                          // 3: QPO balance
    c(tech.momentum1m, 200),                                   // 4: 1-min mom ±0.5% → ±1
    c(tech.momentum5m, 100),                                   // 5: 5-min mom ±1% → ±1
    c(ind.rsi != null ? (ind.rsi - 50) / 50 : 0),             // 6: RSI centered
    c(tech.emaCrossover === 'BULL' ? 1 : tech.emaCrossover === 'BEAR' ? -1 : 0), // 7: EMA
    c(tech.vwapAlign === 'BULL' ? 1 : tech.vwapAlign === 'BEAR' ? -1 : 0),       // 8: VWAP
    c(tech.rangePosition * 2 - 1),                             // 9: range pos 0-1 → -1..+1
    c(ind.atrPct != null ? (ind.atrPct - 0.3) / 0.3 : 0),    // 10: ATR% normalized
    0,                                                          // 11: reserved (OI momentum)
  ]
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

// ── KNN Query (attention-style: Q·K softmax → V) ────────────────────────────

interface HorizonResult {
  predictedMove: number
  bullProb: number
  bearProb: number
}

function queryHorizon(
  weights: number[],
  topK: { sim: number; i: number }[],
  resolved: CrudePattern[],
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

function queryAttention(queryVec: number[], store: CrudeStore): CrudePrediction {
  const resolved = store.patterns.filter(p => p.outcome20 !== null)

  if (resolved.length < MIN_PATTERNS) {
    return {
      predictedMove: 0, bullProb: 0.5, bearProb: 0.5,
      topSim: 0, confidence: 0, nResolved: resolved.length,
      direction: null, status: resolved.length === 0 ? 'no_data' : 'warming',
      h5: null, h15: null, h20: null,
    }
  }

  // Q · K — cosine similarity between query and all stored patterns
  const sims = resolved.map(p => cosineSim(queryVec, p.vec))
  const indexed = sims.map((sim, i) => ({ sim, i }))
  indexed.sort((a, b) => b.sim - a.sim)
  const topK = indexed.slice(0, Math.min(KNN_K, resolved.length))

  // Softmax over similarities → attention weights
  const maxSim = topK[0].sim
  const expScores = topK.map(t => Math.exp((t.sim - maxSim) / TEMPERATURE))
  const sumExp = expScores.reduce((a, b) => a + b, 0)
  const weights = expScores.map(e => e / sumExp)

  // V — query each outcome horizon with same attention weights
  const h5 = queryHorizon(weights, topK, resolved, 'outcome5')
  const h15 = queryHorizon(weights, topK, resolved, 'outcome15')
  const h20 = queryHorizon(weights, topK, resolved, 'outcome20')

  // Primary prediction uses 20-min horizon (matches syslog cycle)
  return {
    predictedMove: h20.predictedMove, bullProb: h20.bullProb, bearProb: h20.bearProb,
    topSim: topK[0].sim, confidence: weights[0], nResolved: resolved.length,
    direction: h20.bullProb >= 0.55 ? 'BULL' : h20.bearProb >= 0.55 ? 'BEAR' : null,
    status: 'ready',
    h5, h15, h20,
  }
}

// ── Outcome Resolution (multi-horizon: 5m, 15m, 20m) ────────────────────────

function resolveOutcomes(store: CrudeStore) {
  const now = Date.now()
  for (const pattern of store.patterns) {
    if (pattern.sessionDay !== store.sessionDay) continue

    // Resolve 5-min outcome
    if (pattern.outcome5 === null && now - pattern.ts >= OUTCOME_5_MS) {
      const snap = store.snapshots.find(s => s.ts >= pattern.ts + OUTCOME_5_MS)
      if (snap) pattern.outcome5 = ((snap.price - pattern.price) / pattern.price) * 100
    }

    // Resolve 15-min outcome
    if (pattern.outcome15 === null && now - pattern.ts >= OUTCOME_15_MS) {
      const snap = store.snapshots.find(s => s.ts >= pattern.ts + OUTCOME_15_MS)
      if (snap) pattern.outcome15 = ((snap.price - pattern.price) / pattern.price) * 100
    }

    // Resolve 20-min outcome
    if (pattern.outcome20 === null && now - pattern.ts >= OUTCOME_20_MS) {
      const snap = store.snapshots.find(s => s.ts >= pattern.ts + OUTCOME_20_MS)
      if (snap) pattern.outcome20 = ((snap.price - pattern.price) / pattern.price) * 100
    }
  }
}

// ── Composite Blending ────────────────────────────────────────────────────────

function computeComposite(prediction: CrudePrediction, tech: CrudeTechnicals): CrudeComposite {
  const votes: { score: number; weight: number }[] = []

  // VWAP alignment
  if (tech.vwapAlign) {
    votes.push({ score: tech.vwapAlign === 'BULL' ? 1 : 0, weight: 1.2 })
  }

  // EMA crossover
  if (tech.emaCrossover) {
    votes.push({ score: tech.emaCrossover === 'BULL' ? 1 : 0, weight: 1.0 })
  }

  // RSI
  if (tech.rsi != null) {
    votes.push({ score: Math.max(0, Math.min(1, (tech.rsi - 30) / 40)), weight: 0.8 })
  }

  // Momentum 5m
  if (Math.abs(tech.momentum5m) > 0.0005) {
    votes.push({ score: tech.momentum5m > 0 ? 1 : 0, weight: 1.0 })
  }

  // Range position (near high = bull, near low = bear)
  if (tech.sessionHigh > tech.sessionLow) {
    votes.push({ score: tech.rangePosition, weight: 0.6 })
  }

  // Momentum 1m
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

  // Horizon alignment bonus: when 5m, 15m, 20m all agree on direction, boost confidence
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

// ── SysLog ────────────────────────────────────────────────────────────────────

interface OptInfo { strike: number; type: 'CE' | 'PE'; symbol: string; entryLtp: number }

async function updateSysLog(ps: ProductState, product: CrudeProduct, composite: CrudeComposite, spot: number, chain: ReturnType<typeof getCrudeChain>): Promise<CrudeSysLogEntry[]> {
  ensureSysLogLoaded(ps, product)
  const sysLogStore = ps.sysLogStore
  const now = Date.now()
  const ist = getISTHourMin(now)
  const mins = ist.hour * 60 + ist.minute
  const inWindow = mins >= MCX_OPEN_HOUR * 60 + MCX_OPEN_MIN && mins <= MCX_CLOSE_HOUR * 60 + MCX_CLOSE_MIN

  let changed = false
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
    entry.outcomeMove = currentMove
    entry.outcomeDir = spotDiff > 0 ? 'BULL' : spotDiff < 0 ? 'BEAR' : null
    entry.spotAtOutcome = spot
    entry.resolved = true
    const effectiveDir = entry.predDir ?? moveDir
    entry.correct = effectiveDir !== null && (entry.targetHit === true || effectiveDir === entry.outcomeDir)
    changed = true
  }
  if (changed) {
    persistSysLog(ps, product)
    const lastEntry = sysLogStore.entries[sysLogStore.entries.length - 1]
    if (lastEntry?.resolved && lastEntry.targetHit && now - lastEntry.cycleTs < SYSLOG_CYCLE_MS) {
      sysLogStore.lastCycleTs = 0
    }
  }

  // Minimum quality filters: skip noise predictions
  const dirProb = Math.max(composite.bullProb, composite.bearProb)
  const hasConviction = composite.confidence >= 0.20 || dirProb >= 0.65 || Math.abs(composite.predictedMove) >= 0.08

  if (inWindow && now - sysLogStore.lastCycleTs >= SYSLOG_CYCLE_MS && composite.status === 'ready' && spot > 0 && hasConviction) {
    const currentDay = new Date(now + 5.5 * 3600_000).toISOString().slice(0, 10)

    // Fetch ATM option LTP right here — avoids timing gap when lastCycleTs resets mid-call
    let optInfo: OptInfo | null = null
    const optDir = composite.direction ?? (composite.predictedMove > 0 ? 'BULL' : composite.predictedMove < 0 ? 'BEAR' : null)
    if (chain && optDir) {
      const atm = chain.atmStrike
      const optList = optDir === 'BULL' ? chain.calls : chain.puts
      const atmOpt = optList.find(o => o.strike === atm)
      if (atmOpt) {
        try {
          const ltpKey = `MCX:${atmOpt.tradingsymbol}`
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
      predDir: composite.direction,
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
    })
    if (sysLogStore.entries.length > MAX_SYSLOG) {
      sysLogStore.entries = sysLogStore.entries.slice(-MAX_SYSLOG)
    }
    sysLogStore.lastCycleTs = now
    persistSysLog(ps, product)
  }

  return sysLogStore.entries.slice(-30)
}

// ── Main Entry Point ──────────────────────────────────────────────────────────

export async function getCrudeState(product: CrudeProduct = 'CRUDEOIL'): Promise<CrudeState> {
  startBackgroundAccumulator()
  const ps = getProductState(product)
  const store = ps.store
  ensureLoaded(ps, product)

  const now = Date.now()
  const ist = getISTHourMin(now)
  const mins = ist.hour * 60 + ist.minute
  const marketOpen = mins >= MCX_OPEN_HOUR * 60 + MCX_OPEN_MIN && mins <= MCX_CLOSE_HOUR * 60 + MCX_CLOSE_MIN
  const currentDay = new Date(now + 5.5 * 3600_000).toISOString().slice(0, 10)

  const future = getNearestCrudeFuture(product)
  if (!future) return emptyState(product, marketOpen)

  // Read tick-by-tick data from bot's WebSocket feed (crude-state.json)
  // Falls back to Kite REST API if bot isn't running
  let spot = 0
  let depth: CrudeState['depth'] | undefined
  let volume = 0
  let oi = 0

  const CRUDE_STATE_FILE = path.join('/workspace/option-trader', 'crude-state.json')
  try {
    const raw = fs.readFileSync(CRUDE_STATE_FILE, 'utf8')
    const csData = JSON.parse(raw)
    const productData = csData?.products?.[product]
    if (productData && productData.ltp > 0 && Date.now() - (csData.updatedAt ?? 0) < 30_000) {
      spot = productData.ltp
      depth = productData.depth
      volume = productData.volume ?? 0
      oi = productData.oi ?? 0
    }
  } catch { /* file not found or stale — fall through to REST */ }

  // Fallback: Kite REST API (when bot isn't running)
  if (spot <= 0) {
    try {
      const quoteKey = `MCX:${future.tradingsymbol}`
      const quote = await kiteGetQuote([quoteKey])
      const q = quote[quoteKey]
      if (q) {
        spot = q.last_price
        depth = q.depth
        volume = q.volume ?? 0
        oi = q.oi ?? 0
      }
    } catch {
      try {
        const ltpKey = `MCX:${future.tradingsymbol}`
        const ltpData = await kiteGetLTP([ltpKey])
        spot = ltpData[ltpKey]?.last_price ?? 0
      } catch { /* both failed */ }
    }
  }

  if (spot <= 0) return emptyState(product, marketOpen)

  // Warm indicators from historical data
  if (!ps.engineWarmed || now - ps.lastWarmTs > 300_000) {
    if (!ps.warmingPromise) {
      ps.warmingPromise = warmIndicators(ps, future.instrumentToken).finally(() => { ps.warmingPromise = null })
    }
    if (!ps.engineWarmed) {
      await ps.warmingPromise
    }
  }

  // Session management
  if (store.sessionDay !== currentDay) {
    // Mark stale unresolved patterns from prior sessions as flat (cleanup)
    for (const p of store.patterns) {
      if (p.sessionDay !== currentDay) {
        if (p.outcome5 === null) p.outcome5 = 0
        if (p.outcome15 === null) p.outcome15 = 0
        if (p.outcome20 === null) p.outcome20 = 0
      }
    }
    store.sessionDay = currentDay
    store.sessionOpen = spot
    store.sessionHigh = spot
    store.sessionLow = spot
    store.snapshots = []
    store.priceHistory = []
    ps.indicatorEngine.resetSession()
    persist(ps, product) // save cleaned patterns
  }
  if (store.sessionOpen <= 0) store.sessionOpen = spot

  // Track full-session high/low
  if (spot > store.sessionHigh) store.sessionHigh = spot
  if (spot < store.sessionLow || store.sessionLow === 0) store.sessionLow = spot

  // Update indicators
  const ind = ps.indicatorEngine.update(now, spot, volume)

  // Track price history for momentum
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

  const technicals: CrudeTechnicals = {
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

  // Snapshot + pattern store (only during market hours to avoid stale-price pollution)
  if (marketOpen && now - store.lastSnapshotTs >= SNAPSHOT_INTERVAL_MS) {
    store.snapshots.push({ ts: now, vec, price: spot, proxy })
    if (store.snapshots.length > MAX_SNAPSHOTS) store.snapshots = store.snapshots.slice(-MAX_SNAPSHOTS)
    store.lastSnapshotTs = now

    store.patterns.push({ ts: now, vec, price: spot, proxy, outcome5: null, outcome15: null, outcome20: null, sessionDay: currentDay })
    if (store.patterns.length > MAX_PATTERNS) store.patterns = store.patterns.slice(-MAX_PATTERNS)
  }

  resolveOutcomes(store)
  const prediction = queryAttention(vec, store)

  if (now - store.lastPersistTs >= PERSIST_INTERVAL_MS) {
    persist(ps, product)
  }

  const composite = computeComposite(prediction, technicals)
  const chain = getCrudeChain(spot, product, 5)

  const sysLog = await updateSysLog(ps, product, composite, spot, chain)

  if (chain) {
    try {
      const { fetchChainOI } = await import('./crudeContracts')
      chain.oiAnalytics = (await fetchChainOI(chain)) ?? undefined
    } catch {}
  }

  const minutesAccumulated = store.snapshots.length > 1
    ? Math.round((store.snapshots[store.snapshots.length - 1].ts - store.snapshots[0].ts) / 60_000)
    : 0

  return {
    prediction, technicals, composite,
    snapshotCount: store.snapshots.length,
    patternCount: store.patterns.length,
    resolvedCount: store.patterns.filter(p => p.outcome20 !== null).length,
    proxy, minutesAccumulated, sysLog, chain,
    spot, futureSymbol: future.tradingsymbol, futureToken: future.instrumentToken,
    product, marketOpen, depth,
  }
}

// ── Background Accumulator ────────────────────────────────────────────────────
// Runs every 60s regardless of browser activity so patterns accumulate during
// the full MCX session (9:00–23:30) even when no tab is open.

let _bgStarted = false

function startBackgroundAccumulator() {
  if (_bgStarted) return
  _bgStarted = true
  setInterval(async () => {
    try { await getCrudeState('CRUDEOIL') } catch { /* ignore */ }
    try { await getCrudeState('CRUDEOILM') } catch { /* ignore */ }
  }, 60_000)
}

function emptyState(product: CrudeProduct, marketOpen: boolean): CrudeState {
  return {
    prediction: { predictedMove: 0, bullProb: 0.5, bearProb: 0.5, topSim: 0, confidence: 0, nResolved: 0, direction: null, status: 'no_data', h5: null, h15: null, h20: null },
    technicals: { rsi: null, emaShort: null, emaLong: null, emaCrossover: null, vwap: null, vwapAlign: null, atr: null, atrPct: null, momentum1m: 0, momentum5m: 0, sessionHigh: 0, sessionLow: 0, rangePosition: 0.5, volume: 0, oi: 0 },
    composite: { predictedMove: 0, bullProb: 0.5, bearProb: 0.5, direction: null, confidence: 0, status: 'no_data', components: { patternWeight: 0, techWeight: 0, patternBullProb: 0.5, techBullScore: 0.5 } },
    snapshotCount: 0, patternCount: 0, resolvedCount: 0, proxy: 0, minutesAccumulated: 0,
    sysLog: [], chain: null, spot: 0, futureSymbol: '', futureToken: 0, product, marketOpen,
  }
}
