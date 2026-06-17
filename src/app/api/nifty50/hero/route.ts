import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { getHeroState, armHero, disarmHero, resetHeroStats } from '@/lib/optionHero'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json(getHeroState())
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json() as { action: string }
  const { action } = body

  if (action === 'ARM') {
    return NextResponse.json(armHero())
  } else if (action === 'DISARM') {
    return NextResponse.json(disarmHero())
  } else if (action === 'RESET') {
    return NextResponse.json(resetHeroStats())
  } else {
    return NextResponse.json({ error: 'Unknown action — use ARM, DISARM, or RESET' }, { status: 400 })
  }
}
