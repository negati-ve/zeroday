import fs from 'fs'
import path from 'path'
import { IndicatorEngine, type IndicatorValues } from './indicators'

// ── Constants ─────────────────────────────────────────────────────────────────

const VEC_DIM      = 12
const VEC_DIM_V2   = 15           // 15 dims (added kalman vel as dim14)
const MAX_PATTERNS    = 500
const MAX_PATTERNS_V2 = 600       // 10h per session at 1-min snapshots
const MAX_SNAPSHOTS   = 180       // 3h of 1-min snapshots for outcome resolution
const SNAPSHOT_INTERVAL_MS = 60_000
const OUTCOME_5_MS  = 10 * 60_000  // 10m first checkpoint
const OUTCOME_15_MS = 30 * 60_000  // 30m core swing horizon
const OUTCOME_20_MS = 60 * 60_000  // 60m full swing outcome (h5/h15/h20 naming kept)
const TEMPERATURE   = 0.15
const KNN_K         = 20
const MIN_PATTERNS  = 10
const MIN_PATTERNS_V2 = 3
const PERSIST_INTERVAL_MS    = 5 * 60_000
const V2_PERSIST_INTERVAL_MS = 5 * 60_000
const SYSLOG_CYCLE_MS   = 900_000     // 15 min — write frequency
const SYSLOG_RESOLVE_MS = 3_600_000   // 60 min — outcome resolution window
const MAX_SYSLOG = 200
const TYPICAL_MOVE_BTC = 0.3      // BTC ~0.3% per 60m directional move

// Trade management
const TRADE_ENTRY_MIN_CONF  = 0.30   // composite confidence floor
const TRADE_ENTRY_MIN_PROB  = 0.58   // direction probability floor
const TRADE_ENTRY_VEL_MIN   = 3.0    // Kalman velocity $/min for entry
const TRADE_STOP_PCT        = 0.50   // hard stop -0.50%
const TRADE_TRIG_PCT        = 0.25   // start trailing at +0.25% peak
const TRADE_TRAIL_PCT       = 0.50   // trail: exit when pnl < peak × 50%
const TRADE_VEL_REV_EXIT    = 4.0    // velocity reversal $/min for vel_rev exit
const TRADE_VEL_REV_CONSEC  = 2      // consecutive calls needed for vel_rev
const TRADE_MAX_HOLD_MIN    = 120
const TRADE_COOLDOWN_MS     = 5 * 60_000
const MAX_TRADE_LOG         = 100

// Flow state constants
const CD_WINDOW_MS  = 5 * 60_000  // 5-min rolling delta window
const CD_BUCKET_MS  = 60_000      // 1-min buckets for z-score
const CD_BUCKET_MAX = 60          // keep last 60 min
const AGG_WINDOW    = 100         // trades for aggression ratio
const CUSUM_H       = 0.15        // CUSUM alarm threshold for BTC

// Kalman constants for BTC (much more volatile)
const KALMAN_Q_PRICE = 500
const KALMAN_Q_VEL   = 0.5
const KALMAN_R       = 200

// Cache durations
const DERIBIT_CACHE_MS   = 60_000
const FUNDING_OI_CACHE_MS = 10_000

const BASE_DIR = '/workspace/option-trader'

// ── Session ───────────────────────────────────────────────────────────────────

export type BTCSession = 'asia' | 'london' | 'ny'

export function getBTCSession(utcHour: number): BTCSession {
  if (utcHour < 8)  return 'asia'
  if (utcHour < 16) return 'london'
  return 'ny'
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface BTCPattern {
  ts: number
  vec: number[]
  price: number
  outcome5:  number | null
  outcome15: number | null
  outcome20: number | null
}

interface BTCPatternV2 {
  ts: number
  vec: number[]
  price: number
  sessionKey: BTCSession
  sessionDay: string
  outcome5:  number | null
  outcome15: number | null
  outcome20: number | null
}

interface Snapshot {
  ts: number
  vec: number[]
  price: number
}

interface BTCStore {
  snapshots:       Snapshot[]
  patterns:        BTCPattern[]
  lastSnapshotTs:  number
  lastPersistTs:   number
  sessionDay:      string | null
  sessionHigh:     number
  sessionLow:      number
  priceHistory:    { ts: number; price: number }[]
}

export interface HorizonPrediction {
  predictedMove: number
  bullProb:      number
  bearProb:      number
}

export interface BTCPrediction {
  predictedMove: number
  bullProb:      number
  bearProb:      number
  topSim:        number
  confidence:    number
  nResolved:     number
  direction:     'BULL' | 'BEAR' | null
  status:        'ready' | 'warming' | 'no_data'
  h5:  HorizonPrediction | null
  h15: HorizonPrediction | null
  h20: HorizonPrediction | null
}

export interface BTCTechnicals {
  rsi:          number | null
  emaShort:     number | null
  emaLong:      number | null
  emaCrossover: 'BULL' | 'BEAR' | null
  vwap:         number | null
  vwapAlign:    'BULL' | 'BEAR' | null
  atr:          number | null
  atrPct:       number | null
  momentum1m:   number
  momentum5m:   number
  sessionHigh:  number
  sessionLow:   number
  rangePosition: number
}

export interface BTCComposite {
  predictedMove: number
  bullProb:      number
  bearProb:      number
  direction:     'BULL' | 'BEAR' | null
  confidence:    number
  status:        'ready' | 'warming' | 'no_data'
  components: {
    patternWeight:   number
    techWeight:      number
    patternBullProb: number
    techBullScore:   number
  }
}

export interface BTCSysLogEntry {
  cycleTs:          number
  cycleTime:        string
  predMove:         number
  predDir:          'BULL' | 'BEAR' | null
  predConf:         number
  predBullProb:     number
  predBearProb:     number
  spotAtPred:       number
  predSpot:         number
  outcomeMove:      number | null
  outcomeDir:       'BULL' | 'BEAR' | null
  spotAtOutcome:    number | null
  resolved:         boolean
  correct:          boolean | null
  sessionDay:       string
  peakMove:         number | null
  liveMove:         number | null
  liveSpot:         number | null
  kalmanVelAtPred?: number  // Kalman velocity at prediction time ($/min)
}

export interface BTCTradeEntry {
  id:            string
  openTs:        number
  openTime:      string
  closeTs:       number | null
  closeTime:     string | null
  dir:           'BULL' | 'BEAR'
  entrySpot:     number
  closeSpot:     number | null
  pnlPct:        number | null
  peakPct:       number
  exitReason:    'trail' | 'stop' | 'vel_rev' | 'pat_flip' | 'time' | null
  entryVel:      number
  entryConf:     number
  entryBullProb: number
  entryCdZ:      number
  sessionKey:    BTCSession
}

export interface BTCFlowState {
  cumDelta:       number
  cdZScore:       number
  aggressionRatio: number
  cusumPos:        number
  cusumNeg:        number
  cusumAlarm:      'BULL' | 'BEAR' | null
  fundingRate:     number | null
  markPrice:       number | null
  openInterest:    number | null
}

export interface BTCOIAnalytics {
  strikes: {
    strike:     number
    callOI:     number
    callLtp:    number
    putLtp:     number
    putOI:      number
    callVolume: number
    putVolume:  number
    expiry:     string
  }[]
  pcr:            number
  maxPainStrike:  number
  atmStrike:      number
  totalCallOI:    number
  totalPutOI:     number
  expiry:         string
}

export interface BTCV2 {
  prediction:          BTCPrediction
  sessionKey:          BTCSession
  sessionPatternCount: number
  flowState:           BTCFlowState | null
  featureVec:          number[]
  kalmanVelocity:      number
}

export interface BitcoinState {
  spot:               number
  markPrice:          number | null
  fundingRate:        number | null
  openInterest:       number | null
  prediction:         BTCPrediction
  technicals:         BTCTechnicals
  composite:          BTCComposite
  snapshotCount:      number
  patternCount:       number
  resolvedCount:      number
  minutesAccumulated: number
  sysLog:             BTCSysLogEntry[]
  oiAnalytics:        BTCOIAnalytics | null
  flow:               BTCFlowState | null
  v2:                 BTCV2 | null
  depth:              { buy: { price: number; qty: number }[]; sell: { price: number; qty: number }[] } | null
  symbol:             string
  activeTrade:        BTCTradeEntry | null
  tradeLog:           BTCTradeEntry[]
}

// ── Internal flow state ───────────────────────────────────────────────────────

interface AggTrade { price: number; qty: number; isBuyerMaker: boolean; ts: number }
interface CdBucket  { ts: number; delta: number }

interface KalmanState {
  x:           [number, number]
  P:           [[number, number], [number, number]]
  initialised: boolean
}

interface BTCProductState {
  store:              BTCStore
  indicatorEngine:    IndicatorEngine
  engineWarmed:       boolean
  warmingPromise:     Promise<void> | null
  loaded:             boolean
  lastPersistTs:      number
  sysLogStore:        { entries: BTCSysLogEntry[]; lastCycleTs: number }
  sysLogLoaded:       boolean
  // Flow state
  cdBuckets:          CdBucket[]
  cdBucketStats:      { mean: number; std: number }
  lastAggTrades:      AggTrade[]
  cusumPos:           number
  cusumNeg:           number
  lastFlowState:      BTCFlowState | null
  lastFlowStateAt:    number
  // Cache
  lastFundingRate:    number | null
  lastMarkPrice:      number | null
  lastOpenInterest:   number | null
  lastFundingTs:      number
  lastDeribitData:    BTCOIAnalytics | null
  lastDeribitTs:      number
  // V2
  patternsV2:         { asia: BTCPatternV2[]; london: BTCPatternV2[]; ny: BTCPatternV2[] }
  patternsV2Loaded:   boolean
  patternsV2LastPersistTs: number
  lastV2SnapshotTs:   number
  kalman:             KalmanState
  kalmanLastTs:       number
  // Trade management
  activeTrade:        BTCTradeEntry | null
  tradeLog:           BTCTradeEntry[]
  tradeLogLoaded:     boolean
  lastTradeCloseTs:   number
  velRevConsec:       number
  // WebSocket
  wsDepth:            { buy: { price: number; qty: number }[]; sell: { price: number; qty: number }[] } | null
  wsNewTrades:        AggTrade[]
  wsConnected:        boolean
  wsConnecting:       boolean
  wsLastMsgTs:        number
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _state: BTCProductState | null = null

function getState(): BTCProductState {
  if (!_state) {
    _state = {
      store: freshStore(),
      indicatorEngine: new IndicatorEngine({ emaShortPeriod: 9, emaLongPeriod: 21, rsiPeriod: 14, atrPeriod: 14 }),
      engineWarmed:    false,
      warmingPromise:  null,
      loaded:          false,
      lastPersistTs:   0,
      sysLogStore:     { entries: [], lastCycleTs: 0 },
      sysLogLoaded:    false,
      cdBuckets:       [],
      cdBucketStats:   { mean: 0, std: 1 },
      lastAggTrades:   [],
      cusumPos:        0,
      cusumNeg:        0,
      lastFlowState:   null,
      lastFlowStateAt: 0,
      lastFundingRate: null,
      lastMarkPrice:   null,
      lastOpenInterest: null,
      lastFundingTs:   0,
      lastDeribitData: null,
      lastDeribitTs:   0,
      patternsV2:      { asia: [], london: [], ny: [] },
      patternsV2Loaded: false,
      patternsV2LastPersistTs: 0,
      lastV2SnapshotTs: 0,
      kalman: { x: [0, 0], P: [[100, 0], [0, 1]], initialised: false },
      kalmanLastTs:    0,
      activeTrade:     null,
      tradeLog:        [],
      tradeLogLoaded:  false,
      lastTradeCloseTs: 0,
      velRevConsec:    0,
      wsDepth:         null,
      wsNewTrades:     [],
      wsConnected:     false,
      wsConnecting:    false,
      wsLastMsgTs:     0,
    }
  }
  return _state
}

function freshStore(): BTCStore {
  return {
    snapshots: [], patterns: [],
    lastSnapshotTs: 0, lastPersistTs: 0,
    sessionDay: null, sessionHigh: 0, sessionLow: Infinity,
    priceHistory: [],
  }
}

// ── Persistence ───────────────────────────────────────────────────────────────

const FILE_PATTERNS = path.join(BASE_DIR, 'bitcoin-patterns.json')
const FILE_SYSLOG   = path.join(BASE_DIR, 'bitcoin-syslog.json')
const FILE_TRADES   = path.join(BASE_DIR, 'bitcoin-trades.json')
const V2_FILES: Record<BTCSession, string> = {
  asia:   path.join(BASE_DIR, 'bitcoin-v2-asia.json'),
  london: path.join(BASE_DIR, 'bitcoin-v2-london.json'),
  ny:     path.join(BASE_DIR, 'bitcoin-v2-ny.json'),
}

function ensureLoaded(ps: BTCProductState) {
  if (ps.loaded) return
  ps.loaded = true
  try {
    const raw = fs.readFileSync(FILE_PATTERNS, 'utf8')
    const saved = JSON.parse(raw) as { patterns?: BTCPattern[] }
    if (Array.isArray(saved.patterns)) {
      ps.store.patterns = saved.patterns
        .filter(p => Array.isArray(p.vec) && p.vec.length >= VEC_DIM)
        .slice(-MAX_PATTERNS)
    }
  } catch { /* no file */ }
}

function persistPatterns(ps: BTCProductState) {
  try {
    fs.writeFileSync(FILE_PATTERNS, JSON.stringify({
      patterns: ps.store.patterns.slice(-MAX_PATTERNS), savedAt: Date.now(),
    }))
    ps.store.lastPersistTs = Date.now()
  } catch { /* ignore */ }
}

function ensureSysLogLoaded(ps: BTCProductState) {
  if (ps.sysLogLoaded) return
  ps.sysLogLoaded = true
  try {
    const raw = fs.readFileSync(FILE_SYSLOG, 'utf8')
    const saved = JSON.parse(raw) as Partial<typeof ps.sysLogStore>
    if (Array.isArray(saved.entries)) {
      const seen = new Set<number>()
      ps.sysLogStore.entries = saved.entries.filter((e: { cycleTs: number }) => {
        if (seen.has(e.cycleTs)) return false
        seen.add(e.cycleTs); return true
      }).slice(-MAX_SYSLOG)
    }
    if (saved.lastCycleTs) ps.sysLogStore.lastCycleTs = saved.lastCycleTs
  } catch { /* no file */ }
}

function persistSysLog(ps: BTCProductState) {
  try {
    fs.writeFileSync(FILE_SYSLOG, JSON.stringify({
      entries: ps.sysLogStore.entries.slice(-MAX_SYSLOG),
      lastCycleTs: ps.sysLogStore.lastCycleTs,
      savedAt: Date.now(),
    }))
  } catch { /* ignore */ }
}

function ensurePatternsV2Loaded(ps: BTCProductState) {
  if (ps.patternsV2Loaded) return
  ps.patternsV2Loaded = true
  for (const key of ['asia', 'london', 'ny'] as BTCSession[]) {
    try {
      const raw = fs.readFileSync(V2_FILES[key], 'utf8')
      const saved = JSON.parse(raw) as { patterns?: BTCPatternV2[] }
      if (Array.isArray(saved.patterns)) {
        ps.patternsV2[key] = saved.patterns
          .filter(p => Array.isArray(p.vec) && p.vec.length >= 14)
          .slice(-MAX_PATTERNS_V2)
      }
    } catch { /* no file */ }
  }
}

function persistPatternsV2(ps: BTCProductState) {
  for (const key of ['asia', 'london', 'ny'] as BTCSession[]) {
    try {
      fs.writeFileSync(V2_FILES[key], JSON.stringify({
        patterns: ps.patternsV2[key].slice(-MAX_PATTERNS_V2), savedAt: Date.now(),
      }))
    } catch { /* ignore */ }
  }
  ps.patternsV2LastPersistTs = Date.now()
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

async function fetchBTC(url: string, timeoutMs = 5000): Promise<unknown> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) return null
    return await res.json()
  } catch { return null } finally { clearTimeout(timer) }
}

// ── Binance API ───────────────────────────────────────────────────────────────

async function fetchDepth(): Promise<{ buy: { price: number; qty: number }[]; sell: { price: number; qty: number }[] } | null> {
  const data = await fetchBTC('https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDC&limit=5') as any
  if (!data?.bids || !data?.asks) return null
  return {
    buy:  (data.bids as [string, string][]).map(([p, q]) => ({ price: +p, qty: +q })),
    sell: (data.asks as [string, string][]).map(([p, q]) => ({ price: +p, qty: +q })),
  }
}

async function fetchPremiumIndex(): Promise<{ markPrice: number; fundingRate: number } | null> {
  const data = await fetchBTC('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDC') as any
  if (!data?.markPrice) return null
  return { markPrice: +data.markPrice, fundingRate: +data.lastFundingRate * 100 }
}

async function fetchOpenInterest(): Promise<number | null> {
  const data = await fetchBTC('https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDC') as any
  return data?.openInterest != null ? +data.openInterest : null
}

async function fetchAggTrades(): Promise<AggTrade[]> {
  const data = await fetchBTC('https://fapi.binance.com/fapi/v1/aggTrades?symbol=BTCUSDC&limit=500') as any
  if (!Array.isArray(data)) return []
  return data.map((t: any) => ({
    price: +t.p, qty: +t.q, isBuyerMaker: !!t.m, ts: t.T,
  }))
}

async function fetchKlines(limit = 200): Promise<{ ts: number; close: number; volume: number }[]> {
  const data = await fetchBTC(
    `https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDC&interval=1m&limit=${limit}`, 15_000
  ) as any
  if (!Array.isArray(data)) return []
  return data.map((k: any) => ({ ts: +k[0], close: +k[4], volume: +k[5] }))
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

const WS_URL = 'wss://fstream.binance.com/stream?streams=btcusdc@depth5@100ms/btcusdc@aggTrade'
const WS_STALE_MS    = 30_000   // reconnect if no message for 30s
const WS_RECONNECT_MS = 3_000   // reconnect delay after close/error

function ensureWsConnected(ps: BTCProductState): void {
  const now = Date.now()

  // Stale-connection guard: reconnect if no message received for 30s
  if (ps.wsConnected && ps.wsLastMsgTs > 0 && now - ps.wsLastMsgTs > WS_STALE_MS) {
    console.warn('[bitcoin] WebSocket stale — reconnecting')
    ps.wsConnected = false
  }

  if (ps.wsConnected || ps.wsConnecting) return
  ps.wsConnecting = true

  let ws: WebSocket
  try {
    ws = new WebSocket(WS_URL)
  } catch (e) {
    ps.wsConnecting = false
    console.error('[bitcoin] WebSocket init failed:', e instanceof Error ? e.message : e)
    setTimeout(() => ensureWsConnected(ps), WS_RECONNECT_MS)
    return
  }

  ws.addEventListener('open', () => {
    ps.wsConnected  = true
    ps.wsConnecting = false
    ps.wsLastMsgTs  = Date.now()
    console.log('[bitcoin] WebSocket connected:', WS_URL)
  })

  ws.addEventListener('message', (evt: MessageEvent) => {
    ps.wsLastMsgTs = Date.now()
    try {
      const msg    = JSON.parse(evt.data as string) as { stream: string; data: Record<string, unknown> }
      const stream = msg.stream ?? ''
      const data   = msg.data ?? {}

      if (stream.includes('depth')) {
        // Partial book depth snapshot: b[] = bids, a[] = asks (top 5 each)
        const b = data.b as [string, string][] | undefined
        const a = data.a as [string, string][] | undefined
        if (b?.length && a?.length) {
          ps.wsDepth = {
            buy:  b.map(([p, q]) => ({ price: +p, qty: +q })),
            sell: a.map(([p, q]) => ({ price: +p, qty: +q })),
          }
        }
      } else if (stream.includes('aggTrade')) {
        ps.wsNewTrades.push({
          price: +(data.p as string),
          qty:   +(data.q as string),
          isBuyerMaker: !!(data.m as boolean),
          ts:    +(data.T as number),
        })
        // Bound buffer to avoid memory growth between slow SSE polls
        if (ps.wsNewTrades.length > 2000) ps.wsNewTrades = ps.wsNewTrades.slice(-1000)
      }
    } catch { /* ignore parse errors */ }
  })

  ws.addEventListener('close', () => {
    ps.wsConnected  = false
    ps.wsConnecting = false
    console.log('[bitcoin] WebSocket closed — reconnecting in', WS_RECONNECT_MS, 'ms')
    setTimeout(() => ensureWsConnected(ps), WS_RECONNECT_MS)
  })

  ws.addEventListener('error', (e: Event) => {
    const msg = e instanceof ErrorEvent ? e.message : 'unknown error'
    console.error('[bitcoin] WebSocket error:', msg)
    ps.wsConnected  = false
    ps.wsConnecting = false
    // close event follows and will schedule reconnect
  })
}

// ── Deribit API ───────────────────────────────────────────────────────────────

function parseDeribitExpiry(name: string): string {
  // BTC-30MAY25-100000-C → "30MAY25"
  const parts = name.split('-')
  return parts[1] ?? ''
}

function parseDeribitStrike(name: string): number {
  const parts = name.split('-')
  return parts[2] ? +parts[2] : 0
}

function parseDeribitType(name: string): 'C' | 'P' | null {
  const t = name.split('-')[3]
  return t === 'C' ? 'C' : t === 'P' ? 'P' : null
}

const MONTH_IDX: Record<string, number> = {
  JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11
}

// Returns nearest upcoming expiry string from a list of expiry strings (DDMMMYY)
function nearestExpiry(expiries: string[]): string {
  const now = Date.now()
  const toTs = (exp: string): number => {
    const m = exp.match(/^(\d{2})([A-Z]{3})(\d{2})$/)
    if (!m) return Infinity
    const mon = MONTH_IDX[m[2]]
    if (mon === undefined) return Infinity
    const d = new Date(Date.UTC(2000 + +m[3], mon, +m[1], 8, 0, 0, 0))
    return d.getTime()
  }
  const future = expiries.filter(e => toTs(e) >= now - 86400_000)
  if (future.length === 0) return expiries[0] ?? ''
  return future.sort((a, b) => toTs(a) - toTs(b))[0]
}

async function fetchDeribitOI(spot: number): Promise<BTCOIAnalytics | null> {
  const data = await fetchBTC(
    'https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option',
    10_000
  ) as any
  if (!Array.isArray(data?.result)) return null

  // Collect all expiries, pick nearest
  const expiriesSet = new Set<string>()
  for (const item of data.result) {
    const exp = parseDeribitExpiry(item.instrument_name ?? '')
    if (exp) expiriesSet.add(exp)
  }
  const expiry = nearestExpiry(Array.from(expiriesSet))
  if (!expiry) return null

  // Filter to nearest expiry
  const relevant = data.result.filter(
    (item: any) => parseDeribitExpiry(item.instrument_name ?? '') === expiry
  )

  // Aggregate by strike
  const strikesMap = new Map<number, {
    callOI: number; callLtp: number; putOI: number; putLtp: number;
    callVolume: number; putVolume: number
  }>()
  for (const item of relevant) {
    const name   = item.instrument_name as string
    const strike = parseDeribitStrike(name)
    const type   = parseDeribitType(name)
    if (!strike || !type) continue
    if (!strikesMap.has(strike)) {
      strikesMap.set(strike, { callOI: 0, callLtp: 0, putOI: 0, putLtp: 0, callVolume: 0, putVolume: 0 })
    }
    const row  = strikesMap.get(strike)!
    const ltp  = (item.last ?? item.mark_price ?? 0) * spot   // BTC → USD
    const oi   = item.open_interest ?? 0                       // in BTC
    const vol  = item.volume ?? 0
    if (type === 'C') {
      row.callOI = oi; row.callLtp = ltp; row.callVolume = vol
    } else {
      row.putOI = oi; row.putLtp = ltp; row.putVolume = vol
    }
  }

  const strikes = Array.from(strikesMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([strike, v]) => ({ strike, expiry, ...v }))

  if (strikes.length === 0) return null

  const totalCallOI = strikes.reduce((s, r) => s + r.callOI, 0)
  const totalPutOI  = strikes.reduce((s, r) => s + r.putOI, 0)
  const pcr         = totalCallOI > 0 ? totalPutOI / totalCallOI : 0

  // Max pain: minimize total OI loss at each strike
  let maxPainStrike = strikes[0].strike
  let minPain = Infinity
  for (const candidate of strikes) {
    let pain = 0
    for (const row of strikes) {
      if (row.strike > candidate.strike) pain += row.callOI * (row.strike - candidate.strike)
      if (row.strike < candidate.strike) pain += row.putOI  * (candidate.strike - row.strike)
    }
    if (pain < minPain) { minPain = pain; maxPainStrike = candidate.strike }
  }

  const atmStrike = strikes.reduce((best, s) =>
    Math.abs(s.strike - spot) < Math.abs(best.strike - spot) ? s : best
  ).strike

  return { strikes, pcr, maxPainStrike, atmStrike, totalCallOI, totalPutOI, expiry }
}

// ── Flow state (agg trades → cumDelta, CUSUM) ─────────────────────────────────

function updateFlowState(ps: BTCProductState, trades: AggTrade[], now: number): void {
  if (trades.length === 0) return

  // Update rolling delta window (5-min)
  const cutoff = now - CD_WINDOW_MS
  for (const t of trades) {
    const minute = Math.floor(t.ts / CD_BUCKET_MS) * CD_BUCKET_MS
    let bucket = ps.cdBuckets.find(b => b.ts === minute)
    if (!bucket) {
      bucket = { ts: minute, delta: 0 }
      ps.cdBuckets.push(bucket)
    }
    bucket.delta += t.isBuyerMaker ? -t.qty : t.qty
  }
  ps.cdBuckets = ps.cdBuckets.filter(b => b.ts >= now - CD_BUCKET_MAX * CD_BUCKET_MS)

  const windowBuckets = ps.cdBuckets.filter(b => b.ts >= cutoff)
  const cumDelta = windowBuckets.reduce((s, b) => s + b.delta, 0)

  // Z-score of cumDelta relative to bucket history
  const vals = ps.cdBuckets.map(b => b.delta)
  const mean = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0
  const variance = vals.length > 1
    ? vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length : 1
  const std = Math.sqrt(variance) || 1
  ps.cdBucketStats = { mean, std }
  const cdZScore = (cumDelta - mean * windowBuckets.length) / (std * Math.sqrt(Math.max(1, windowBuckets.length)))

  // Aggression ratio (last 100 trades)
  ps.lastAggTrades = [...ps.lastAggTrades, ...trades].slice(-AGG_WINDOW)
  const buyCount = ps.lastAggTrades.filter(t => !t.isBuyerMaker).length
  const aggressionRatio = ps.lastAggTrades.length > 0 ? (buyCount / ps.lastAggTrades.length) * 2 - 1 : 0

  // CUSUM on cdZScore (normalised)
  const zn = cdZScore / 3   // normalise to ~[-1,1]
  const k  = 0.5
  ps.cusumPos = Math.max(0, ps.cusumPos + zn - k)
  ps.cusumNeg = Math.max(0, ps.cusumNeg - zn - k)
  if (ps.cusumPos >= CUSUM_H || ps.cusumNeg >= CUSUM_H) {
    // one-shot reset after alarm
    if (ps.cusumPos >= CUSUM_H) ps.cusumPos = 0
    if (ps.cusumNeg >= CUSUM_H) ps.cusumNeg = 0
  }
  const cusumAlarm = ps.cusumPos >= CUSUM_H ? 'BULL'
    : ps.cusumNeg >= CUSUM_H ? 'BEAR' : null

  ps.lastFlowState = {
    cumDelta, cdZScore, aggressionRatio,
    cusumPos: ps.cusumPos, cusumNeg: ps.cusumNeg, cusumAlarm,
    fundingRate:  ps.lastFundingRate,
    markPrice:    ps.lastMarkPrice,
    openInterest: ps.lastOpenInterest,
  }
  ps.lastFlowStateAt = now
}

// ── Warm indicators ───────────────────────────────────────────────────────────

async function warmIndicators(ps: BTCProductState) {
  try {
    // Fetch 400 klines (~6.5h) — enough for indicator warm-up + pattern backfill
    // Non-realtime klines lack OBI/depth dims so marginal value of deeper history is low
    const klines = await fetchKlines(400)
    if (klines.length === 0) return

    const engine = new IndicatorEngine({ emaShortPeriod: 9, emaLongPeriod: 21, rsiPeriod: 14, atrPeriod: 14 })
    const kal: KalmanState = { x: [0, 0], P: [[100, 0], [0, 1]], initialised: false }
    let kalLastTs = 0
    const sessionHigh: Record<string, number> = {}
    const sessionLow:  Record<string, number> = {}

    type Snap = { ts: number; price: number; vec: number[]; vecV2: number[]; sessionKey: BTCSession; sessionDay: string }
    const snaps: Snap[] = []

    for (let i = 0; i < klines.length; i++) {
      const k   = klines[i]
      const ind = engine.update(k.ts, k.close, k.volume)

      // Kalman velocity
      const dtMin = kalLastTs > 0 ? (k.ts - kalLastTs) / 60_000 : 1
      kalmanUpdate(kal, k.close, dtMin)
      kalLastTs = k.ts
      const kalmanVelocity = kal.x[1]

      const utcHour    = new Date(k.ts).getUTCHours()
      const utcDate    = new Date(k.ts).toISOString().slice(0, 10)
      const sessionKey = getBTCSession(utcHour)
      const sKey       = `${utcDate}-${sessionKey}`

      if (!sessionHigh[sKey] || k.close > sessionHigh[sKey]) sessionHigh[sKey] = k.close
      if (!sessionLow[sKey]  || k.close < sessionLow[sKey])  sessionLow[sKey]  = k.close
      const hi = sessionHigh[sKey], lo = sessionLow[sKey]

      const momentum1m = i >= 1  ? (k.close - klines[i-1].close)  / klines[i-1].close  : 0
      const momentum5m = i >= 5  ? (k.close - klines[i-5].close)  / klines[i-5].close  : 0

      const tech: BTCTechnicals = {
        rsi: ind.rsi, emaShort: ind.emaShort, emaLong: ind.emaLong,
        emaCrossover: ind.emaShort != null && ind.emaLong != null
          ? ind.emaShort > ind.emaLong ? 'BULL' : ind.emaShort < ind.emaLong ? 'BEAR' : null : null,
        vwap: ind.vwap,
        vwapAlign: ind.vwap != null ? (k.close > ind.vwap ? 'BULL' : k.close < ind.vwap ? 'BEAR' : null) : null,
        atr: ind.atr, atrPct: ind.atrPct,
        momentum1m, momentum5m,
        sessionHigh: hi, sessionLow: lo,
        rangePosition: hi > lo ? (k.close - lo) / (hi - lo) : 0.5,
      }

      // depth=null → OBI/mpEdge/spread dims stay 0; flow=null → cdZ/aggr/cusum stay 0
      const vec   = buildFeatureVectorV1(k.close, ind, tech, null, 0)
      const vecV2 = buildFeatureVectorV2(k.close, ind, tech, utcHour, null, null, kalmanVelocity)

      snaps.push({ ts: k.ts, price: k.close, vec, vecV2, sessionKey, sessionDay: utcDate })
    }

    // Populate V1 patterns (backfill if sparse — stale partial files shouldn't prevent rebuild)
    if (ps.store.patterns.length < 50) {
      for (let i = 0; i < snaps.length; i++) {
        const s   = snaps[i]
        const o5  = snaps[i + 10] ? ((snaps[i+10].price - s.price) / s.price) * 100 : null
        const o15 = snaps[i + 30] ? ((snaps[i+30].price - s.price) / s.price) * 100 : null
        const o20 = snaps[i + 60] ? ((snaps[i+60].price - s.price) / s.price) * 100 : null
        ps.store.patterns.push({ ts: s.ts, vec: s.vec, price: s.price, outcome5: o5, outcome15: o15, outcome20: o20 })
      }
      if (ps.store.patterns.length > MAX_PATTERNS) ps.store.patterns = ps.store.patterns.slice(-MAX_PATTERNS)
    }

    // Populate V2 patterns per session (only if empty)
    for (const key of ['asia', 'london', 'ny'] as BTCSession[]) {
      if (ps.patternsV2[key].length > 0) continue
      const sessionSnaps = snaps.filter(s => s.sessionKey === key)
      for (let i = 0; i < sessionSnaps.length; i++) {
        const s   = sessionSnaps[i]
        // find price 10/30/60 snaps later in full kline array (same price series)
        const idx  = snaps.indexOf(s)
        const o5   = snaps[idx + 10] ? ((snaps[idx+10].price - s.price) / s.price) * 100 : null
        const o15  = snaps[idx + 30] ? ((snaps[idx+30].price - s.price) / s.price) * 100 : null
        const o20  = snaps[idx + 60] ? ((snaps[idx+60].price - s.price) / s.price) * 100 : null
        ps.patternsV2[key].push({ ts: s.ts, vec: s.vecV2, price: s.price,
          sessionKey: key, sessionDay: s.sessionDay, outcome5: o5, outcome15: o15, outcome20: o20 })
      }
      if (ps.patternsV2[key].length > MAX_PATTERNS_V2) ps.patternsV2[key] = ps.patternsV2[key].slice(-MAX_PATTERNS_V2)
    }

    // Seed snapshots for future outcome resolution
    for (const s of snaps.slice(-MAX_SNAPSHOTS)) {
      ps.store.snapshots.push({ ts: s.ts, vec: s.vec, price: s.price })
    }
    ps.store.lastSnapshotTs = snaps[snaps.length - 1]?.ts ?? 0

    // Use the same engine for live indicator warm-up
    ps.indicatorEngine = engine
    ps.engineWarmed    = true

  } catch (err) {
    console.error('[bitcoin] warmIndicators failed:', err instanceof Error ? err.message : err)
  }
}

// ── Kalman filter ─────────────────────────────────────────────────────────────

function kalmanUpdate(ks: KalmanState, price: number, dtMinutes: number): void {
  if (!ks.initialised) {
    ks.x = [price, 0]
    ks.P = [[KALMAN_R, 0], [0, KALMAN_Q_VEL]]
    ks.initialised = true
    return
  }
  const dt = Math.max(0.016, Math.min(dtMinutes, 10))
  const xp0 = ks.x[0] + ks.x[1] * dt
  const xp1 = ks.x[1]
  const P00  = ks.P[0][0] + dt * (ks.P[0][1] + ks.P[1][0]) + dt * dt * ks.P[1][1] + KALMAN_Q_PRICE
  const P01  = ks.P[0][1] + dt * ks.P[1][1]
  const P10  = ks.P[1][0] + dt * ks.P[1][1]
  const P11  = ks.P[1][1] + KALMAN_Q_VEL
  const S    = P00 + KALMAN_R
  const K0   = P00 / S
  const K1   = P10 / S
  const innov = price - xp0
  ks.x = [xp0 + K0 * innov, xp1 + K1 * innov]
  ks.P = [
    [P00 - K0 * P00, P01 - K0 * P01],
    [P10 - K1 * P00, P11 - K1 * P10],
  ]
}

// ── Feature Vectors ───────────────────────────────────────────────────────────

function clamp(v: number, scale = 1): number {
  return Math.max(-1, Math.min(1, Number.isFinite(v) ? v * scale : 0))
}

function buildFeatureVectorV1(
  price:   number,
  ind:     IndicatorValues,
  tech:    BTCTechnicals,
  depth:   { buy: { price: number; qty: number }[]; sell: { price: number; qty: number }[] } | null,
  cdZScore: number,
): number[] {
  let obi = 0, mpEdgeTicks = 0, depthAsymm = 0
  if (depth && depth.buy.length > 0 && depth.sell.length > 0) {
    const bidQty = depth.buy.reduce((s, l) => s + l.qty, 0)
    const askQty = depth.sell.reduce((s, l) => s + l.qty, 0)
    const total  = bidQty + askQty
    obi = total > 0 ? (bidQty - askQty) / total : 0          // 5-level total imbalance
    const bestBid = depth.buy[0], bestAsk = depth.sell[0]
    const bestTotal = bestBid.qty + bestAsk.qty
    depthAsymm = bestTotal > 0 ? (bestBid.qty - bestAsk.qty) / bestTotal : 0  // best-level only
    const mid = (bestBid.price + bestAsk.price) / 2
    const micro = (bestAsk.price * bestBid.qty + bestBid.price * bestAsk.qty)
      / (bestBid.qty + bestAsk.qty)
    const tickSz = Math.max(1, bestAsk.price - bestBid.price)
    mpEdgeTicks = (micro - mid) / tickSz
  }

  const emaCross = ind.emaShort != null && ind.emaLong != null
    ? ind.emaShort > ind.emaLong ? 1 : ind.emaShort < ind.emaLong ? -1 : 0
    : 0

  return [
    clamp(obi),                                                       // 0 OBI
    clamp(mpEdgeTicks, 0.5),                                          // 1 mpEdgeTicks
    clamp(depthAsymm),                                                // 2 depthAsymmetry
    0,                                                                // 3 qpoBalance (no orders count in Binance)
    clamp(tech.momentum1m, 200),                                      // 4 momentum1m
    clamp(tech.momentum5m, 100),                                      // 5 momentum5m
    clamp(ind.rsi != null ? (ind.rsi - 50) / 50 : 0),                // 6 RSI normalised
    clamp(emaCross),                                                   // 7 EMA crossover
    clamp(ind.vwap != null ? (price > ind.vwap ? 1 : price < ind.vwap ? -1 : 0) : 0), // 8 VWAP align
    clamp(tech.rangePosition * 2 - 1),                                // 9 range position
    clamp(ind.atrPct != null ? (ind.atrPct - 0.3) / 0.3 : 0),        // 10 ATR%
    clamp(cdZScore, 0.33),                                            // 11 cdZScore / 3
  ]
}

function buildFeatureVectorV2(
  price:          number,
  ind:            IndicatorValues,
  tech:           BTCTechnicals,
  utcHour:        number,
  flow:           BTCFlowState | null,
  depth:          { buy: { price: number; qty: number }[]; sell: { price: number; qty: number }[] } | null,
  kalmanVelocity: number,
): number[] {
  let mpEdgeTicks = 0, spreadTicks = 0
  if (depth && depth.buy.length > 0 && depth.sell.length > 0) {
    const bestBid = depth.buy[0], bestAsk = depth.sell[0]
    const mid   = (bestBid.price + bestAsk.price) / 2
    const micro = (bestAsk.price * bestBid.qty + bestBid.price * bestAsk.qty)
      / (bestBid.qty + bestAsk.qty)
    const tickSz = Math.max(1, bestAsk.price - bestBid.price)
    mpEdgeTicks  = (micro - mid) / tickSz
    spreadTicks  = Math.min(1, (bestAsk.price - bestBid.price) / tickSz / 5) * 2 - 1
  }

  const cdZ    = flow ? clamp(flow.cdZScore, 0.33) : clamp(tech.momentum5m, 100)
  const aggr   = flow ? clamp(flow.aggressionRatio) : clamp(tech.momentum1m, 200)
  const cusumNet = flow
    ? clamp((flow.cusumPos - flow.cusumNeg) / (CUSUM_H * 2))
    : 0

  const timeOfDay = clamp(utcHour / 24 * 2 - 1)  // -1 at 0:00, +1 at 24:00

  const emaCross = ind.emaShort != null && ind.emaLong != null
    ? ind.emaShort > ind.emaLong ? 1 : ind.emaShort < ind.emaLong ? -1 : 0
    : 0

  return [
    cdZ,                                                               // 0 cdZScore (flow)
    clamp(mpEdgeTicks, 0.5),                                          // 1 mpEdgeTicks
    clamp(spreadTicks),                                               // 2 spreadTicks
    0,                                                                // 3 qpoBalance (no orders count)
    clamp(tech.momentum1m, 200),                                      // 4 momentum1m
    clamp(tech.momentum5m, 100),                                      // 5 momentum5m
    clamp(ind.rsi != null ? (ind.rsi - 50) / 50 : 0),                // 6 RSI
    clamp(emaCross),                                                   // 7 EMA crossover
    clamp(ind.vwap != null ? (price > ind.vwap ? 1 : price < ind.vwap ? -1 : 0) : 0), // 8 VWAP
    clamp(tech.rangePosition * 2 - 1),                                // 9 range position
    clamp(ind.atrPct != null ? (ind.atrPct - 0.3) / 0.3 : 0),        // 10 ATR%
    timeOfDay,                                                        // 11 timeOfDay
    aggr,                                                             // 12 aggressionRatio
    cusumNet,                                                         // 13 cusumNet
    clamp(kalmanVelocity / 20),                                       // 14 Kalman velocity (±$20/min → ±1)
  ]
}

// ── Cosine similarity ─────────────────────────────────────────────────────────

function cosineSim(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) { dot += a[i]*b[i]; magA += a[i]*a[i]; magB += b[i]*b[i] }
  const denom = Math.sqrt(magA) * Math.sqrt(magB)
  return denom > 1e-10 ? dot / denom : 0
}

// ── KNN Query ─────────────────────────────────────────────────────────────────

function queryHorizon<P extends { outcome5: number|null; outcome15: number|null; outcome20: number|null }>(
  weights: number[],
  topK: { sim: number; i: number }[],
  resolved: P[],
  horizon: keyof P,
): HorizonPrediction {
  let predictedMove = 0, bullW = 0, bearW = 0, totalW = 0
  for (let i = 0; i < topK.length; i++) {
    const outcome = resolved[topK[i].i][horizon] as number | null
    if (outcome === null) continue
    predictedMove += weights[i] * outcome
    totalW += weights[i]
    if (outcome > 0) bullW += weights[i]
    else if (outcome < 0) bearW += weights[i]
  }
  if (totalW > 0) predictedMove /= totalW
  const total = bullW + bearW
  return { predictedMove, bullProb: total > 0 ? bullW / total : 0.5, bearProb: total > 0 ? bearW / total : 0.5 }
}

function queryAttention<P extends { vec: number[]; outcome5: number|null; outcome15: number|null; outcome20: number|null }>(
  queryVec: number[],
  patterns: P[],
  minResolved = MIN_PATTERNS,
): BTCPrediction {
  const resolved = patterns.filter(p => p.outcome20 !== null)
  if (resolved.length < minResolved) {
    return {
      predictedMove: 0, bullProb: 0.5, bearProb: 0.5,
      topSim: 0, confidence: 0, nResolved: resolved.length,
      direction: null, status: resolved.length === 0 ? 'no_data' : 'warming',
      h5: null, h15: null, h20: null,
    }
  }
  const sims    = resolved.map(p => cosineSim(queryVec, p.vec))
  const indexed = sims.map((sim, i) => ({ sim, i })).sort((a, b) => b.sim - a.sim)
  const topK    = indexed.slice(0, Math.min(KNN_K, resolved.length))
  const maxSim  = topK[0].sim
  const expScores = topK.map(t => Math.exp((t.sim - maxSim) / TEMPERATURE))
  const sumExp    = expScores.reduce((a, b) => a + b, 0)
  const weights   = expScores.map(e => e / sumExp)

  const h5  = queryHorizon(weights, topK, resolved, 'outcome5')
  const h15 = queryHorizon(weights, topK, resolved, 'outcome15')
  const h20 = queryHorizon(weights, topK, resolved, 'outcome20')

  return {
    predictedMove: h20.predictedMove, bullProb: h20.bullProb, bearProb: h20.bearProb,
    topSim: topK[0].sim, confidence: weights[0], nResolved: resolved.length,
    direction: h20.bullProb >= 0.55 ? 'BULL' : h20.bearProb >= 0.55 ? 'BEAR' : null,
    status: 'ready', h5, h15, h20,
  }
}

// ── Outcome resolution ────────────────────────────────────────────────────────

function resolveOutcomes(store: BTCStore) {
  const now = Date.now()
  for (const p of store.patterns) {
    if (p.outcome5 === null && now - p.ts >= OUTCOME_5_MS) {
      const snap = store.snapshots.find(s => s.ts >= p.ts + OUTCOME_5_MS)
      if (snap) p.outcome5 = ((snap.price - p.price) / p.price) * 100
    }
    if (p.outcome15 === null && now - p.ts >= OUTCOME_15_MS) {
      const snap = store.snapshots.find(s => s.ts >= p.ts + OUTCOME_15_MS)
      if (snap) p.outcome15 = ((snap.price - p.price) / p.price) * 100
    }
    if (p.outcome20 === null && now - p.ts >= OUTCOME_20_MS) {
      const snap = store.snapshots.find(s => s.ts >= p.ts + OUTCOME_20_MS)
      if (snap) p.outcome20 = ((snap.price - p.price) / p.price) * 100
    }
  }
}

function resolveOutcomesV2(patterns: BTCPatternV2[], snapshots: Snapshot[]) {
  const now = Date.now()
  for (const p of patterns) {
    if (p.outcome5 === null && now - p.ts >= OUTCOME_5_MS) {
      const snap = snapshots.find(s => s.ts >= p.ts + OUTCOME_5_MS)
      if (snap) p.outcome5 = ((snap.price - p.price) / p.price) * 100
    }
    if (p.outcome15 === null && now - p.ts >= OUTCOME_15_MS) {
      const snap = snapshots.find(s => s.ts >= p.ts + OUTCOME_15_MS)
      if (snap) p.outcome15 = ((snap.price - p.price) / p.price) * 100
    }
    if (p.outcome20 === null && now - p.ts >= OUTCOME_20_MS) {
      const snap = snapshots.find(s => s.ts >= p.ts + OUTCOME_20_MS)
      if (snap) p.outcome20 = ((snap.price - p.price) / p.price) * 100
    }
  }
}

// ── Composite blending ────────────────────────────────────────────────────────

function computeComposite(prediction: BTCPrediction, tech: BTCTechnicals): BTCComposite {
  const votes: { score: number; weight: number }[] = []

  if (tech.vwapAlign) votes.push({ score: tech.vwapAlign === 'BULL' ? 1 : 0, weight: 1.2 })
  if (tech.emaCrossover) votes.push({ score: tech.emaCrossover === 'BULL' ? 1 : 0, weight: 1.0 })
  if (tech.rsi != null) votes.push({ score: Math.max(0, Math.min(1, (tech.rsi - 30) / 40)), weight: 0.8 })
  if (Math.abs(tech.momentum5m) > 0.0005) votes.push({ score: tech.momentum5m > 0 ? 1 : 0, weight: 1.0 })
  if (tech.sessionHigh > tech.sessionLow) votes.push({ score: tech.rangePosition, weight: 0.6 })
  if (Math.abs(tech.momentum1m) > 0.0002) votes.push({ score: tech.momentum1m > 0 ? 1 : 0, weight: 0.5 })

  let techBullScore = 0.5
  if (votes.length > 0) {
    const totalW = votes.reduce((s, v) => s + v.weight, 0)
    techBullScore = votes.reduce((s, v) => s + v.score * v.weight, 0) / totalW
  }

  const patternReady  = prediction.status === 'ready' && prediction.nResolved >= MIN_PATTERNS
  const patternWeight = patternReady ? 0.5 + 0.2 * Math.min(1, prediction.confidence / 0.3) : 0
  const techWeight    = votes.length >= 3 ? 1 - patternWeight : 0
  const totalWeight   = patternWeight + techWeight

  if (totalWeight === 0) {
    return {
      predictedMove: 0, bullProb: 0.5, bearProb: 0.5, direction: null, confidence: 0, status: 'no_data',
      components: { patternWeight: 0, techWeight: 0, patternBullProb: 0.5, techBullScore: 0.5 },
    }
  }

  const blendedBull = (patternWeight * prediction.bullProb + techWeight * techBullScore) / totalWeight
  const patMove     = patternReady ? prediction.predictedMove : 0
  const techMove    = (techBullScore - 0.5) * 2 * TYPICAL_MOVE_BTC
  const blendedMove = (patternWeight * patMove + techWeight * techMove) / totalWeight

  let horizonBonus = 0
  if (patternReady && prediction.h5 && prediction.h15 && prediction.h20) {
    const s5 = Math.sign(prediction.h5.predictedMove)
    const s15 = Math.sign(prediction.h15.predictedMove)
    const s20 = Math.sign(prediction.h20.predictedMove)
    if (s5 === s15 && s15 === s20 && s20 !== 0) horizonBonus = 0.15
  }

  const conf = patternReady
    ? prediction.confidence * (0.7 + 0.3 * Math.abs(techBullScore - 0.5) * 2) + horizonBonus
    : Math.abs(techBullScore - 0.5) * 2

  return {
    predictedMove: blendedMove,
    bullProb: blendedBull, bearProb: 1 - blendedBull,
    direction: blendedBull >= 0.55 ? 'BULL' : (1 - blendedBull) >= 0.55 ? 'BEAR' : null,
    confidence: Math.min(1, conf),
    status: patternReady || votes.length >= 3 ? 'ready' : votes.length > 0 ? 'warming' : 'no_data',
    components: {
      patternWeight: totalWeight > 0 ? patternWeight / totalWeight : 0,
      techWeight:    totalWeight > 0 ? techWeight    / totalWeight : 0,
      patternBullProb: prediction.bullProb,
      techBullScore,
    },
  }
}

// ── SysLog ────────────────────────────────────────────────────────────────────

function updateSysLog(ps: BTCProductState, composite: BTCComposite, spot: number, kalmanVelocity = 0): BTCSysLogEntry[] {
  ensureSysLogLoaded(ps)
  const sl  = ps.sysLogStore
  const now = Date.now()
  const utcDate = new Date(now).toISOString().slice(0, 10)
  const utcH = new Date(now).getUTCHours()
  const utcM = new Date(now).getUTCMinutes()
  const cycleTime = `${String(utcH).padStart(2,'0')}:${String(utcM).padStart(2,'0')}Z`

  const dirProb   = Math.max(composite.bullProb, composite.bearProb)
  // Only log swing-worthy predictions: require meaningful velocity + directional confidence
  const velOk     = Math.abs(kalmanVelocity) >= TRADE_ENTRY_VEL_MIN   // ≥ 3 $/min
  const hasConviction = velOk && dirProb >= 0.60 && Math.abs(composite.predictedMove) >= 0.10

  let changed = false
  for (const entry of sl.entries) {
    if (entry.resolved) continue
    const spotDiff   = spot - entry.spotAtPred
    const currentMove = entry.spotAtPred > 0 ? (spotDiff / entry.spotAtPred) * 100 : 0
    if (spot > 0) { entry.liveMove = currentMove; entry.liveSpot = spot; changed = true }

    const moveDir = entry.predMove > 0 ? 'BULL' : entry.predMove < 0 ? 'BEAR' : null
    if (moveDir && spot > 0) {
      const prev = entry.peakMove ?? 0
      if (moveDir === 'BULL' && currentMove > prev) { entry.peakMove = currentMove; changed = true }
      if (moveDir === 'BEAR' && currentMove < prev) { entry.peakMove = currentMove; changed = true }
    }

    const timeUp = now - entry.cycleTs >= SYSLOG_RESOLVE_MS
    if (!timeUp) continue
    entry.outcomeMove   = currentMove
    entry.outcomeDir    = spotDiff > 0 ? 'BULL' : spotDiff < 0 ? 'BEAR' : null
    entry.spotAtOutcome = spot
    entry.resolved      = true
    const effectiveDir  = entry.predDir
    entry.correct = effectiveDir !== null && effectiveDir === entry.outcomeDir
    changed = true
  }

  if (changed) persistSysLog(ps)

  // 24/7: no inWindow gate for BTC
  if (now - sl.lastCycleTs >= SYSLOG_CYCLE_MS && composite.status === 'ready' && spot > 0 && hasConviction) {
    sl.lastCycleTs = now
    sl.entries.push({
      cycleTs:       now,
      cycleTime,
      predMove:      composite.predictedMove,
      predDir:       composite.direction ?? (composite.predictedMove > 0 ? 'BULL' : composite.predictedMove < 0 ? 'BEAR' : null),
      predConf:      composite.confidence,
      predBullProb:  composite.bullProb,
      predBearProb:  composite.bearProb,
      spotAtPred:    spot,
      predSpot:      spot * (1 + composite.predictedMove / 100),
      outcomeMove:   null,
      outcomeDir:    null,
      spotAtOutcome: null,
      resolved:      false,
      correct:       null,
      sessionDay:    utcDate,
      peakMove:      null,
      liveMove:         0,
      liveSpot:         spot,
      kalmanVelAtPred:  kalmanVelocity,
    })
    if (sl.entries.length > MAX_SYSLOG) sl.entries = sl.entries.slice(-MAX_SYSLOG)
    persistSysLog(ps)
  }

  return sl.entries.slice(-30)
}

// ── Trade persistence ─────────────────────────────────────────────────────────

function ensureTradesLoaded(ps: BTCProductState) {
  if (ps.tradeLogLoaded) return
  ps.tradeLogLoaded = true
  try {
    const raw = fs.readFileSync(FILE_TRADES, 'utf8')
    const saved = JSON.parse(raw) as { activeTrade?: BTCTradeEntry | null; tradeLog?: BTCTradeEntry[] }
    if (saved.activeTrade) ps.activeTrade = saved.activeTrade
    if (Array.isArray(saved.tradeLog)) ps.tradeLog = saved.tradeLog.slice(-MAX_TRADE_LOG)
  } catch { /* no file */ }
}

function persistTrades(ps: BTCProductState) {
  try {
    fs.writeFileSync(FILE_TRADES, JSON.stringify({
      activeTrade: ps.activeTrade,
      tradeLog:    ps.tradeLog.slice(-MAX_TRADE_LOG),
      savedAt:     Date.now(),
    }))
  } catch { /* ignore */ }
}

// ── Trade management ──────────────────────────────────────────────────────────

function utcTimeStr(now: number): string {
  const d = new Date(now)
  return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}Z`
}

function checkTradeEntry(
  ps:             BTCProductState,
  composite:      BTCComposite,
  v2:             BTCV2,
  flow:           BTCFlowState | null,
  kalmanVelocity: number,
  spot:           number,
  now:            number,
): void {
  if (ps.activeTrade) return
  if (now - ps.lastTradeCloseTs < TRADE_COOLDOWN_MS) return

  const dir = composite.direction
  if (!dir) return
  if (composite.confidence < TRADE_ENTRY_MIN_CONF) return

  const dirProb = dir === 'BULL' ? composite.bullProb : composite.bearProb
  if (dirProb < TRADE_ENTRY_MIN_PROB) return

  // Velocity gate — must be moving in direction with enough momentum
  const velOk = dir === 'BULL' ? kalmanVelocity >= TRADE_ENTRY_VEL_MIN : kalmanVelocity <= -TRADE_ENTRY_VEL_MIN
  if (!velOk) return

  // Flow: CD must not be actively opposing (strong counter-flow)
  if (flow) {
    const cdStronglyOpposes = dir === 'BULL' ? flow.cdZScore < -0.8 : flow.cdZScore > 0.8
    if (cdStronglyOpposes) return
  }

  // V2 must agree (skip gate if V2 still warming)
  if (v2.prediction.status === 'ready' && v2.prediction.direction && v2.prediction.direction !== dir) return

  const utcH = new Date(now).getUTCHours()
  const sessionKey = getBTCSession(utcH)

  ps.activeTrade = {
    id:            String(now),
    openTs:        now,
    openTime:      utcTimeStr(now),
    closeTs:       null,
    closeTime:     null,
    dir,
    entrySpot:     spot,
    closeSpot:     null,
    pnlPct:        null,
    peakPct:       0,
    exitReason:    null,
    entryVel:      kalmanVelocity,
    entryConf:     composite.confidence,
    entryBullProb: composite.bullProb,
    entryCdZ:      flow?.cdZScore ?? 0,
    sessionKey,
  }
  persistTrades(ps)
}

function updateActiveTrade(
  ps:             BTCProductState,
  spot:           number,
  kalmanVelocity: number,
  composite:      BTCComposite,
  now:            number,
): void {
  const trade = ps.activeTrade
  if (!trade) return

  const sign   = trade.dir === 'BULL' ? 1 : -1
  const pnlPct = ((spot - trade.entrySpot) / trade.entrySpot) * 100 * sign
  if (pnlPct > trade.peakPct) trade.peakPct = pnlPct

  let exitReason: BTCTradeEntry['exitReason'] = null

  // Hard stop
  if (pnlPct <= -TRADE_STOP_PCT) {
    exitReason = 'stop'
    ps.velRevConsec = 0
  }
  // Trail: once peak threshold met, exit on sufficient drawdown from peak
  else if (trade.peakPct >= TRADE_TRIG_PCT && pnlPct < trade.peakPct * TRADE_TRAIL_PCT) {
    exitReason = 'trail'
    ps.velRevConsec = 0
  }
  else {
    // Velocity reversal: velocity strongly opposing for N consecutive checks
    const velOpposes = trade.dir === 'BULL' ? kalmanVelocity <= -TRADE_VEL_REV_EXIT
                                             : kalmanVelocity >= TRADE_VEL_REV_EXIT
    if (velOpposes) {
      ps.velRevConsec++
      if (ps.velRevConsec >= TRADE_VEL_REV_CONSEC) {
        exitReason = 'vel_rev'
        ps.velRevConsec = 0
      }
    } else {
      ps.velRevConsec = 0
    }

    // Pattern flip: composite turned against us with conviction
    if (!exitReason && composite.direction && composite.direction !== trade.dir && composite.confidence >= 0.40) {
      exitReason = 'pat_flip'
    }

    // Time stop
    if (!exitReason && (now - trade.openTs) / 60_000 >= TRADE_MAX_HOLD_MIN) {
      exitReason = 'time'
    }
  }

  if (exitReason) {
    trade.closeTs     = now
    trade.closeTime   = utcTimeStr(now)
    trade.closeSpot   = spot
    trade.pnlPct      = pnlPct
    trade.exitReason  = exitReason
    ps.tradeLog.push({ ...trade })
    if (ps.tradeLog.length > MAX_TRADE_LOG) ps.tradeLog = ps.tradeLog.slice(-MAX_TRADE_LOG)
    ps.activeTrade       = null
    ps.lastTradeCloseTs  = now
    persistTrades(ps)
  }
}

// ── Main Entry Point ──────────────────────────────────────────────────────────

export async function getBitcoinState(): Promise<BitcoinState> {
  startBackgroundAccumulator()
  const ps    = getState()
  const store = ps.store
  ensureLoaded(ps)
  ensurePatternsV2Loaded(ps)

  const now     = Date.now()
  const utcHour = new Date(now).getUTCHours()
  const sessionKey = getBTCSession(utcHour)
  const utcDate = new Date(now).toISOString().slice(0, 10)

  // ── WebSocket (start/maintain connection) ──
  ensureWsConnected(ps)

  // ── Warm indicators on first call ──
  if (!ps.engineWarmed) {
    if (!ps.warmingPromise) {
      ps.warmingPromise = warmIndicators(ps).finally(() => { ps.warmingPromise = null })
    }
    await ps.warmingPromise
  }

  // ── Depth: prefer live WS snapshot, fall back to REST only if WS not yet warm ──
  const depth = ps.wsDepth ?? await fetchDepth()

  // ── Spot from depth ──
  let spot = 0
  if (depth && depth.buy.length > 0 && depth.sell.length > 0) {
    spot = (depth.buy[0].price + depth.sell[0].price) / 2
  }
  if (spot <= 0) return emptyState()

  // ── Funding + OI (cached 10s) ──
  if (now - ps.lastFundingTs > FUNDING_OI_CACHE_MS) {
    ps.lastFundingTs = now
    fetchPremiumIndex().then(r => {
      if (r) { ps.lastFundingRate = r.fundingRate; ps.lastMarkPrice = r.markPrice }
    }).catch(() => {})
    fetchOpenInterest().then(r => {
      if (r != null) ps.lastOpenInterest = r
    }).catch(() => {})
  }

  // ── Agg trades → flow state (consume WS buffer; REST fallback on first call before WS warms) ──
  const trades = ps.wsNewTrades.length > 0
    ? ps.wsNewTrades.splice(0)
    : (ps.wsConnected ? [] : await fetchAggTrades())
  if (trades.length > 0) updateFlowState(ps, trades, now)
  const flowState: BTCFlowState | null = ps.lastFlowState
    ?? (ps.lastFlowStateAt > 0 && now - ps.lastFlowStateAt < 5 * 60_000 ? ps.lastFlowState : null)

  // ── Deribit OI (cached 60s) ──
  if (now - ps.lastDeribitTs > DERIBIT_CACHE_MS) {
    ps.lastDeribitTs = now
    fetchDeribitOI(spot).then(r => { if (r) ps.lastDeribitData = r }).catch(() => {})
  }

  // ── Indicators ──
  const volume = trades.reduce((s, t) => s + t.qty, 0)
  const ind    = ps.indicatorEngine.update(now, spot, volume)

  // ── Session tracking (UTC day boundary) ──
  if (store.sessionDay !== utcDate) {
    store.sessionDay  = utcDate
    store.sessionHigh = spot
    store.sessionLow  = spot
    store.snapshots   = []
    store.priceHistory = []
    ps.kalman = { x: [0, 0], P: [[100, 0], [0, 1]], initialised: false }
    ps.kalmanLastTs = 0
    ps.indicatorEngine = new IndicatorEngine({ emaShortPeriod: 9, emaLongPeriod: 21, rsiPeriod: 14, atrPeriod: 14 })
    persistPatterns(ps)
  }
  if (spot > store.sessionHigh) store.sessionHigh = spot
  if (spot < store.sessionLow || store.sessionLow === 0) store.sessionLow = spot

  store.priceHistory.push({ ts: now, price: spot })
  store.priceHistory = store.priceHistory.filter(p => p.ts >= now - 10 * 60_000)
  const price1mAgo  = store.priceHistory.findLast(p => p.ts <= now - 60_000)?.price ?? spot
  const price5mAgo  = store.priceHistory.findLast(p => p.ts <= now - 5 * 60_000)?.price ?? spot
  const momentum1m  = price1mAgo > 0 ? (spot - price1mAgo) / price1mAgo : 0
  const momentum5m  = price5mAgo > 0 ? (spot - price5mAgo) / price5mAgo : 0
  const rangePosition = store.sessionHigh > store.sessionLow
    ? (spot - store.sessionLow) / (store.sessionHigh - store.sessionLow) : 0.5

  const technicals: BTCTechnicals = {
    rsi:       ind.rsi,
    emaShort:  ind.emaShort,
    emaLong:   ind.emaLong,
    emaCrossover: ind.emaShort != null && ind.emaLong != null
      ? ind.emaShort > ind.emaLong ? 'BULL' : ind.emaShort < ind.emaLong ? 'BEAR' : null : null,
    vwap:      ind.vwap,
    vwapAlign: ind.vwap != null ? (spot > ind.vwap ? 'BULL' : spot < ind.vwap ? 'BEAR' : null) : null,
    atr:       ind.atr,
    atrPct:    ind.atrPct,
    momentum1m, momentum5m,
    sessionHigh: store.sessionHigh, sessionLow: store.sessionLow, rangePosition,
  }

  // ── Kalman ──
  const dtMin = ps.kalmanLastTs > 0 ? (now - ps.kalmanLastTs) / 60_000 : 1
  kalmanUpdate(ps.kalman, spot, dtMin)
  ps.kalmanLastTs = now
  const kalmanVelocity = ps.kalman.x[1]

  // ── Feature vectors ──
  const cdZScore = flowState?.cdZScore ?? 0
  const vec   = buildFeatureVectorV1(spot, ind, technicals, depth, cdZScore)
  const vecV2 = buildFeatureVectorV2(spot, ind, technicals, utcHour, flowState, depth, kalmanVelocity)

  // ── Snapshots + patterns (24/7 — every 60s) ──
  if (now - store.lastSnapshotTs >= SNAPSHOT_INTERVAL_MS) {
    store.snapshots.push({ ts: now, vec, price: spot })
    if (store.snapshots.length > MAX_SNAPSHOTS) store.snapshots = store.snapshots.slice(-MAX_SNAPSHOTS)
    store.lastSnapshotTs = now

    store.patterns.push({ ts: now, vec, price: spot, outcome5: null, outcome15: null, outcome20: null })
    if (store.patterns.length > MAX_PATTERNS) store.patterns = store.patterns.slice(-MAX_PATTERNS)
  }
  resolveOutcomes(store)

  // ── V2 patterns ──
  if (now - ps.lastV2SnapshotTs >= SNAPSHOT_INTERVAL_MS) {
    ps.lastV2SnapshotTs = now
    const buf = ps.patternsV2[sessionKey]
    buf.push({ ts: now, vec: vecV2, price: spot, sessionKey, sessionDay: utcDate,
      outcome5: null, outcome15: null, outcome20: null })
    if (buf.length > MAX_PATTERNS_V2) ps.patternsV2[sessionKey] = buf.slice(-MAX_PATTERNS_V2)
  }
  resolveOutcomesV2(ps.patternsV2[sessionKey], store.snapshots)

  const predV2 = queryAttention(vecV2, ps.patternsV2[sessionKey], MIN_PATTERNS_V2)

  if (now - ps.patternsV2LastPersistTs >= V2_PERSIST_INTERVAL_MS) persistPatternsV2(ps)

  const v2: BTCV2 = {
    prediction:          predV2,
    sessionKey,
    sessionPatternCount: ps.patternsV2[sessionKey].filter(p => p.outcome20 !== null).length,
    flowState,
    featureVec:          vecV2,
    kalmanVelocity,
  }

  // ── V1 prediction + composite ──
  const prediction = queryAttention(vec, store.patterns, MIN_PATTERNS)
  const composite  = computeComposite(prediction, technicals)

  if (now - store.lastPersistTs >= PERSIST_INTERVAL_MS) persistPatterns(ps)

  const sysLog = updateSysLog(ps, composite, spot, kalmanVelocity)

  // Trade management
  ensureTradesLoaded(ps)
  updateActiveTrade(ps, spot, kalmanVelocity, composite, now)
  checkTradeEntry(ps, composite, v2, flowState, kalmanVelocity, spot, now)

  const minutesAccumulated = store.snapshots.length > 1
    ? Math.round((store.snapshots[store.snapshots.length - 1].ts - store.snapshots[0].ts) / 60_000)
    : 0

  return {
    spot,
    markPrice:    ps.lastMarkPrice,
    fundingRate:  ps.lastFundingRate,
    openInterest: ps.lastOpenInterest,
    prediction,
    technicals,
    composite,
    snapshotCount: store.snapshots.length,
    patternCount:  store.patterns.length,
    resolvedCount: store.patterns.filter(p => p.outcome20 !== null).length,
    minutesAccumulated,
    sysLog,
    oiAnalytics:  ps.lastDeribitData,
    flow:         flowState,
    v2,
    depth,
    symbol:       'BTCUSDC',
    activeTrade:  ps.activeTrade ? { ...ps.activeTrade } : null,
    tradeLog:     ps.tradeLog.slice(-20).reverse(),
  }
}

// ── Background accumulator ────────────────────────────────────────────────────

let _bgStarted = false

function startBackgroundAccumulator() {
  if (_bgStarted) return
  _bgStarted = true
  setInterval(async () => {
    try { await getBitcoinState() } catch { /* ignore */ }
  }, 60_000)
}

function emptyState(): BitcoinState {
  const emptyPred: BTCPrediction = {
    predictedMove: 0, bullProb: 0.5, bearProb: 0.5,
    topSim: 0, confidence: 0, nResolved: 0,
    direction: null, status: 'no_data', h5: null, h15: null, h20: null,
  }
  return {
    spot: 0, markPrice: null, fundingRate: null, openInterest: null,
    prediction: emptyPred,
    technicals: { rsi: null, emaShort: null, emaLong: null, emaCrossover: null,
      vwap: null, vwapAlign: null, atr: null, atrPct: null,
      momentum1m: 0, momentum5m: 0, sessionHigh: 0, sessionLow: 0, rangePosition: 0.5 },
    composite: { predictedMove: 0, bullProb: 0.5, bearProb: 0.5, direction: null, confidence: 0,
      status: 'no_data', components: { patternWeight: 0, techWeight: 0, patternBullProb: 0.5, techBullScore: 0.5 } },
    snapshotCount: 0, patternCount: 0, resolvedCount: 0, minutesAccumulated: 0,
    sysLog: [], oiAnalytics: null, flow: null, v2: null, depth: null, symbol: 'BTCUSDC',
    activeTrade: null, tradeLog: [],
  }
}
