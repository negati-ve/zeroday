'use client'
import { useState, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import ThemeToggle from '@/components/ThemeToggle'

// Fallback stock list (updated from DB on mount)
const FALLBACK_STOCKS = [
  'NSE:AXISBANK','NSE:BAJFINANCE','NSE:DIXON','NSE:HCLTECH','NSE:HDFCBANK',
  'NSE:HINDUNILVR','NSE:ICICIBANK','NSE:INDIGO','NSE:INDUSTOWER','NSE:INFY',
  'NSE:KOTAKBANK','NSE:LODHA','NSE:LT','NSE:MANKIND','NSE:PRESTIGE',
  'NSE:RELIANCE','NSE:SUNPHARMA','NSE:TITAN','NSE:WIPRO',
]

// ── Types ────────────────────────────────────────────────────────────────────

interface Trade {
  stock: string
  direction: 'BULL' | 'BEAR'
  entryPrice: number
  exitPrice: number
  entryTime: string
  exitTime: string
  pnlPct: number
  holdMin: number
  exitReason: string
  peakPct: number
  patBullProb?: number
  patBearProb?: number
  patPredMove?: number
  patTopSim?: number
  optType?: 'CE' | 'PE'
  strike?: number
  lotSize?: number
  optionPnl?: number
}

interface Summary {
  totalTrades: number
  winRate: number
  avgPnlPct: number
  totalPnlPct: number
  avgHoldMin: number
  maxDrawdownPct: number
  totalOptionPnl?: number
  byStock: Record<string, { trades: number; winRate: number; avgPnlPct: number; totalPnlPct: number; totalOptionPnl?: number }>
  byExitReason: Record<string, number>
}

type SortKey = 'stock' | 'direction' | 'pnlPct' | 'holdMin' | 'exitReason' | 'entryTime' | 'optionPnl'

// ── Helpers ──────────────────────────────────────────────────────────────────

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function defaultStartDate(): string {
  const d = new Date()
  d.setDate(d.getDate() - 7)
  return isoDate(d)
}

function defaultEndDate(): string {
  return isoDate(new Date())
}

function fmtDateShort(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
}

// ── Styles ───────────────────────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  fontSize: '9px', color: 'var(--text3)', letterSpacing: '0.1em', textTransform: 'uppercase',
  marginBottom: '4px', display: 'block',
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '5px 8px',
  background: 'var(--bg3)', border: '1px solid var(--border)',
  borderRadius: '4px', color: 'var(--text)',
  fontFamily: 'inherit', fontSize: '11px', outline: 'none',
}

const checkboxRowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text2)', cursor: 'pointer',
}

const sectionTitleStyle: React.CSSProperties = {
  fontSize: '10px', fontWeight: 700, color: 'var(--text2)', letterSpacing: '0.08em',
  textTransform: 'uppercase', marginBottom: '8px', marginTop: '14px',
}

const cardStyle: React.CSSProperties = {
  background: 'var(--bg2)', border: '1px solid var(--border)',
  borderRadius: '6px', padding: '12px 14px',
  display: 'flex', flexDirection: 'column', gap: '2px',
}

const btnStyle: React.CSSProperties = {
  border: '1px solid var(--border)', borderRadius: '4px',
  padding: '6px 14px', fontSize: '11px', fontFamily: 'inherit',
  cursor: 'pointer', letterSpacing: '0.05em', transition: 'all 0.15s',
  background: 'transparent', color: 'var(--text2)',
}

// ── Config Panel ─────────────────────────────────────────────────────────────

interface SavedStrat { id: number; name: string; config: any; lastResults?: Summary | null; lastRunAt?: number; configHash?: string; updatedAt?: number }

function hashConfig(cfg: any): string {
  // Deterministic hash from config (excluding date range which is run-specific)
  const { startDate, endDate, ...rest } = cfg
  const str = JSON.stringify(rest, Object.keys(rest).sort())
  let h = 0
  for (let i = 0; i < str.length; i++) { h = ((h << 5) - h + str.charCodeAt(i)) | 0 }
  return 'h' + Math.abs(h).toString(36)
}

function ConfigPanel({ onRun, running, allStocks, activeStrategyId, loadConfig }: {
  onRun: (cfg: any) => void; running: boolean; allStocks: string[];
  activeStrategyId: number | null; loadConfig: any | null;
}) {
  const [selectedStocks, setSelectedStocks] = useState<Set<string>>(new Set(allStocks))
  const [_strategyName, _setStrategyName] = useState('') // unused, kept for compat
  const [startDate, setStartDate] = useState(defaultStartDate)
  const [endDate, setEndDate] = useState(defaultEndDate)
  const [direction, setDirection] = useState<'BOTH' | 'BULL' | 'BEAR'>('BOTH')

  // Entry filters
  const [minConfirm, setMinConfirm] = useState(4)
  const [minObi, setMinObi] = useState(0.35)
  const [minMpEdgeTicks, setMinMpEdgeTicks] = useState(0.3)
  const [minScore, setMinScore] = useState(0.15)
  const [cdRequired, setCdRequired] = useState(false)
  const [minPocDev, setMinPocDev] = useState(0.3)
  const [cooldownMin, setCooldownMin] = useState(15)
  const [maxPositions, setMaxPositions] = useState(1)

  // Pattern prediction filter
  const [patternEnabled, setPatternEnabled] = useState(false)
  const [patternStore, setPatternStore] = useState<string>('pat5')
  const [patternMinProb, setPatternMinProb] = useState(60)
  const [patternMinMove, setPatternMinMove] = useState(0)

  // Pattern exit
  const [patternExitEnabled, setPatternExitEnabled] = useState(false)
  const [patternExitStore, setPatternExitStore] = useState<string>('')
  const [patternExitProb, setPatternExitProb] = useState(70)

  // Technical Indicators
  const [emaFilterEnabled, setEmaFilterEnabled] = useState(false)
  const [emaShortPeriod, setEmaShortPeriod] = useState(9)
  const [emaLongPeriod, setEmaLongPeriod] = useState(21)
  const [emaMode, setEmaMode] = useState<'price_above' | 'crossover'>('price_above')
  const [rsiFilterEnabled, setRsiFilterEnabled] = useState(false)
  const [rsiPeriod, setRsiPeriod] = useState(14)
  const [rsiOverbought, setRsiOverbought] = useState(70)
  const [rsiOversold, setRsiOversold] = useState(30)
  const [vwapFilterEnabled, setVwapFilterEnabled] = useState(false)
  const [atrExitEnabled, setAtrExitEnabled] = useState(false)
  const [atrPeriod, setAtrPeriod] = useState(14)
  const [atrStopMult, setAtrStopMult] = useState(2.0)
  const [atrTargetMult, setAtrTargetMult] = useState(3.0)

  // Leverage mode
  const [optionMode, setOptionMode] = useState(false)

  // Exit strategy
  const [takeProfitEnabled, setTakeProfitEnabled] = useState(true)
  const [takeProfitPct, setTakeProfitPct] = useState(0.3)
  const [stopLossEnabled, setStopLossEnabled] = useState(true)
  const [stopLossPct, setStopLossPct] = useState(0.5)
  const [trailEnabled, setTrailEnabled] = useState(true)
  const [trailTriggerPct, setTrailTriggerPct] = useState(0.15)
  const [trailPct, setTrailPct] = useState(45)
  const [maxHoldEnabled, setMaxHoldEnabled] = useState(true)
  const [maxHoldMin, setMaxHoldMin] = useState(20)
  const [noProfitEnabled, setNoProfitEnabled] = useState(true)
  const [noProfitMin, setNoProfitMin] = useState(4)

  function toggleStock(s: string) {
    setSelectedStocks(prev => {
      const next = new Set(prev)
      if (next.has(s)) next.delete(s); else next.add(s)
      return next
    })
  }

  // Sync when allStocks changes (e.g. fetched from API)
  useEffect(() => { setSelectedStocks(new Set(allStocks)) }, [allStocks])

  function selectAll() { setSelectedStocks(new Set(allStocks)) }
  function deselectAll() { setSelectedStocks(new Set()) }

  function getStrategyConfig() {
    return {
      stocks: [...selectedStocks], direction,
      minConfirm, minObi, minMpEdgeTicks, minScore,
      cdRequired, minPocDev, cooldownMin, maxPositions,
      patternEnabled, patternStore, patternMinProb, patternMinMove,
      patternExitEnabled,
      patternExitStore: patternExitStore || undefined,
      patternExitProb,
      emaFilterEnabled, emaShortPeriod, emaLongPeriod, emaMode,
      rsiFilterEnabled, rsiPeriod, rsiOverbought, rsiOversold,
      vwapFilterEnabled,
      atrExitEnabled, atrPeriod, atrStopMult, atrTargetMult,
      optionMode,
      takeProfitEnabled, takeProfitPct,
      stopLossEnabled, stopLossPct,
      trailEnabled, trailTriggerPct, trailPct,
      maxHoldEnabled, maxHoldMin,
      noProfitEnabled, noProfitMin,
    }
  }

  function handleRun() {
    onRun({ ...getStrategyConfig(), startDate, endDate })
  }

  function applyConfig(cfg: any) {
    if (cfg.stocks) setSelectedStocks(new Set(cfg.stocks))
    if (cfg.direction) setDirection(cfg.direction)
    if (cfg.minConfirm != null) setMinConfirm(cfg.minConfirm)
    if (cfg.minObi != null) setMinObi(cfg.minObi)
    if (cfg.minMpEdgeTicks != null) setMinMpEdgeTicks(cfg.minMpEdgeTicks)
    if (cfg.minScore != null) setMinScore(cfg.minScore)
    if (cfg.cdRequired != null) setCdRequired(cfg.cdRequired)
    if (cfg.minPocDev != null) setMinPocDev(cfg.minPocDev)
    if (cfg.cooldownMin != null) setCooldownMin(cfg.cooldownMin)
    if (cfg.maxPositions != null) setMaxPositions(cfg.maxPositions)
    if (cfg.patternEnabled != null) setPatternEnabled(cfg.patternEnabled)
    if (cfg.patternStore != null) setPatternStore(cfg.patternStore)
    if (cfg.patternMinProb != null) setPatternMinProb(cfg.patternMinProb)
    if (cfg.patternMinMove != null) setPatternMinMove(cfg.patternMinMove)
    if (cfg.patternExitEnabled != null) setPatternExitEnabled(cfg.patternExitEnabled)
    if (cfg.patternExitStore != null) setPatternExitStore(cfg.patternExitStore)
    if (cfg.patternExitProb != null) setPatternExitProb(cfg.patternExitProb)
    if (cfg.emaFilterEnabled != null) setEmaFilterEnabled(cfg.emaFilterEnabled)
    if (cfg.emaShortPeriod != null) setEmaShortPeriod(cfg.emaShortPeriod)
    if (cfg.emaLongPeriod != null) setEmaLongPeriod(cfg.emaLongPeriod)
    if (cfg.emaMode != null) setEmaMode(cfg.emaMode)
    if (cfg.rsiFilterEnabled != null) setRsiFilterEnabled(cfg.rsiFilterEnabled)
    if (cfg.rsiPeriod != null) setRsiPeriod(cfg.rsiPeriod)
    if (cfg.rsiOverbought != null) setRsiOverbought(cfg.rsiOverbought)
    if (cfg.rsiOversold != null) setRsiOversold(cfg.rsiOversold)
    if (cfg.vwapFilterEnabled != null) setVwapFilterEnabled(cfg.vwapFilterEnabled)
    if (cfg.atrExitEnabled != null) setAtrExitEnabled(cfg.atrExitEnabled)
    if (cfg.atrPeriod != null) setAtrPeriod(cfg.atrPeriod)
    if (cfg.atrStopMult != null) setAtrStopMult(cfg.atrStopMult)
    if (cfg.atrTargetMult != null) setAtrTargetMult(cfg.atrTargetMult)
    if (cfg.optionMode != null) setOptionMode(cfg.optionMode)
    if (cfg.takeProfitEnabled != null) setTakeProfitEnabled(cfg.takeProfitEnabled)
    if (cfg.takeProfitPct != null) setTakeProfitPct(cfg.takeProfitPct)
    if (cfg.stopLossEnabled != null) setStopLossEnabled(cfg.stopLossEnabled)
    if (cfg.stopLossPct != null) setStopLossPct(cfg.stopLossPct)
    if (cfg.trailEnabled != null) setTrailEnabled(cfg.trailEnabled)
    if (cfg.trailTriggerPct != null) setTrailTriggerPct(cfg.trailTriggerPct)
    if (cfg.trailPct != null) setTrailPct(cfg.trailPct)
    if (cfg.maxHoldEnabled != null) setMaxHoldEnabled(cfg.maxHoldEnabled)
    if (cfg.maxHoldMin != null) setMaxHoldMin(cfg.maxHoldMin)
    if (cfg.noProfitEnabled != null) setNoProfitEnabled(cfg.noProfitEnabled)
    if (cfg.noProfitMin != null) setNoProfitMin(cfg.noProfitMin)
  }

  // Apply loaded config from parent (strategy selector)
  useEffect(() => {
    if (loadConfig) applyConfig(loadConfig)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadConfig])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      {/* Stock selection */}
      <div style={sectionTitleStyle}>STOCKS</div>
      <div style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
        <button onClick={selectAll} style={{ ...btnStyle, padding: '3px 8px', fontSize: '10px' }}>SELECT ALL</button>
        <button onClick={deselectAll} style={{ ...btnStyle, padding: '3px 8px', fontSize: '10px' }}>DESELECT ALL</button>
        <span style={{ fontSize: '10px', color: 'var(--text3)', alignSelf: 'center' }}>{selectedStocks.size}/{allStocks.length}</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '8px' }}>
        {allStocks.map(s => {
          const short = s.replace('NSE:', '')
          const on = selectedStocks.has(s)
          return (
            <button key={s} onClick={() => toggleStock(s)} style={{
              background: on ? 'var(--bg3)' : 'transparent',
              border: `1px solid ${on ? 'var(--text3)' : 'var(--border)'}`,
              borderRadius: '3px', padding: '2px 6px',
              fontSize: '10px', fontFamily: 'inherit', cursor: 'pointer',
              color: on ? 'var(--text)' : 'var(--text3)',
              transition: 'all 0.1s',
            }}>{short}</button>
          )
        })}
      </div>

      {/* Date range */}
      <div style={sectionTitleStyle}>DATE RANGE</div>
      <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>START</label>
          <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={inputStyle} />
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>END</label>
          <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} style={inputStyle} />
        </div>
      </div>

      {/* Direction */}
      <div style={sectionTitleStyle}>SIGNAL DIRECTION</div>
      <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
        {(['BOTH', 'BULL', 'BEAR'] as const).map(d => (
          <button key={d} onClick={() => setDirection(d)} style={{
            ...btnStyle, padding: '4px 10px', fontSize: '10px',
            background: direction === d ? (d === 'BULL' ? 'var(--bull)' : d === 'BEAR' ? 'var(--bear)' : 'var(--accent)') : 'transparent',
            color: direction === d ? (d === 'BOTH' ? 'var(--bg)' : '#000') : 'var(--text3)',
            border: direction === d ? 'none' : '1px solid var(--border)',
          }}>{d}</button>
        ))}
      </div>

      {/* Entry filters */}
      <div style={sectionTitleStyle}>ENTRY FILTERS</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '8px' }}>
        <div>
          <label style={labelStyle}>MIN CONFIRMS</label>
          <input type="number" value={minConfirm} min={1} max={50} onChange={e => setMinConfirm(Number(e.target.value))} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>MIN OBI</label>
          <input type="number" value={minObi} min={0} max={1} step={0.05} onChange={e => setMinObi(Number(e.target.value))} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>MIN MP EDGE TICKS</label>
          <input type="number" value={minMpEdgeTicks} min={0} max={5} step={0.1} onChange={e => setMinMpEdgeTicks(Number(e.target.value))} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>MIN SCORE (|OBI*MP|)</label>
          <input type="number" value={minScore} min={0} max={5} step={0.05} onChange={e => setMinScore(Number(e.target.value))} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>MIN POC DEV %</label>
          <input type="number" value={minPocDev} min={0} max={5} step={0.1} onChange={e => setMinPocDev(Number(e.target.value))} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>COOLDOWN (MIN)</label>
          <input type="number" value={cooldownMin} min={0} max={120} onChange={e => setCooldownMin(Number(e.target.value))} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>MAX POSITIONS</label>
          <input type="number" value={maxPositions} min={1} max={12} onChange={e => setMaxPositions(Number(e.target.value))} style={inputStyle} />
        </div>
        <div style={{ display: 'flex', alignItems: 'end', paddingBottom: '2px' }}>
          <label style={checkboxRowStyle}>
            <input type="checkbox" checked={cdRequired} onChange={e => setCdRequired(e.target.checked)} />
            CD AGREEMENT
          </label>
        </div>
      </div>

      {/* Pattern prediction filter */}
      <div style={sectionTitleStyle}>PATTERN PREDICTION</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '8px' }}>
        <label style={checkboxRowStyle}>
          <input type="checkbox" checked={patternEnabled} onChange={e => setPatternEnabled(e.target.checked)} />
          PATTERN PREDICTION FILTER
        </label>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', opacity: patternEnabled ? 1 : 0.4 }}>
          <span style={{ fontSize: '10px', color: 'var(--text3)', width: '40px', flexShrink: 0 }}>STORE</span>
          <select
            value={patternStore}
            disabled={!patternEnabled}
            onChange={e => setPatternStore(e.target.value)}
            style={{ ...inputStyle, width: '120px', cursor: patternEnabled ? 'pointer' : 'default' }}
          >
            <option value="pat5">pat5 (5m)</option>
            <option value="pat15">pat15 (15m)</option>
            <option value="pat30v2">pat30v2 (30m)</option>
            <option value="pat30_5">pat30_5 (30m/5m)</option>
            <option value="pat60_20">pat60_20 (60m/20m)</option>
          </select>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', opacity: patternEnabled ? 1 : 0.4 }}>
          <span style={{ fontSize: '10px', color: 'var(--text3)', width: '40px', flexShrink: 0 }}>MIN %</span>
          <input
            type="number"
            value={patternMinProb}
            min={50}
            max={95}
            step={5}
            disabled={!patternEnabled}
            onChange={e => setPatternMinProb(Number(e.target.value))}
            style={{ ...inputStyle, width: '70px' }}
          />
          <span style={{ fontSize: '10px', color: 'var(--text3)' }}>% directional prob</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', opacity: patternEnabled ? 1 : 0.4 }}>
          <span style={{ fontSize: '10px', color: 'var(--text3)', width: '40px', flexShrink: 0 }}>MOVE</span>
          <input
            type="number"
            value={patternMinMove}
            min={0}
            max={2}
            step={0.05}
            disabled={!patternEnabled}
            onChange={e => setPatternMinMove(Number(e.target.value))}
            style={{ ...inputStyle, width: '70px' }}
          />
          <span style={{ fontSize: '10px', color: 'var(--text3)' }}>% min predicted move</span>
        </div>
        {patternEnabled && (
          <div style={{
            fontSize: '9px', color: 'var(--text3)', lineHeight: '1.4',
            padding: '6px 8px', background: 'var(--bg3)', borderRadius: '4px',
          }}>
            Pattern must agree with signal direction. BULL entry needs bullProb &ge; {patternMinProb}%, BEAR needs bearProb &ge; {patternMinProb}%.
            {patternMinMove > 0 && <> Predicted move must be &ge; {patternMinMove}% in signal direction.</>}
            {' '}Full 12-dim vector for recent data; partial for historical data before 2026-05-18.
          </div>
        )}
      </div>

      {/* Technical Indicators */}
      <div style={sectionTitleStyle}>TECHNICAL INDICATORS</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '8px' }}>
        {/* EMA */}
        <label style={checkboxRowStyle}>
          <input type="checkbox" checked={emaFilterEnabled} onChange={e => setEmaFilterEnabled(e.target.checked)} />
          EMA FILTER
        </label>
        <div style={{ display: 'flex', gap: '6px', opacity: emaFilterEnabled ? 1 : 0.4 }}>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>SHORT</label>
            <input type="number" value={emaShortPeriod} min={2} max={50} disabled={!emaFilterEnabled}
              onChange={e => setEmaShortPeriod(Number(e.target.value))} style={inputStyle} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>LONG</label>
            <input type="number" value={emaLongPeriod} min={5} max={200} disabled={!emaFilterEnabled}
              onChange={e => setEmaLongPeriod(Number(e.target.value))} style={inputStyle} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>MODE</label>
            <select value={emaMode} disabled={!emaFilterEnabled} onChange={e => setEmaMode(e.target.value as any)}
              style={{ ...inputStyle, cursor: emaFilterEnabled ? 'pointer' : 'default' }}>
              <option value="price_above">Price vs EMA</option>
              <option value="crossover">EMA Cross</option>
            </select>
          </div>
        </div>
        {emaFilterEnabled && (
          <div style={{ fontSize: '9px', color: 'var(--text3)', lineHeight: '1.4', padding: '6px 8px', background: 'var(--bg3)', borderRadius: '4px' }}>
            {emaMode === 'crossover'
              ? `BULL: EMA(${emaShortPeriod}) > EMA(${emaLongPeriod}). BEAR: EMA(${emaShortPeriod}) < EMA(${emaLongPeriod}).`
              : `BULL: price above EMA(${emaShortPeriod}). BEAR: price below EMA(${emaShortPeriod}).`}
            {' '}Computed from 1-min candles built from tick data.
          </div>
        )}

        {/* RSI */}
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: '8px', marginTop: '2px' }}>
          <label style={checkboxRowStyle}>
            <input type="checkbox" checked={rsiFilterEnabled} onChange={e => setRsiFilterEnabled(e.target.checked)} />
            RSI FILTER
          </label>
        </div>
        <div style={{ display: 'flex', gap: '6px', opacity: rsiFilterEnabled ? 1 : 0.4 }}>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>PERIOD</label>
            <input type="number" value={rsiPeriod} min={2} max={50} disabled={!rsiFilterEnabled}
              onChange={e => setRsiPeriod(Number(e.target.value))} style={inputStyle} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>OVERBOUGHT</label>
            <input type="number" value={rsiOverbought} min={50} max={95} disabled={!rsiFilterEnabled}
              onChange={e => setRsiOverbought(Number(e.target.value))} style={inputStyle} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>OVERSOLD</label>
            <input type="number" value={rsiOversold} min={5} max={50} disabled={!rsiFilterEnabled}
              onChange={e => setRsiOversold(Number(e.target.value))} style={inputStyle} />
          </div>
        </div>
        {rsiFilterEnabled && (
          <div style={{ fontSize: '9px', color: 'var(--text3)', lineHeight: '1.4', padding: '6px 8px', background: 'var(--bg3)', borderRadius: '4px' }}>
            Blocks BULL entries when RSI &gt; {rsiOverbought} (overbought). Blocks BEAR entries when RSI &lt; {rsiOversold} (oversold). Wilder smoothing, {rsiPeriod}-period.
          </div>
        )}

        {/* VWAP */}
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: '8px', marginTop: '2px' }}>
          <label style={checkboxRowStyle}>
            <input type="checkbox" checked={vwapFilterEnabled} onChange={e => setVwapFilterEnabled(e.target.checked)} />
            VWAP FILTER
          </label>
        </div>
        {vwapFilterEnabled && (
          <div style={{ fontSize: '9px', color: 'var(--text3)', lineHeight: '1.4', padding: '6px 8px', background: 'var(--bg3)', borderRadius: '4px' }}>
            BULL: price must be above session VWAP. BEAR: price must be below session VWAP. Resets each trading day.
          </div>
        )}

        {/* ATR Exit */}
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: '8px', marginTop: '2px' }}>
          <label style={checkboxRowStyle}>
            <input type="checkbox" checked={atrExitEnabled} onChange={e => setAtrExitEnabled(e.target.checked)} />
            ATR-BASED EXITS
          </label>
        </div>
        <div style={{ display: 'flex', gap: '6px', opacity: atrExitEnabled ? 1 : 0.4 }}>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>ATR PERIOD</label>
            <input type="number" value={atrPeriod} min={2} max={50} disabled={!atrExitEnabled}
              onChange={e => setAtrPeriod(Number(e.target.value))} style={inputStyle} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>STOP (x ATR)</label>
            <input type="number" value={atrStopMult} min={0.5} max={10} step={0.5} disabled={!atrExitEnabled}
              onChange={e => setAtrStopMult(Number(e.target.value))} style={inputStyle} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>TARGET (x ATR)</label>
            <input type="number" value={atrTargetMult} min={0.5} max={10} step={0.5} disabled={!atrExitEnabled}
              onChange={e => setAtrTargetMult(Number(e.target.value))} style={inputStyle} />
          </div>
        </div>
        {atrExitEnabled && (
          <div style={{ fontSize: '9px', color: 'var(--text3)', lineHeight: '1.4', padding: '6px 8px', background: 'var(--bg3)', borderRadius: '4px' }}>
            Dynamic stops based on volatility. Stop at {atrStopMult}x ATR({atrPeriod}) loss, target at {atrTargetMult}x ATR({atrPeriod}) profit. ATR computed from 1-min candle True Range.
          </div>
        )}
      </div>

      {/* Leverage mode */}
      <div style={sectionTitleStyle}>LEVERAGE</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '8px' }}>
        <label style={checkboxRowStyle}>
          <input type="checkbox" checked={optionMode} onChange={e => setOptionMode(e.target.checked)} />
          OPTION MODE (1-lot ATM, delta=0.5)
        </label>
        {optionMode && (
          <div style={{
            fontSize: '9px', color: 'var(--text3)', lineHeight: '1.4',
            padding: '6px 8px', background: 'var(--bg3)', borderRadius: '4px',
          }}>
            Simulates buying 1-lot ATM CE (BULL) or PE (BEAR). P&amp;L = underlying move &times; 0.5 &times; lot size. Lot sizes from NSE F&amp;O contract specs.
          </div>
        )}
      </div>

      {/* Exit strategy */}
      <div style={sectionTitleStyle}>EXIT STRATEGY</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <label style={{ ...checkboxRowStyle, width: '130px', flexShrink: 0 }}>
            <input type="checkbox" checked={takeProfitEnabled} onChange={e => setTakeProfitEnabled(e.target.checked)} />
            TAKE PROFIT
          </label>
          <input type="number" value={takeProfitPct} min={0} max={10} step={0.05} disabled={!takeProfitEnabled}
            onChange={e => setTakeProfitPct(Number(e.target.value))}
            style={{ ...inputStyle, width: '70px', opacity: takeProfitEnabled ? 1 : 0.4 }} />
          <span style={{ fontSize: '10px', color: 'var(--text3)' }}>%</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <label style={{ ...checkboxRowStyle, width: '130px', flexShrink: 0 }}>
            <input type="checkbox" checked={stopLossEnabled} onChange={e => setStopLossEnabled(e.target.checked)} />
            STOP LOSS
          </label>
          <input type="number" value={stopLossPct} min={0} max={10} step={0.05} disabled={!stopLossEnabled}
            onChange={e => setStopLossPct(Number(e.target.value))}
            style={{ ...inputStyle, width: '70px', opacity: stopLossEnabled ? 1 : 0.4 }} />
          <span style={{ fontSize: '10px', color: 'var(--text3)' }}>%</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <label style={{ ...checkboxRowStyle, width: '130px', flexShrink: 0 }}>
            <input type="checkbox" checked={trailEnabled} onChange={e => setTrailEnabled(e.target.checked)} />
            TRAIL STOP
          </label>
          <span style={{ fontSize: '10px', color: 'var(--text3)' }}>trigger</span>
          <input type="number" value={trailTriggerPct} min={0} max={10} step={0.05} disabled={!trailEnabled}
            onChange={e => setTrailTriggerPct(Number(e.target.value))}
            style={{ ...inputStyle, width: '60px', opacity: trailEnabled ? 1 : 0.4 }} />
          <span style={{ fontSize: '10px', color: 'var(--text3)' }}>% trail at</span>
          <input type="number" value={trailPct} min={0} max={100} step={5} disabled={!trailEnabled}
            onChange={e => setTrailPct(Number(e.target.value))}
            style={{ ...inputStyle, width: '50px', opacity: trailEnabled ? 1 : 0.4 }} />
          <span style={{ fontSize: '10px', color: 'var(--text3)' }}>% of peak</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <label style={{ ...checkboxRowStyle, width: '130px', flexShrink: 0 }}>
            <input type="checkbox" checked={maxHoldEnabled} onChange={e => setMaxHoldEnabled(e.target.checked)} />
            MAX HOLD
          </label>
          <input type="number" value={maxHoldMin} min={1} max={120} disabled={!maxHoldEnabled}
            onChange={e => setMaxHoldMin(Number(e.target.value))}
            style={{ ...inputStyle, width: '60px', opacity: maxHoldEnabled ? 1 : 0.4 }} />
          <span style={{ fontSize: '10px', color: 'var(--text3)' }}>min</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <label style={{ ...checkboxRowStyle, width: '130px', flexShrink: 0 }}>
            <input type="checkbox" checked={noProfitEnabled} onChange={e => setNoProfitEnabled(e.target.checked)} />
            NO-PROFIT EXIT
          </label>
          <input type="number" value={noProfitMin} min={1} max={60} disabled={!noProfitEnabled}
            onChange={e => setNoProfitMin(Number(e.target.value))}
            style={{ ...inputStyle, width: '60px', opacity: noProfitEnabled ? 1 : 0.4 }} />
          <span style={{ fontSize: '10px', color: 'var(--text3)' }}>min</span>
        </div>

        {/* Pattern reversal exit */}
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: '8px', marginTop: '4px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <label style={checkboxRowStyle}>
            <input type="checkbox" checked={patternExitEnabled} onChange={e => setPatternExitEnabled(e.target.checked)} />
            PATTERN REVERSAL EXIT
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', opacity: patternExitEnabled ? 1 : 0.4 }}>
            <span style={{ fontSize: '10px', color: 'var(--text3)', width: '50px', flexShrink: 0 }}>STORE</span>
            <select
              value={patternExitStore}
              disabled={!patternExitEnabled}
              onChange={e => setPatternExitStore(e.target.value)}
              style={{ ...inputStyle, width: '130px', cursor: patternExitEnabled ? 'pointer' : 'default' }}
            >
              <option value="">same as entry</option>
              <option value="pat5">pat5 (5m)</option>
              <option value="pat15">pat15 (15m)</option>
              <option value="pat30v2">pat30v2 (30m)</option>
              <option value="pat30_5">pat30_5 (30m/5m)</option>
              <option value="pat60_20">pat60_20 (60m/20m)</option>
            </select>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', opacity: patternExitEnabled ? 1 : 0.4 }}>
            <span style={{ fontSize: '10px', color: 'var(--text3)', width: '50px', flexShrink: 0 }}>PROB</span>
            <input
              type="number"
              value={patternExitProb}
              min={50}
              max={95}
              step={5}
              disabled={!patternExitEnabled}
              onChange={e => setPatternExitProb(Number(e.target.value))}
              style={{ ...inputStyle, width: '60px' }}
            />
            <span style={{ fontSize: '10px', color: 'var(--text3)' }}>% opposing prob to exit</span>
          </div>
          {patternExitEnabled && (
            <div style={{
              fontSize: '9px', color: 'var(--text3)', lineHeight: '1.4',
              padding: '6px 8px', background: 'var(--bg3)', borderRadius: '4px',
            }}>
              Exit BULL when bearProb &ge; {patternExitProb}%. Exit BEAR when bullProb &ge; {patternExitProb}%.
              {!patternExitStore && ' Uses entry pattern store.'}
            </div>
          )}
        </div>
      </div>

      {/* Run button */}
      <button onClick={handleRun} disabled={running || selectedStocks.size === 0} style={{
        ...btnStyle,
        width: '100%', padding: '10px',
        background: running ? 'transparent' : 'var(--accent)',
        color: running ? 'var(--text3)' : 'var(--bg)',
        border: running ? '1px solid var(--border)' : 'none',
        fontWeight: 700, fontSize: '12px',
        opacity: selectedStocks.size === 0 ? 0.4 : 1,
      }}>
        {running ? 'RUNNING BACKTEST...' : 'RUN BACKTEST'}
      </button>

      {/* Active strategy indicator */}
      {activeStrategyId && (
        <div style={{ marginTop: '8px', fontSize: '9px', color: 'var(--text3)', textAlign: 'center' }}>
          Strategy auto-saved on each run
        </div>
      )}
    </div>
  )
}

// ── Summary Cards ────────────────────────────────────────────────────────────

function SummaryCards({ summary }: { summary: Summary }) {
  const cards: { label: string; value: string; color?: string }[] = [
    { label: 'TOTAL TRADES', value: String(summary.totalTrades) },
    { label: 'WIN RATE', value: `${(summary.winRate * 100).toFixed(1)}%`, color: summary.winRate >= 0.5 ? 'var(--bull)' : 'var(--bear)' },
    { label: 'AVG P&L', value: `${summary.avgPnlPct >= 0 ? '+' : ''}${summary.avgPnlPct.toFixed(3)}%`, color: summary.avgPnlPct >= 0 ? 'var(--bull)' : 'var(--bear)' },
    { label: 'TOTAL P&L', value: `${summary.totalPnlPct >= 0 ? '+' : ''}${summary.totalPnlPct.toFixed(3)}%`, color: summary.totalPnlPct >= 0 ? 'var(--bull)' : 'var(--bear)' },
    { label: 'AVG HOLD', value: `${summary.avgHoldMin.toFixed(1)} min` },
    { label: 'MAX DRAWDOWN', value: `${summary.maxDrawdownPct.toFixed(3)}%`, color: 'var(--bear)' },
  ]
  if (summary.totalOptionPnl != null) {
    cards.push({ label: 'OPTION P&L', value: `${summary.totalOptionPnl >= 0 ? '+' : ''}₹${summary.totalOptionPnl.toLocaleString('en-IN')}`, color: summary.totalOptionPnl >= 0 ? 'var(--bull)' : 'var(--bear)' })
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: '8px', marginBottom: '16px' }}>
      {cards.map(c => (
        <div key={c.label} style={cardStyle}>
          <span style={{ fontSize: '9px', color: 'var(--text3)', letterSpacing: '0.08em' }}>{c.label}</span>
          <span style={{ fontSize: '16px', fontWeight: 700, color: c.color ?? 'var(--text)', letterSpacing: '-0.02em' }}>{c.value}</span>
        </div>
      ))}
    </div>
  )
}

// ── Exit Reason Breakdown ────────────────────────────────────────────────────

function ExitReasonBreakdown({ byExitReason, total }: { byExitReason: Record<string, number>; total: number }) {
  const entries = Object.entries(byExitReason).sort((a, b) => b[1] - a[1])
  const colorMap: Record<string, string> = {
    TakeProfit: 'var(--bull)', StopLoss: 'var(--bear)', Trail: 'var(--mixed)',
    MaxHold: 'var(--text3)', NoProfit: 'var(--bear)', DataEnd: 'var(--text3)',
    PatternReversal: 'var(--accent)', ATR_Target: 'var(--bull)', ATR_Stop: 'var(--bear)',
  }

  return (
    <div style={{ ...cardStyle, marginBottom: '16px' }}>
      <span style={{ fontSize: '9px', color: 'var(--text3)', letterSpacing: '0.08em', marginBottom: '6px' }}>EXIT REASONS</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {entries.map(([reason, count]) => {
          const pct = total > 0 ? (count / total * 100).toFixed(1) : '0'
          return (
            <div key={reason} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ width: '90px', fontSize: '11px', color: colorMap[reason] ?? 'var(--text2)', flexShrink: 0 }}>{reason}</span>
              <div style={{ flex: 1, height: '4px', background: 'var(--bg3)', borderRadius: '2px', overflow: 'hidden' }}>
                <div style={{ width: `${total > 0 ? count / total * 100 : 0}%`, height: '100%', background: colorMap[reason] ?? 'var(--text3)', borderRadius: '2px' }} />
              </div>
              <span style={{ fontSize: '10px', color: 'var(--text3)', width: '60px', textAlign: 'right', flexShrink: 0 }}>{count} ({pct}%)</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Per-Stock Table ──────────────────────────────────────────────────────────

function StockBreakdown({ byStock }: { byStock: Summary['byStock'] }) {
  const entries = Object.entries(byStock).sort((a, b) => b[1].totalPnlPct - a[1].totalPnlPct)
  if (entries.length === 0) return null
  const hasOption = entries.some(([, d]) => d.totalOptionPnl != null)

  const thStyle: React.CSSProperties = {
    padding: '6px 8px', textAlign: 'left', fontSize: '9px',
    color: 'var(--text3)', letterSpacing: '0.08em', borderBottom: '1px solid var(--border)',
  }
  const tdStyle: React.CSSProperties = {
    padding: '5px 8px', fontSize: '11px', borderBottom: '1px solid var(--border)',
  }

  return (
    <div style={{ overflowX: 'auto', marginBottom: '16px' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'inherit' }}>
        <thead>
          <tr>
            <th style={thStyle}>STOCK</th>
            <th style={{ ...thStyle, textAlign: 'right' }}>TRADES</th>
            <th style={{ ...thStyle, textAlign: 'right' }}>WIN RATE</th>
            <th style={{ ...thStyle, textAlign: 'right' }}>AVG P&L</th>
            <th style={{ ...thStyle, textAlign: 'right' }}>TOTAL P&L</th>
            {hasOption && <th style={{ ...thStyle, textAlign: 'right' }}>₹ OPTION P&L</th>}
          </tr>
        </thead>
        <tbody>
          {entries.map(([stock, data]) => (
            <tr key={stock}>
              <td style={{ ...tdStyle, color: 'var(--text)', fontWeight: 600 }}>{stock.replace('NSE:', '')}</td>
              <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--text2)' }}>{data.trades}</td>
              <td style={{ ...tdStyle, textAlign: 'right', color: data.winRate >= 0.5 ? 'var(--bull)' : 'var(--bear)' }}>
                {(data.winRate * 100).toFixed(1)}%
              </td>
              <td style={{ ...tdStyle, textAlign: 'right', color: data.avgPnlPct >= 0 ? 'var(--bull)' : 'var(--bear)' }}>
                {data.avgPnlPct >= 0 ? '+' : ''}{data.avgPnlPct.toFixed(3)}%
              </td>
              <td style={{ ...tdStyle, textAlign: 'right', color: data.totalPnlPct >= 0 ? 'var(--bull)' : 'var(--bear)', fontWeight: 600 }}>
                {data.totalPnlPct >= 0 ? '+' : ''}{data.totalPnlPct.toFixed(3)}%
              </td>
              {hasOption && (
                <td style={{ ...tdStyle, textAlign: 'right', color: (data.totalOptionPnl ?? 0) >= 0 ? 'var(--bull)' : 'var(--bear)', fontWeight: 600 }}>
                  {(data.totalOptionPnl ?? 0) >= 0 ? '+' : ''}₹{(data.totalOptionPnl ?? 0).toLocaleString('en-IN')}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Trades Table ─────────────────────────────────────────────────────────────

function TradesTable({ trades }: { trades: Trade[] }) {
  const [sortKey, setSortKey] = useState<SortKey>('entryTime')
  const [sortAsc, setSortAsc] = useState(false)

  const hasPatternData = trades.some(t => t.patBullProb != null)
  const hasOptionData = trades.some(t => t.optionPnl != null)

  const sorted = [...trades].sort((a, b) => {
    let cmp = 0
    switch (sortKey) {
      case 'stock': cmp = a.stock.localeCompare(b.stock); break
      case 'direction': cmp = a.direction.localeCompare(b.direction); break
      case 'pnlPct': cmp = a.pnlPct - b.pnlPct; break
      case 'holdMin': cmp = a.holdMin - b.holdMin; break
      case 'exitReason': cmp = a.exitReason.localeCompare(b.exitReason); break
      case 'entryTime': cmp = new Date(a.entryTime).getTime() - new Date(b.entryTime).getTime(); break
      case 'optionPnl': cmp = (a.optionPnl ?? 0) - (b.optionPnl ?? 0); break
    }
    return sortAsc ? cmp : -cmp
  })

  function handleSort(key: SortKey) {
    if (sortKey === key) setSortAsc(!sortAsc)
    else { setSortKey(key); setSortAsc(key === 'stock' || key === 'direction' || key === 'exitReason') }
  }

  const thStyle: React.CSSProperties = {
    padding: '6px 8px', textAlign: 'left', fontSize: '9px',
    color: 'var(--text3)', letterSpacing: '0.08em', borderBottom: '1px solid var(--border)',
    cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap',
  }
  const tdStyle: React.CSSProperties = {
    padding: '4px 8px', fontSize: '11px', borderBottom: '1px solid var(--border)',
    whiteSpace: 'nowrap',
  }

  const arrow = (key: SortKey) => sortKey === key ? (sortAsc ? ' ▲' : ' ▼') : ''

  function patProbColor(prob: number | undefined, isDirectional: boolean): string {
    if (prob == null) return 'var(--text3)'
    const pct = prob * 100
    if (isDirectional) {
      if (pct >= 70) return 'var(--bull)'
      if (pct >= 55) return 'var(--mixed)'
      return 'var(--text3)'
    }
    return 'var(--text3)'
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'inherit' }}>
        <thead>
          <tr>
            <th style={thStyle} onClick={() => handleSort('entryTime')}>ENTRY{arrow('entryTime')}</th>
            <th style={thStyle} onClick={() => handleSort('stock')}>STOCK{arrow('stock')}</th>
            <th style={thStyle} onClick={() => handleSort('direction')}>DIR{arrow('direction')}</th>
            <th style={{ ...thStyle, textAlign: 'right' }}>ENTRY ₹</th>
            <th style={{ ...thStyle, textAlign: 'right' }}>EXIT ₹</th>
            <th style={{ ...thStyle, textAlign: 'right' }} onClick={() => handleSort('pnlPct')}>P&L{arrow('pnlPct')}</th>
            <th style={{ ...thStyle, textAlign: 'right' }}>PEAK</th>
            <th style={{ ...thStyle, textAlign: 'right' }} onClick={() => handleSort('holdMin')}>HOLD{arrow('holdMin')}</th>
            <th style={thStyle} onClick={() => handleSort('exitReason')}>EXIT{arrow('exitReason')}</th>
            {hasOptionData && (
              <>
                <th style={{ ...thStyle, textAlign: 'right' }}>OPT</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>STRIKE</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>LOT</th>
                <th style={{ ...thStyle, textAlign: 'right' }} onClick={() => handleSort('optionPnl')}>₹ P&L{arrow('optionPnl')}</th>
              </>
            )}
            {hasPatternData && (
              <>
                <th style={{ ...thStyle, textAlign: 'right' }}>BULL%</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>BEAR%</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>PRED</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>SIM</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {sorted.map((t, i) => {
            const dirProb = t.direction === 'BULL' ? t.patBullProb : t.patBearProb
            return (
              <tr key={i} style={{ background: i % 2 === 0 ? 'transparent' : 'var(--bg2)' }}>
                <td style={{ ...tdStyle, color: 'var(--text3)', fontSize: '10px' }}>{fmtDateShort(t.entryTime)}</td>
                <td style={{ ...tdStyle, color: 'var(--text)', fontWeight: 600 }}>{t.stock.replace('NSE:', '')}</td>
                <td style={{ ...tdStyle, color: t.direction === 'BULL' ? 'var(--bull)' : 'var(--bear)', fontWeight: 600 }}>
                  {t.direction === 'BULL' ? '▲' : '▼'} {t.direction}
                </td>
                <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--text2)' }}>{t.entryPrice.toFixed(2)}</td>
                <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--text2)' }}>{t.exitPrice.toFixed(2)}</td>
                <td style={{ ...tdStyle, textAlign: 'right', color: t.pnlPct >= 0 ? 'var(--bull)' : 'var(--bear)', fontWeight: 600 }}>
                  {t.pnlPct >= 0 ? '+' : ''}{t.pnlPct.toFixed(3)}%
                </td>
                <td style={{ ...tdStyle, textAlign: 'right', color: t.peakPct > 0 ? 'var(--bull)' : 'var(--text3)' }}>
                  {t.peakPct > 0 ? `+${t.peakPct.toFixed(3)}%` : '—'}
                </td>
                <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--text2)' }}>{t.holdMin.toFixed(1)}m</td>
                <td style={{ ...tdStyle, color: exitReasonColor(t.exitReason), fontSize: '10px' }}>{t.exitReason}</td>
                {hasOptionData && (
                  <>
                    <td style={{ ...tdStyle, textAlign: 'right', color: t.direction === 'BULL' ? 'var(--bull)' : 'var(--bear)', fontSize: '10px' }}>
                      {t.optType}
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--text2)', fontSize: '10px' }}>{t.strike}</td>
                    <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--text3)', fontSize: '10px' }}>{t.lotSize}</td>
                    <td style={{ ...tdStyle, textAlign: 'right', color: (t.optionPnl ?? 0) >= 0 ? 'var(--bull)' : 'var(--bear)', fontWeight: 600 }}>
                      {(t.optionPnl ?? 0) >= 0 ? '+' : ''}₹{(t.optionPnl ?? 0).toLocaleString('en-IN')}
                    </td>
                  </>
                )}
                {hasPatternData && (
                  <>
                    <td style={{ ...tdStyle, textAlign: 'right', color: t.patBullProb != null && t.patBullProb >= 0.6 ? 'var(--bull)' : 'var(--text3)', fontSize: '10px' }}>
                      {t.patBullProb != null ? `${(t.patBullProb * 100).toFixed(0)}%` : '—'}
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right', color: t.patBearProb != null && t.patBearProb >= 0.6 ? 'var(--bear)' : 'var(--text3)', fontSize: '10px' }}>
                      {t.patBearProb != null ? `${(t.patBearProb * 100).toFixed(0)}%` : '—'}
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right', color: t.patPredMove != null ? (t.patPredMove >= 0 ? 'var(--bull)' : 'var(--bear)') : 'var(--text3)', fontSize: '10px' }}>
                      {t.patPredMove != null ? `${t.patPredMove >= 0 ? '+' : ''}${t.patPredMove.toFixed(2)}%` : '—'}
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right', color: t.patTopSim != null && t.patTopSim >= 0.8 ? 'var(--text)' : 'var(--text3)', fontSize: '10px' }}>
                      {t.patTopSim != null ? t.patTopSim.toFixed(2) : '—'}
                    </td>
                  </>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function exitReasonColor(reason: string): string {
  switch (reason) {
    case 'TakeProfit': return 'var(--bull)'
    case 'StopLoss': return 'var(--bear)'
    case 'Trail': return 'var(--mixed)'
    case 'NoProfit': return 'var(--bear)'
    case 'PatternReversal': return 'var(--accent)'
    case 'ATR_Target': return 'var(--bull)'
    case 'ATR_Stop': return 'var(--bear)'
    default: return 'var(--text3)'
  }
}

// ── Results Panel ────────────────────────────────────────────────────────────

function ResultsPanel({ trades, summary }: { trades: Trade[]; summary: Summary }) {
  return (
    <div>
      <SummaryCards summary={summary} />
      <ExitReasonBreakdown byExitReason={summary.byExitReason} total={summary.totalTrades} />
      <StockBreakdown byStock={summary.byStock} />
      <div style={{ ...sectionTitleStyle, marginTop: '16px' }}>ALL TRADES ({trades.length})</div>
      <TradesTable trades={trades} />
    </div>
  )
}

// ── Main ─────────────────────────────────────────────────────────────────────

export default function BacktestClient() {
  const router = useRouter()
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [trades, setTrades] = useState<Trade[] | null>(null)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [elapsed, setElapsed] = useState<number | null>(null)
  const [allStocks, setAllStocks] = useState<string[]>(FALLBACK_STOCKS)
  const [meta, setMeta] = useState<{ minDate: string; maxDate: string; totalTicks: number } | null>(null)
  const [savedStrategies, setSavedStrategies] = useState<SavedStrat[]>([])
  const [activeStrategyId, setActiveStrategyId] = useState<number | null>(null)
  const [loadConfig, setLoadConfig] = useState<any | null>(null)
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')

  function loadStrategies() {
    fetch('/api/strategies').then(r => r.json()).then(d => {
      if (Array.isArray(d)) setSavedStrategies(d)
    }).catch(() => {})
  }

  useEffect(() => {
    fetch('/api/backtest').then(r => r.json()).then(d => {
      if (d.stocks) setAllStocks(d.stocks)
      if (d.minDate) setMeta({ minDate: d.minDate, maxDate: d.maxDate, totalTicks: d.totalTicks })
    }).catch(() => {})
    loadStrategies()
  }, [])

  const handleRun = useCallback(async (config: any) => {
    setRunning(true)
    setError(null)
    setTrades(null)
    setSummary(null)
    const t0 = Date.now()
    try {
      const res = await fetch('/api/backtest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Backtest failed')
      setTrades(data.trades)
      setSummary(data.summary)
      setElapsed(Date.now() - t0)

      // Auto-save strategy with results
      const cfgHash = hashConfig(config)
      const now = new Date()
      const autoName = `Run ${now.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' })} ${now.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false })}`

      const saveRes = await fetch('/api/strategies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: autoName, config, results: data.summary, configHash: cfgHash }),
      })
      const saved = await saveRes.json()
      if (saved.id) setActiveStrategyId(saved.id)
      loadStrategies()
    } catch (e: any) {
      setError(e.message ?? 'Unknown error')
    } finally {
      setRunning(false)
    }
  }, [])

  function handleSelectStrategy(s: SavedStrat) {
    setActiveStrategyId(s.id)
    setLoadConfig({ ...s.config, _ts: Date.now() }) // _ts forces useEffect to fire
    if (s.lastResults) {
      setSummary(s.lastResults)
      setTrades(null) // clear trade details — only show summary from saved
      setElapsed(null)
    }
  }

  async function handleDeleteStrategy(id: number) {
    await fetch('/api/strategies', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    if (activeStrategyId === id) { setActiveStrategyId(null); setSummary(null); setTrades(null) }
    loadStrategies()
  }

  async function handleRenameStrategy(id: number, newName: string) {
    if (!newName.trim()) return
    await fetch('/api/strategies', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name: newName.trim() }),
    })
    setRenamingId(null)
    setRenameValue('')
    loadStrategies()
  }

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' })
    router.push('/')
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <header style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexWrap: 'wrap', gap: '8px', padding: '10px 16px',
        borderBottom: '1px solid var(--border)', background: 'var(--bg2)',
        position: 'sticky', top: 0, zIndex: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px' }}>
          <a href="/dashboard" style={{ fontWeight: 700, fontSize: '15px', letterSpacing: '-0.02em', color: 'var(--text)', textDecoration: 'none' }}>ZERODAY</a>
          <span style={{ color: 'var(--text3)', fontSize: '10px' }}>/</span>
          <span style={{ fontSize: '12px', color: 'var(--text2)', letterSpacing: '0.05em', fontWeight: 600 }}>BACKTEST</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <a href="/dashboard" style={{
            ...btnStyle, textDecoration: 'none', display: 'inline-block', padding: '4px 10px', fontSize: '11px',
          }}>DASHBOARD</a>
          <a href="/dashboard/live" style={{
            ...btnStyle, textDecoration: 'none', display: 'inline-block', padding: '4px 10px', fontSize: '11px',
          }}>LIVE</a>
          <a href="/dashboard/conviction" style={{
            ...btnStyle, textDecoration: 'none', display: 'inline-block', padding: '4px 10px', fontSize: '11px', color: 'var(--accent)', fontWeight: 700,
          }}>CONVICTION</a>
          <ThemeToggle />
          <button onClick={handleLogout} style={{ ...btnStyle, padding: '4px 10px', fontSize: '11px' }}>SIGN OUT</button>
        </div>
      </header>

      {/* Strategy selector bar */}
      {savedStrategies.length > 0 && (
        <div style={{
          borderBottom: '1px solid var(--border)', background: 'var(--bg)',
          padding: '8px 16px', overflowX: 'auto', whiteSpace: 'nowrap',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '10px', color: 'var(--text3)', marginBottom: '6px' }}>
            <span style={{ fontWeight: 700, letterSpacing: '0.08em' }}>STRATEGIES</span>
            <span>({savedStrategies.length})</span>
          </div>
          <div style={{ display: 'flex', gap: '6px', overflowX: 'auto', paddingBottom: '4px' }}>
            {savedStrategies.map(s => {
              const isActive = activeStrategyId === s.id
              const lr = s.lastResults
              const wrColor = lr ? (lr.winRate >= 0.5 ? 'var(--bull)' : 'var(--bear)') : 'var(--text3)'
              const pnlColor = lr ? (lr.totalPnlPct >= 0 ? 'var(--bull)' : 'var(--bear)') : 'var(--text3)'
              return (
                <div key={s.id} style={{
                  display: 'inline-flex', flexDirection: 'column', gap: '3px',
                  padding: '8px 12px', borderRadius: '6px', cursor: 'pointer',
                  border: isActive ? '2px solid var(--accent)' : '1px solid var(--border)',
                  background: isActive ? 'var(--bg2)' : 'var(--bg)',
                  minWidth: '140px', maxWidth: '200px', flexShrink: 0,
                  transition: 'all 0.15s',
                }} onClick={() => handleSelectStrategy(s)}>
                  {/* Name row with rename/delete */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    {renamingId === s.id ? (
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={e => setRenameValue(e.target.value)}
                        onBlur={() => handleRenameStrategy(s.id, renameValue)}
                        onKeyDown={e => { if (e.key === 'Enter') handleRenameStrategy(s.id, renameValue); if (e.key === 'Escape') setRenamingId(null) }}
                        onClick={e => e.stopPropagation()}
                        style={{ ...inputStyle, padding: '2px 4px', fontSize: '10px', width: '100px' }}
                      />
                    ) : (
                      <span style={{
                        fontSize: '10px', fontWeight: 700, color: isActive ? 'var(--text)' : 'var(--text2)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
                      }}>{s.name}</span>
                    )}
                    <span
                      onClick={e => { e.stopPropagation(); setRenamingId(s.id); setRenameValue(s.name) }}
                      style={{ fontSize: '9px', cursor: 'pointer', color: 'var(--text3)', flexShrink: 0 }}
                      title="Rename"
                    >✏</span>
                    <span
                      onClick={e => { e.stopPropagation(); handleDeleteStrategy(s.id) }}
                      style={{ fontSize: '9px', cursor: 'pointer', color: 'var(--bear)', flexShrink: 0 }}
                      title="Delete"
                    >✕</span>
                  </div>
                  {/* Quick stats */}
                  {lr ? (
                    <div style={{ display: 'flex', gap: '8px', fontSize: '10px' }}>
                      <span style={{ color: wrColor, fontWeight: 600 }}>{(lr.winRate * 100).toFixed(0)}% WR</span>
                      <span style={{ color: pnlColor, fontWeight: 600 }}>{lr.totalPnlPct >= 0 ? '+' : ''}{lr.totalPnlPct.toFixed(2)}%</span>
                      <span style={{ color: 'var(--text3)' }}>{lr.totalTrades}T</span>
                    </div>
                  ) : (
                    <span style={{ fontSize: '9px', color: 'var(--text3)' }}>No results yet</span>
                  )}
                  {lr?.totalOptionPnl != null && (
                    <div style={{ fontSize: '9px', color: lr.totalOptionPnl >= 0 ? 'var(--bull)' : 'var(--bear)' }}>
                      ₹{lr.totalOptionPnl.toLocaleString('en-IN')}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Body: two-panel layout */}
      <div className="zd-backtest-panels" style={{
        display: 'flex', flex: 1, gap: '0',
        flexDirection: 'row',
      }}>
        {/* Left panel: config */}
        <aside className="zd-backtest-sidebar" style={{
          width: '380px', minWidth: '320px', maxWidth: '420px', flexShrink: 0,
          borderRight: '1px solid var(--border)',
          padding: '16px', overflowY: 'auto', maxHeight: 'calc(100vh - 102px)',
        }}>
          <ConfigPanel onRun={handleRun} running={running} allStocks={allStocks}
            activeStrategyId={activeStrategyId} loadConfig={loadConfig} />
        </aside>

        {/* Right panel: results */}
        <main className="zd-backtest-main" style={{ flex: 1, padding: '16px', overflowY: 'auto', maxHeight: 'calc(100vh - 102px)' }}>
          {running && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '200px', color: 'var(--text3)', fontSize: '12px' }}>
              Running backtest... (querying ~8M ticks, this may take a moment)
            </div>
          )}

          {error && (
            <div style={{
              padding: '12px 16px', borderRadius: '6px', marginBottom: '16px',
              background: 'rgba(239,68,68,0.1)', border: '1px solid var(--bear)',
              color: 'var(--bear)', fontSize: '12px',
            }}>
              {error}
            </div>
          )}

          {!running && !error && !trades && !summary && (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              height: '300px', color: 'var(--text3)', fontSize: '12px',
              flexDirection: 'column', gap: '8px',
            }}>
              <div>Configure parameters and run a backtest</div>
              <div style={{ fontSize: '10px' }}>
                {meta
                  ? `Data: ${(meta.totalTicks / 1e6).toFixed(1)}M ticks across ${allStocks.length} stocks, ${meta.minDate} to ${meta.maxDate}`
                  : 'Loading data info...'}
              </div>
            </div>
          )}

          {/* Show summary from saved strategy (no trades) */}
          {!running && !error && !trades && summary && (
            <>
              <div style={{ fontSize: '10px', color: 'var(--text3)', marginBottom: '12px' }}>
                Showing saved results — click RUN BACKTEST to get full trade details
              </div>
              {summary.totalTrades === 0 ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '200px', color: 'var(--text3)', fontSize: '12px' }}>
                  No trades generated
                </div>
              ) : (
                <>
                  <SummaryCards summary={summary} />
                  {summary.byExitReason && Object.keys(summary.byExitReason).length > 0 && (
                    <ExitReasonBreakdown byExitReason={summary.byExitReason} total={summary.totalTrades} />
                  )}
                  {summary.byStock && Object.keys(summary.byStock).length > 0 && (
                    <StockBreakdown byStock={summary.byStock} />
                  )}
                </>
              )}
            </>
          )}

          {trades && summary && (
            <>
              {elapsed != null && (
                <div style={{ fontSize: '10px', color: 'var(--text3)', marginBottom: '12px' }}>
                  Completed in {(elapsed / 1000).toFixed(1)}s
                </div>
              )}
              {summary.totalTrades === 0 ? (
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  height: '200px', color: 'var(--text3)', fontSize: '12px',
                  flexDirection: 'column', gap: '8px',
                }}>
                  <div>No trades generated</div>
                  <div style={{ fontSize: '10px' }}>Try loosening entry filters or expanding the date range</div>
                </div>
              ) : (
                <ResultsPanel trades={trades} summary={summary} />
              )}
            </>
          )}
        </main>
      </div>
    </div>
  )
}
