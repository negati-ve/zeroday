import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { getEngine } from '@/lib/paperEngine'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json(getEngine().getAllStrategies())
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { strategyId } = await req.json()
  if (!strategyId) return NextResponse.json({ error: 'strategyId required' }, { status: 400 })

  const liveId = getEngine().activate(strategyId, user.userId)
  return NextResponse.json({ liveId })
}

export async function DELETE(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { liveId } = await req.json()
  if (!liveId) return NextResponse.json({ error: 'liveId required' }, { status: 400 })

  getEngine().deactivate(liveId)
  return NextResponse.json({ ok: true })
}
