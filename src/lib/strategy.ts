export interface StrategyConfig {
  stocks: string[]
  direction: 'BULL' | 'BEAR' | 'BOTH'
  minConfirm: number
  minObi: number
  minMpEdgeTicks: number
  minScore: number
  cdRequired: boolean
  minPocDev: number
  cooldownMin: number
  maxPositions: number
  takeProfitEnabled: boolean
  takeProfitPct: number
  stopLossEnabled: boolean
  stopLossPct: number
  trailEnabled: boolean
  trailTriggerPct: number
  trailPct: number
  maxHoldEnabled: boolean
  maxHoldMin: number
  noProfitEnabled: boolean
  noProfitMin: number
  patternEnabled?: boolean
  patternStore?: string
  patternMinProb?: number
  patternMinMove?: number
  patternExitEnabled?: boolean
  patternExitStore?: string
  patternExitProb?: number
  optionMode?: boolean
  // Technical Indicators
  emaFilterEnabled?: boolean
  emaShortPeriod?: number
  emaLongPeriod?: number
  emaMode?: 'price_above' | 'crossover'
  rsiFilterEnabled?: boolean
  rsiPeriod?: number
  rsiOverbought?: number
  rsiOversold?: number
  vwapFilterEnabled?: boolean
  atrExitEnabled?: boolean
  atrPeriod?: number
  atrStopMult?: number
  atrTargetMult?: number
}

export interface SavedStrategy {
  id: number
  userId: number
  name: string
  config: StrategyConfig
  createdAt: number
  updatedAt: number
}

export interface LiveStrategyRow {
  id: number
  userId: number
  strategyId: number
  isActive: number
  startedAt: number
  stoppedAt: number | null
}

export interface PaperPositionRow {
  id: number
  liveStrategyId: number
  stock: string
  direction: 'BULL' | 'BEAR'
  entryPrice: number
  entryTime: number
  exitPrice: number | null
  exitTime: number | null
  exitReason: string | null
  peakMovePct: number
  optType: string | null
  strike: number | null
  lotSize: number | null
  optionPnl: number | null
}

export const STOCK_META: Record<string, { lotSize: number; strikeStep: number }> = {
  'NSE:HDFCBANK': { lotSize: 550, strikeStep: 5 },
  'NSE:INFY': { lotSize: 400, strikeStep: 20 },
  'NSE:ICICIBANK': { lotSize: 700, strikeStep: 10 },
  'NSE:WIPRO': { lotSize: 3000, strikeStep: 5 },
  'NSE:HCLTECH': { lotSize: 350, strikeStep: 10 },
  'NSE:KOTAKBANK': { lotSize: 2000, strikeStep: 5 },
  'NSE:BAJFINANCE': { lotSize: 750, strikeStep: 10 },
  'NSE:AXISBANK': { lotSize: 625, strikeStep: 10 },
  'NSE:SUNPHARMA': { lotSize: 350, strikeStep: 20 },
  'NSE:RELIANCE': { lotSize: 500, strikeStep: 10 },
  'NSE:LT': { lotSize: 175, strikeStep: 20 },
  'NSE:INDUSTOWER': { lotSize: 1700, strikeStep: 5 },
  'NSE:DIXON': { lotSize: 125, strikeStep: 50 },
  'NSE:HINDUNILVR': { lotSize: 300, strikeStep: 10 },
  'NSE:INDIGO': { lotSize: 300, strikeStep: 25 },
  'NSE:LODHA': { lotSize: 750, strikeStep: 5 },
  'NSE:MANKIND': { lotSize: 250, strikeStep: 25 },
  'NSE:PRESTIGE': { lotSize: 438, strikeStep: 5 },
  'NSE:TITAN': { lotSize: 375, strikeStep: 10 },
  'NSE:TCS': { lotSize: 175, strikeStep: 25 },
  'NSE:SBIN': { lotSize: 1500, strikeStep: 5 },
}

export const ATM_DELTA = 0.5
