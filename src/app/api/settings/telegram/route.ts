import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import fs from 'fs'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const SETTINGS_FILE = '/workspace/option-trader/telegram-settings.json'

interface TelegramSettings {
  enabled: boolean
  categories: Record<string, boolean>
}

const DEFAULT_SETTINGS: TelegramSettings = {
  enabled: true,
  categories: {
    startup: true,
    shutdown: true,
    auth: true,
    market_hours: true,
    websocket: true,
    entries: true,
    exits: true,
    exit_alerts: true,
    position_sync: true,
    capital: true,
    watchlist: true,
    walls: true,
    patterns: true,
    pat30m_virtual: true,
    holidays: true,
    errors: true,
    gt_entries: true,
    gt_exits: true,
    gt_watchlist: true,
    gt_alerts: true,
  },
}

function readSettings(): TelegramSettings {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8')
    const parsed = JSON.parse(raw) as TelegramSettings
    return {
      enabled: parsed.enabled ?? true,
      categories: { ...DEFAULT_SETTINGS.categories, ...parsed.categories },
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export async function GET() {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json(readSettings())
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json() as Partial<TelegramSettings>
  const current = readSettings()

  if (typeof body.enabled === 'boolean') {
    current.enabled = body.enabled
  }
  if (body.categories && typeof body.categories === 'object') {
    for (const [key, val] of Object.entries(body.categories)) {
      if (typeof val === 'boolean' && key in current.categories) {
        current.categories[key] = val
      }
    }
  }

  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(current, null, 2))
    return NextResponse.json({ ok: true, settings: current })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
