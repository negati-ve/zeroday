import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { getN50State, type N50State } from '@/lib/nifty50'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

let cache: { data: N50State; ts: number } | null = null
const CACHE_TTL = 5_000

export async function GET() {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const now = Date.now()
    if (cache && now - cache.ts < CACHE_TTL) {
      return NextResponse.json(cache.data)
    }
    const state = getN50State()
    cache = { data: state, ts: now }
    return NextResponse.json(state)
  } catch (err) {
    return NextResponse.json({
      prediction: { predictedMove: 0, bullProb: 0.5, bearProb: 0.5, topSim: 0, confidence: 0, nResolved: 0, direction: null, status: 'no_data' },
      snapshotCount: 0, patternCount: 0, resolvedCount: 0, niftyProxy: 0,
      bullStockPct: 0, bearStockPct: 0, coverageCount: 0, minutesAccumulated: 0,
      error: String(err instanceof Error ? err.message : err),
    })
  }
}
