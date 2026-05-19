import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { DatabaseSync } from 'node:sqlite'
import path from 'path'
import fs from 'fs'
import { IndicatorEngine } from '@/lib/indicators'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const TICKS_DB = path.join('/workspace/option-trader/data', 'ticks.db')
const PATTERN_BASE_DIR = '/workspace/option-trader'

const STOCK_META: Record<string, { lotSize: number; strikeStep: number }> = {
  'NSE:HDFCBANK': { lotSize: 550, strikeStep: 5 },
  'NSE:INFY': { lotSize: 400, strikeStep: 20 },
  'NSE:ICICIBANK': { lotSize: 700, strikeStep: 10 },
  'NSE:WIPRO': { lotSize: 3000, strikeStep: 5 },
  'NSE:HCLTECH': { lotSize: 350, strikeStep: 10 },
  'NSE:KOTAKBANK': { lotSize: 2000, strikeStep: 5 },
  'NSE:BAJFINANCE': { lotSize: 750, strikeStep: 10 },
  'NSE:AXISBANK': { lotSize: 625, strikeStep: 10 },
  'NSE:SUNPHARMA': { lotSize: 350, strikeStep: 20 },
  'NSE:RELIANCE': { lotSize: 500, strikeStep: 10 },
  'NSE:LT': { lotSize: 175, strikeStep: 20 },
  'NSE:INDUSTOWER': { lotSize: 1700, strikeStep: 5 },
  'NSE:DIXON': { lotSize: 125, strikeStep: 50 },
  'NSE:HINDUNILVR': { lotSize: 300, strikeStep: 10 },
  'NSE:INDIGO': { lotSize: 300, strikeStep: 25 },
  'NSE:LODHA': { lotSize: 750, strikeStep: 5 },
  'NSE:MANKIND': { lotSize: 250, strikeStep: 25 },
  'NSE:PRESTIGE': { lotSize: 438, strikeStep: 5 },
  'NSE:TITAN': { lotSize: 375, strikeStep: 10 },
  'NSE:TCS': { lotSize: 175, strikeStep: 25 },
  'NSE:SBIN': { lotSize: 1500, strikeStep: 5 },
}
const ATM_DELTA = 0.5

// ── Pattern memory helpers ──────────────────────────────────────────────────

function vecCosineSim(a: number[], b: number[]): number {
  let dot = 0, mA = 0, mB = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) { dot += a[i]*b[i]; mA += a[i]**2; mB += b[i]**2 }
  const d = Math.sqrt(mA) * Math.sqrt(mB)
  return d > 0 ? dot / d : 0
}

/**
 * Build a 12-dim state vector from signal_ticks columns.
 * Uses new columns (ema_agg, depth_bid/ask_qty, cd_vel_z_score, cosine_bull,
 * vp_val/vah, cusum_cp/cn) when available; falls back to 0 for historical data.
 */
function buildVectorFromTick(
  tick: {
    imbalance: number; mp_edge_ticks: number; bid_qpo: number; ask_qpo: number;
    cum_delta: number; poc_dev: number; price: number;
    ema_agg: number | null; depth_bid_qty: number | null; depth_ask_qty: number | null;
    cd_z_score: number | null; cd_vel_z_score: number | null; cosine_bull: number | null;
    vp_val: number | null; vp_vah: number | null; cusum_cp: number | null; cusum_cn: number | null;
  },
  cdZScoreFallback: number,
  ret60: number,
): number[] {
  const c = (v: number) => Math.max(-1, Math.min(1, Number.isFinite(v) ? v : 0))
  const qpoSum = (tick.bid_qpo || 0) + (tick.ask_qpo || 0)
  const bidQpoNorm = qpoSum > 0 ? ((tick.bid_qpo || 0) - (tick.ask_qpo || 0)) / qpoSum : 0

  // Use DB columns when available, fall back to approximations
  const aggRatio = tick.ema_agg ?? 0
  const depthBid = tick.depth_bid_qty ?? 0
  const depthAsk = tick.depth_ask_qty ?? 0
  const depthSum = depthBid + depthAsk
  const depthAsymm = depthSum > 0 ? (depthBid - depthAsk) / depthSum : 0
  const cdZ = tick.cd_z_score ?? cdZScoreFallback
  const cdVelZ = tick.cd_vel_z_score ?? 0
  const hvnClearance = (Math.abs(tick.poc_dev || 0) - 0.003) / 0.005

  // vaPosition from value area bounds
  let vaPosition = 0
  if (tick.vp_val != null && tick.vp_vah != null && tick.vp_vah > tick.vp_val) {
    const vaMid = (tick.vp_val + tick.vp_vah) / 2
    const vaHalf = (tick.vp_vah - tick.vp_val) / 2
    vaPosition = vaHalf > 0 ? (tick.price - vaMid) / vaHalf : 0
  }

  const cosineBull = tick.cosine_bull ?? 0

  // cusumNet from cp/cn
  const cusumH = 2.0 // default CUSUM_H
  const cusumNet = (tick.cusum_cp != null && tick.cusum_cn != null)
    ? ((tick.cusum_cp - tick.cusum_cn) / Math.max(cusumH, 1))
    : 0

  return [
    c(tick.imbalance || 0),          // dim 0: OBI
    c((tick.mp_edge_ticks || 0) * 0.5), // dim 1: mpEdgeTicks/2
    c(aggRatio),                     // dim 2: aggRatio
    c(bidQpoNorm),                   // dim 3: bidQpoNorm
    c(depthAsymm),                   // dim 4: depthAsymm
    c(cdZ / 3),                      // dim 5: cdZScore/3
    c(cdVelZ / 3),                   // dim 6: cdVelZScore/3
    c(ret60 * 200),                  // dim 7: momentum
    c(hvnClearance),                 // dim 8: hvnClearance
    c(vaPosition),                   // dim 9: vaPosition
    c(cosineBull),                   // dim 10: cosineBull
    c(cusumNet),                     // dim 11: cusumNet
  ]
}

interface PatternEntry { vec: number[]; outcome: number; ts: number }

/**
 * Lightweight pattern query — same algorithm as PatternStore.query.
 * Recency-decayed cosine similarity, softmax-weighted outcome prediction.
 */
function queryPatterns(
  queryVec: number[],
  patterns: PatternEntry[],
  k = 20,
  temperature = 0.15,
  now = Date.now(),
  decayLambda = 0.005,
): { bullProb: number; bearProb: number; predictedMove: number; topSim: number } | null {
  if (patterns.length < 10) return null

  const scored = patterns
    .map(p => {
      const rawSim = vecCosineSim(queryVec, p.vec)
      const ageDays = (now - p.ts) / 86_400_000
      return { sim: rawSim * Math.exp(-decayLambda * ageDays), outcome: p.outcome }
    })
    .sort((a, b) => b.sim - a.sim)
    .slice(0, Math.min(k, patterns.length))

  const rawScores = scored.map(x => x.sim / temperature)
  const maxRaw = Math.max(...rawScores)
  const expS = rawScores.map(s => Math.exp(s - maxRaw))
  const Z = expS.reduce((a, b) => a + b, 0)
  const weights = expS.map(e => e / Z)

  let predictedMove = 0, bullProb = 0, bearProb = 0
  for (let i = 0; i < scored.length; i++) {
    predictedMove += weights[i] * scored[i].outcome
    if (scored[i].outcome > 0) bullProb += weights[i]
    else bearProb += weights[i]
  }

  return { bullProb, bearProb, predictedMove, topSim: scored[0].sim }
}

/** Map store type to filename prefix and outcome field in pattern JSON. */
const PATTERN_STORE_MAP: Record<string, { prefix: string; outcomeField: string }> = {
  'pat5':     { prefix: 'patterns',       outcomeField: 'outcome5' },
  'pat15':    { prefix: 'patterns_15m',   outcomeField: 'outcome15' },
  'pat30v2':  { prefix: 'patterns_30v2',  outcomeField: 'outcome30' },
  'pat30_5':  { prefix: 'patterns_30_5m', outcomeField: 'outcome5' },
  'pat60_20': { prefix: 'patterns_60_20m',outcomeField: 'outcome15' },
}

/**
 * Load a single pattern store from disk.
 * Returns array of { vec, outcome, ts } for resolved patterns only.
 */
function loadPatternStore(stock: string, storeType: string): PatternEntry[] {
  const conf = PATTERN_STORE_MAP[storeType]
  if (!conf) return []

  // stock comes in as "NSE:INFY" — extract the ticker part
  const ticker = stock.replace(/^NSE:/, '').replace(/[^A-Za-z0-9]/g, '_')
  const filePath = path.join(PATTERN_BASE_DIR, `${conf.prefix}_NSE_${ticker}.json`)

  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    const data = JSON.parse(raw)
    return (data.buf || [])
      .filter((p: any) => p[conf.outcomeField] != null && p.vec && Array.isArray(p.vec))
      .map((p: any) => ({ vec: p.vec as number[], outcome: p[conf.outcomeField] as number, ts: p.ts as number }))
  } catch {
    return []
  }
}

// ── Config type ─────────────────────────────────────────────────────────────

interface BacktestConfig {
  stocks: string[]
  startDate: string          // ISO date
  endDate: string            // ISO date
  direction: 'BULL' | 'BEAR' | 'BOTH'
  // Entry filters (each has enabled flag)
  minConfirm: number
  minObi: number
  minMpEdgeTicks: number
  minScore: number
  cdRequired: boolean
  minPocDev: number
  cooldownMin: number
  maxPositions: number
  // Exit strategy
  takeProfitEnabled: boolean
  takeProfitPct: number
  stopLossEnabled: boolean
  stopLossPct: number
  trailEnabled: boolean
  trailTriggerPct: number
  trailPct: number
  maxHoldEnabled: boolean
  maxHoldMin: number
  noProfitEnabled: boolean
  noProfitMin: number
  // Pattern prediction filter
  patternEnabled?: boolean
  patternStore?: string       // 'pat5' | 'pat15' | 'pat30v2' | 'pat30_5' | 'pat60_20'
  patternMinProb?: number     // 0-100, min directional probability
  patternMinMove?: number     // 0-2, min abs predicted % move in signal direction
  patternExitEnabled?: boolean // exit when pattern flips against position
  patternExitStore?: string   // pattern store for exit (defaults to patternStore)
  patternExitProb?: number    // 0-100, opposing prob threshold to trigger exit (default 70)
  optionMode?: boolean        // true = compute ATM option P&L per trade
  // Technical Indicators
  emaFilterEnabled?: boolean
  emaShortPeriod?: number     // default 9
  emaLongPeriod?: number      // default 21
  emaMode?: 'price_above' | 'crossover'
  rsiFilterEnabled?: boolean
  rsiPeriod?: number          // default 14
  rsiOverbought?: number      // default 70
  rsiOversold?: number        // default 30
  vwapFilterEnabled?: boolean
  atrExitEnabled?: boolean
  atrPeriod?: number          // default 14
  atrStopMult?: number        // default 2.0
  atrTargetMult?: number      // default 3.0
}

interface Trade {
  stock: string
  direction: 'BULL' | 'BEAR'
  entryPrice: number
  exitPrice: number
  entryTime: string
  exitTime: string
  pnlPct: number
  holdMin: number
  exitReason: string
  peakPct: number
  patBullProb?: number
  patBearProb?: number
  patPredMove?: number
  patTopSim?: number
  optType?: 'CE' | 'PE'
  strike?: number
  lotSize?: number
  optionPnl?: number
}

interface OpenPosition {
  stock: string
  direction: 'BULL' | 'BEAR'
  entryPrice: number
  entryTs: number
  peakMove: number
  patBullProb?: number
  patBearProb?: number
  patPredMove?: number
  patTopSim?: number
  atrAtEntry?: number
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let config: BacktestConfig
  try {
    config = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!config.stocks || config.stocks.length === 0) {
    return NextResponse.json({ error: 'Select at least one stock' }, { status: 400 })
  }

  let db: DatabaseSync
  try {
    db = new DatabaseSync(TICKS_DB, { readOnly: true } as any)
  } catch (e: any) {
    return NextResponse.json({ error: `Cannot open ticks database: ${e.message}` }, { status: 500 })
  }

  try {
    const startTs = new Date(config.startDate).getTime()
    const endTs = new Date(config.endDate).getTime() + 86400000 // end of day

    // Build placeholders for stocks
    const placeholders = config.stocks.map(() => '?').join(',')
    const sql = `SELECT *
      FROM signal_ticks
      WHERE ts >= ? AND ts <= ? AND stock IN (${placeholders})
      ORDER BY ts ASC`

    const params = [startTs, endTs, ...config.stocks]
    const stmt = db.prepare(sql)
    const rows = stmt.all(...params) as any[]

    // Pre-load pattern stores if pattern filter enabled
    const patternEnabled = config.patternEnabled && config.patternStore
    const patternStores = new Map<string, PatternEntry[]>()
    if (patternEnabled) {
      for (const stock of config.stocks) {
        const patterns = loadPatternStore(stock, config.patternStore!)
        if (patterns.length > 0) patternStores.set(stock, patterns)
      }
    }
    const patMinProb = (config.patternMinProb ?? 60) / 100 // convert % to 0-1

    // Pre-load exit pattern stores (may differ from entry stores)
    const patternExitEnabled = config.patternExitEnabled && (config.patternExitStore || config.patternStore)
    const exitPatternStores = new Map<string, PatternEntry[]>()
    const exitPatternStoreType = config.patternExitStore || config.patternStore || ''
    if (patternExitEnabled) {
      for (const stock of config.stocks) {
        if (exitPatternStoreType === config.patternStore && patternStores.has(stock)) {
          exitPatternStores.set(stock, patternStores.get(stock)!)
        } else {
          const patterns = loadPatternStore(stock, exitPatternStoreType)
          if (patterns.length > 0) exitPatternStores.set(stock, patterns)
        }
      }
    }
    const patExitProb = (config.patternExitProb ?? 70) / 100

    // Indicator engines per stock
    const indicatorEngines = new Map<string, IndicatorEngine>()
    const useIndicators = config.emaFilterEnabled || config.rsiFilterEnabled || config.vwapFilterEnabled || config.atrExitEnabled
    if (useIndicators) {
      for (const stock of config.stocks) {
        indicatorEngines.set(stock, new IndicatorEngine({
          emaShortPeriod: config.emaShortPeriod ?? 9,
          emaLongPeriod: config.emaLongPeriod ?? 21,
          rsiPeriod: config.rsiPeriod ?? 14,
          atrPeriod: config.atrPeriod ?? 14,
        }))
      }
    }
    const rsiOverbought = config.rsiOverbought ?? 70
    const rsiOversold = config.rsiOversold ?? 30
    const atrStopMult = config.atrStopMult ?? 2.0
    const atrTargetMult = config.atrTargetMult ?? 3.0
    const lastSessionDay = new Map<string, number>()

    // Rolling state per stock for building state vectors
    // CD stats: rolling window of cum_delta values for Z-score
    const cdBuffer = new Map<string, number[]>() // stock -> last N cum_delta values
    // Price history: for 60s return
    const priceHistory = new Map<string, { ts: number; price: number }[]>()
    const CD_BUFFER_SIZE = 50
    const PRICE_HISTORY_WINDOW_MS = 65_000 // keep ~65s of prices

    const trades: Trade[] = []
    const positions = new Map<string, OpenPosition>() // stock -> open position
    const cooldowns = new Map<string, number>()       // stock -> last exit ts
    const cooldownMs = config.cooldownMin * 60 * 1000
    const maxHoldMs = config.maxHoldMin * 60 * 1000
    const noProfitMs = config.noProfitMin * 60 * 1000

    for (const row of rows) {
      const stock = row.stock as string
      const ts = row.ts as number
      const price = row.price as number
      if (price == null || price <= 0) continue

      // Update indicator engine
      const volDelta = row.vol_delta as number ?? 0
      let indicators: { emaShort: number | null; emaLong: number | null; rsi: number | null; vwap: number | null; atr: number | null; atrPct: number | null } | null = null
      const indEngine = indicatorEngines.get(stock)
      if (indEngine) {
        const dayNum = Math.floor((ts + 19800000) / 86400000) // IST day boundary
        const prevDay = lastSessionDay.get(stock)
        if (prevDay != null && dayNum !== prevDay) indEngine.resetSession()
        lastSessionDay.set(stock, dayNum)
        indicators = indEngine.update(ts, price, volDelta)
      }

      // Update rolling state for pattern vector building
      if (patternEnabled) {
        // Update CD buffer
        const cd = row.cum_delta as number
        if (cd != null) {
          let buf = cdBuffer.get(stock)
          if (!buf) { buf = []; cdBuffer.set(stock, buf) }
          buf.push(cd)
          if (buf.length > CD_BUFFER_SIZE) buf.shift()
        }
        // Update price history
        let ph = priceHistory.get(stock)
        if (!ph) { ph = []; priceHistory.set(stock, ph) }
        ph.push({ ts, price })
        // Prune old entries
        const cutoff = ts - PRICE_HISTORY_WINDOW_MS
        while (ph.length > 0 && ph[0].ts < cutoff) ph.shift()
      }

      // Check exits first for open position on this stock
      const pos = positions.get(stock)
      if (pos) {
        let movePct: number
        if (pos.direction === 'BULL') {
          movePct = ((price - pos.entryPrice) / pos.entryPrice) * 100
        } else {
          movePct = ((pos.entryPrice - price) / pos.entryPrice) * 100
        }
        if (movePct > pos.peakMove) pos.peakMove = movePct

        const heldMs = ts - pos.entryTs
        let exitReason: string | null = null

        // Take profit
        if (config.takeProfitEnabled && movePct >= config.takeProfitPct) {
          exitReason = 'TakeProfit'
        }
        // Stop loss
        if (!exitReason && config.stopLossEnabled && movePct <= -config.stopLossPct) {
          exitReason = 'StopLoss'
        }
        // Trail stop
        if (!exitReason && config.trailEnabled && pos.peakMove >= config.trailTriggerPct) {
          const trailThreshold = pos.peakMove * (config.trailPct / 100)
          if (movePct < trailThreshold) {
            exitReason = 'Trail'
          }
        }
        // Max hold
        if (!exitReason && config.maxHoldEnabled && heldMs >= maxHoldMs) {
          exitReason = 'MaxHold'
        }
        // No profit
        if (!exitReason && config.noProfitEnabled && heldMs >= noProfitMs && pos.peakMove <= 0) {
          exitReason = 'NoProfit'
        }
        // ATR-based exits
        if (!exitReason && config.atrExitEnabled && pos.atrAtEntry != null && pos.atrAtEntry > 0) {
          const atrPctEntry = (pos.atrAtEntry / pos.entryPrice) * 100
          if (movePct <= -(atrPctEntry * atrStopMult)) {
            exitReason = 'ATR_Stop'
          } else if (movePct >= atrPctEntry * atrTargetMult) {
            exitReason = 'ATR_Target'
          }
        }

        // Pattern reversal exit
        if (!exitReason && patternExitEnabled) {
          const exitPats = exitPatternStores.get(stock)
          if (exitPats && exitPats.length >= 10) {
            const buf = cdBuffer.get(stock)
            let cdZExit = 0
            if (buf && buf.length >= 5) {
              const mean = buf.reduce((a, b) => a + b, 0) / buf.length
              const variance = buf.reduce((a, v) => a + (v - mean) ** 2, 0) / buf.length
              const std = Math.sqrt(variance)
              const cd = row.cum_delta as number
              cdZExit = std > 0 ? (cd - mean) / std : 0
            }
            const ph = priceHistory.get(stock)
            let ret60Exit = 0
            if (ph && ph.length >= 2) {
              ret60Exit = (price - ph[0].price) / ph[0].price
            }
            const exitVec = buildVectorFromTick(
              {
                imbalance: row.imbalance as number,
                mp_edge_ticks: row.mp_edge_ticks as number,
                bid_qpo: row.bid_qpo as number,
                ask_qpo: row.ask_qpo as number,
                cum_delta: row.cum_delta as number,
                poc_dev: row.poc_dev as number,
                price,
                ema_agg: row.ema_agg as number | null,
                depth_bid_qty: row.depth_bid_qty as number | null,
                depth_ask_qty: row.depth_ask_qty as number | null,
                cd_z_score: row.cd_z_score as number | null,
                cd_vel_z_score: row.cd_vel_z_score as number | null,
                cosine_bull: row.cosine_bull as number | null,
                vp_val: row.vp_val as number | null,
                vp_vah: row.vp_vah as number | null,
                cusum_cp: row.cusum_cp as number | null,
                cusum_cn: row.cusum_cn as number | null,
              },
              cdZExit,
              ret60Exit,
            )
            const exitPat = queryPatterns(exitVec, exitPats, 20, 0.15, ts)
            if (exitPat) {
              const opposingProb = pos.direction === 'BULL' ? exitPat.bearProb : exitPat.bullProb
              if (opposingProb >= patExitProb) {
                exitReason = 'PatternReversal'
              }
            }
          }
        }

        if (exitReason) {
          const trade: Trade = {
            stock,
            direction: pos.direction,
            entryPrice: pos.entryPrice,
            exitPrice: price,
            entryTime: new Date(pos.entryTs).toISOString(),
            exitTime: new Date(ts).toISOString(),
            pnlPct: Math.round(movePct * 10000) / 10000,
            holdMin: Math.round(heldMs / 60000 * 10) / 10,
            exitReason,
            peakPct: Math.round(pos.peakMove * 10000) / 10000,
            patBullProb: pos.patBullProb,
            patBearProb: pos.patBearProb,
            patPredMove: pos.patPredMove,
            patTopSim: pos.patTopSim,
          }
          if (config.optionMode) {
            const meta = STOCK_META[stock] ?? { lotSize: 1, strikeStep: 10 }
            trade.optType = pos.direction === 'BULL' ? 'CE' : 'PE'
            trade.strike = trade.optType === 'CE'
              ? Math.floor(pos.entryPrice / meta.strikeStep) * meta.strikeStep
              : Math.ceil(pos.entryPrice / meta.strikeStep) * meta.strikeStep
            trade.lotSize = meta.lotSize
            const underlyingMove = pos.direction === 'BULL' ? (price - pos.entryPrice) : (pos.entryPrice - price)
            trade.optionPnl = Math.round(underlyingMove * ATM_DELTA * meta.lotSize)
          }
          trades.push(trade)
          positions.delete(stock)
          cooldowns.set(stock, ts)
        }
        continue // already processed this tick for this stock's position
      }

      // Check entry conditions
      const sig = row.confirm_sig as string
      if (sig !== 'BULL' && sig !== 'BEAR') continue
      if (config.direction !== 'BOTH' && sig !== config.direction) continue

      const confirmCount = (row.confirm_count as number) || 0
      if (confirmCount < config.minConfirm) continue

      const imbalance = row.imbalance as number
      if (imbalance == null) continue
      if (sig === 'BULL' && imbalance < config.minObi) continue
      if (sig === 'BEAR' && imbalance > -config.minObi) continue

      const mpEdge = row.mp_edge_ticks as number
      if (mpEdge == null) continue
      if (Math.abs(mpEdge) < config.minMpEdgeTicks) continue

      const score = Math.abs(imbalance * mpEdge)
      if (score < config.minScore) continue

      if (config.cdRequired) {
        const cd = row.cum_delta as number
        if (cd == null) continue
        if (sig === 'BULL' && cd < 0) continue
        if (sig === 'BEAR' && cd > 0) continue
      }

      const pocDev = row.poc_dev as number
      if (pocDev != null && Math.abs(pocDev) < config.minPocDev / 100) continue

      // Technical indicator entry filters
      if (indicators) {
        if (config.emaFilterEnabled && indicators.emaShort != null && indicators.emaLong != null) {
          if (config.emaMode === 'crossover') {
            if (sig === 'BULL' && indicators.emaShort <= indicators.emaLong) continue
            if (sig === 'BEAR' && indicators.emaShort >= indicators.emaLong) continue
          } else {
            if (sig === 'BULL' && price < indicators.emaShort) continue
            if (sig === 'BEAR' && price > indicators.emaShort) continue
          }
        }
        if (config.rsiFilterEnabled && indicators.rsi != null) {
          if (sig === 'BULL' && indicators.rsi > rsiOverbought) continue
          if (sig === 'BEAR' && indicators.rsi < rsiOversold) continue
        }
        if (config.vwapFilterEnabled && indicators.vwap != null) {
          if (sig === 'BULL' && price < indicators.vwap) continue
          if (sig === 'BEAR' && price > indicators.vwap) continue
        }
      }

      // Pattern prediction filter
      let patResult: { bullProb: number; bearProb: number; predictedMove: number; topSim: number } | null = null
      if (patternEnabled) {
        const stockPatterns = patternStores.get(stock)
        if (stockPatterns && stockPatterns.length >= 10) {
          // Compute cdZScore from rolling buffer
          const buf = cdBuffer.get(stock)
          let cdZScore = 0
          if (buf && buf.length >= 5) {
            const mean = buf.reduce((a, b) => a + b, 0) / buf.length
            const variance = buf.reduce((a, v) => a + (v - mean) ** 2, 0) / buf.length
            const std = Math.sqrt(variance)
            const cd = row.cum_delta as number
            cdZScore = std > 0 ? (cd - mean) / std : 0
          }
          // Compute ret60 from price history
          const ph = priceHistory.get(stock)
          let ret60 = 0
          if (ph && ph.length >= 2) {
            const oldest = ph[0]
            ret60 = (price - oldest.price) / oldest.price
          }

          const vec = buildVectorFromTick(
            {
              imbalance: row.imbalance as number,
              mp_edge_ticks: row.mp_edge_ticks as number,
              bid_qpo: row.bid_qpo as number,
              ask_qpo: row.ask_qpo as number,
              cum_delta: row.cum_delta as number,
              poc_dev: row.poc_dev as number,
              price,
              ema_agg: row.ema_agg as number | null,
              depth_bid_qty: row.depth_bid_qty as number | null,
              depth_ask_qty: row.depth_ask_qty as number | null,
              cd_z_score: row.cd_z_score as number | null,
              cd_vel_z_score: row.cd_vel_z_score as number | null,
              cosine_bull: row.cosine_bull as number | null,
              vp_val: row.vp_val as number | null,
              vp_vah: row.vp_vah as number | null,
              cusum_cp: row.cusum_cp as number | null,
              cusum_cn: row.cusum_cn as number | null,
            },
            cdZScore,
            ret60,
          )
          patResult = queryPatterns(vec, stockPatterns, 20, 0.15, ts)
          if (patResult) {
            const dirProb = sig === 'BULL' ? patResult.bullProb : patResult.bearProb
            if (dirProb < patMinProb) continue // pattern disagrees with signal
            const minMove = config.patternMinMove ?? 0
            if (minMove > 0) {
              const dirMove = sig === 'BULL' ? patResult.predictedMove : -patResult.predictedMove
              if (dirMove < minMove) continue // predicted move too small or wrong direction
            }
          }
        }
      }

      // Cooldown check
      const lastExit = cooldowns.get(stock)
      if (lastExit && (ts - lastExit) < cooldownMs) continue

      // Max positions check
      if (positions.size >= config.maxPositions) continue

      // Open position
      positions.set(stock, {
        stock,
        direction: sig as 'BULL' | 'BEAR',
        entryPrice: price,
        entryTs: ts,
        peakMove: 0,
        patBullProb: patResult?.bullProb,
        patBearProb: patResult?.bearProb,
        patPredMove: patResult?.predictedMove,
        patTopSim: patResult?.topSim,
        atrAtEntry: indicators?.atr ?? undefined,
      })
    }

    // Force close any remaining open positions at last tick price
    // (they didn't hit any exit condition before data ended)
    // We already processed all rows, so these just get marked as "DataEnd"
    for (const [stock, pos] of positions) {
      // Find the last price we saw for this stock
      let lastPrice = pos.entryPrice
      let lastTs = pos.entryTs
      // Since we iterated all rows, we can't easily go back. Use entry price as fallback.
      // Actually let's scan backwards in rows for last price for this stock
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].stock === stock && rows[i].price > 0) {
          lastPrice = rows[i].price
          lastTs = rows[i].ts
          break
        }
      }
      let movePct: number
      if (pos.direction === 'BULL') {
        movePct = ((lastPrice - pos.entryPrice) / pos.entryPrice) * 100
      } else {
        movePct = ((pos.entryPrice - lastPrice) / pos.entryPrice) * 100
      }
      const trade: Trade = {
        stock,
        direction: pos.direction,
        entryPrice: pos.entryPrice,
        exitPrice: lastPrice,
        entryTime: new Date(pos.entryTs).toISOString(),
        exitTime: new Date(lastTs).toISOString(),
        pnlPct: Math.round(movePct * 10000) / 10000,
        holdMin: Math.round((lastTs - pos.entryTs) / 60000 * 10) / 10,
        exitReason: 'DataEnd',
        peakPct: Math.round(pos.peakMove * 10000) / 10000,
        patBullProb: pos.patBullProb,
        patBearProb: pos.patBearProb,
        patPredMove: pos.patPredMove,
        patTopSim: pos.patTopSim,
      }
      if (config.optionMode) {
        const meta = STOCK_META[stock] ?? { lotSize: 1, strikeStep: 10 }
        trade.optType = pos.direction === 'BULL' ? 'CE' : 'PE'
        trade.strike = trade.optType === 'CE'
          ? Math.floor(pos.entryPrice / meta.strikeStep) * meta.strikeStep
          : Math.ceil(pos.entryPrice / meta.strikeStep) * meta.strikeStep
        trade.lotSize = meta.lotSize
        const underlyingMove = pos.direction === 'BULL' ? (lastPrice - pos.entryPrice) : (pos.entryPrice - lastPrice)
        trade.optionPnl = Math.round(underlyingMove * ATM_DELTA * meta.lotSize)
      }
      trades.push(trade)
    }

    // Compute summary
    const wins = trades.filter(t => t.pnlPct > 0)
    const totalPnl = trades.reduce((s, t) => s + t.pnlPct, 0)
    const avgPnl = trades.length > 0 ? totalPnl / trades.length : 0
    const avgHold = trades.length > 0 ? trades.reduce((s, t) => s + t.holdMin, 0) / trades.length : 0

    // Max drawdown (cumulative P&L curve)
    let cumPnl = 0
    let peakCum = 0
    let maxDd = 0
    for (const t of trades) {
      cumPnl += t.pnlPct
      if (cumPnl > peakCum) peakCum = cumPnl
      const dd = cumPnl - peakCum
      if (dd < maxDd) maxDd = dd
    }

    const totalOptionPnl = config.optionMode ? trades.reduce((s, t) => s + (t.optionPnl ?? 0), 0) : undefined

    // By stock
    const byStock: Record<string, { trades: number; winRate: number; avgPnlPct: number; totalPnlPct: number; totalOptionPnl?: number }> = {}
    for (const t of trades) {
      if (!byStock[t.stock]) byStock[t.stock] = { trades: 0, winRate: 0, avgPnlPct: 0, totalPnlPct: 0 }
      byStock[t.stock].trades++
      byStock[t.stock].totalPnlPct += t.pnlPct
      if (config.optionMode) {
        byStock[t.stock].totalOptionPnl = (byStock[t.stock].totalOptionPnl ?? 0) + (t.optionPnl ?? 0)
      }
    }
    for (const stock of Object.keys(byStock)) {
      const stockTrades = trades.filter(t => t.stock === stock)
      const stockWins = stockTrades.filter(t => t.pnlPct > 0)
      byStock[stock].winRate = stockTrades.length > 0 ? Math.round(stockWins.length / stockTrades.length * 1000) / 1000 : 0
      byStock[stock].avgPnlPct = stockTrades.length > 0 ? Math.round(byStock[stock].totalPnlPct / stockTrades.length * 10000) / 10000 : 0
      byStock[stock].totalPnlPct = Math.round(byStock[stock].totalPnlPct * 10000) / 10000
    }

    // By exit reason
    const byExitReason: Record<string, number> = {}
    for (const t of trades) {
      byExitReason[t.exitReason] = (byExitReason[t.exitReason] || 0) + 1
    }

    const summary = {
      totalTrades: trades.length,
      winRate: trades.length > 0 ? Math.round(wins.length / trades.length * 1000) / 1000 : 0,
      avgPnlPct: Math.round(avgPnl * 10000) / 10000,
      totalPnlPct: Math.round(totalPnl * 10000) / 10000,
      avgHoldMin: Math.round(avgHold * 10) / 10,
      maxDrawdownPct: Math.round(maxDd * 10000) / 10000,
      totalOptionPnl,
      byStock,
      byExitReason,
    }

    db.close()
    return NextResponse.json({ trades, summary })
  } catch (e: any) {
    try { db.close() } catch { /* ignore */ }
    return NextResponse.json({ error: `Backtest error: ${e.message}` }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let db: DatabaseSync
  try {
    db = new DatabaseSync(TICKS_DB, { readOnly: true } as any)
  } catch (e: any) {
    return NextResponse.json({ error: `Cannot open ticks database: ${e.message}` }, { status: 500 })
  }

  try {
    const range = db.prepare('SELECT MIN(ts) as minTs, MAX(ts) as maxTs, COUNT(*) as total FROM signal_ticks').get() as any
    const stocks = db.prepare('SELECT DISTINCT stock FROM signal_ticks ORDER BY stock').all() as any[]
    db.close()
    return NextResponse.json({
      stocks: stocks.map((s: any) => s.stock),
      minDate: new Date(range.minTs).toISOString().slice(0, 10),
      maxDate: new Date(range.maxTs).toISOString().slice(0, 10),
      totalTicks: range.total,
    })
  } catch (e: any) {
    try { db.close() } catch { /* ignore */ }
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
