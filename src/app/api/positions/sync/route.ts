import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { kiteGetPositions, kiteGetQuote } from '@/lib/kite'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

let lastSyncTs = 0
const SYNC_COOLDOWN_MS = 10_000

export async function POST() {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (Date.now() - lastSyncTs < SYNC_COOLDOWN_MS) {
    return NextResponse.json({ error: 'Rate limited — wait 10s between syncs' }, { status: 429 })
  }

  try {
    const { net } = await kiteGetPositions()

    const nfoOptions = net.filter((p: any) =>
      p.exchange === 'NFO' &&
      (p.quantity as number) > 0 &&
      (String(p.tradingsymbol).endsWith('CE') || String(p.tradingsymbol).endsWith('PE'))
    )

    const positions = nfoOptions.map((p: any) => {
      const sym = String(p.tradingsymbol)
      const optType = sym.endsWith('CE') ? 'CE' : 'PE'
      const direction = optType === 'CE' ? 'BULL' : 'BEAR'
      return {
        tradingsymbol: sym,
        exchange: p.exchange,
        quantity: p.quantity,
        averagePrice: p.average_price,
        lastPrice: p.last_price,
        pnl: p.pnl ?? ((p.last_price - p.average_price) * p.quantity),
        optType,
        direction,
        product: p.product,
        instrumentToken: p.instrument_token,
      }
    })

    let quotes: Record<string, any> = {}
    if (positions.length > 0) {
      const symbols = positions.map(p => `NFO:${p.tradingsymbol}`)
      try {
        quotes = await kiteGetQuote(symbols)
      } catch { /* quote fetch optional */ }
    }

    const enriched = positions.map(p => {
      const q = quotes[`NFO:${p.tradingsymbol}`]
      return {
        ...p,
        bestBid: q?.depth?.buy?.[0]?.price ?? null,
        bestAsk: q?.depth?.sell?.[0]?.price ?? null,
        oi: q?.oi ?? null,
      }
    })

    lastSyncTs = Date.now()

    return NextResponse.json({
      ok: true,
      count: enriched.length,
      positions: enriched,
      syncedAt: lastSyncTs,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
