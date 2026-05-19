import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { getEngine } from '@/lib/paperEngine'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function DELETE(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { positionId } = await req.json()
  if (!positionId) return NextResponse.json({ error: 'positionId required' }, { status: 400 })

  getEngine().manualClose(positionId)
  return NextResponse.json({ ok: true })
}
