import fs from 'fs'
import path from 'path'
import type { StockState, StockStateFile } from './stockState'
import { readStockState } from './stockState'

// ── NIFTY 50 Constituents (May 2026) ───────────────────────────────────────

export const NIFTY50_STOCKS = [
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
] as const

const FEATURES_PER_STOCK = 6
const VEC_DIM = NIFTY50_STOCKS.length * FEATURES_PER_STOCK

const PATTERN_FILE = path.join('/workspace/option-trader', 'nifty50-patterns.json')
const SNAPSHOT_INTERVAL_MS = 60_000
const MAX_SNAPSHOTS = 120
const MAX_PATTERNS = 1000
const OUTCOME_HORIZON_MS = 20 * 60_000
const TEMPERATURE = 0.3
const KNN_K = 30
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

export interface N50State {
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

// ── Singleton Store ────────────────────────────────────────────────────────

let store: Store = {
  snapshots: [],
  patterns: [],
  lastSnapshotTs: 0,
  lastPersistTs: 0,
  sessionDay: null,
  sessionPrices: {},
}

let loaded = false

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

  return {
    prediction,
    snapshotCount: store.snapshots.length,
    patternCount: store.patterns.length,
    resolvedCount: store.patterns.filter(p => p.outcome20 !== null).length,
    niftyProxy: proxy,
    bullStockPct: totalStocks > 0 ? Math.round((bullStocks / totalStocks) * 100) : 0,
    bearStockPct: totalStocks > 0 ? Math.round((bearStocks / totalStocks) * 100) : 0,
    coverageCount: count,
    minutesAccumulated,
  }
}

export function persistN50() {
  persist()
}

function emptyState(): N50State {
  return {
    prediction: {
      predictedMove: 0, bullProb: 0.5, bearProb: 0.5,
      topSim: 0, confidence: 0, nResolved: 0,
      direction: null, status: 'no_data',
    },
    snapshotCount: 0, patternCount: 0, resolvedCount: 0,
    niftyProxy: 0, bullStockPct: 0, bearStockPct: 0,
    coverageCount: 0, minutesAccumulated: 0,
  }
}
