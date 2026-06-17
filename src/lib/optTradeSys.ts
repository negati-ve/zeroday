// Paper trading system for NIFTY options — 5 lots, phase-aware entry/exit
// State persisted to /workspace/option-trader/opt-trade-sys.json

import fs from 'fs'
import type { PhaseAnalysis, MetaRegimeData, NiftyV2, NiftyComposite, NiftyTechnicals, NiftyFutChain } from './niftyFut'

const STATE_FILE = '/workspace/option-trader/opt-trade-sys.json'
const LOTS        = 5
const MAX_HISTORY = 30

// Target multipliers by phase+alignment
const TARGET_MULT: Record<string, number> = {
  'START_HIDDEN':  2.5,
  'START_VISIBLE': 2.0,
  'START_NEUTRAL': 1.8,
  'MID_HIDDEN':    2.0,
  'MID_VISIBLE':   1.8,
  'MID_NEUTRAL':   1.5,
  'END_ANY':       1.3,
}
const HARD_STOP_MULT = 0.50   // 50% of premium = max loss per position

export interface OTSPosition {
  id:             string
  entryTs:        number
  entryTime:      string           // IST HH:MM
  direction:      'BULL' | 'BEAR'
  optType:        'CE' | 'PE'
  strike:         number
  lots:           number
  lotSize:        number
  entryPrice:     number           // option LTP at entry
  currentPrice:   number           // latest option LTP
  target:         number           // target LTP (dynamic)
  stopLoss:       number           // hard stop LTP
  dynamicStop:    number           // trailing/breakeven stop LTP
  pnl:            number           // unrealised P&L ₹
  peakPnl:        number           // highest unrealised P&L seen
  peakPrice:      number           // option LTP at peak P&L
  holdingMins:    number
  phaseAtEntry:   string
  stabilityAtEntry: string
  obiAlignAtEntry:  string
  entrySignalScore: number
  status:         'OPEN' | 'CLOSED'
  exitTs?:        number
  exitTime?:      string
  exitPrice?:     number
  exitReason?:    string
  closedPnl?:     number
}

export interface OTSDecision {
  action:   'WAIT' | 'ENTER' | 'STAY' | 'TIGHTEN' | 'EXIT_TARGET' | 'EXIT_STOP' | 'EXIT_PHASE'
  reason:   string
  signalScore: number            // 0–6 signals met
  signals:  string[]             // which signals fired
  direction?: 'BULL' | 'BEAR'
  suggestedStrike?:   number
  suggestedType?:     'CE' | 'PE'
  suggestedEntryLtp?: number
  target?:    number
  stopLoss?:  number
}

export interface OTSStats {
  totalTrades: number
  wins:        number
  winRate:     number
  totalPnl:    number
  bestTrade:   number
  worstTrade:  number
  avgTrade:    number
}

export interface OTSState {
  position: OTSPosition | null
  history:  OTSPosition[]
  decision: OTSDecision
  stats:    OTSStats
}

interface Persisted {
  position: OTSPosition | null
  history:  OTSPosition[]
}

// ── Persistence ───────────────────────────────────────────────────────────────

function load(): Persisted {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }
  catch { return { position: null, history: [] } }
}

function save(p: Persisted) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(p)) } catch { /* ignore */ }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function istStr(ts: number): string {
  return new Date(ts + 5.5 * 3_600_000).toISOString().slice(11, 16)
}

function getLtp(
  oi: NiftyFutChain['oiAnalytics'],
  strike: number,
  type: 'CE' | 'PE',
): number {
  if (!oi) return 0
  const row = oi.strikes.find(s => s.strike === strike)
  if (!row) return 0
  return type === 'CE' ? (row.ceLtp ?? 0) : (row.peLtp ?? 0)
}

function atmStrike(spot: number, step: number): number {
  return Math.round(spot / step) * step
}

function targetMult(phase: string, align: string): number {
  if (phase === 'END') return TARGET_MULT['END_ANY']
  const key = `${phase}_${align}`
  return TARGET_MULT[key] ?? 1.5
}

function closePos(pos: OTSPosition, exitPrice: number, now: number, reason: string): OTSPosition {
  const closedPnl = (exitPrice - pos.entryPrice) * pos.lots * pos.lotSize
  return { ...pos, currentPrice: exitPrice, pnl: closedPnl, status: 'CLOSED',
    exitTs: now, exitTime: istStr(now), exitPrice, exitReason: reason, closedPnl }
}

function buildStats(history: OTSPosition[]): OTSStats {
  const closed = history.filter(p => p.status === 'CLOSED')
  const wins   = closed.filter(p => (p.closedPnl ?? 0) > 0).length
  const totalPnl = closed.reduce((s, p) => s + (p.closedPnl ?? 0), 0)
  const pnls   = closed.map(p => p.closedPnl ?? 0)
  return {
    totalTrades: closed.length, wins,
    winRate:    closed.length > 0 ? wins / closed.length : 0,
    totalPnl,
    bestTrade:  pnls.length ? Math.max(...pnls) : 0,
    worstTrade: pnls.length ? Math.min(...pnls) : 0,
    avgTrade:   closed.length > 0 ? totalPnl / closed.length : 0,
  }
}

// ── Main evaluation ───────────────────────────────────────────────────────────

export function computeOTSState(args: {
  spot:        number
  phase:       PhaseAnalysis | null
  metaRegime:  MetaRegimeData | null
  v2:          NiftyV2 | null
  composite:   NiftyComposite
  technicals:  NiftyTechnicals
  chain:       NiftyFutChain | null
  marketOpen:  boolean
}): OTSState {
  const { spot, phase: pa, v2, composite: comp, chain, marketOpen } = args
  const persisted = load()
  let position = persisted.position ? { ...persisted.position } : null

  const now        = Date.now()
  const strikeStep = chain?.strikeStep ?? 50
  const lotSize    = chain?.lotSize    ?? 75
  const oi         = chain?.oiAnalytics

  // ── Refresh current price + P&L for open position ─────────────────────────
  let stateChanged = false
  if (position && position.status === 'OPEN') {
    const ltp = getLtp(oi, position.strike, position.optType)
    if (ltp > 0) {
      position.currentPrice  = ltp
      position.holdingMins   = Math.round((now - position.entryTs) / 60_000)
      position.pnl           = (ltp - position.entryPrice) * position.lots * position.lotSize
      if (position.pnl > position.peakPnl) {
        position.peakPnl   = position.pnl
        position.peakPrice = ltp
      }
      stateChanged = true
    }

    // Auto-close at market end
    if (!marketOpen) {
      const ltp2 = position.currentPrice
      const closed = closePos(position, ltp2, now, 'MARKET_CLOSE')
      persisted.position = null
      persisted.history.unshift(closed)
      if (persisted.history.length > MAX_HISTORY) persisted.history.length = MAX_HISTORY
      save(persisted)
      const dec: OTSDecision = { action: 'EXIT_PHASE', reason: 'Market closed — auto-exit', signalScore: 0, signals: [] }
      return { position: null, history: persisted.history.slice(0, 10), decision: dec, stats: buildStats(persisted.history) }
    }
  }

  // ── Signal scoring ────────────────────────────────────────────────────────
  const oracleDir  = comp.direction
  const v2Dir      = v2?.prediction.direction ?? null
  const cdZ        = v2?.flowState?.cdZScore ?? null
  const cusumAlarm = v2?.flowState?.cusumAlarm ?? null
  const phase      = pa?.phase ?? 'UNKNOWN'
  const stability  = pa?.stability ?? 'NOISY'
  const cdVelTrend = pa?.cdVelTrend ?? 'FLAT'
  const obiAlign   = pa?.obiCdAlignment ?? 'NEUTRAL'

  const signals: string[] = []
  let signalScore = 0

  if (oracleDir) {
    signalScore++; signals.push(`oracle:${oracleDir}`)
  }
  if (v2Dir && v2Dir === oracleDir) {
    signalScore++; signals.push(`v2:${v2Dir}`)
  }
  if (cdZ != null && oracleDir) {
    if ((oracleDir === 'BULL' && cdZ > 0.3) || (oracleDir === 'BEAR' && cdZ < -0.3)) {
      signalScore++; signals.push(`cdZ:${cdZ.toFixed(2)}σ`)
    }
  }
  if (phase === 'START' || phase === 'MID') {
    signalScore++; signals.push(`phase:${phase}`)
  }
  if (stability === 'STABLE' || stability === 'TRANSITIONING') {
    signalScore++; signals.push(`stab:${stability}`)
  }
  if (obiAlign === 'HIDDEN' || obiAlign === 'VISIBLE') {
    signalScore++; signals.push(`align:${obiAlign}`)
  }

  // ── In-trade monitoring ───────────────────────────────────────────────────
  if (position && position.status === 'OPEN') {
    const ltp       = position.currentPrice
    const entryLtp  = position.entryPrice
    const profitPct = entryLtp > 0 ? (ltp - entryLtp) / entryLtp : 0

    // Trailing stop: trail to 72% of peak once profit > 25%
    if (profitPct > 0.25 && position.peakPrice > 0) {
      const trail = position.peakPrice * 0.72
      if (trail > position.dynamicStop) {
        position.dynamicStop = trail
        stateChanged = true
      }
    }
    // Breakeven lock when phase or stability degrades
    const degraded = phase === 'END' || stability === 'NOISY'
    if (degraded && position.dynamicStop < entryLtp * 1.03) {
      position.dynamicStop = entryLtp * 1.03
      stateChanged = true
    }

    const stopHit        = ltp <= position.stopLoss
    const dynStopHit     = position.dynamicStop > position.stopLoss && ltp <= position.dynamicStop
    const targetHit      = ltp >= position.target
    const oracleFlipped  = !!(oracleDir && oracleDir !== position.direction)
    const cdFading       = (position.direction === 'BULL' && cdVelTrend === 'FALLING') ||
                           (position.direction === 'BEAR' && cdVelTrend === 'RISING')
    const fullDegradation = phase === 'END' && cdFading && stability === 'NOISY'

    const exit = (exitPrice: number, reason: string, action: OTSDecision['action']) => {
      const closed = closePos(position!, exitPrice, now, reason)
      persisted.position = null
      persisted.history.unshift(closed)
      if (persisted.history.length > MAX_HISTORY) persisted.history.length = MAX_HISTORY
      save(persisted)
      return {
        position: null,
        history: persisted.history.slice(0, 10),
        decision: { action, reason: `${reason} @ ₹${exitPrice.toFixed(1)}`, signalScore, signals } as OTSDecision,
        stats: buildStats(persisted.history),
      }
    }

    if (targetHit)        return exit(ltp, 'TARGET_HIT', 'EXIT_TARGET')
    if (stopHit)          return exit(ltp, 'HARD_STOP',  'EXIT_STOP')
    if (dynStopHit)       return exit(ltp, 'DYNAMIC_STOP', 'EXIT_STOP')
    if (oracleFlipped)    return exit(ltp, `ORACLE_FLIP→${oracleDir}`, 'EXIT_PHASE')
    if (fullDegradation)  return exit(ltp, 'PHASE_END+cdFade+NOISY', 'EXIT_PHASE')

    // Stay or tighten
    if (stateChanged) { persisted.position = position; save(persisted) }

    const tightenReasons = [
      phase === 'END'        ? 'Phase→END' : '',
      cdFading               ? 'cdVel fading' : '',
      stability === 'NOISY'  ? 'NOISY' : '',
      cusumAlarm && cusumAlarm !== position.direction ? `CUSUM:${cusumAlarm}` : '',
    ].filter(Boolean)

    const action    = tightenReasons.length > 0 ? 'TIGHTEN' : 'STAY'
    const reason    = action === 'STAY'
      ? `Phase:${phase} cdVel:${cdVelTrend} align:${obiAlign} pnl:₹${position.pnl.toFixed(0)}`
      : `Tighten — ${tightenReasons.join(', ')}`

    return { position, history: persisted.history.slice(0, 10),
      decision: { action, reason, signalScore, signals }, stats: buildStats(persisted.history) }
  }

  // ── Entry evaluation ──────────────────────────────────────────────────────
  if (!marketOpen) {
    const dec: OTSDecision = { action: 'WAIT', reason: 'Market closed', signalScore, signals }
    return { position: null, history: persisted.history.slice(0, 10), decision: dec, stats: buildStats(persisted.history) }
  }

  const canEnter = signalScore >= 4 && !!oracleDir && (phase === 'START' || phase === 'MID')
  if (!canEnter) {
    const reason = !oracleDir
      ? `No oracle direction (score ${signalScore}/6)`
      : signalScore < 4
        ? `Signal ${signalScore}/6 — need ≥4 (missing: ${6 - signalScore})`
        : `Phase ${phase} — need START/MID`
    const dec: OTSDecision = { action: 'WAIT', reason, signalScore, signals, direction: oracleDir ?? undefined }
    return { position: null, history: persisted.history.slice(0, 10), decision: dec, stats: buildStats(persisted.history) }
  }

  const dir    = oracleDir!
  const type: 'CE' | 'PE' = dir === 'BULL' ? 'CE' : 'PE'
  const strike = atmStrike(spot, strikeStep)
  const entryLtp = getLtp(oi, strike, type)

  if (entryLtp <= 0) {
    const dec: OTSDecision = { action: 'WAIT', reason: `No LTP for ${strike}${type} — chain not loaded`, signalScore, signals }
    return { position: null, history: persisted.history.slice(0, 10), decision: dec, stats: buildStats(persisted.history) }
  }

  const mult     = targetMult(phase, obiAlign)
  const target   = entryLtp * mult
  const stopLoss = entryLtp * (1 - HARD_STOP_MULT)

  const newPos: OTSPosition = {
    id: `ots-${now}`,
    entryTs: now, entryTime: istStr(now),
    direction: dir, optType: type, strike,
    lots: LOTS, lotSize,
    entryPrice: entryLtp, currentPrice: entryLtp,
    target, stopLoss, dynamicStop: stopLoss,
    pnl: 0, peakPnl: 0, peakPrice: entryLtp,
    holdingMins: 0,
    phaseAtEntry: phase, stabilityAtEntry: stability, obiAlignAtEntry: obiAlign,
    entrySignalScore: signalScore,
    status: 'OPEN',
  }

  persisted.position = newPos
  save(persisted)

  const dec: OTSDecision = {
    action: 'ENTER',
    reason: `${dir} ${strike}${type} @ ₹${entryLtp.toFixed(1)} | tgt ₹${target.toFixed(1)} (${mult}×) | stop ₹${stopLoss.toFixed(1)}`,
    signalScore, signals, direction: dir,
    suggestedStrike: strike, suggestedType: type, suggestedEntryLtp: entryLtp,
    target, stopLoss,
  }
  return { position: newPos, history: persisted.history.slice(0, 10), decision: dec, stats: buildStats(persisted.history) }
}
