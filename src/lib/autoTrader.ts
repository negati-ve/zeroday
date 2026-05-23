import fs from 'fs'
import path from 'path'
import { kitePlaceOrder, kiteGetQuote, kiteGetLTP } from './kite'
import { getNiftyContracts, type NiftyContracts } from './niftyContracts'
import { getN50State, updateSysLog, type SysLogEntry } from './nifty50'
import { getISTHourMin } from './tradingCalendar'

const STATE_FILE = path.join('/workspace/zeroday', 'syslog-at-state.json')
const COOLDOWN_TICKS = 2
const MAX_HOLD_MIN = 60
const CLOSE_EXIT_HOUR = 15
const CLOSE_EXIT_MIN = 15
const BG_INTERVAL_MS = 30_000

// ── Types ──────────────────────────────────────────────────────────────────

interface ATPos {
  sym: string
  dir: 'BULL' | 'BEAR'
  entry: number
  lot: number
  oid: string
  ts: number
}

interface ATLog {
  ts: number
  act: 'BUY' | 'SELL' | 'HOLD' | 'SKIP' | 'ERR'
  sym?: string
  dir?: string
  price?: number
  oid?: string
  pnl?: number
  msg?: string
}

export interface ATState {
  mode: 'IDLE' | 'ARMED' | 'LIVE' | 'COOLDOWN'
  lastCycle: number
  cd: number
  pos: ATPos | null
  log: ATLog[]
  stats: { n: number; w: number; pnl: number }
  lastProcessedAt: number
}

// ── State persistence ──────────────────────────────────────────────────────

function defaultState(): ATState {
  return { mode: 'IDLE', lastCycle: 0, cd: 0, pos: null, log: [], stats: { n: 0, w: 0, pnl: 0 }, lastProcessedAt: 0 }
}

let cached: ATState | null = null

export function getATState(): ATState {
  if (cached) return cached
  try {
    cached = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    return cached!
  } catch {
    cached = defaultState()
    return cached
  }
}

function save(s: ATState) {
  cached = s
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)) } catch {}
}

function addLog(s: ATState, entry: ATLog): ATLog[] {
  return [...s.log.slice(-30), entry]
}

// ── ARM / DISARM ───────────────────────────────────────────────────────────

export function armAT(): ATState {
  const s = getATState()
  if (s.mode !== 'IDLE') return s
  const next: ATState = { ...s, mode: 'ARMED', log: addLog(s, { ts: Date.now(), act: 'SKIP', msg: 'Armed' }) }
  save(next)
  return next
}

export async function disarmAT(): Promise<ATState> {
  const s = getATState()
  if (s.pos && s.mode === 'LIVE') {
    try {
      const ep = await sellPosition(s.pos)
      const pnl = (ep - s.pos.entry) * s.pos.lot
      const next: ATState = {
        ...s, mode: 'IDLE', pos: null, cd: 0, lastProcessedAt: Date.now(),
        log: addLog(s, { ts: Date.now(), act: 'SELL', sym: s.pos.sym, price: ep, pnl, msg: 'Disarm exit' }),
        stats: { n: s.stats.n + 1, w: s.stats.w + (pnl > 0 ? 1 : 0), pnl: s.stats.pnl + pnl },
      }
      save(next)
      return next
    } catch (err) {
      const next: ATState = {
        ...s, mode: 'IDLE', pos: null, cd: 0, lastProcessedAt: Date.now(),
        log: addLog(s, { ts: Date.now(), act: 'ERR', msg: `Disarm sell failed: ${err}` }),
      }
      save(next)
      return next
    }
  }
  const next: ATState = { ...s, mode: 'IDLE', pos: null, cd: 0, lastProcessedAt: Date.now(), log: addLog(s, { ts: Date.now(), act: 'SKIP', msg: 'Disarmed' }) }
  save(next)
  return next
}

export function resetATStats(): ATState {
  const s = getATState()
  const next: ATState = { ...s, stats: { n: 0, w: 0, pnl: 0 }, log: [] }
  save(next)
  return next
}

// ── Order helpers ──────────────────────────────────────────────────────────

let orderLock = false

async function sellPosition(pos: ATPos): Promise<number> {
  if (orderLock) throw new Error('Order lock — another order in progress')
  orderLock = true
  try {
    const quote = await kiteGetQuote([`NFO:${pos.sym}`])
    const q = quote[`NFO:${pos.sym}`]
    const bestBid = q?.depth?.buy?.[0]?.price ?? 0

    if (bestBid > 0) {
      await kitePlaceOrder({
        exchange: 'NFO', tradingsymbol: pos.sym,
        transaction_type: 'SELL', quantity: pos.lot,
        product: 'NRML', order_type: 'LIMIT', price: bestBid,
      })
      return bestBid
    }
    await kitePlaceOrder({
      exchange: 'NFO', tradingsymbol: pos.sym,
      transaction_type: 'SELL', quantity: pos.lot,
      product: 'NRML', order_type: 'MARKET', price: 0,
    })
    return 0
  } finally { orderLock = false }
}

async function buyContract(sym: string, lot: number): Promise<{ oid: string; price: number }> {
  if (orderLock) throw new Error('Order lock — another order in progress')
  orderLock = true
  try {
    const quote = await kiteGetQuote([`NFO:${sym}`])
    const q = quote[`NFO:${sym}`]
    const bestAsk = q?.depth?.sell?.[0]?.price ?? 0
    if (bestAsk <= 0) throw new Error('No ask price — market closed?')

    const result = await kitePlaceOrder({
      exchange: 'NFO', tradingsymbol: sym,
      transaction_type: 'BUY', quantity: lot,
      product: 'NRML', order_type: 'LIMIT', price: bestAsk,
    })
    return { oid: result.order_id, price: bestAsk }
  } finally { orderLock = false }
}

// ── Core tick processor ────────────────────────────────────────────────────

let processing = false

export async function processATTick(sysLog: SysLogEntry[], contracts: NiftyContracts | null): Promise<ATState> {
  const s = getATState()
  if (s.mode === 'IDLE' || processing) return s
  if (!sysLog?.length) return s

  const latest = sysLog.reduce((a, b) => a.cycleTs > b.cycleTs ? a : b)

  if (latest.cycleTs <= s.lastCycle) {
    return await checkSafetyGuards(s)
  }

  processing = true
  try {
    if (s.mode === 'ARMED') {
      return await handleArmed(s, latest, contracts)
    } else if (s.mode === 'LIVE' && s.pos) {
      return await handleLive(s, latest)
    } else if (s.mode === 'COOLDOWN') {
      return handleCooldown(s, latest)
    }
    return s
  } catch (err) {
    const next: ATState = { ...s, lastCycle: latest.cycleTs, lastProcessedAt: Date.now(), log: addLog(s, { ts: Date.now(), act: 'ERR', msg: String(err) }) }
    save(next)
    return next
  } finally { processing = false }
}

async function handleArmed(s: ATState, entry: SysLogEntry, contracts: NiftyContracts | null): Promise<ATState> {
  if (!entry.predDir || !contracts) {
    const next: ATState = { ...s, lastCycle: entry.cycleTs, lastProcessedAt: Date.now(), log: addLog(s, { ts: Date.now(), act: 'SKIP', msg: entry.predDir ? 'No contracts' : 'Neutral — skip' }) }
    save(next)
    return next
  }

  const opt = (entry.predDir === 'BULL' ? contracts.bull : contracts.bear)[0]
  if (!opt) {
    const next: ATState = { ...s, lastCycle: entry.cycleTs, lastProcessedAt: Date.now(), log: addLog(s, { ts: Date.now(), act: 'ERR', msg: 'No contract' }) }
    save(next)
    return next
  }

  try {
    const { oid, price } = await buyContract(opt.tradingsymbol, contracts.lotSize)
    const next: ATState = {
      ...s, mode: 'LIVE', lastCycle: entry.cycleTs, lastProcessedAt: Date.now(),
      pos: { sym: opt.tradingsymbol, dir: entry.predDir, entry: price, lot: contracts.lotSize, oid, ts: Date.now() },
      log: addLog(s, { ts: Date.now(), act: 'BUY', sym: opt.tradingsymbol, dir: entry.predDir, price, oid }),
    }
    save(next)
    return next
  } catch (err) {
    const next: ATState = { ...s, lastCycle: entry.cycleTs, lastProcessedAt: Date.now(), log: addLog(s, { ts: Date.now(), act: 'ERR', msg: `Buy fail: ${err}` }) }
    save(next)
    return next
  }
}

async function handleLive(s: ATState, entry: SysLogEntry): Promise<ATState> {
  if (entry.predDir === s.pos!.dir) {
    const next: ATState = { ...s, lastCycle: entry.cycleTs, lastProcessedAt: Date.now(), log: addLog(s, { ts: Date.now(), act: 'HOLD', sym: s.pos!.sym, dir: s.pos!.dir, msg: `Agrees: ${entry.predDir}` }) }
    save(next)
    return next
  }
  return await exitAndCooldown(s, entry.cycleTs, `Flip→${entry.predDir ?? '—'}`)
}

async function exitAndCooldown(s: ATState, cycleTs: number, reason: string): Promise<ATState> {
  try {
    const ep = await sellPosition(s.pos!)
    const pnl = ep > 0 ? (ep - s.pos!.entry) * s.pos!.lot : 0
    const next: ATState = {
      ...s, mode: 'COOLDOWN', lastCycle: cycleTs, cd: COOLDOWN_TICKS, pos: null, lastProcessedAt: Date.now(),
      log: addLog(s, { ts: Date.now(), act: 'SELL', sym: s.pos!.sym, dir: s.pos!.dir, price: ep, pnl, msg: reason }),
      stats: { n: s.stats.n + 1, w: s.stats.w + (pnl > 0 ? 1 : 0), pnl: s.stats.pnl + pnl },
    }
    save(next)
    return next
  } catch (err) {
    const next: ATState = { ...s, lastCycle: cycleTs, lastProcessedAt: Date.now(), log: addLog(s, { ts: Date.now(), act: 'ERR', msg: `Exit fail: ${err}` }) }
    save(next)
    return next
  }
}

function handleCooldown(s: ATState, entry: SysLogEntry): ATState {
  const rem = s.cd - 1
  const next: ATState = {
    ...s, mode: rem <= 0 ? 'ARMED' : 'COOLDOWN',
    lastCycle: entry.cycleTs, cd: Math.max(0, rem), lastProcessedAt: Date.now(),
    log: addLog(s, { ts: Date.now(), act: 'SKIP', msg: rem <= 0 ? 'Cooldown done — re-armed' : `Cooldown ${rem}/${COOLDOWN_TICKS}` }),
  }
  save(next)
  return next
}

// ── Safety guards (run even without new SysLog tick) ───────────────────────

async function checkSafetyGuards(s: ATState): Promise<ATState> {
  if (s.mode !== 'LIVE' || !s.pos) return s

  const now = Date.now()
  const heldMin = (now - s.pos.ts) / 60_000
  const { hour, minute } = getISTHourMin(now)

  if (heldMin >= MAX_HOLD_MIN) {
    return await exitAndCooldown(s, s.lastCycle, `Max hold ${MAX_HOLD_MIN}m`)
  }

  if (hour > CLOSE_EXIT_HOUR || (hour === CLOSE_EXIT_HOUR && minute >= CLOSE_EXIT_MIN)) {
    return await exitAndCooldown(s, s.lastCycle, 'Market close exit')
  }

  return s
}

// ── Background timer (runs independently of browser) ───────────────────────

let bgStarted = false

export function ensureATBackground() {
  if (bgStarted) return
  bgStarted = true
  console.log('[autoTrader] background timer started — 30s interval')

  setInterval(async () => {
    const s = getATState()
    if (s.mode === 'IDLE') return

    const { hour, minute } = getISTHourMin(Date.now())
    const marketOpen = hour >= 9 && (hour < 15 || (hour === 15 && minute <= 30))
    if (!marketOpen && s.mode !== 'LIVE') return
    // If LIVE outside market hours, safety guards will exit

    try {
      const ltp = await kiteGetLTP(['NSE:NIFTY 50'])
      const spot = ltp['NSE:NIFTY 50']?.last_price
      if (!spot || spot <= 0) return

      const n50 = getN50State()
      const sysLog = updateSysLog(n50.composite, spot)
      const contracts = getNiftyContracts(spot)
      await processATTick(sysLog, contracts)
    } catch (err) {
      console.error('[autoTrader] bg tick error:', err instanceof Error ? err.message : err)
    }
  }, BG_INTERVAL_MS)
}
