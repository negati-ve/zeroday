import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import fs from 'fs'

const PAPER_TRADES_FILE = '/workspace/option-trader/paper-trades.jsonl'

export async function POST(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json() as {
    stock: string
    optType: 'CE' | 'PE'
    strike: number
    strikeLabel: 'ITM' | 'OTM'
    ltp: number
  }

  const { stock, optType, strike, strikeLabel, ltp } = body
  if (!stock || !optType || !strike || !strikeLabel || !ltp) {
    return NextResponse.json({ error: 'stock, optType, strike, strikeLabel, ltp required' }, { status: 400 })
  }

  const trade = {
    ts: Date.now(),
    stock,
    optType,
    strike,
    strikeLabel,
    underlyingLtp: ltp,
    entryTime: new Date().toISOString(),
  }

  try {
    fs.appendFileSync(PAPER_TRADES_FILE, JSON.stringify(trade) + '\n')
  } catch {
    return NextResponse.json({ error: 'Failed to write paper trade log' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, trade })
}

export async function GET(_req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    if (!fs.existsSync(PAPER_TRADES_FILE)) return NextResponse.json({ trades: [] })
    const lines = fs.readFileSync(PAPER_TRADES_FILE, 'utf8').trim().split('\n').filter(Boolean)
    const trades = lines.map(l => JSON.parse(l))
    return NextResponse.json({ trades })
  } catch {
    return NextResponse.json({ trades: [] })
  }
}
