import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { getN50State, updateSysLog, type N50State } from '@/lib/nifty50'
import { kiteGetLTP } from '@/lib/kite'
import { getNiftyContracts, getCachedNiftyOI, type NiftyContracts, type NiftyOIAnalytics } from '@/lib/niftyContracts'
import { processATTick, getATState, ensureATBackground } from '@/lib/autoTrader'

ensureATBackground()

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

let cache: { data: N50State & { niftySpot?: number; contracts?: NiftyContracts; sysLog?: any[]; autoTrader?: any; oiAnalytics?: NiftyOIAnalytics }; ts: number } | null = null
const CACHE_TTL = 5_000

async function fetchNiftySpot(): Promise<number | undefined> {
  try {
    const data = await kiteGetLTP(['NSE:NIFTY 50'])
    const price = data['NSE:NIFTY 50']?.last_price
    if (price && price > 0) return price
  } catch (err) {
    console.error('[nifty50] fetchNiftySpot failed:', err instanceof Error ? err.message : err)
  }
  return undefined
}

export async function GET() {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const now = Date.now()
    if (cache && now - cache.ts < CACHE_TTL) {
      return NextResponse.json(cache.data)
    }
    const state = getN50State()
    const niftySpot = await fetchNiftySpot()
    const contracts = niftySpot ? getNiftyContracts(niftySpot) : undefined
    const sysLog = niftySpot && niftySpot > 0 ? updateSysLog(state.composite, niftySpot) : []
    // Server-side auto-trader processes every tick
    if (sysLog.length > 0) {
      await processATTick(sysLog, contracts ?? null).catch(() => {})
    }
    const autoTrader = getATState()
    const result: N50State & { niftySpot?: number; contracts?: NiftyContracts; sysLog?: any[]; autoTrader?: any; oiAnalytics?: NiftyOIAnalytics } = { ...state, niftySpot, contracts: contracts ?? undefined, sysLog, autoTrader }

    // OI analytics: inject from synchronous cache first (always fast), then refresh in background
    const cachedOI = getCachedNiftyOI()
    if (cachedOI) result.oiAnalytics = cachedOI
    if (contracts) {
      const { fetchNiftyChainOI } = await import('@/lib/niftyContracts')
      fetchNiftyChainOI(contracts).catch(() => {})
    }

    cache = { data: result, ts: now }
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json({
      prediction: { predictedMove: 0, bullProb: 0.5, bearProb: 0.5, topSim: 0, confidence: 0, nResolved: 0, direction: null, status: 'no_data' },
      snapshotCount: 0, patternCount: 0, resolvedCount: 0, niftyProxy: 0,
      bullStockPct: 0, bearStockPct: 0, coverageCount: 0, minutesAccumulated: 0,
      error: 'Internal error fetching N50 state',
    }, { status: 500 })
  }
}
