import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { getBitcoinState } from '@/lib/bitcoin'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

let cache: { data: any; ts: number } | null = null
const CACHE_TTL = 1000

export async function GET() {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const now = Date.now()
    if (cache && now - cache.ts < CACHE_TTL) return NextResponse.json(cache.data)
    const state = await getBitcoinState()
    cache = { data: state, ts: now }
    return NextResponse.json(state)
  } catch (err) {
    console.error('[bitcoin API]', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
