import { readStockState, type StockState } from './stockState'
import { type StrategyConfig, type PaperPositionRow, STOCK_META, ATM_DELTA } from './strategy'
import { getDb } from './db'

interface ActiveStrategy {
  liveId: number
  strategyId: number
  userId: number
  name: string
  config: StrategyConfig
}

interface OpenPosition {
  id: number
  liveStrategyId: number
  stock: string
  direction: 'BULL' | 'BEAR'
  entryPrice: number
  entryTime: number
  peakMovePct: number
}

export interface LiveSnapshot {
  strategies: {
    liveId: number
    strategyId: number
    name: string
    isActive: boolean
    startedAt: number
    openPositions: (OpenPosition & { currentPrice: number; pnlPct: number; optionPnl: number | null; holdMin: number })[]
    closedToday: PaperPositionRow[]
    totalPnlToday: number
    totalOptionPnlToday: number
  }[]
  updatedAt: number
}

function isMarketOpen(): boolean {
  const now = new Date()
  const istStr = now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })
  const ist = new Date(istStr)
  const day = ist.getDay()
  if (day === 0 || day === 6) return false
  const mins = ist.getHours() * 60 + ist.getMinutes()
  return mins >= 555 && mins <= 930 // 9:15 to 15:30
}

function isEODCloseTime(): boolean {
  const now = new Date()
  const istStr = now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })
  const ist = new Date(istStr)
  const mins = ist.getHours() * 60 + ist.getMinutes()
  return mins >= 925 // 15:25 — force close 5 min before market close
}

function todayStartEpoch(): number {
  const now = new Date()
  const istStr = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
  return new Date(istStr + 'T00:00:00+05:30').getTime()
}

class PaperEngine {
  private interval: ReturnType<typeof setInterval> | null = null
  private active: ActiveStrategy[] = []
  private openPositions: OpenPosition[] = []
  private db: ReturnType<typeof getDb>
  private lastPrices: Record<string, number> = {}

  constructor() {
    this.db = getDb()
    this.loadState()
    this.start()
  }

  private loadState() {
    const rows = this.db.prepare(`
      SELECT ls.id as liveId, ls.strategy_id as strategyId, ls.user_id as userId,
             s.name, s.config_json
      FROM live_strategies ls
      JOIN strategies s ON s.id = ls.strategy_id
      WHERE ls.is_active = 1
    `).all() as any[]

    this.active = rows.map(r => ({
      liveId: r.liveId,
      strategyId: r.strategyId,
      userId: r.userId,
      name: r.name,
      config: JSON.parse(r.config_json) as StrategyConfig,
    }))

    const posRows = this.db.prepare(`
      SELECT id, live_strategy_id as liveStrategyId, stock, direction,
             entry_price as entryPrice, entry_time as entryTime,
             peak_move_pct as peakMovePct
      FROM paper_positions WHERE exit_price IS NULL
    `).all() as any[]

    this.openPositions = posRows.map(r => ({
      id: r.id,
      liveStrategyId: r.liveStrategyId,
      stock: r.stock,
      direction: r.direction,
      entryPrice: r.entryPrice,
      entryTime: r.entryTime,
      peakMovePct: r.peakMovePct,
    }))
  }

  private start() {
    if (this.interval) return
    this.interval = setInterval(() => this.tick(), 5000)
  }

  private tick() {
    const state = readStockState()
    if (!state) return

    // Cache latest prices
    for (const [name, s] of Object.entries(state.stocks)) {
      if (s.ltp > 0) this.lastPrices[name] = s.ltp
    }

    const now = Date.now()

    for (const strat of this.active) {
      const cfg = strat.config
      const stratPositions = this.openPositions.filter(p => p.liveStrategyId === strat.liveId)

      // --- EXIT checks ---
      for (const pos of stratPositions) {
        const stockKey = pos.stock.replace(/^NSE:/, '')
        const sd = state.stocks[stockKey]
        if (!sd || sd.ltp <= 0) continue

        const price = sd.ltp
        let movePct: number
        if (pos.direction === 'BULL') {
          movePct = ((price - pos.entryPrice) / pos.entryPrice) * 100
        } else {
          movePct = ((pos.entryPrice - price) / pos.entryPrice) * 100
        }

        if (movePct > pos.peakMovePct) {
          pos.peakMovePct = movePct
          this.db.prepare('UPDATE paper_positions SET peak_move_pct = ? WHERE id = ?')
            .run(movePct, pos.id)
        }

        const heldMs = now - pos.entryTime
        let exitReason: string | null = null

        // EOD force close
        if (isEODCloseTime()) {
          exitReason = 'EOD'
        }

        // Take profit
        if (!exitReason && cfg.takeProfitEnabled && movePct >= cfg.takeProfitPct) {
          exitReason = 'TakeProfit'
        }
        // Stop loss
        if (!exitReason && cfg.stopLossEnabled && movePct <= -cfg.stopLossPct) {
          exitReason = 'StopLoss'
        }
        // Trail stop
        if (!exitReason && cfg.trailEnabled && pos.peakMovePct >= cfg.trailTriggerPct) {
          const trailThreshold = pos.peakMovePct * (cfg.trailPct / 100)
          if (movePct < trailThreshold) exitReason = 'Trail'
        }
        // Max hold
        if (!exitReason && cfg.maxHoldEnabled && heldMs >= cfg.maxHoldMin * 60000) {
          exitReason = 'MaxHold'
        }
        // No profit
        if (!exitReason && cfg.noProfitEnabled && heldMs >= cfg.noProfitMin * 60000 && pos.peakMovePct <= 0) {
          exitReason = 'NoProfit'
        }

        // Pattern reversal exit
        if (!exitReason && cfg.patternExitEnabled) {
          const exitStoreKey = (cfg.patternExitStore || cfg.patternStore || 'pat5') as keyof Pick<StockState, 'pat5' | 'pat15' | 'pat30v2' | 'pat30_5' | 'pat60_20'>
          const pat = sd[exitStoreKey]
          if (pat && pat.n > 0) {
            const opposingProb = pos.direction === 'BULL' ? pat.bear : pat.bull
            const threshold = cfg.patternExitProb ?? 70
            if (opposingProb >= threshold) {
              exitReason = 'PatternReversal'
            }
          }
        }

        if (exitReason) {
          this.closePosition(pos, price, now, exitReason, cfg)
        }
      }

      // --- ENTRY checks (only during market hours) ---
      if (!isMarketOpen()) continue

      const currentOpenCount = this.openPositions.filter(p => p.liveStrategyId === strat.liveId).length
      if (currentOpenCount >= cfg.maxPositions) continue

      for (const stockNse of cfg.stocks) {
        const stockKey = stockNse.replace(/^NSE:/, '')
        const sd = state.stocks[stockKey]
        if (!sd || sd.ltp <= 0) continue

        // Already have position in this stock for this strategy?
        if (this.openPositions.some(p => p.liveStrategyId === strat.liveId && p.stock === stockNse)) continue

        // Re-check max positions (may have opened one already this tick)
        const nowOpenCount = this.openPositions.filter(p => p.liveStrategyId === strat.liveId).length
        if (nowOpenCount >= cfg.maxPositions) break

        const entrySignal = this.checkEntry(sd, cfg, strat.liveId, stockNse, now)
        if (!entrySignal) continue

        this.openPosition(strat, stockNse, entrySignal, sd.ltp, now)
      }
    }
  }

  private checkEntry(
    sd: StockState, cfg: StrategyConfig, liveId: number, stock: string, now: number
  ): 'BULL' | 'BEAR' | null {
    const sig = sd.signal
    if (sig !== 'BULL' && sig !== 'BEAR') return null
    if (cfg.direction !== 'BOTH' && sig !== cfg.direction) return null

    // Confirm count
    if (sd.confirmCount < cfg.minConfirm) return null

    // OBI
    if (sig === 'BULL' && sd.imbalance < cfg.minObi) return null
    if (sig === 'BEAR' && sd.imbalance > -cfg.minObi) return null

    // mpEdgeTicks — stock-state.json stores the raw value; check directional sign
    if (sd.mpEdgeTicks != null) {
      if (sig === 'BULL' && sd.mpEdgeTicks < cfg.minMpEdgeTicks) return null
      if (sig === 'BEAR' && sd.mpEdgeTicks > -cfg.minMpEdgeTicks) return null
    }

    // Signal score
    if (sd.mpEdgeTicks != null) {
      const score = Math.abs(sd.imbalance * sd.mpEdgeTicks)
      if (score < cfg.minScore) return null
    }

    // CD agreement
    if (cfg.cdRequired) {
      if (sig === 'BULL' && sd.cumDelta < 0) return null
      if (sig === 'BEAR' && sd.cumDelta > 0) return null
    }

    // POC deviation
    if (sd.poc != null && sd.ltp > 0) {
      const dev = Math.abs((sd.ltp - sd.poc) / sd.ltp)
      if (dev < cfg.minPocDev / 100) return null
    }

    // Cooldown
    const lastExit = this.db.prepare(`
      SELECT MAX(exit_time) as t FROM paper_positions
      WHERE live_strategy_id = ? AND stock = ? AND exit_time IS NOT NULL
    `).get(liveId, stock) as any
    if (lastExit?.t && (now - lastExit.t) < cfg.cooldownMin * 60000) return null

    // Pattern prediction
    if (cfg.patternEnabled && cfg.patternStore) {
      const patKey = cfg.patternStore as keyof Pick<StockState, 'pat5' | 'pat15' | 'pat30v2' | 'pat30_5' | 'pat60_20'>
      const pat = sd[patKey]
      if (pat && pat.n > 0) {
        const dirProb = sig === 'BULL' ? pat.bull : pat.bear
        const minProb = cfg.patternMinProb ?? 60
        if (dirProb < minProb) return null

        const minMove = cfg.patternMinMove ?? 0
        if (minMove > 0) {
          const dirMove = sig === 'BULL' ? pat.move : -pat.move
          if (dirMove < minMove) return null
        }
      }
    }

    return sig
  }

  private openPosition(strat: ActiveStrategy, stock: string, direction: 'BULL' | 'BEAR', price: number, now: number) {
    const cfg = strat.config
    let optType: string | null = null
    let strike: number | null = null
    let lotSize: number | null = null

    if (cfg.optionMode) {
      const meta = STOCK_META[stock] ?? { lotSize: 1, strikeStep: 10 }
      optType = direction === 'BULL' ? 'CE' : 'PE'
      strike = optType === 'CE'
        ? Math.floor(price / meta.strikeStep) * meta.strikeStep
        : Math.ceil(price / meta.strikeStep) * meta.strikeStep
      lotSize = meta.lotSize
    }

    const result = this.db.prepare(`
      INSERT INTO paper_positions (live_strategy_id, stock, direction, entry_price, entry_time, opt_type, strike, lot_size)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(strat.liveId, stock, direction, price, now, optType, strike, lotSize)

    const id = Number(this.db.prepare('SELECT last_insert_rowid() as id').get()! as any).valueOf()
    // Actually get the ID properly
    const lastRow = this.db.prepare('SELECT id FROM paper_positions WHERE live_strategy_id = ? AND stock = ? AND entry_time = ? ORDER BY id DESC LIMIT 1')
      .get(strat.liveId, stock, now) as any

    this.openPositions.push({
      id: lastRow.id,
      liveStrategyId: strat.liveId,
      stock,
      direction,
      entryPrice: price,
      entryTime: now,
      peakMovePct: 0,
    })
  }

  private closePosition(pos: OpenPosition, exitPrice: number, now: number, reason: string, cfg: StrategyConfig) {
    let optionPnl: number | null = null
    if (cfg.optionMode) {
      const meta = STOCK_META[pos.stock] ?? { lotSize: 1, strikeStep: 10 }
      const underlyingMove = pos.direction === 'BULL' ? (exitPrice - pos.entryPrice) : (pos.entryPrice - exitPrice)
      optionPnl = Math.round(underlyingMove * ATM_DELTA * meta.lotSize)
    }

    this.db.prepare(`
      UPDATE paper_positions
      SET exit_price = ?, exit_time = ?, exit_reason = ?, option_pnl = ?, peak_move_pct = ?
      WHERE id = ?
    `).run(exitPrice, now, reason, optionPnl, pos.peakMovePct, pos.id)

    this.openPositions = this.openPositions.filter(p => p.id !== pos.id)
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  activate(strategyId: number, userId: number): number {
    // Check if already active
    const existing = this.db.prepare(
      'SELECT id FROM live_strategies WHERE strategy_id = ? AND is_active = 1'
    ).get(strategyId) as any
    if (existing) return existing.id

    this.db.prepare(
      'INSERT INTO live_strategies (user_id, strategy_id, is_active, started_at) VALUES (?, ?, 1, ?)'
    ).run(userId, strategyId, Math.floor(Date.now() / 1000))

    const row = this.db.prepare(
      'SELECT id FROM live_strategies WHERE strategy_id = ? AND is_active = 1'
    ).get(strategyId) as any

    const strat = this.db.prepare(
      'SELECT name, config_json FROM strategies WHERE id = ?'
    ).get(strategyId) as any

    this.active.push({
      liveId: row.id,
      strategyId,
      userId,
      name: strat.name,
      config: JSON.parse(strat.config_json),
    })

    return row.id
  }

  deactivate(liveId: number) {
    this.db.prepare(
      'UPDATE live_strategies SET is_active = 0, stopped_at = ? WHERE id = ?'
    ).run(Math.floor(Date.now() / 1000), liveId)

    // Close all open positions for this strategy
    const positions = this.openPositions.filter(p => p.liveStrategyId === liveId)
    const strat = this.active.find(s => s.liveId === liveId)
    const cfg = strat?.config
    for (const pos of positions) {
      const price = this.lastPrices[pos.stock.replace(/^NSE:/, '')] ?? pos.entryPrice
      this.closePosition(pos, price, Date.now(), 'Manual', cfg ?? {} as StrategyConfig)
    }

    this.active = this.active.filter(s => s.liveId !== liveId)
  }

  manualClose(positionId: number) {
    const pos = this.openPositions.find(p => p.id === positionId)
    if (!pos) return
    const strat = this.active.find(s => s.liveId === pos.liveStrategyId)
    const cfg = strat?.config ?? {} as StrategyConfig
    const price = this.lastPrices[pos.stock.replace(/^NSE:/, '')] ?? pos.entryPrice
    this.closePosition(pos, price, Date.now(), 'Manual', cfg)
  }

  getSnapshot(): LiveSnapshot {
    const state = readStockState()
    const now = Date.now()
    const todayStart = todayStartEpoch()

    const strategies = this.active.map(strat => {
      const openPos = this.openPositions
        .filter(p => p.liveStrategyId === strat.liveId)
        .map(p => {
          const stockKey = p.stock.replace(/^NSE:/, '')
          const currentPrice = state?.stocks[stockKey]?.ltp ?? this.lastPrices[stockKey] ?? p.entryPrice
          let pnlPct: number
          if (p.direction === 'BULL') {
            pnlPct = ((currentPrice - p.entryPrice) / p.entryPrice) * 100
          } else {
            pnlPct = ((p.entryPrice - currentPrice) / p.entryPrice) * 100
          }
          let optionPnl: number | null = null
          if (strat.config.optionMode) {
            const meta = STOCK_META[p.stock] ?? { lotSize: 1, strikeStep: 10 }
            const underlyingMove = p.direction === 'BULL' ? (currentPrice - p.entryPrice) : (p.entryPrice - currentPrice)
            optionPnl = Math.round(underlyingMove * ATM_DELTA * meta.lotSize)
          }
          return {
            ...p,
            currentPrice,
            pnlPct: Math.round(pnlPct * 10000) / 10000,
            optionPnl,
            holdMin: Math.round((now - p.entryTime) / 60000 * 10) / 10,
          }
        })

      const closedToday = this.db.prepare(`
        SELECT id, live_strategy_id as liveStrategyId, stock, direction,
               entry_price as entryPrice, entry_time as entryTime,
               exit_price as exitPrice, exit_time as exitTime,
               exit_reason as exitReason, peak_move_pct as peakMovePct,
               opt_type as optType, strike, lot_size as lotSize, option_pnl as optionPnl
        FROM paper_positions
        WHERE live_strategy_id = ? AND exit_time IS NOT NULL AND exit_time >= ?
        ORDER BY exit_time DESC
      `).all(strat.liveId, todayStart) as unknown as PaperPositionRow[]

      let totalPnlToday = 0
      let totalOptionPnlToday = 0
      for (const t of closedToday) {
        if (t.exitPrice != null && t.entryPrice > 0) {
          const move = t.direction === 'BULL'
            ? ((t.exitPrice - t.entryPrice) / t.entryPrice) * 100
            : ((t.entryPrice - t.exitPrice) / t.entryPrice) * 100
          totalPnlToday += move
        }
        totalOptionPnlToday += t.optionPnl ?? 0
      }
      // Add open positions' unrealized P&L
      for (const p of openPos) {
        totalPnlToday += p.pnlPct
        totalOptionPnlToday += p.optionPnl ?? 0
      }

      return {
        liveId: strat.liveId,
        strategyId: strat.strategyId,
        name: strat.name,
        isActive: true,
        startedAt: 0,
        openPositions: openPos,
        closedToday,
        totalPnlToday: Math.round(totalPnlToday * 10000) / 10000,
        totalOptionPnlToday: Math.round(totalOptionPnlToday),
      }
    })

    return { strategies, updatedAt: state?.updatedAt ?? now }
  }

  // Also include stopped strategies for today's view
  getAllStrategies(): LiveSnapshot {
    const snapshot = this.getSnapshot()

    const stoppedRows = this.db.prepare(`
      SELECT ls.id as liveId, ls.strategy_id as strategyId, ls.started_at as startedAt,
             ls.stopped_at as stoppedAt, s.name
      FROM live_strategies ls
      JOIN strategies s ON s.id = ls.strategy_id
      WHERE ls.is_active = 0 AND ls.stopped_at >= ?
    `).all(Math.floor(todayStartEpoch() / 1000)) as any[]

    for (const row of stoppedRows) {
      const closedToday = this.db.prepare(`
        SELECT id, live_strategy_id as liveStrategyId, stock, direction,
               entry_price as entryPrice, entry_time as entryTime,
               exit_price as exitPrice, exit_time as exitTime,
               exit_reason as exitReason, peak_move_pct as peakMovePct,
               opt_type as optType, strike, lot_size as lotSize, option_pnl as optionPnl
        FROM paper_positions
        WHERE live_strategy_id = ? AND exit_time IS NOT NULL AND exit_time >= ?
        ORDER BY exit_time DESC
      `).all(row.liveId, todayStartEpoch()) as unknown as PaperPositionRow[]

      let totalPnlToday = 0
      let totalOptionPnlToday = 0
      for (const t of closedToday) {
        if (t.exitPrice != null && t.entryPrice > 0) {
          const move = t.direction === 'BULL'
            ? ((t.exitPrice - t.entryPrice) / t.entryPrice) * 100
            : ((t.entryPrice - t.exitPrice) / t.entryPrice) * 100
          totalPnlToday += move
        }
        totalOptionPnlToday += t.optionPnl ?? 0
      }

      snapshot.strategies.push({
        liveId: row.liveId,
        strategyId: row.strategyId,
        name: row.name,
        isActive: false,
        startedAt: row.startedAt * 1000,
        openPositions: [],
        closedToday,
        totalPnlToday: Math.round(totalPnlToday * 10000) / 10000,
        totalOptionPnlToday: Math.round(totalOptionPnlToday),
      })
    }

    return snapshot
  }
}

// Lazy singleton — only created on first access, survives hot reload via globalThis
const g = globalThis as any
export function getEngine(): PaperEngine {
  if (!g.__paperEngine) {
    g.__paperEngine = new PaperEngine()
  }
  return g.__paperEngine
}
