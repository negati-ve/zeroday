import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { getATState, armAT, disarmAT, resetATStats } from '@/lib/autoTrader'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json(getATState())
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json() as { action: string }
  const { action } = body

  if (action === 'ARM') {
    return NextResponse.json(armAT())
  } else if (action === 'DISARM') {
    const state = await disarmAT()
    return NextResponse.json(state)
  } else if (action === 'RESET_STATS') {
    return NextResponse.json(resetATStats())
  } else {
    return NextResponse.json({ error: 'Unknown action — use ARM, DISARM, or RESET_STATS' }, { status: 400 })
  }
}
