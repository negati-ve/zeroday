import fs from 'fs'
import path from 'path'

const STATE_FILE  = path.join('/workspace/option-trader', 'stock-state.json')
const PRICES_FILE = path.join('/workspace/option-trader', 'stock-prices.json')

export interface PatData {
  move: number
  bull: number
  bear: number
  sim: number
  n: number
  predDir?: 'BULL' | 'BEAR'
  predAge?: number
  actualMove?: number
  agrees?: boolean
}

export interface WallData {
  price: number
  iceberg: boolean
  resets: number
  drainPct: number
  absRatio?: number
}

export interface DepthWall {
  side: 'BID' | 'ASK'
  status: 'FORMING' | 'DEFENDING' | 'GROWING' | 'BREAKING'
  price: number
  ratio: number
  defenseCount: number
}

export interface StockState {
  ltp: number
  signal: 'BULL' | 'BEAR' | 'NEUTRAL'
  confirmCount: number
  trend: 'BULL' | 'BEAR' | 'NEUTRAL'
  imbalance: number
  strikeStep: number
  mpEdgeTicks: number | null
  aggRatio: number
  cdZ: number
  cumDelta: number
  pat5: PatData | null
  pat15: PatData | null
  pat30: PatData | null
  pat30v2: PatData | null
  pat30_5: PatData | null
  pat60_20: PatData | null
  // Extended fields
  cdVelZ: number
  emaAgg: number
  cosineBull: number
  cosineBear: number
  cusumBull: boolean
  cusumBear: boolean
  hvn: { price: number; dev: number } | null
  va: { low: number; high: number; inside: boolean } | null
  poc: number | null
  shortPoc: number | null
  wallAsk: WallData | null
  wallBid: WallData | null
  depthWalls: DepthWall[]
  squeezeActive: 'BULL' | 'BEAR' | null
  squeezeConsec: number
  intradayHigh: number | null
  intradayLow: number | null
  // Technical indicators
  indicators: {
    emaShort: number | null
    emaLong: number | null
    emaCrossover: 'BULL' | 'BEAR' | null
    rsi: number | null
    vwap: number | null
    vwapAlign: 'BULL' | 'BEAR' | null
    atr: number | null
    atrPct: number | null
  } | null
  // computed
  alignScore: number
  alignDir: 'BULL' | 'BEAR' | 'MIXED' | 'NONE'
}

export interface Position {
  stock: string
  direction: 'BULL' | 'BEAR'
  buySymbol: string
  sellSymbol: string | null
  buyToken: number
  lotSize: number
  buyEntry: number
  sellEntry: number
  currentBid: number | null
  pnl: number | null
  peak: number
  heldMin: number
  source: 'zerodha' | 'bot'
  isExiting: boolean
}

export interface CapitalData {
  net: number
  cash: number
  collateral: number
  totalUsed: number
  optPremium: number
  span: number
  exposure: number
  m2mUnreal: number
  realizedToday?: number
  openPnl?: number
  fetchedAt: number
}

export interface StockStateFile {
  updatedAt: number
  stocks: Record<string, StockState>
  positions: Position[]
  capital: CapitalData | null
}

function computeAlignment(stock: Omit<StockState, 'alignScore' | 'alignDir'>): { alignScore: number; alignDir: 'BULL' | 'BEAR' | 'MIXED' | 'NONE' } {
  const scores: number[] = []
  if (stock.pat30_5)  scores.push(stock.pat30_5.bull  - stock.pat30_5.bear)
  if (stock.pat60_20) scores.push(stock.pat60_20.bull - stock.pat60_20.bear)
  if (stock.pat30v2)  scores.push(stock.pat30v2.bull  - stock.pat30v2.bear)
  else if (stock.pat30) scores.push(stock.pat30.bull - stock.pat30.bear)

  if (scores.length === 0) return { alignScore: 0, alignDir: 'NONE' }

  const avg = scores.reduce((a, b) => a + b, 0) / scores.length
  const allBull = scores.every(s => s > 0)
  const allBear = scores.every(s => s < 0)

  const alignScore = Math.abs(avg) / 100
  const alignDir = allBull ? 'BULL' : allBear ? 'BEAR' : scores.length > 1 ? 'MIXED' : avg > 0 ? 'BULL' : 'BEAR'

  return { alignScore, alignDir }
}

export interface StockPrice {
  ltp: number
  signal: 'BULL' | 'BEAR' | 'NEUTRAL'
  confirmCount: number
  cdZ: number
  trend: 'BULL' | 'BEAR' | 'NEUTRAL'
  imbalance: number
}

export interface StockPricesFile {
  updatedAt: number
  prices: Record<string, StockPrice>
}

export function readStockPrices(): StockPricesFile | null {
  try {
    const raw = fs.readFileSync(PRICES_FILE, 'utf8')
    return JSON.parse(raw) as StockPricesFile
  } catch {
    return null
  }
}

export function readPositions(): { positions: Position[]; capital: CapitalData | null } | null {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8')
    const parsed = JSON.parse(raw) as { positions?: Position[]; capital?: CapitalData | null }
    return { positions: parsed.positions ?? [], capital: parsed.capital ?? null }
  } catch {
    return null
  }
}

export function readStockState(): StockStateFile | null {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8')
    const parsed = JSON.parse(raw) as {
      updatedAt: number
      stocks: Record<string, Omit<StockState, 'alignScore' | 'alignDir'>>
      positions?: Position[]
      capital?: CapitalData | null
    }
    const extendedDefaults = {
      strikeStep: 10,
      cdVelZ: 0, emaAgg: 0, cosineBull: 0, cosineBear: 0,
      cusumBull: false as boolean, cusumBear: false as boolean,
      hvn: null as StockState['hvn'], va: null as StockState['va'],
      poc: null as number | null, shortPoc: null as number | null,
      wallAsk: null as StockState['wallAsk'], wallBid: null as StockState['wallBid'],
      depthWalls: [] as DepthWall[],
      squeezeActive: null as StockState['squeezeActive'], squeezeConsec: 0,
      intradayHigh: null as number | null, intradayLow: null as number | null,
      indicators: null as StockState['indicators'],
      pat30v2: null as PatData | null,
      pat60_20: null as PatData | null,
    }
    const stocks: Record<string, StockState> = {}
    for (const [name, data] of Object.entries(parsed.stocks)) {
      const { alignScore, alignDir } = computeAlignment(data)
      stocks[name] = { ...extendedDefaults, ...data, alignScore, alignDir }
    }
    return { updatedAt: parsed.updatedAt, stocks, positions: parsed.positions ?? [], capital: parsed.capital ?? null }
  } catch {
    return null
  }
}

export function sortedStocks(state: StockStateFile): [string, StockState][] {
  return Object.entries(state.stocks).sort(([, a], [, b]) => {
    // Primary: alignment score (non-MIXED beats MIXED)
    const aScore = a.alignDir === 'MIXED' ? a.alignScore * 0.5 : a.alignScore
    const bScore = b.alignDir === 'MIXED' ? b.alignScore * 0.5 : b.alignScore
    if (Math.abs(aScore - bScore) > 0.01) return bScore - aScore
    // Secondary: total n (more data = more reliable)
    const aN = (a.pat5?.n ?? 0) + (a.pat15?.n ?? 0) + (a.pat30v2?.n ?? a.pat30?.n ?? 0)
    const bN = (b.pat5?.n ?? 0) + (b.pat15?.n ?? 0) + (b.pat30v2?.n ?? b.pat30?.n ?? 0)
    return bN - aN
  })
}
