import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { getCrudeState, type CrudeState } from '@/lib/crudeOil'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const cacheMap = new Map<string, { data: CrudeState; ts: number }>()
const CACHE_TTL = 1_000

export async function GET(req: Request) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const now = Date.now()
    const { searchParams } = new URL(req.url)
    const product = searchParams.get('product') === 'CRUDEOILM' ? 'CRUDEOILM' as const : 'CRUDEOIL' as const

    const cached = cacheMap.get(product)
    if (cached && now - cached.ts < CACHE_TTL) {
      return NextResponse.json(cached.data)
    }

    const state = await getCrudeState(product)
    cacheMap.set(product, { data: state, ts: now })
    return NextResponse.json(state)
  } catch (err) {
    console.error('[crude] API error:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
