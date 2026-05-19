import { NextRequest } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { readStockState, sortedStocks, readStockPrices } from '@/lib/stockState'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(_req: NextRequest) {
  const user = await getSessionUser()
  if (!user) {
    return new Response('Unauthorized', { status: 401 })
  }

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    start(controller) {
      let closed = false

      const enqueue = (chunk: string) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          closed = true
        }
      }

      const send = (data: unknown) => enqueue(`data: ${JSON.stringify(data)}\n\n`)
      // SSE comment — keeps proxy alive, no client-side effect
      const heartbeat = () => enqueue(': heartbeat\n\n')

      // Send snapshot immediately on connect
      const state = readStockState()
      const makeSnapshot = (s: ReturnType<typeof readStockState>) => s
        ? { type: 'snapshot', stocks: sortedStocks(s).map(([name, st]) => ({ name, ...st })), positions: s.positions, capital: s.capital, updatedAt: s.updatedAt }
        : { type: 'waiting' }

      send(makeSnapshot(state))

      // Poll prices every 1s — fast ltp/signal/cdZ/trend updates
      const pricesInterval = setInterval(() => {
        if (closed) { clearInterval(pricesInterval); return }
        const p = readStockPrices()
        if (!p) return
        send({ type: 'prices', prices: p.prices, updatedAt: p.updatedAt })
      }, 1000)

      // Full snapshot every 10s — includes pat data and positions
      const dataInterval = setInterval(() => {
        if (closed) { clearInterval(dataInterval); return }
        send(makeSnapshot(readStockState()))
      }, 10000)

      // Heartbeat every 15s — prevents proxy timeout on idle connections
      const heartbeatInterval = setInterval(() => {
        if (closed) { clearInterval(heartbeatInterval); return }
        heartbeat()
      }, 15000)

      // Cleanup on client disconnect
      const cleanup = () => {
        closed = true
        clearInterval(pricesInterval)
        clearInterval(dataInterval)
        clearInterval(heartbeatInterval)
      }
      _req.signal.addEventListener('abort', cleanup)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',       // nginx: disable proxy buffering for this response
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
