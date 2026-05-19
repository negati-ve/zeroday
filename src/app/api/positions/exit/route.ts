import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import fs from 'fs'
import path from 'path'

const KITE_TOKEN_FILE = '/workspace/option-trader/kite_token.json'
const KITE_API_BASE = 'https://api.kite.trade'

interface KiteToken {
  api_key: string
  access_token: string
}

function readKiteToken(): KiteToken {
  const raw = fs.readFileSync(KITE_TOKEN_FILE, 'utf8')
  return JSON.parse(raw)
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json() as {
    symbol: string
    quantity: number
    price: number
    exchange?: string
    product?: string
  }

  const { symbol, quantity, price } = body
  if (!symbol || !quantity || !price) {
    return NextResponse.json({ error: 'symbol, quantity, price are required' }, { status: 400 })
  }

  if (price <= 0 || quantity <= 0) {
    return NextResponse.json({ error: 'price and quantity must be positive' }, { status: 400 })
  }

  let token: KiteToken
  try {
    token = readKiteToken()
  } catch {
    return NextResponse.json({ error: 'Failed to read Kite token — is the bot running?' }, { status: 500 })
  }

  const exchange = body.exchange ?? 'NFO'
  const product = body.product ?? 'NRML'

  // Build form-urlencoded body for Kite API
  const params = new URLSearchParams({
    exchange,
    tradingsymbol: symbol,
    transaction_type: 'SELL',
    quantity: String(quantity),
    product,
    order_type: 'LIMIT',
    price: String(price),
    validity: 'DAY',
  })

  const kiteRes = await fetch(`${KITE_API_BASE}/orders/regular`, {
    method: 'POST',
    headers: {
      'Authorization': `token ${token.api_key}:${token.access_token}`,
      'X-Kite-Version': '3',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  })

  const kiteBody = await kiteRes.json()

  if (!kiteRes.ok) {
    return NextResponse.json(
      { error: kiteBody.message ?? 'Kite API error', kite: kiteBody },
      { status: kiteRes.status }
    )
  }

  return NextResponse.json({
    ok: true,
    order_id: kiteBody.data?.order_id,
    symbol,
    quantity,
    price,
    exchange,
  })
}
