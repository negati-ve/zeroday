import { NextRequest } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { getEngine } from '@/lib/paperEngine'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(_req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return new Response('Unauthorized', { status: 401 })

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    start(controller) {
      let closed = false

      const enqueue = (chunk: string) => {
        if (closed) return
        try { controller.enqueue(encoder.encode(chunk)) } catch { closed = true }
      }

      const send = (data: unknown) => enqueue(`data: ${JSON.stringify(data)}\n\n`)

      // Immediate snapshot
      send(getEngine().getAllStrategies())

      // Push updates every 5s
      const interval = setInterval(() => {
        if (closed) { clearInterval(interval); return }
        send(getEngine().getAllStrategies())
      }, 5000)

      // Heartbeat every 15s
      const heartbeat = setInterval(() => {
        if (closed) { clearInterval(heartbeat); return }
        enqueue(': heartbeat\n\n')
      }, 15000)

      _req.signal.addEventListener('abort', () => {
        closed = true
        clearInterval(interval)
        clearInterval(heartbeat)
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
