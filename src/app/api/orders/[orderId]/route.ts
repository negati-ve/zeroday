import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { kiteModifyOrder, kiteCancelOrder } from '@/lib/kite'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// PUT /api/orders/:orderId — modify a pending order
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ orderId: string }> }
) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (user.role !== 'admin') return NextResponse.json({ error: 'Admin only' }, { status: 403 })

  const { orderId } = await params
  if (!orderId) return NextResponse.json({ error: 'orderId required' }, { status: 400 })

  let body: any
  try { body = await req.json() } catch { body = {} }

  const { price, trigger_price, quantity, order_type, validity } = body

  if (price == null && trigger_price == null && quantity == null && !order_type && !validity) {
    return NextResponse.json({ error: 'At least one field to modify is required' }, { status: 400 })
  }

  try {
    const result = await kiteModifyOrder(orderId, { price, trigger_price, quantity, order_type, validity })
    return NextResponse.json({ ok: true, order_id: result.order_id })
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? 'Modify failed' }, { status: 500 })
  }
}

// DELETE /api/orders/:orderId — cancel a pending order
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ orderId: string }> }
) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (user.role !== 'admin') return NextResponse.json({ error: 'Admin only' }, { status: 403 })

  const { orderId } = await params
  if (!orderId) return NextResponse.json({ error: 'orderId required' }, { status: 400 })

  try {
    const result = await kiteCancelOrder(orderId)
    return NextResponse.json({ ok: true, order_id: result.order_id })
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? 'Cancel failed' }, { status: 500 })
  }
}
