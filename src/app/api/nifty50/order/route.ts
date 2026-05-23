import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { kitePlaceOrder, kiteGetQuote, kiteGetLTP } from '@/lib/kite'
import { getNiftyContracts } from '@/lib/niftyContracts'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const NIFTY_LOT_SIZE = 65
const MAX_SPREAD_PCT = 0.10
const ORDER_COOLDOWN_MS = 30_000

let orderLock = false
let lastOrderTs = 0

export async function POST(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (orderLock) {
    return NextResponse.json({ error: 'Another order is in progress' }, { status: 429 })
  }

  if (Date.now() - lastOrderTs < ORDER_COOLDOWN_MS) {
    return NextResponse.json({ error: 'Rate limited — wait 30s between orders' }, { status: 429 })
  }

  orderLock = true
  try {
    const body = await req.json() as {
      tradingsymbol: string
      transaction_type: 'BUY' | 'SELL'
      lotSize: number
      order_type?: 'LIMIT' | 'MARKET'
      price?: number
    }

    const { tradingsymbol, transaction_type, lotSize } = body
    if (!tradingsymbol || !transaction_type || !lotSize) {
      return NextResponse.json({ error: 'tradingsymbol, transaction_type, lotSize required' }, { status: 400 })
    }
    if (transaction_type !== 'BUY' && transaction_type !== 'SELL') {
      return NextResponse.json({ error: 'transaction_type must be BUY or SELL' }, { status: 400 })
    }
    if (typeof lotSize !== 'number' || !Number.isInteger(lotSize) || lotSize <= 0) {
      return NextResponse.json({ error: 'lotSize must be a positive integer' }, { status: 400 })
    }
    if (transaction_type === 'BUY' && lotSize !== NIFTY_LOT_SIZE) {
      return NextResponse.json({ error: `BUY lotSize must be ${NIFTY_LOT_SIZE}` }, { status: 400 })
    }
    if (!/^NIFTY\d{2}[A-Z]{3}\d{3,6}(CE|PE)$/.test(tradingsymbol) && !/^NIFTY\d{5,7}(CE|PE)$/.test(tradingsymbol)) {
      return NextResponse.json({ error: 'Invalid tradingsymbol format' }, { status: 400 })
    }

    let spotPrice: number
    try {
      const ltp = await kiteGetLTP(['NSE:NIFTY 50'])
      spotPrice = ltp['NSE:NIFTY 50']?.last_price
      if (!spotPrice || spotPrice <= 0) {
        return NextResponse.json({ error: 'Cannot fetch NIFTY spot — token may be expired' }, { status: 500 })
      }
    } catch {
      return NextResponse.json({ error: 'Kite API unavailable — is the token valid?' }, { status: 500 })
    }

    if (transaction_type === 'BUY') {
      const contracts = getNiftyContracts(spotPrice)
      if (!contracts) {
        return NextResponse.json({ error: 'No NIFTY contracts available' }, { status: 400 })
      }
      const allValid = [...contracts.bull, ...contracts.bear]
      if (!allValid.some(c => c.tradingsymbol === tradingsymbol)) {
        return NextResponse.json({ error: `${tradingsymbol} is not a valid NIFTY contract` }, { status: 400 })
      }
    }

    const quote = await kiteGetQuote([`NFO:${tradingsymbol}`])
    const q = quote[`NFO:${tradingsymbol}`]
    if (!q) {
      return NextResponse.json({ error: `No quote for ${tradingsymbol}` }, { status: 404 })
    }

    const bestBid = q.depth?.buy?.[0]?.price ?? 0
    const bestAsk = q.depth?.sell?.[0]?.price ?? 0

    if (bestBid <= 0 || bestAsk <= 0) {
      return NextResponse.json({ error: 'No valid bid/ask — market may be closed or no liquidity' }, { status: 400 })
    }

    const reqOrderType = body.order_type === 'MARKET' ? 'MARKET' as const : 'LIMIT' as const

    if (reqOrderType === 'LIMIT') {
      const mid = (bestAsk + bestBid) / 2
      const spreadPct = (bestAsk - bestBid) / mid
      if (spreadPct > MAX_SPREAD_PCT) {
        return NextResponse.json({
          error: `Spread too wide: ${(spreadPct * 100).toFixed(1)}% (max ${MAX_SPREAD_PCT * 100}%)`,
          bestBid, bestAsk,
        }, { status: 400 })
      }
    }
    let price: number
    if (reqOrderType === 'MARKET') {
      price = 0
    } else if (body.price != null && body.price > 0) {
      price = body.price
    } else {
      price = transaction_type === 'BUY' ? bestAsk : bestBid
    }

    const result = await kitePlaceOrder({
      exchange: 'NFO',
      tradingsymbol,
      transaction_type,
      quantity: lotSize,
      product: 'NRML',
      order_type: reqOrderType,
      price,
    })

    lastOrderTs = Date.now()

    return NextResponse.json({
      ok: true,
      order_id: result.order_id,
      tradingsymbol,
      transaction_type,
      quantity: lotSize,
      order_type: reqOrderType,
      price,
      bestBid,
      bestAsk,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  } finally {
    orderLock = false
  }
}
