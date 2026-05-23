import fs from 'fs'

const KITE_TOKEN_FILE = '/workspace/option-trader/kite_token.json'
const KITE_API_BASE = 'https://api.kite.trade'

interface KiteToken {
  api_key: string
  access_token: string
}

let tokenCache: { token: KiteToken; ts: number } | null = null
const TOKEN_CACHE_TTL = 300_000

function readToken(forceRefresh = false): KiteToken {
  const now = Date.now()
  if (!forceRefresh && tokenCache && now - tokenCache.ts < TOKEN_CACHE_TTL) return tokenCache.token
  let raw: string
  try {
    raw = fs.readFileSync(KITE_TOKEN_FILE, 'utf8')
  } catch {
    if (tokenCache) return tokenCache.token
    throw new Error('Token file missing and no cached token')
  }
  let token: KiteToken
  try {
    token = JSON.parse(raw) as KiteToken
  } catch {
    if (tokenCache) return tokenCache.token
    throw new Error('Token file corrupt and no cached token')
  }
  if (!token.api_key || !token.access_token) {
    if (tokenCache) return tokenCache.token
    throw new Error('Token file missing required fields')
  }
  tokenCache = { token, ts: now }
  return token
}

function authHeaders(forceRefresh = false): Record<string, string> {
  const t = readToken(forceRefresh)
  return {
    'Authorization': `token ${t.api_key}:${t.access_token}`,
    'X-Kite-Version': '3',
  }
}

async function kiteGet(url: string): Promise<Response> {
  let res = await fetch(url, { headers: authHeaders(), signal: AbortSignal.timeout(10_000) })
  if (res.status === 403) {
    await res.text().catch(() => {})
    res = await fetch(url, { headers: authHeaders(true), signal: AbortSignal.timeout(10_000) })
  }
  return res
}

export async function kiteGetLTP(instruments: string[]): Promise<Record<string, { last_price: number; instrument_token: number }>> {
  const qs = instruments.map(i => `i=${encodeURIComponent(i)}`).join('&')
  const res = await kiteGet(`${KITE_API_BASE}/quote/ltp?${qs}`)
  if (!res.ok) throw new Error(`Kite LTP error: ${res.status}`)
  const body = await res.json() as { data: Record<string, { last_price: number; instrument_token: number }> }
  return body.data
}

export async function kiteGetQuote(instruments: string[]): Promise<Record<string, {
  last_price: number
  instrument_token: number
  depth: {
    buy: { price: number; quantity: number; orders: number }[]
    sell: { price: number; quantity: number; orders: number }[]
  }
  oi: number
  volume: number
}>> {
  const qs = instruments.map(i => `i=${encodeURIComponent(i)}`).join('&')
  const res = await kiteGet(`${KITE_API_BASE}/quote?${qs}`)
  if (!res.ok) throw new Error(`Kite quote error: ${res.status}`)
  const body = await res.json() as { data: Record<string, any> }
  return body.data
}

export async function kiteGetPositions(): Promise<{ net: any[]; day: any[] }> {
  const res = await kiteGet(`${KITE_API_BASE}/portfolio/positions`)
  if (!res.ok) throw new Error(`Kite positions error: ${res.status}`)
  const body = await res.json() as { data: { net: any[]; day: any[] } }
  return body.data
}

export async function kiteGetHistorical(
  instrumentToken: number,
  interval: 'minute' | '3minute' | '5minute' | '15minute' | '60minute' | 'day',
  from: string,
  to: string,
): Promise<{ date: string; open: number; high: number; low: number; close: number; volume: number }[]> {
  const url = `${KITE_API_BASE}/instruments/historical/${instrumentToken}/${interval}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
  const res = await kiteGet(url)
  if (!res.ok) throw new Error(`Kite historical error: ${res.status}`)
  const body = await res.json() as { data: { candles: any[][] } }
  return (body.data?.candles ?? []).map(c => ({
    date: c[0] as string,
    open: c[1] as number,
    high: c[2] as number,
    low: c[3] as number,
    close: c[4] as number,
    volume: c[5] as number,
  }))
}

export async function kitePlaceOrder(params: {
  exchange: string
  tradingsymbol: string
  transaction_type: 'BUY' | 'SELL'
  quantity: number
  product: string
  order_type: string
  price: number
  validity?: string
}): Promise<{ order_id: string }> {
  const body = new URLSearchParams({
    exchange: params.exchange,
    tradingsymbol: params.tradingsymbol,
    transaction_type: params.transaction_type,
    quantity: String(params.quantity),
    product: params.product,
    order_type: params.order_type,
    price: String(params.price),
    validity: params.validity ?? 'DAY',
  })

  let res = await fetch(`${KITE_API_BASE}/orders/regular`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(10_000),
  })

  if (res.status === 403) {
    console.warn('[kite] 403 on order POST — retrying with fresh token')
    await res.text().catch(() => {})
    res = await fetch(`${KITE_API_BASE}/orders/regular`, {
      method: 'POST',
      headers: { ...authHeaders(true), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(10_000),
    })
  }

  const data = await res.json()
  if (!res.ok) throw new Error(data.message ?? `Kite order failed: ${res.status}`)
  const orderId = data.data?.order_id
  if (!orderId) throw new Error('Kite order response missing order_id')
  return { order_id: orderId }
}
