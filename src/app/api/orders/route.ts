import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { kiteGetOrders } from '@/lib/kite'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// GET /api/orders — returns all open/pending Zerodha orders (admin only)
export async function GET() {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (user.role !== 'admin') return NextResponse.json({ error: 'Admin only' }, { status: 403 })

  try {
    const orders = await kiteGetOrders()
    // Return all orders; client filters by status
    return NextResponse.json({ orders })
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? 'Failed to fetch orders' }, { status: 500 })
  }
}
