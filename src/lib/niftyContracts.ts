import fs from 'fs'
import path from 'path'
import { getISTDateStr, getISTHourMin } from './tradingCalendar'

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
