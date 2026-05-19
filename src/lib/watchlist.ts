import fs from 'fs'
import path from 'path'

const WATCHLIST_FILE = path.join('/workspace/option-trader', 'watchlist.json')

export interface Watchlist {
  stocks: string[]
}

export function readWatchlist(): Watchlist {
  try {
    const raw = fs.readFileSync(WATCHLIST_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Watchlist
    if (Array.isArray(parsed.stocks)) return parsed
  } catch { /* fall through */ }
  // Fallback: read from .env STOCK_WHITELIST
  const envList = process.env.STOCK_WHITELIST ?? ''
  const stocks = envList ? envList.split(',').map(s => s.trim()).filter(Boolean) : []
  return { stocks }
}

export function writeWatchlist(wl: Watchlist): void {
  fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(wl, null, 2))
}
