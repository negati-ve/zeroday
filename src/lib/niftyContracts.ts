import fs from 'fs'
import path from 'path'
import { getISTDateStr, getISTHourMin } from './tradingCalendar'
import { kiteGetQuote } from './kite'

const INSTRUMENTS_FILE = path.join('/workspace/option-trader', 'data', 'kite_instruments.csv')
const STRIKE_STEP = 50
const LOT_SIZE = 65

interface NiftyOption {
  tradingsymbol: string
  strike: number
  expiry: string
  instrumentType: 'CE' | 'PE'
}

export interface NiftyContracts {
  bull: NiftyOption[]
  bear: NiftyOption[]
  spotEstimate: number
  expiry: string
  lotSize: number
}

let cache: { data: NiftyOption[]; ts: number } | null = null
const CACHE_TTL = 3600_000

function loadNiftyOptions(): NiftyOption[] {
  if (cache && Date.now() - cache.ts < CACHE_TTL) return cache.data

  const options: NiftyOption[] = []
  try {
    const raw = fs.readFileSync(INSTRUMENTS_FILE, 'utf8')
    for (const line of raw.split('\n')) {
      if (!line.includes('NFO-OPT')) continue
      const cols = line.split(',')
      if (cols.length < 12) continue
      if (cols[3] !== '"NIFTY"') continue
      const segment = cols[10]
      if (segment !== 'NFO-OPT') continue
      const tradingsymbol = cols[2]
      const expiry = cols[5]
      if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) continue
      const strike = parseFloat(cols[6])
      const instrumentType = cols[9] as 'CE' | 'PE'
      if (instrumentType !== 'CE' && instrumentType !== 'PE') continue
      if (!tradingsymbol || !expiry || isNaN(strike)) continue
      options.push({ tradingsymbol, strike, expiry, instrumentType })
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err
    console.warn('[niftyContracts] Instruments file not found:', INSTRUMENTS_FILE)
  }

  if (options.length > 0) {
    cache = { data: options, ts: Date.now() }
  }
  return options
}

function getNextExpiry(options: NiftyOption[]): string | null {
  const now = Date.now()
  const todayIST = getISTDateStr(now)
  const { hour, minute } = getISTHourMin(now)
  const skipToday = hour > 15 || (hour === 15 && minute >= 30)
  const expiries = [...new Set(options.map(o => o.expiry))]
    .filter(e => skipToday ? e > todayIST : e >= todayIST)
    .sort()
  return expiries[0] ?? null
}

export function getNiftyContracts(spotEstimate: number): NiftyContracts | null {
  if (!spotEstimate || spotEstimate <= 0) return null

  const options = loadNiftyOptions()
  if (options.length === 0) return null

  const expiry = getNextExpiry(options)
  if (!expiry) {
    console.warn('[niftyContracts] No valid expiry found — CSV may be stale')
    return null
  }

  const expiryOpts = options.filter(o => o.expiry === expiry)
  const atm = Math.round(spotEstimate / STRIKE_STEP) * STRIKE_STEP

  const bullStrikes = [atm, atm + STRIKE_STEP, atm - STRIKE_STEP]
  const bearStrikes = [atm, atm - STRIKE_STEP, atm + STRIKE_STEP]

  const bull = bullStrikes
    .map(s => expiryOpts.find(o => o.strike === s && o.instrumentType === 'CE'))
    .filter(Boolean) as NiftyOption[]

  const bear = bearStrikes
    .map(s => expiryOpts.find(o => o.strike === s && o.instrumentType === 'PE'))
    .filter(Boolean) as NiftyOption[]

  if (bull.length === 0 || bear.length === 0) return null

  return { bull, bear, spotEstimate, expiry, lotSize: LOT_SIZE }
}

// ── Option Chain OI Analytics ─────────────────────────────────────────────

export interface NiftyOIAnalytics {
  strikes: Array<{
    strike: number
    ceSymbol: string
    peSymbol: string
    ceOI: number
    peOI: number
    ceLtp: number
    peLtp: number
    callVol: number
    putVol: number
    painAtStrike: number
  }>
  maxPainStrike: number
  maxPainPull: number
  pcr: number
  totalCallOI: number
  totalPutOI: number
  atmStrike: number
}

let niftyOiCache: { data: NiftyOIAnalytics; ts: number } | null = null
const NIFTY_OI_CACHE_TTL = 30_000

/** Synchronous read of the last successfully-fetched OI data (no API call). */
export function getCachedNiftyOI(): NiftyOIAnalytics | null {
  return niftyOiCache && Date.now() - niftyOiCache.ts < NIFTY_OI_CACHE_TTL
    ? niftyOiCache.data : null
}

export async function fetchNiftyChainOI(contracts: NiftyContracts): Promise<NiftyOIAnalytics | null> {
  if (niftyOiCache && Date.now() - niftyOiCache.ts < NIFTY_OI_CACHE_TTL) {
    return niftyOiCache.data
  }

  const options = loadNiftyOptions()
  if (options.length === 0) return null

  const expiry = getNextExpiry(options)
  if (!expiry) return null

  const expiryOpts = options.filter(o => o.expiry === expiry)
  const spot = contracts.spotEstimate
  const atm = Math.round(spot / STRIKE_STEP) * STRIKE_STEP

  // Scan ATM ± 5 strikes = 10 steps each side, 11 total
  const scanStrikes: number[] = []
  for (let i = -5; i <= 5; i++) {
    scanStrikes.push(atm + i * STRIKE_STEP)
  }

  const callMap = new Map<number, NiftyOption>()
  const putMap = new Map<number, NiftyOption>()
  for (const s of scanStrikes) {
    const ce = expiryOpts.find(o => o.strike === s && o.instrumentType === 'CE')
    const pe = expiryOpts.find(o => o.strike === s && o.instrumentType === 'PE')
    if (ce) callMap.set(s, ce)
    if (pe) putMap.set(s, pe)
  }

  const instruments: string[] = []
  for (const s of scanStrikes) {
    const ce = callMap.get(s)
    const pe = putMap.get(s)
    if (ce) instruments.push(`NFO:${ce.tradingsymbol}`)
    if (pe) instruments.push(`NFO:${pe.tradingsymbol}`)
  }

  if (instruments.length === 0) return null

  let quotes: Record<string, { last_price: number; oi: number; volume: number; depth?: { buy: any[]; sell: any[] } }>
  try {
    quotes = await kiteGetQuote(instruments)
  } catch {
    return niftyOiCache?.data ?? null
  }

  const strikeData: NiftyOIAnalytics['strikes'] = []
  let totalCallOI = 0
  let totalPutOI = 0

  for (const strike of scanStrikes) {
    const ce = callMap.get(strike)
    const pe = putMap.get(strike)
    const cq = ce ? quotes[`NFO:${ce.tradingsymbol}`] : null
    const pq = pe ? quotes[`NFO:${pe.tradingsymbol}`] : null

    const ceOI = cq?.oi ?? 0
    const peOI = pq?.oi ?? 0
    const ceLtp = cq?.last_price ?? 0
    const peLtp = pq?.last_price ?? 0
    const callVol = cq?.volume ?? 0
    const putVol = pq?.volume ?? 0

    totalCallOI += ceOI
    totalPutOI += peOI

    strikeData.push({
      strike,
      ceSymbol: ce?.tradingsymbol ?? '',
      peSymbol: pe?.tradingsymbol ?? '',
      ceOI, peOI, ceLtp, peLtp, callVol, putVol,
      painAtStrike: 0,
    })
  }

  // Max Pain: for each candidate settlement strike, sum writer losses across all strikes
  let minPain = Infinity
  let maxPainStrike = atm
  for (const candidate of strikeData) {
    let pain = 0
    for (const s of strikeData) {
      if (candidate.strike > s.strike) pain += (candidate.strike - s.strike) * s.ceOI
      if (candidate.strike < s.strike) pain += (s.strike - candidate.strike) * s.peOI
    }
    candidate.painAtStrike = pain
    if (pain < minPain) {
      minPain = pain
      maxPainStrike = candidate.strike
    }
  }

  const pcr = totalCallOI > 0 ? totalPutOI / totalCallOI : 0

  // Pull strength: avg % pain increase at adjacent strikes
  const mpIdx = strikeData.findIndex(s => s.strike === maxPainStrike)
  let maxPainPull = 0
  if (minPain > 0 && mpIdx >= 0) {
    const neighbors: number[] = []
    if (mpIdx > 0) neighbors.push(strikeData[mpIdx - 1].painAtStrike)
    if (mpIdx < strikeData.length - 1) neighbors.push(strikeData[mpIdx + 1].painAtStrike)
    if (neighbors.length > 0) {
      const avgNeighborPain = neighbors.reduce((a, b) => a + b, 0) / neighbors.length
      maxPainPull = Math.round((avgNeighborPain - minPain) / minPain * 100)
    }
  }

  const result: NiftyOIAnalytics = {
    strikes: strikeData,
    maxPainStrike, maxPainPull, pcr,
    totalCallOI, totalPutOI, atmStrike: atm,
  }
  niftyOiCache = { data: result, ts: Date.now() }
  return result
}
