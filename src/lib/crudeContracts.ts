import fs from 'fs'
import path from 'path'
import { getISTDateStr, getISTHourMin } from './tradingCalendar'
import { kiteGetQuote } from './kite'

const INSTRUMENTS_FILE = path.join('/workspace/option-trader', 'data', 'kite_instruments.csv')

// MCX Crude Oil contract specs
// CRUDEOIL: 100 barrels/lot, ₹1 tick (futures), ₹0.10 tick (options), 50-pt strike step
// CRUDEOILM: 10 barrels/lot, ₹1 tick (futures), ₹0.05 tick (options), 50-pt strike step
export const CRUDE_SPECS = {
  CRUDEOIL:  { lotSize: 100, tickFut: 1, tickOpt: 0.1, strikeStep: 50, name: 'Crude Oil' },
  CRUDEOILM: { lotSize: 10,  tickFut: 1, tickOpt: 0.05, strikeStep: 50, name: 'Crude Oil Mini' },
} as const

export type CrudeProduct = keyof typeof CRUDE_SPECS

export interface CrudeOption {
  tradingsymbol: string
  instrumentToken: number
  strike: number
  expiry: string
  instrumentType: 'CE' | 'PE'
  product: CrudeProduct
}

export interface CrudeFuture {
  tradingsymbol: string
  instrumentToken: number
  expiry: string
  product: CrudeProduct
}

export interface CrudeOptionLive extends CrudeOption {
  ltp: number
  oi: number
  volume: number
  bid: number
  ask: number
}

export interface OIAnalytics {
  maxPainStrike: number
  pcr: number
  totalCallOI: number
  totalPutOI: number
  strikes: {
    strike: number
    callOI: number
    putOI: number
    callLTP: number
    putLTP: number
    callVol: number
    putVol: number
    painAtStrike: number
  }[]
}

export interface CrudeChain {
  calls: CrudeOption[]
  puts: CrudeOption[]
  spotEstimate: number
  expiry: string
  product: CrudeProduct
  lotSize: number
  strikeStep: number
  atmStrike: number
  oiAnalytics?: OIAnalytics
}

let optCache: { data: CrudeOption[]; ts: number } | null = null
let futCache: { data: CrudeFuture[]; ts: number } | null = null
const CACHE_TTL = 3600_000

function loadCrudeOptions(): CrudeOption[] {
  if (optCache && Date.now() - optCache.ts < CACHE_TTL) return optCache.data

  const options: CrudeOption[] = []
  try {
    const raw = fs.readFileSync(INSTRUMENTS_FILE, 'utf8')
    for (const line of raw.split('\n')) {
      if (!line.includes('MCX-OPT')) continue
      const cols = line.split(',')
      if (cols.length < 12) continue
      const name = cols[3]?.replace(/"/g, '')
      if (name !== 'CRUDEOIL' && name !== 'CRUDEOILM') continue
      const segment = cols[10]
      if (segment !== 'MCX-OPT') continue
      const tradingsymbol = cols[2]
      const instrumentToken = parseInt(cols[0], 10)
      const expiry = cols[5]
      if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) continue
      const strike = parseFloat(cols[6])
      const instrumentType = cols[9] as 'CE' | 'PE'
      if (instrumentType !== 'CE' && instrumentType !== 'PE') continue
      if (!tradingsymbol || isNaN(strike) || isNaN(instrumentToken)) continue
      const product: CrudeProduct = name === 'CRUDEOILM' ? 'CRUDEOILM' : 'CRUDEOIL'
      options.push({ tradingsymbol, instrumentToken, strike, expiry, instrumentType, product })
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err
  }

  if (options.length > 0) optCache = { data: options, ts: Date.now() }
  return options
}

function loadCrudeFutures(): CrudeFuture[] {
  if (futCache && Date.now() - futCache.ts < CACHE_TTL) return futCache.data

  const futures: CrudeFuture[] = []
  try {
    const raw = fs.readFileSync(INSTRUMENTS_FILE, 'utf8')
    for (const line of raw.split('\n')) {
      if (!line.includes('MCX-FUT')) continue
      const cols = line.split(',')
      if (cols.length < 12) continue
      const name = cols[3]?.replace(/"/g, '')
      if (name !== 'CRUDEOIL' && name !== 'CRUDEOILM') continue
      const segment = cols[10]
      if (segment !== 'MCX-FUT') continue
      const tradingsymbol = cols[2]
      const instrumentToken = parseInt(cols[0], 10)
      const expiry = cols[5]
      if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) continue
      if (isNaN(instrumentToken)) continue
      const product: CrudeProduct = name === 'CRUDEOILM' ? 'CRUDEOILM' : 'CRUDEOIL'
      futures.push({ tradingsymbol, instrumentToken, expiry, product })
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err
  }

  if (futures.length > 0) futCache = { data: futures, ts: Date.now() }
  return futures
}

function getNextExpiry(items: { expiry: string }[]): string | null {
  const now = Date.now()
  const todayIST = getISTDateStr(now)
  const { hour, minute } = getISTHourMin(now)
  // MCX closes at 23:30, so skip today's expiry only after 23:30
  const skipToday = hour >= 23 && minute >= 30
  const expiries = [...new Set(items.map(o => o.expiry))]
    .filter(e => skipToday ? e > todayIST : e >= todayIST)
    .sort()
  return expiries[0] ?? null
}

export function getNearestCrudeFuture(product: CrudeProduct = 'CRUDEOIL'): CrudeFuture | null {
  const futures = loadCrudeFutures().filter(f => f.product === product)
  if (futures.length === 0) return null
  const expiry = getNextExpiry(futures)
  if (!expiry) return null
  return futures.find(f => f.expiry === expiry) ?? null
}

export function getCrudeChain(spotEstimate: number, product: CrudeProduct = 'CRUDEOIL', numStrikes = 5): CrudeChain | null {
  if (!spotEstimate || spotEstimate <= 0) return null

  const spec = CRUDE_SPECS[product]
  const options = loadCrudeOptions().filter(o => o.product === product)
  if (options.length === 0) return null

  const expiry = getNextExpiry(options)
  if (!expiry) return null

  const expiryOpts = options.filter(o => o.expiry === expiry)
  const atm = Math.round(spotEstimate / spec.strikeStep) * spec.strikeStep

  // ATM ± numStrikes
  const strikes: number[] = []
  for (let i = -numStrikes; i <= numStrikes; i++) {
    strikes.push(atm + i * spec.strikeStep)
  }

  const calls = strikes
    .map(s => expiryOpts.find(o => o.strike === s && o.instrumentType === 'CE'))
    .filter(Boolean) as CrudeOption[]

  const puts = strikes
    .map(s => expiryOpts.find(o => o.strike === s && o.instrumentType === 'PE'))
    .filter(Boolean) as CrudeOption[]

  return {
    calls,
    puts,
    spotEstimate,
    expiry,
    product,
    lotSize: spec.lotSize,
    strikeStep: spec.strikeStep,
    atmStrike: atm,
  }
}

let oiCache: { data: OIAnalytics; ts: number; product: string } | null = null
const OI_CACHE_TTL = 10_000

export async function fetchChainOI(chain: CrudeChain): Promise<OIAnalytics | null> {
  if (oiCache && Date.now() - oiCache.ts < OI_CACHE_TTL && oiCache.product === chain.product) {
    return oiCache.data
  }

  const instruments: string[] = []
  const callMap = new Map<number, CrudeOption>()
  const putMap = new Map<number, CrudeOption>()

  for (const c of chain.calls) {
    instruments.push(`MCX:${c.tradingsymbol}`)
    callMap.set(c.strike, c)
  }
  for (const p of chain.puts) {
    instruments.push(`MCX:${p.tradingsymbol}`)
    putMap.set(p.strike, p)
  }

  if (instruments.length === 0) return null

  let quotes: Record<string, { last_price: number; oi: number; volume: number; depth: { buy: any[]; sell: any[] } }>
  try {
    quotes = await kiteGetQuote(instruments)
  } catch {
    return oiCache?.data ?? null
  }

  const strikeData: OIAnalytics['strikes'] = []
  let totalCallOI = 0
  let totalPutOI = 0

  const allStrikes = [...new Set([...chain.calls.map(c => c.strike), ...chain.puts.map(p => p.strike)])].sort((a, b) => a - b)

  for (const strike of allStrikes) {
    const call = callMap.get(strike)
    const put = putMap.get(strike)
    const cq = call ? quotes[`MCX:${call.tradingsymbol}`] : null
    const pq = put ? quotes[`MCX:${put.tradingsymbol}`] : null

    const callOI = cq?.oi ?? 0
    const putOI = pq?.oi ?? 0
    const callLTP = cq?.last_price ?? 0
    const putLTP = pq?.last_price ?? 0
    const callVol = cq?.volume ?? 0
    const putVol = pq?.volume ?? 0
    const callBid = cq?.depth?.buy?.[0]?.price ?? 0
    const callAsk = cq?.depth?.sell?.[0]?.price ?? 0
    const putBid = pq?.depth?.buy?.[0]?.price ?? 0
    const putAsk = pq?.depth?.sell?.[0]?.price ?? 0

    totalCallOI += callOI
    totalPutOI += putOI

    strikeData.push({ strike, callOI, putOI, callLTP, putLTP, callVol, putVol, painAtStrike: 0 })
  }

  // Max Pain: for each strike as settlement, compute total loss to option writers
  let minPain = Infinity
  let maxPainStrike = chain.atmStrike
  for (const candidate of strikeData) {
    let pain = 0
    for (const s of strikeData) {
      // Call writers lose when settlement > strike
      if (candidate.strike > s.strike) {
        pain += (candidate.strike - s.strike) * s.callOI
      }
      // Put writers lose when settlement < strike
      if (candidate.strike < s.strike) {
        pain += (s.strike - candidate.strike) * s.putOI
      }
    }
    candidate.painAtStrike = pain
    if (pain < minPain) {
      minPain = pain
      maxPainStrike = candidate.strike
    }
  }

  const pcr = totalCallOI > 0 ? totalPutOI / totalCallOI : 0

  const result: OIAnalytics = { maxPainStrike, pcr, totalCallOI, totalPutOI, strikes: strikeData }
  oiCache = { data: result, ts: Date.now(), product: chain.product }
  return result
}
