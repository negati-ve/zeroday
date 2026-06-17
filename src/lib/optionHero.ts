/**
 * optionHero — paper-trade options with 3 OTM legs (NEAR/MID/FAR).
 *
 * Entry: GT-lite signal + momentum confirmation (cdVelRoC ACCELERATING + kNN ALIGNED).
 * Legs:  1 lot each at ATM+1/+2/+3 steps (CE for BULL, PE for BEAR).
 *        Chosen OTM so premium is cheap — affordable to lose entirely.
 * Exit:  momentum-tiered stops (TIGHT/MID/WIDE) per leg.
 *        High adverse momentum → exit at TIGHT stop.
 *        Low adverse momentum → hold to WIDE stop (absorbs squeeze noise).
 *        Profit targets (LOW/MID/HIGH) per leg when moving in direction.
 * Targets: continuously updated from oracle predicted move + GT score strength.
 */

import fs from 'fs'
import path from 'path'
import { kiteGetLTP } from './kite'
import { getISTHourMin, getISTDateStr } from './tradingCalendar'
import { type N50State } from './nifty50'
import { type NiftyOIAnalytics } from './niftyContracts'

// ── Constants ─────────────────────────────────────────────────────────────

const STATE_FILE  = path.join('/workspace/zeroday', 'hero-state.json')
const INSTRUMENTS = path.join('/workspace/option-trader', 'data', 'kite_instruments.csv')
const STRIKE_STEP = 50
const LOT_SIZE    = 65
const MAX_HOLD_MIN = 90
const CLOSE_HOUR  = 15
const CLOSE_MIN   = 20
const BG_INTERVAL = 30_000
const MAX_LOG     = 50
const MAX_CLOSED  = 15

// OTM steps and profit/stop tiers per leg
const LEG_DEF = {
  NEAR: {
    stepsOtm: 1,
    tp: [0.40, 0.85, 1.60],    // +40% / +85% / +160%
    sl: [-0.35, -0.55, -0.75], // TIGHT / MID / WIDE
  },
  MID: {
    stepsOtm: 2,
    tp: [0.75, 1.60, 3.20],
    sl: [-0.40, -0.60, -0.80],
  },
  FAR: {
    stepsOtm: 3,
    tp: [1.30, 3.20, 6.50],
    sl: [-0.45, -0.65, -0.85],
  },
} as const

type LegLabel = 'NEAR' | 'MID' | 'FAR'
type MomTier  = 'TIGHT' | 'MID' | 'WIDE'

// ── Types ─────────────────────────────────────────────────────────────────

export interface HeroLeg {
  label: LegLabel
  symbol: string
  strike: number
  optionType: 'CE' | 'PE'
  lots: number
  entryPremium: number
  entrySpot: number
  entryTs: number
  currentPremium: number
  peakPremium: number
  tpLow: number; tpMid: number; tpHigh: number   // % of entry (e.g. 0.40 = 40%)
  slTight: number; slMid: number; slWide: number  // negative %
  status: 'OPEN' | 'EXITED'
  exitTs?: number
  exitPremium?: number
  exitReason?: string
  pnl?: number
}

export interface HeroPosition {
  id: string
  direction: 'BULL' | 'BEAR'
  entryTs: number
  entrySpot: number
  legs: HeroLeg[]
  gtScoreAtEntry: number
  oracleDirAtEntry: 'BULL' | 'BEAR' | null
  oracleConfAtEntry: number
  phaseAtEntry: string
  oraclePredMoveAtEntry: number
  momTier: MomTier       // current adverse momentum tier
  lastGtScore: number
  totalPnl: number
}

export interface HeroLog {
  ts: number
  act: 'ENTRY' | 'EXIT_LEG' | 'EXIT_ALL' | 'HOLD' | 'SKIP' | 'TIER_CHANGE' | 'ERR'
  msg: string
  pnl?: number
  leg?: LegLabel
  dir?: 'BULL' | 'BEAR'
}

export interface HeroState {
  armed: boolean
  position: HeroPosition | null
  closedPositions: HeroPosition[]
  log: HeroLog[]
  stats: { trades: number; wins: number; pnl: number }
  lastTickTs: number
}

// ── State persistence ─────────────────────────────────────────────────────

function defaultState(): HeroState {
  return {
    armed: false,
    position: null,
    closedPositions: [],
    log: [],
    stats: { trades: 0, wins: 0, pnl: 0 },
    lastTickTs: 0,
  }
}

let _state: HeroState | null = null

export function getHeroState(): HeroState {
  if (_state) return _state
  try {
    _state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as HeroState
    return _state
  } catch {
    _state = defaultState()
    return _state
  }
}

function save(s: HeroState) {
  _state = s
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)) } catch {}
}

function addLog(s: HeroState, entry: HeroLog): HeroLog[] {
  return [...s.log.slice(-(MAX_LOG - 1)), entry]
}

// ── ARM / RESET ───────────────────────────────────────────────────────────

export function armHero(): HeroState {
  const s = getHeroState()
  const next: HeroState = { ...s, armed: true, log: addLog(s, { ts: Date.now(), act: 'SKIP', msg: 'Hero armed' }) }
  save(next)
  return next
}

export function disarmHero(): HeroState {
  const s = getHeroState()
  const next: HeroState = { ...s, armed: false, log: addLog(s, { ts: Date.now(), act: 'SKIP', msg: 'Hero disarmed' }) }
  save(next)
  return next
}

export function resetHeroStats(): HeroState {
  const s = getHeroState()
  const next: HeroState = { ...s, stats: { trades: 0, wins: 0, pnl: 0 }, closedPositions: [], log: [] }
  save(next)
  return next
}

// ── Option contract lookup ─────────────────────────────────────────────────

interface NiftyOpt { tradingsymbol: string; strike: number; expiry: string; instrumentType: 'CE' | 'PE' }

let _instrCache: { data: NiftyOpt[]; ts: number } | null = null

function loadNiftyOpts(): NiftyOpt[] {
  if (_instrCache && Date.now() - _instrCache.ts < 3_600_000) return _instrCache.data
  const opts: NiftyOpt[] = []
  try {
    const raw = fs.readFileSync(INSTRUMENTS, 'utf8')
    for (const line of raw.split('\n')) {
      if (!line.includes('NFO-OPT')) continue
      const c = line.split(',')
      if (c.length < 12 || c[3] !== '"NIFTY"' || c[10] !== 'NFO-OPT') continue
      const sym = c[2]; const expiry = c[5]; const strike = parseFloat(c[6])
      const type = c[9] as 'CE' | 'PE'
      if (!sym || !expiry || isNaN(strike) || (type !== 'CE' && type !== 'PE')) continue
      opts.push({ tradingsymbol: sym, strike, expiry, instrumentType: type })
    }
  } catch {}
  if (opts.length) _instrCache = { data: opts, ts: Date.now() }
  return opts
}

function getExpiry(opts: NiftyOpt[]): string | null {
  const now = Date.now()
  const today = getISTDateStr(now)
  const { hour, minute } = getISTHourMin(now)
  const skipToday = hour > 15 || (hour === 15 && minute >= 30)
  const expiries = [...new Set(opts.map(o => o.expiry))]
    .filter(e => skipToday ? e > today : e >= today)
    .sort()
  return expiries[0] ?? null
}

function selectLegs(spot: number, dir: 'BULL' | 'BEAR'): Array<{ label: LegLabel; symbol: string; strike: number; optionType: 'CE' | 'PE' }> | null {
  const opts = loadNiftyOpts()
  const expiry = getExpiry(opts)
  if (!expiry) return null

  const atm = Math.round(spot / STRIKE_STEP) * STRIKE_STEP
  const expiryOpts = opts.filter(o => o.expiry === expiry)
  const type: 'CE' | 'PE' = dir === 'BULL' ? 'CE' : 'PE'
  const sign = dir === 'BULL' ? 1 : -1
  const labels: LegLabel[] = ['NEAR', 'MID', 'FAR']

  const legs = labels.map(label => {
    const steps = LEG_DEF[label].stepsOtm
    const strike = atm + sign * steps * STRIKE_STEP
    const opt = expiryOpts.find(o => o.strike === strike && o.instrumentType === type)
    if (!opt) return null
    return { label, symbol: opt.tradingsymbol, strike, optionType: type }
  })

  if (legs.some(l => l === null)) return null
  return legs as Array<{ label: LegLabel; symbol: string; strike: number; optionType: 'CE' | 'PE' }>
}

// ── LTP fetch ─────────────────────────────────────────────────────────────

async function fetchLegPrices(legs: HeroLeg[]): Promise<Map<string, number>> {
  const open = legs.filter(l => l.status === 'OPEN')
  if (!open.length) return new Map()
  try {
    const keys = open.map(l => `NFO:${l.symbol}`)
    const data = await kiteGetLTP(keys)
    const m = new Map<string, number>()
    for (const l of open) {
      const p = data[`NFO:${l.symbol}`]?.last_price
      if (p && p > 0) m.set(l.symbol, p)
    }
    return m
  } catch { return new Map() }
}

// ── Entry signal (GT-lite, server-side) ───────────────────────────────────
//
// Score gates: we need ≥3 of 5 confirmations before entering.
// The scoring mirrors computeN50GT from the client but uses only server data.

function computeEntrySignal(n50: N50State, oi: NiftyOIAnalytics | null): {
  enter: boolean
  direction: 'BULL' | 'BEAR' | null
  entryScore: number
  reason: string
} {
  const comp = n50.composite
  const tech = n50.technicals
  const pa   = n50.phaseAnalysis

  const oracleDir = comp.direction
  if (!oracleDir) return { enter: false, direction: null, entryScore: 0, reason: 'oracle neutral' }
  if (comp.confidence < 0.55) return { enter: false, direction: null, entryScore: 0, reason: `oracle conf low ${(comp.confidence*100).toFixed(0)}%` }

  const isBull = oracleDir === 'BULL'
  let score = 0
  const parts: string[] = []

  // 1. Oracle conviction (0–1)
  const oracleScore = Math.min(1, comp.confidence)
  score += oracleScore
  parts.push(`oracle ${(oracleScore*100).toFixed(0)}%`)

  // 2. CD Z-score in direction (0–1)
  const cdDir = isBull ? tech.avgCdZ : -tech.avgCdZ
  if (cdDir > 1.5) { score += 1; parts.push('cdZ strong') }
  else if (cdDir > 0.8) { score += 0.5; parts.push('cdZ moderate') }

  // 3. CUSUM confirmation (0–0.5)
  const cusumDir = isBull ? tech.cusumBullCount : tech.cusumBearCount
  const cusumOpp = isBull ? tech.cusumBearCount : tech.cusumBullCount
  if (cusumDir >= 2 && cusumOpp === 0) { score += 0.5; parts.push('cusum clear') }
  else if (cusumDir >= 1) { score += 0.25; parts.push('cusum partial') }

  // 4. Phase: cdVelZ ACCELERATING in direction (0–0.5)
  if (pa?.cdVelRoCLabel === 'ACCELERATING') {
    const cdVelDir = isBull ? (pa.cdVelRoC > 0) : (pa.cdVelRoC < 0)
    if (cdVelDir) { score += 0.5; parts.push('accel') }
    else { score -= 0.25 }  // decelerating against direction
  }

  // 5. kNN pattern consistency (0–0.5)
  if (pa?.knnConsistency === 'ALIGNED') { score += 0.5; parts.push('kNN aligned') }

  // 6. OBI/CD phase — HIDDEN is OK (accumulation), VISIBLE is better
  if (pa?.obiCdPhase === 'VISIBLE') { score += 0.25; parts.push('visible') }
  else if (pa?.obiCdPhase === 'HIDDEN') { score += 0.1 }  // fine, just harder to see

  // 7. PCR (if available): costly options signal
  if (oi?.pcr != null) {
    const pcr = oi.pcr
    if (isBull && pcr <= 0.75) { score += 0.25; parts.push(`pcr ${pcr.toFixed(2)} call-heavy`) }
    else if (!isBull && pcr >= 1.3) { score += 0.25; parts.push(`pcr ${pcr.toFixed(2)} put-heavy`) }
  }

  // Threshold: score ≥ 2.5 to enter (oracle+cdZ+cusum+accel is ~2.5)
  const enter = score >= 2.5
  return {
    enter,
    direction: enter ? oracleDir : null,
    entryScore: score,
    reason: parts.join(' · '),
  }
}

// ── Adverse momentum tier ─────────────────────────────────────────────────
//
// Determines which SL level to use based on momentum AGAINST our position.
// High adverse momentum → cut fast (TIGHT). Low adverse → give space (WIDE).

function computeAdverseMomTier(n50: N50State, pos: HeroPosition): MomTier {
  const tech = n50.technicals
  const pa   = n50.phaseAnalysis
  const isBull = pos.direction === 'BULL'

  // CD Z-score against position direction
  const adverseCdZ = isBull ? -tech.avgCdZ : tech.avgCdZ

  // cdVelRoC against position
  const cdVelAdverse = pa ? (isBull ? -pa.cdVelRoC : pa.cdVelRoC) : 0

  // GT score drift since entry (negative = score moving against us)
  const scoreDrift = isBull ? pos.lastGtScore - pos.gtScoreAtEntry : pos.gtScoreAtEntry - pos.lastGtScore

  let tier: MomTier = 'WIDE'
  if (adverseCdZ > 2.0 || (adverseCdZ > 1.2 && cdVelAdverse > 0.15)) {
    tier = 'TIGHT'  // strong adverse flow — cut fast
  } else if (adverseCdZ > 0.8 || cdVelAdverse > 0.08 || scoreDrift < -0.15) {
    tier = 'MID'   // moderate — standard stop
  }
  // else WIDE — weak adverse, give the position breathing room (possible squeeze)

  return tier
}

// ── Active SL and TP for a leg at current momentum tier ──────────────────

function activeSL(leg: HeroLeg, tier: MomTier): number {
  return tier === 'TIGHT' ? leg.slTight : tier === 'MID' ? leg.slMid : leg.slWide
}

function activeTPs(leg: HeroLeg, pos: HeroPosition): number[] {
  // Scale targets dynamically based on oracle predicted move vs entry
  // If oracle predicted +0.5% and we entered near, adjust TP multiples
  const scale = pos.oraclePredMoveAtEntry !== 0
    ? Math.max(0.5, Math.min(2.0, Math.abs(pos.oraclePredMoveAtEntry) / 0.3))
    : 1.0
  return [leg.tpLow * scale, leg.tpMid * scale, leg.tpHigh * scale]
}

// ── GT-lite score for position monitoring ─────────────────────────────────

function computeGTLiteScore(n50: N50State, oi: NiftyOIAnalytics | null, spot: number): number {
  const tech = n50.technicals
  const comp = n50.composite
  const pa   = n50.phaseAnalysis

  const cdNorm  = Math.max(-1, Math.min(1, tech.avgCdZ / 3))
  const cTotal  = tech.cusumBullCount + tech.cusumBearCount
  const cusum   = cTotal > 0 ? (tech.cusumBullCount - tech.cusumBearCount) / cTotal : 0
  const microC  = (cdNorm + cusum) / 2
  const orcC    = comp.direction === 'BULL' ? comp.confidence : comp.direction === 'BEAR' ? -comp.confidence : 0

  let mpC = 0, pcrC = 0
  if (oi && spot > 0) {
    if (oi.maxPainStrike) {
      const dist = (oi.maxPainStrike - spot) / spot * 100
      mpC = Math.max(-1, Math.min(1, (dist / 1.5) * Math.min(1, oi.maxPainPull / 30)))
    }
    if (oi.pcr) {
      if (oi.pcr >= 1.5) pcrC = -Math.min(1, (oi.pcr - 1) * 0.7)
      else if (oi.pcr >= 1.2) pcrC = -0.35
      else if (oi.pcr <= 0.6) pcrC = Math.min(1, (1 - oi.pcr) * 0.7)
      else if (oi.pcr <= 0.8) pcrC = 0.35
    }
  }

  const avgCdZ  = tech.avgCdZ
  const avgImb  = tech.avgImbalance
  const chop    = Math.abs(avgCdZ) < 0.3
  const rMult   = chop ? 0.5 : 1.0

  const score = rMult * (0.20 * mpC + 0.20 * pcrC) + 0.25 * orcC + 0.20 * microC
  return Math.max(-1, Math.min(1, score + (pa?.cdVelRoC ?? 0) * 0.15))
}

// ── Main tick processor ───────────────────────────────────────────────────

let _processing = false

export async function processHeroTick(
  n50: N50State,
  spot: number,
  oi: NiftyOIAnalytics | null,
): Promise<HeroState> {
  const s = getHeroState()
  if (!s.armed || _processing || !spot || spot <= 0) return s

  // Market hours gate
  const { hour, minute } = getISTHourMin(Date.now())
  const mins = hour * 60 + minute
  const inHours = mins >= 9 * 60 + 30 && mins <= CLOSE_HOUR * 60 + CLOSE_MIN

  _processing = true
  try {
    if (s.position) {
      return await _handleOpen(s, n50, spot, oi, inHours)
    } else if (inHours) {
      return await _handleEntry(s, n50, spot, oi)
    }
    return s
  } catch (err) {
    const next: HeroState = { ...s, lastTickTs: Date.now(), log: addLog(s, { ts: Date.now(), act: 'ERR', msg: String(err) }) }
    save(next)
    return next
  } finally {
    _processing = false
  }
}

async function _handleEntry(s: HeroState, n50: N50State, spot: number, oi: NiftyOIAnalytics | null): Promise<HeroState> {
  const sig = computeEntrySignal(n50, oi)
  if (!sig.enter || !sig.direction) {
    const next: HeroState = { ...s, lastTickTs: Date.now(), log: addLog(s, { ts: Date.now(), act: 'SKIP', msg: `No entry: score=${sig.entryScore.toFixed(2)} — ${sig.reason}` }) }
    save(next)
    return next
  }

  const legs = selectLegs(spot, sig.direction)
  if (!legs) {
    const next: HeroState = { ...s, lastTickTs: Date.now(), log: addLog(s, { ts: Date.now(), act: 'ERR', msg: 'Contract lookup failed — instruments CSV stale?' }) }
    save(next)
    return next
  }

  // Fetch entry LTPs
  const syms = legs.map(l => `NFO:${l.symbol}`)
  let prices: Record<string, number> = {}
  try {
    const raw = await kiteGetLTP(syms)
    for (const { symbol } of legs) {
      const p = raw[`NFO:${symbol}`]?.last_price
      if (p && p > 0) prices[symbol] = p
    }
  } catch {
    const next: HeroState = { ...s, lastTickTs: Date.now(), log: addLog(s, { ts: Date.now(), act: 'ERR', msg: 'LTP fetch failed at entry' }) }
    save(next)
    return next
  }

  // Build leg objects
  const heroLegs: HeroLeg[] = legs.map(({ label, symbol, strike, optionType }) => {
    const def  = LEG_DEF[label]
    const prem = prices[symbol] ?? 0
    return {
      label, symbol, strike, optionType,
      lots: 1,
      entryPremium: prem,
      entrySpot: spot,
      entryTs: Date.now(),
      currentPremium: prem,
      peakPremium: prem,
      tpLow: def.tp[0], tpMid: def.tp[1], tpHigh: def.tp[2],
      slTight: def.sl[0], slMid: def.sl[1], slWide: def.sl[2],
      status: 'OPEN',
    }
  })

  const gtScore = computeGTLiteScore(n50, oi, spot)
  const pos: HeroPosition = {
    id: `hero-${Date.now()}`,
    direction: sig.direction,
    entryTs: Date.now(),
    entrySpot: spot,
    legs: heroLegs,
    gtScoreAtEntry: gtScore,
    oracleDirAtEntry: n50.composite.direction,
    oracleConfAtEntry: n50.composite.confidence,
    phaseAtEntry: n50.phaseAnalysis?.phase ?? 'UNKNOWN',
    oraclePredMoveAtEntry: n50.composite.predictedMove ?? 0,
    momTier: 'WIDE',
    lastGtScore: gtScore,
    totalPnl: 0,
  }

  const next: HeroState = {
    ...s, position: pos, lastTickTs: Date.now(),
    log: addLog(s, {
      ts: Date.now(), act: 'ENTRY', dir: sig.direction,
      msg: `${sig.direction} score=${sig.entryScore.toFixed(2)} | ${legs.map(l => `${l.label}@${l.strike}`).join(' ')} | ${sig.reason}`,
    }),
  }
  save(next)
  return next
}

async function _handleOpen(s: HeroState, n50: N50State, spot: number, oi: NiftyOIAnalytics | null, inHours: boolean): Promise<HeroState> {
  const pos = s.position!

  // Safety: force-exit at close
  if (!inHours) return _forceExit(s, pos, 'Market close')

  // Safety: max hold
  const heldMin = (Date.now() - pos.entryTs) / 60_000
  if (heldMin >= MAX_HOLD_MIN) return _forceExit(s, pos, `Max hold ${MAX_HOLD_MIN}m`)

  // Update GT-lite score for position monitoring
  const currentGtScore = computeGTLiteScore(n50, oi, spot)
  const updatedPos = { ...pos, lastGtScore: currentGtScore }

  // Compute momentum tier
  const tier = computeAdverseMomTier(n50, updatedPos)
  const tierChanged = tier !== pos.momTier

  // Fetch current LTPs
  const priceMap = await fetchLegPrices(updatedPos.legs)

  let anyExit = false
  let totalPnl = 0
  const logs: HeroLog[] = []

  const updatedLegs = updatedPos.legs.map(leg => {
    if (leg.status === 'EXITED') {
      totalPnl += leg.pnl ?? 0
      return leg
    }

    const curPrem = priceMap.get(leg.symbol) ?? leg.currentPremium
    const peak = Math.max(leg.peakPremium, curPrem)
    const retPct = leg.entryPremium > 0 ? (curPrem - leg.entryPremium) / leg.entryPremium : 0
    const peakRetPct = leg.entryPremium > 0 ? (peak - leg.entryPremium) / leg.entryPremium : 0
    const pnl = (curPrem - leg.entryPremium) * LOT_SIZE * leg.lots

    // Profit target check (use highest reached = peakRetPct)
    const [tpLow, tpMid, tpHigh] = activeTPs(leg, updatedPos)
    let exitReason: string | null = null

    if (peakRetPct >= tpHigh) exitReason = `TP HIGH +${(peakRetPct*100).toFixed(0)}%`
    else if (peakRetPct >= tpMid) exitReason = `TP MID +${(peakRetPct*100).toFixed(0)}%`
    else if (peakRetPct >= tpLow && tier !== 'WIDE') exitReason = `TP LOW +${(peakRetPct*100).toFixed(0)}% [${tier}]`

    // Stop loss check (current premium, not peak)
    if (!exitReason) {
      const sl = activeSL(leg, tier)
      if (retPct <= sl) exitReason = `SL ${tier} ${(retPct*100).toFixed(0)}%`
    }

    // Oracle flipped against position
    if (!exitReason && n50.composite.direction && n50.composite.direction !== updatedPos.direction && n50.composite.confidence > 0.6) {
      if (tier === 'TIGHT') exitReason = `Oracle flip ${n50.composite.direction}`
    }

    if (exitReason) {
      anyExit = true
      const legPnl = pnl
      totalPnl += legPnl
      logs.push({ ts: Date.now(), act: 'EXIT_LEG', leg: leg.label, pnl: legPnl, msg: `${leg.label}@${leg.strike} ${exitReason} pnl=₹${Math.round(legPnl)}` })
      return { ...leg, currentPremium: curPrem, peakPremium: peak, status: 'EXITED' as const, exitTs: Date.now(), exitPremium: curPrem, exitReason, pnl: legPnl }
    }

    totalPnl += pnl
    return { ...leg, currentPremium: curPrem, peakPremium: peak }
  })

  const openLegs = updatedLegs.filter(l => l.status === 'OPEN').length

  // All legs exited — close position
  if (openLegs === 0) {
    return _closePosition(s, { ...updatedPos, legs: updatedLegs, totalPnl, momTier: tier }, logs, 'All legs exited')
  }

  // Update position
  const nextPos: HeroPosition = { ...updatedPos, legs: updatedLegs, totalPnl, momTier: tier }
  let newLog = s.log

  if (tierChanged) {
    newLog = addLog(s, { ts: Date.now(), act: 'TIER_CHANGE', msg: `MomTier ${pos.momTier} → ${tier} | cdZ=${n50.technicals.avgCdZ.toFixed(2)}σ` })
  } else if (anyExit) {
    for (const l of logs) newLog = addLog({ ...s, log: newLog }, l)
  } else {
    newLog = addLog(s, { ts: Date.now(), act: 'HOLD', msg: `Held ${openLegs}/3 open · tier=${tier} · pnl=₹${Math.round(totalPnl)}` })
  }

  const next: HeroState = { ...s, position: nextPos, log: newLog, lastTickTs: Date.now() }
  save(next)
  return next
}

function _forceExit(s: HeroState, pos: HeroPosition, reason: string): HeroState {
  const closedLegs = pos.legs.map(leg => {
    if (leg.status === 'EXITED') return leg
    return { ...leg, status: 'EXITED' as const, exitTs: Date.now(), exitPremium: leg.currentPremium, exitReason: reason, pnl: (leg.currentPremium - leg.entryPremium) * LOT_SIZE * leg.lots }
  })
  const totalPnl = closedLegs.reduce((a, l) => a + (l.pnl ?? 0), 0)
  return _closePosition(s, { ...pos, legs: closedLegs, totalPnl }, [], reason)
}

function _closePosition(s: HeroState, pos: HeroPosition, extraLogs: HeroLog[], reason: string): HeroState {
  const totalPnl = pos.totalPnl
  const isWin = totalPnl > 0
  const closed = [pos, ...s.closedPositions].slice(0, MAX_CLOSED)
  let log = s.log
  for (const l of extraLogs) log = addLog({ ...s, log }, l)
  log = addLog({ ...s, log }, { ts: Date.now(), act: 'EXIT_ALL', dir: pos.direction, pnl: totalPnl, msg: `${reason} | total pnl=₹${Math.round(totalPnl)} | held ${Math.round((Date.now() - pos.entryTs) / 60_000)}m` })

  const next: HeroState = {
    ...s,
    position: null,
    closedPositions: closed,
    log,
    lastTickTs: Date.now(),
    stats: { trades: s.stats.trades + 1, wins: s.stats.wins + (isWin ? 1 : 0), pnl: s.stats.pnl + totalPnl },
  }
  save(next)
  return next
}

// ── Background timer ───────────────────────────────────────────────────────

let _bgStarted = false

export function ensureHeroBackground() {
  if (_bgStarted) return
  _bgStarted = true
  console.log('[optionHero] background timer started — 30s interval')

  setInterval(async () => {
    const s = getHeroState()
    if (!s.armed) return
    try {
      const { kiteGetLTP: _ltp } = await import('./kite')
      const ltpData = await _ltp(['NSE:NIFTY 50'])
      const spot = ltpData['NSE:NIFTY 50']?.last_price
      if (!spot || spot <= 0) return

      const { getN50State } = await import('./nifty50')
      const { getCachedNiftyOI } = await import('./niftyContracts')
      const n50 = getN50State()
      const oi  = getCachedNiftyOI()
      await processHeroTick(n50, spot, oi)
    } catch (err) {
      console.error('[optionHero] bg tick error:', err instanceof Error ? err.message : err)
    }
  }, BG_INTERVAL)
}
