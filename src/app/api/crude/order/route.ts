import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { kiteGetQuote, kitePlaceOrder } from '@/lib/kite'
import { CRUDE_SPECS, type CrudeProduct } from '@/lib/crudeContracts'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

let lastOrderTs = 0
const ORDER_COOLDOWN = 30_000

export async function POST(req: Request) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const now = Date.now()
  if (now - lastOrderTs < ORDER_COOLDOWN) {
    return NextResponse.json({ error: `Cooldown: wait ${Math.ceil((ORDER_COOLDOWN - (now - lastOrderTs)) / 1000)}s` }, { status: 429 })
  }

  try {
    const body = await req.json()
    const { tradingsymbol, transaction_type, product } = body as {
      tradingsymbol: string
      transaction_type: 'BUY' | 'SELL'
      product?: CrudeProduct
    }

    if (!tradingsymbol || !transaction_type) {
      return NextResponse.json({ error: 'Missing tradingsymbol or transaction_type' }, { status: 400 })
    }

    if (transaction_type !== 'BUY' && transaction_type !== 'SELL') {
      return NextResponse.json({ error: 'Invalid transaction_type — must be BUY or SELL' }, { status: 400 })
    }

    if (!tradingsymbol.startsWith('CRUDEOIL')) {
      return NextResponse.json({ error: 'Invalid symbol — must be a crude oil contract' }, { status: 400 })
    }

    // Determine lot size from product
    const crudeProduct: CrudeProduct = product ?? (tradingsymbol.startsWith('CRUDEOILM') ? 'CRUDEOILM' : 'CRUDEOIL')
    const spec = CRUDE_SPECS[crudeProduct]
    const quantity = spec.lotSize

    // Get current quote for pricing
    const quoteKey = `MCX:${tradingsymbol}`
    const quote = await kiteGetQuote([quoteKey])
    const q = quote[quoteKey]
    if (!q) return NextResponse.json({ error: 'Quote not available' }, { status: 400 })

    // Spread check
    const bestBid = q.depth?.buy?.[0]?.price ?? 0
    const bestAsk = q.depth?.sell?.[0]?.price ?? 0
    if (bestBid <= 0 || bestAsk <= 0) {
      return NextResponse.json({ error: 'No bid/ask available — market may be closed' }, { status: 400 })
    }

    const spread = (bestAsk - bestBid) / bestBid
    if (spread > 0.02) {
      return NextResponse.json({ error: `Spread too wide: ${(spread * 100).toFixed(2)}% > 2%` }, { status: 400 })
    }

    // BUY at bestAsk, SELL at bestBid (limit orders)
    const price = transaction_type === 'BUY' ? bestAsk : bestBid

    const result = await kitePlaceOrder({
      exchange: 'MCX',
      tradingsymbol,
      transaction_type,
      quantity,
      product: 'NRML',
      order_type: 'LIMIT',
      price,
    })

    lastOrderTs = now

    return NextResponse.json({
      success: true,
      order_id: result.order_id,
      price,
      quantity,
      tradingsymbol,
      transaction_type,
    })
  } catch (err) {
    return NextResponse.json({
      error: err instanceof Error ? err.message : 'Order failed',
    }, { status: 500 })
  }
}
