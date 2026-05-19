import { NextRequest, NextResponse } from 'next/server'
import { exec } from 'child_process'
import { getSessionUser } from '@/lib/auth'
import { readWatchlist, writeWatchlist } from '@/lib/watchlist'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json(readWatchlist())
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json() as { stocks?: string[]; restartBot?: boolean }
  const wl = readWatchlist()

  if (Array.isArray(body.stocks)) {
    const deduped = [...new Set(body.stocks.map(s => s.trim().toUpperCase()).filter(Boolean))]
    wl.stocks = deduped
    writeWatchlist(wl)
  }

  let botRestarted = false
  let botError: string | null = null

  if (body.restartBot) {
    await new Promise<void>((resolve) => {
      const cmd = `kill $(ps aux | grep bt-put-multi-book | grep -v grep | awk '{print $2}') 2>/dev/null; sleep 1; cd /workspace/option-trader && nohup ./run-bot.sh >> /tmp/option-trader.log 2>&1 &`
      exec(cmd, { shell: '/bin/bash' }, (err) => {
        if (err && err.code !== 1) {
          botError = err.message.slice(0, 120)
        } else {
          botRestarted = true
        }
        resolve()
      })
    })
  }

  return NextResponse.json({ stocks: wl.stocks, botRestarted, botError })
}
