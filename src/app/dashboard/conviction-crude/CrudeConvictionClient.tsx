'use client'
import { useEffect, useState, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import ThemeToggle from '@/components/ThemeToggle'
import DraggablePanelLayout, { type PanelDef } from '@/components/DraggablePanelLayout'

// ── Types ─────────────────────────────────────────────────────────────────────

interface HorizonPrediction {
  predictedMove: number
  bullProb: number
  bearProb: number
}

interface CrudePrediction {
  predictedMove: number
  bullProb: number
  bearProb: number
  topSim: number
  confidence: number
  nResolved: number
  direction: 'BULL' | 'BEAR' | null
  status: 'ready' | 'warming' | 'no_data'
  h5: HorizonPrediction | null
  h15: HorizonPrediction | null
  h20: HorizonPrediction | null
}

interface CrudeTechnicals {
  rsi: number | null
  emaShort: number | null
  emaLong: number | null
  emaCrossover: 'BULL' | 'BEAR' | null
  vwap: number | null
  vwapAlign: 'BULL' | 'BEAR' | null
  atr: number | null
  atrPct: number | null
  momentum1m: number
  momentum5m: number
  sessionHigh: number
  sessionLow: number
  rangePosition: number
  volume: number
  oi: number
}

interface CrudeComposite {
  predictedMove: number
  bullProb: number
  bearProb: number
  direction: 'BULL' | 'BEAR' | null
  confidence: number
  status: 'ready' | 'warming' | 'no_data'
  components: {
    patternWeight: number
    techWeight: number
    patternBullProb: number
    techBullScore: number
  }
}

interface CrudeOption {
  tradingsymbol: string
  instrumentToken: number
  strike: number
  expiry: string
  instrumentType: 'CE' | 'PE'
  product: string
}

interface OIStrike {
  strike: number
  callOI: number
  putOI: number
  callLTP: number
  putLTP: number
  callVol: number
  putVol: number
  painAtStrike: number
}

interface OIAnalytics {
  maxPainStrike: number
  maxPainPull?: number
  pcr: number
  totalCallOI: number
  totalPutOI: number
  strikes: OIStrike[]
}

interface CrudeChain {
  calls: CrudeOption[]
  puts: CrudeOption[]
  spotEstimate: number
  expiry: string
  product: string
  lotSize: number
  strikeStep: number
  atmStrike: number
  oiAnalytics?: OIAnalytics
}

interface SysLogExtend {
  ts: number
  cycleTime: string
  spotAtExtend: number
  prevPredMove: number
}

interface SysLogEntry {
  cycleTs: number
  cycleTime: string
  predMove: number
  predDir: 'BULL' | 'BEAR' | null
  predConf: number
  predBullProb: number
  predBearProb: number
  spotAtPred: number
  predSpot: number
  outcomeMove: number | null
  outcomeDir: 'BULL' | 'BEAR' | null
  spotAtOutcome: number | null
  resolved: boolean
  correct: boolean | null
  sessionDay: string
  peakMove?: number | null
  targetHit?: boolean
  targetHitTs?: number | null
  liveMove?: number | null
  liveSpot?: number | null
  optStrike?: number | null
  optType?: 'CE' | 'PE' | null
  optSymbol?: string | null
  optEntry?: number | null
  optTarget?: number | null
  originalOptEntry?: number | null
  repeatCount?: number
  extends?: SysLogExtend[]
}

interface Pat20Con {
  smoothed: number
  effective: number
  velocity: number
  acceleration: number
  direction: 'BULL' | 'BEAR' | null
  strength: number
}

interface P20CSwingEntry {
  id: number
  startTs: number
  startTime: string
  direction: 'BULL' | 'BEAR'
  scaledAtStart: number
  spotAtStart: number
  sessionDay: string
  optStrike: number | null
  optType: 'CE' | 'PE' | null
  optSymbol: string | null
  optEntry: number | null
  resolved: boolean
  endTs: number | null
  endTime: string | null
  scaledAtEnd: number | null
  spotAtEnd: number | null
  durationMin: number | null
  outcomeMove: number | null
  correct: boolean | null
  optExit: number | null
  pnlGross: number | null
  pnlNet: number | null
}

interface EWPivot {
  ts: number
  price: number
  type: 'H' | 'L'
  wave: string
  timeStr: string
}

interface EWLevel {
  price: number
  label: string
  role: 'support' | 'resistance' | 'target'
}

interface ElliottWaveState {
  pattern: 'IMPULSE_BULL' | 'IMPULSE_BEAR' | 'CORRECTIVE_BULL' | 'CORRECTIVE_BEAR' | 'UNKNOWN'
  currentWave: string
  pivots: EWPivot[]
  levels: EWLevel[]
  primaryTarget: number | null
  invalidation: number | null
  confidence: number
  combinedBias: 'STRONG_BULL' | 'BULL' | 'NEUTRAL' | 'BEAR' | 'STRONG_BEAR'
  combinedNote: string
  updatedAt: number
}

interface DepthLevel {
  price: number
  quantity: number
  orders: number
}

interface MetaRegimeData {
  regime: 'ACCUMULATION' | 'MARKUP' | 'DISTRIBUTION' | 'MARKDOWN' | 'CHOP' | 'UNKNOWN'
  confidence: number
  avgCdZ: number
  avgObi: number
  divergenceScore: number
  momentumSlope: number
}

interface CrudeFlowState {
  cumDelta:        number
  cdZScore:        number
  aggressionRatio: number
  cusumPos:        number
  cusumNeg:        number
  cusumAlarm:      'BULL' | 'BEAR' | null
}

type MCXSession = 'morning' | 'afternoon' | 'evening'

interface CrudeV2 {
  prediction:          CrudePrediction
  sessionKey:          MCXSession
  sessionPatternCount: number
  flowState:           CrudeFlowState | null
  featureVec:          number[]
  kalmanVelocity:      number
}

interface CrudeState {
  prediction: CrudePrediction
  technicals: CrudeTechnicals
  composite: CrudeComposite
  snapshotCount: number
  patternCount: number
  resolvedCount: number
  proxy: number
  minutesAccumulated: number
  sysLog: SysLogEntry[]
  chain: CrudeChain | null
  spot: number
  futureSymbol: string
  futureToken: number
  product: string
  marketOpen: boolean
  pat20Con?: Pat20Con | null
  p20cSysLog?: P20CSwingEntry[]
  elliottWave?: ElliottWaveState | null
  elliottWaveByTF?: Partial<Record<string, ElliottWaveState>>
  metaRegime?: MetaRegimeData | null
  v2?: CrudeV2 | null
  depth?: {
    buy: DepthLevel[]
    sell: DepthLevel[]
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtPct(v: number, decimals = 2): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(decimals)}%`
}

interface KalmanBiasState {
  bias: number; P: number; innovVar: number
  correctedMove: number; sigma: number
  nResolved: number; rmse: number; hitRate: number
}
function computeKalmanBias(sysLog: SysLogEntry[], rawPredMove: number): KalmanBiasState | null {
  const resolved = [...sysLog].filter(e => e.resolved && e.outcomeMove != null).sort((a, b) => a.cycleTs - b.cycleTs)
  if (resolved.length < 5) return null
  const Q = 1e-5; let x = 0, P = 0.01, innovVarEMA = 0.04
  const alpha = 0.25; let sumSq = 0, hitCount = 0
  for (const e of resolved) {
    const innov = e.outcomeMove! - e.predMove
    innovVarEMA = alpha * innov * innov + (1 - alpha) * innovVarEMA
    const R = Math.max(innovVarEMA, 1e-5)
    const Ppred = P + Q; const K = Ppred / (Ppred + R)
    x = x + K * (innov - x); P = (1 - K) * Ppred
    sumSq += innov * innov
    if (Math.abs(innov) < 0.3) hitCount++
  }
  const n = resolved.length; const R = Math.max(innovVarEMA, 1e-5)
  return { bias: x, P, innovVar: R, correctedMove: rawPredMove + x, sigma: Math.sqrt(P + R), nResolved: n, rmse: Math.sqrt(sumSq / n), hitRate: hitCount / n }
}

function fmtNum(v: number, decimals = 1): string {
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)}K`
  return v.toFixed(decimals)
}

function dirColor(dir: 'BULL' | 'BEAR' | null): string {
  if (dir === 'BULL') return 'var(--bull)'
  if (dir === 'BEAR') return 'var(--bear)'
  return 'var(--text3)'
}

const KNN_K_DISPLAY = 20

function dirArrow(dir: 'BULL' | 'BEAR' | null): string {
  if (dir === 'BULL') return '▲'
  if (dir === 'BEAR') return '▼'
  return '·'
}

// ── Estimate option Greeks from moneyness ─────────────────────────────────────

function estimateGreeks(spot: number, strike: number, type: 'CE' | 'PE', expiry: string, lotSize: number) {
  const now = Date.now()
  // MCX options expire at 17:00 IST (not 15:30 like NSE)
  const expiryDate = new Date(expiry + 'T17:00:00+05:30')
  const dte = Math.max(0, Math.ceil((expiryDate.getTime() - now) / 86400_000))
  const moneyness = type === 'CE' ? (spot - strike) / spot : (strike - spot) / spot

  // Delta estimation with DTE influence — sharper near expiry
  const dteFactor = Math.max(0.3, Math.min(1, Math.sqrt(dte / 30)))
  let absDelta = 0.5 + moneyness * (2 / dteFactor)
  absDelta = Math.max(0.05, Math.min(0.95, absDelta))

  // Convention: CE delta is positive, PE delta is negative
  const delta = type === 'PE' ? -absDelta : absDelta

  // Per-point sensitivity (always positive — magnitude of P&L per ₹1 underlying move)
  const perPoint = absDelta * lotSize

  const intrinsic = type === 'CE' ? Math.max(0, spot - strike) : Math.max(0, strike - spot)
  const itm = intrinsic > 0

  return { delta, absDelta, perPoint, dte, intrinsic, itm, moneyness }
}

// ── Dark terminal theme — color reserved for directional data only ────────────

const CYB = {
  // Structural UI — dark/muted, no color bleed
  glow: 'rgba(255,255,255,0.35)',       // dim label text (headers, section tags)
  glowDim: 'rgba(255,255,255,0.04)',    // subtle highlight bg (active toggle, status)
  glowBorder: 'rgba(255,255,255,0.08)', // barely-visible panel borders
  panel: 'rgba(0,0,0,0.25)',            // dark panel background
  scanline: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.01) 2px, rgba(255,255,255,0.01) 4px)',
  // Directional — only for oracle predictions & OI signals
  redGlow: '#ff003c',
  redDim: 'rgba(255,0,60,0.12)',
  accent: '#00ff9f',                    // used ONLY for prediction confidence / target-hit
  accentDim: 'rgba(0,255,159,0.12)',
}

// ── Components ────────────────────────────────────────────────────────────────

function OraclePanel({ state, role = 'admin' }: { state: CrudeState; role?: string }) {
  const { composite, prediction, technicals: tech, pat20Con } = state
  const kb = role !== 'viewer' ? computeKalmanBias(state.sysLog, composite.predictedMove) : null
  const dir: 'BULL' | 'BEAR' | null = composite.predictedMove > 0 ? 'BULL' : composite.predictedMove < 0 ? 'BEAR' : null
  const bullPct = Math.round(composite.bullProb * 100)
  const bearPct = 100 - bullPct
  const compColor = dir === 'BULL' ? 'var(--bull)' : dir === 'BEAR' ? 'var(--bear)' : 'var(--text3)'

  return (
    <div style={{
      background: CYB.panel,
      border: `1px solid ${CYB.glowBorder}`,
      borderRadius: '6px',
      padding: '12px',
      backgroundImage: CYB.scanline,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '8px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
          <span style={{ fontSize: '8px', fontWeight: 700, color: CYB.glow, letterSpacing: '0.15em' }}>{'//ORACLE'}</span>
          <span style={{ fontSize: '9px', color: 'var(--text3)' }}>{state.minutesAccumulated}m</span>
          {state.metaRegime && <RegimeBadgeCrude data={state.metaRegime} compact />}
        </div>
        {state.spot > 0 && (() => {
          const sym = state.futureSymbol
          const monthMatch = sym.match(/\d{2}([A-Z]{3})FUT$/)
          const month = monthMatch ? monthMatch[1] : ''
          const name = sym.replace(/\d{2}[A-Z]{3}FUT$/, '')
          return (
            <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.02em' }}>
              {name}
              {month && <span style={{ fontSize: '9px', fontWeight: 600, color: 'var(--text3)', marginLeft: '3px' }}>{month}FUT</span>}
              {' '}₹{state.spot.toFixed(0)}
              {' '}
              <span style={{
                fontSize: '10px', fontWeight: 600,
                color: state.proxy >= 0 ? 'var(--bull)' : 'var(--bear)',
              }}>
                {fmtPct(state.proxy)}
              </span>
            </span>
          )
        })()}
      </div>

      {composite.status === 'ready' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{
              fontSize: '8px', color: CYB.glow, letterSpacing: '0.1em', width: '48px', fontWeight: 700,
            }}>20M</span>
            <span style={{
              fontSize: '14px', fontWeight: 700, color: compColor,
              padding: '2px 10px', borderRadius: '3px',
              background: dir === 'BULL' ? 'rgba(34,197,94,0.14)' : dir === 'BEAR' ? 'rgba(239,68,68,0.14)' : 'rgba(255,255,255,0.05)',
              border: `1px solid ${dir === 'BULL' ? 'rgba(34,197,94,0.3)' : dir === 'BEAR' ? 'rgba(239,68,68,0.3)' : 'var(--border)'}`,
            }}>
              {(Math.abs(composite.predictedMove) < 0.01 && composite.confidence < 0.5) ? '·' : dirArrow(dir)} {fmtPct(composite.predictedMove, 3)}
              {state.spot > 0 && (
                <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text2)', marginLeft: '6px' }}>
                  → {(state.spot * (1 + composite.predictedMove / 100)).toFixed(0)}
                </span>
              )}
            </span>
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '4px', minWidth: '80px' }}>
              <span style={{ fontSize: '9px', fontWeight: 600, color: 'var(--bull)', width: '24px', textAlign: 'right' }}>{bullPct}</span>
              <div style={{ flex: 1, height: '6px', borderRadius: '3px', background: 'var(--bg3)', display: 'flex', overflow: 'hidden', minWidth: '40px' }}>
                <div style={{ width: `${bullPct}%`, background: 'var(--bull)', transition: 'width 0.3s' }} />
                <div style={{ width: `${bearPct}%`, background: 'var(--bear)', transition: 'width 0.3s' }} />
              </div>
              <span style={{ fontSize: '9px', fontWeight: 600, color: 'var(--bear)', width: '24px' }}>{bearPct}</span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '10px', fontSize: '8px', color: 'var(--text3)', paddingLeft: '56px', flexWrap: 'wrap' }}>
            <span>conf <span style={{ color: 'var(--text2)', fontWeight: 600 }}>{Math.round(composite.confidence * 100)}%</span></span>
            <span>pat <span style={{ color: CYB.glow, fontWeight: 600 }}>{Math.round(composite.components.patternWeight * 100)}%</span></span>
            <span>tech <span style={{ color: CYB.glow, fontWeight: 600 }}>{Math.round(composite.components.techWeight * 100)}%</span></span>
            <span>proxy <span style={{ color: state.proxy >= 0 ? 'var(--bull)' : 'var(--bear)', fontWeight: 600 }}>{fmtPct(state.proxy)}</span></span>
            {pat20Con && (() => {
              const scaled = (pat20Con.effective - 0.5) * 2
              const col = scaled > 0.08 ? 'var(--bull)' : scaled < -0.08 ? 'var(--bear)' : 'var(--text3)'
              const glyph = scaled > 0.08 ? '▲' : scaled < -0.08 ? '▼' : '·'
              return (
                <span>20con <span style={{ color: col, fontWeight: 600 }}>{glyph}{scaled >= 0 ? '+' : ''}{scaled.toFixed(2)}</span></span>
              )
            })()}
          </div>
        </div>
      ) : (
        <div style={{ fontSize: '10px', color: CYB.glow, padding: '4px 0', opacity: 0.6 }}>
          {'> '}{composite.status === 'warming'
            ? `WARMING — ${state.resolvedCount}/10 resolved · ${state.snapshotCount} snapshots`
            : `ACCUMULATING... ${state.snapshotCount} snapshots · ${state.patternCount} patterns`}
        </div>
      )}

      {/* Kalman bias calibration (admin only) */}
      {kb && (
        <div style={{ marginTop: '6px', padding: '6px 8px', borderRadius: '4px', background: 'rgba(0,0,0,0.15)', border: `1px solid ${CYB.glowBorder}`, fontSize: '9px', display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
          <span style={{ color: CYB.glow, letterSpacing: '0.1em', fontWeight: 700 }}>{'//KALMAN'}</span>
          <span style={{ color: 'var(--text2)' }}>
            adj <span style={{ color: kb.correctedMove > 0 ? 'var(--bull)' : kb.correctedMove < 0 ? 'var(--bear)' : 'var(--text3)', fontWeight: 700 }}>{fmtPct(kb.correctedMove, 3)}</span>
          </span>
          <span style={{ color: kb.bias > 0.01 ? 'var(--bull)' : kb.bias < -0.01 ? 'var(--bear)' : 'var(--text3)' }}>
            bias {fmtPct(kb.bias, 3)} {Math.abs(kb.bias) > 0.01 ? (kb.bias > 0 ? '·cold' : '·hot') : '·'}
          </span>
          <span style={{ color: 'var(--text3)' }}>σ=±{kb.sigma.toFixed(3)}%</span>
          <span style={{ color: 'var(--text3)' }}>rmse={fmtPct(kb.rmse, 3)}</span>
          <span style={{ color: 'var(--text3)' }}>hit={Math.round(kb.hitRate * 100)}%</span>
          <span style={{ color: 'var(--text3)' }}>n={kb.nResolved}</span>
        </div>
      )}
      {!kb && role !== 'viewer' && composite.status === 'ready' && (
        <div style={{ marginTop: '4px', fontSize: '9px', color: 'var(--text3)' }}>
          {'//KALMAN'} calibrating — {state.sysLog.filter(e => e.resolved).length}/5 resolved
        </div>
      )}

      {/* Multi-horizon pattern predictions (Q·K→V attention) */}
      {prediction.status === 'ready' && (prediction.h5 || prediction.h15 || prediction.h20) && (
        <div style={{
          marginTop: '8px', padding: '8px 10px', borderRadius: '4px',
          background: 'rgba(0,0,0,0.15)', border: `1px solid ${CYB.glowBorder}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '6px' }}>
            <span style={{ fontSize: '9px', color: CYB.glow, letterSpacing: '0.15em', opacity: 0.5, fontWeight: 700 }}>{'//ATT'}</span>
            {role !== 'viewer' && (
              <span style={{ fontSize: '9px', color: 'var(--text3)' }}>
                sim:{prediction.topSim.toFixed(2)} k={Math.min(KNN_K_DISPLAY, prediction.nResolved)} n={prediction.nResolved}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {([['PAT-5M', prediction.h5], ['PAT-15M', prediction.h15], ['PAT-20M', prediction.h20]] as [string, HorizonPrediction | null][]).map(([label, h]) => {
              if (!h) return <div key={label} style={{ fontSize: '11px', color: 'var(--text3)', fontFamily: 'monospace' }}>{label}: —</div>
              const hBull = Math.round(h.bullProb * 100)
              const hBear = 100 - hBull
              const hDir = hBull > hBear ? 'BULL' : 'BEAR'
              const pct = Math.max(hBull, hBear)
              const hColor = hDir === 'BULL' ? 'var(--bull)' : 'var(--bear)'
              return (
                <div key={label} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', fontFamily: 'monospace' }}>
                  <span style={{ width: '58px', color: 'var(--text3)', flexShrink: 0, fontSize: '10px' }}>{label}</span>
                  <div style={{ width: '70px', height: '5px', background: 'var(--bg3)', borderRadius: '3px', overflow: 'hidden', flexShrink: 0, display: 'flex' }}>
                    <div style={{ width: `${hBull}%`, height: '100%', background: 'var(--bull)' }} />
                    <div style={{ width: `${hBear}%`, height: '100%', background: 'var(--bear)' }} />
                  </div>
                  <span style={{ color: hColor, fontWeight: 700, minWidth: '40px' }}>
                    {hDir === 'BULL' ? '▲' : '▼'}{pct}%
                  </span>
                  <span style={{ color: h.predictedMove >= 0 ? 'var(--bull)' : 'var(--bear)', fontWeight: 600 }}>
                    {fmtPct(h.predictedMove, 3)}
                  </span>
                  {state.spot > 0 && (
                    <span style={{ color: 'var(--text3)', fontSize: '10px' }}>
                      →{(state.spot * (1 + h.predictedMove / 100)).toFixed(0)}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Technicals grid */}
      <div style={{
        marginTop: '8px', padding: '6px 8px', borderRadius: '4px',
        background: 'rgba(0,0,0,0.15)', border: `1px solid ${CYB.glowBorder}`,
      }}>
        <div style={{ fontSize: '7px', color: CYB.glow, letterSpacing: '0.15em', opacity: 0.5, marginBottom: '4px' }}>{'//TECHNICALS'}</div>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(85px, 1fr))',
          gap: '4px', fontSize: '10px', fontFamily: 'monospace',
        }}>
          <TechChip label="RSI" value={tech.rsi != null ? tech.rsi.toFixed(0) : '—'}
            color={tech.rsi != null ? (tech.rsi > 60 ? 'var(--bull)' : tech.rsi < 40 ? 'var(--bear)' : 'var(--text2)') : 'var(--text3)'} />
          <TechChip label="EMA" value={tech.emaCrossover ?? '—'} color={dirColor(tech.emaCrossover)} />
          <TechChip label="VWAP" value={tech.vwapAlign ?? '—'} color={dirColor(tech.vwapAlign)} />
          <TechChip label="ATR%" value={tech.atrPct != null ? tech.atrPct.toFixed(2) + '%' : '—'} color="var(--text2)" />
          <TechChip label="MOM1" value={fmtPct(tech.momentum1m * 100, 2)}
            color={tech.momentum1m > 0 ? 'var(--bull)' : tech.momentum1m < 0 ? 'var(--bear)' : 'var(--text3)'} />
          <TechChip label="MOM5" value={fmtPct(tech.momentum5m * 100, 2)}
            color={tech.momentum5m > 0 ? 'var(--bull)' : tech.momentum5m < 0 ? 'var(--bear)' : 'var(--text3)'} />
          <TechChip label="VOL" value={fmtNum(tech.volume)} color="var(--text2)" />
          <TechChip label="OI" value={fmtNum(tech.oi)} color="var(--text2)" />
        </div>
      </div>

      <div style={{ marginTop: '6px', fontSize: '8px', color: 'var(--text3)', fontFamily: 'monospace', opacity: 0.6 }}>
        {state.patternCount}pat ({state.resolvedCount}res) · {state.snapshotCount}snap
      </div>

      {/* Meta Regime */}
      {state.metaRegime && state.metaRegime.regime !== 'UNKNOWN' && (
        <div style={{ marginTop: '6px' }}>
          <div style={{ fontSize: '7px', color: CYB.glow, letterSpacing: '0.15em', opacity: 0.5, marginBottom: '4px' }}>{'//META_REGIME'}</div>
          <RegimeBadgeCrude data={state.metaRegime} />
        </div>
      )}
    </div>
  )
}

function TechChip({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{
      background: 'rgba(255,255,255,0.02)',
      borderRadius: '3px',
      padding: '3px 5px',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      border: '1px solid rgba(255,255,255,0.06)',
    }}>
      <span style={{ color: CYB.glow, fontSize: '8px', opacity: 0.5, letterSpacing: '0.05em' }}>{label}</span>
      <span style={{ color, fontWeight: 600, fontSize: '10px' }}>{value}</span>
    </div>
  )
}

// ── Regime helpers ────────────────────────────────────────────────────────────

const REGIME_EMOJI: Record<string, string> = {
  ACCUMULATION: '📦', MARKUP: '🚀', DISTRIBUTION: '📤', MARKDOWN: '📉', CHOP: '〰️', UNKNOWN: '❓',
}
const REGIME_SHORT: Record<string, string> = {
  ACCUMULATION: 'acc', MARKUP: 'mkp', DISTRIBUTION: 'dist', MARKDOWN: 'mkdn', CHOP: 'chop', UNKNOWN: '?',
}

function regimeColorCrude(regime: string): string {
  if (regime === 'ACCUMULATION' || regime === 'MARKUP') return 'var(--bull)'
  if (regime === 'DISTRIBUTION' || regime === 'MARKDOWN') return 'var(--bear)'
  return CYB.glow
}

function RegimeBadgeCrude({ data, compact = false }: { data: MetaRegimeData | null | undefined; compact?: boolean }) {
  if (!data || data.regime === 'UNKNOWN') return null
  const emoji = REGIME_EMOJI[data.regime] ?? '❓'
  const short = REGIME_SHORT[data.regime] ?? data.regime.toLowerCase()
  const conf  = Math.round(data.confidence * 100)
  const color = regimeColorCrude(data.regime)
  if (compact) {
    return (
      <span style={{ color, fontSize: '9px', fontWeight: 600, letterSpacing: '0.02em' }}>
        {emoji}{short}·{conf}%
      </span>
    )
  }
  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center',
      padding: '6px 8px', borderRadius: '4px',
      background: 'rgba(0,0,0,0.15)', border: `1px solid ${CYB.glowBorder}`,
      fontSize: '10px', fontFamily: 'monospace',
    }}>
      <span style={{ fontSize: '11px', fontWeight: 700, color }}>{emoji} {data.regime}</span>
      <span style={{ color: 'var(--text3)' }}>{conf}%</span>
      <span style={{ color: data.avgCdZ >= 0 ? 'var(--bull)' : 'var(--bear)' }}>
        mom:{data.avgCdZ >= 0 ? '+' : ''}{data.avgCdZ.toFixed(2)}
      </span>
      <span style={{ color: data.avgObi >= 0 ? 'var(--bull)' : 'var(--bear)' }}>
        obi:{data.avgObi >= 0 ? '+' : ''}{data.avgObi.toFixed(2)}
      </span>
      <span style={{ color: CYB.glow, opacity: 0.7 }}>div:{(data.divergenceScore * 100).toFixed(0)}%</span>
      <span style={{ color: data.momentumSlope >= 0 ? 'var(--bull)' : 'var(--bear)' }}>
        slope:{data.momentumSlope >= 0 ? '+' : ''}{(data.momentumSlope * 1000).toFixed(1)}‰
      </span>
    </div>
  )
}

function DepthPanel({ depth, spot }: { depth: CrudeState['depth']; spot: number }) {
  if (!depth) return (
    <div style={{ background: CYB.panel, border: `1px solid ${CYB.glowBorder}`, borderRadius: '6px', padding: '12px', backgroundImage: CYB.scanline }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', marginBottom: '8px' }}>
        <span style={{ fontSize: '8px', fontWeight: 700, color: CYB.glow, letterSpacing: '0.15em' }}>{'//DEPTH'}</span>
      </div>
      <div style={{ fontSize: '10px', color: CYB.glow, opacity: 0.6 }}>{'> AWAITING DEPTH FEED...'}</div>
    </div>
  )

  const maxQty = Math.max(
    ...depth.buy.map(l => l.quantity),
    ...depth.sell.map(l => l.quantity),
    1,
  )
  const totalBid = depth.buy.reduce((s, l) => s + l.quantity, 0)
  const totalAsk = depth.sell.reduce((s, l) => s + l.quantity, 0)
  const imb = totalBid + totalAsk > 0 ? ((totalBid - totalAsk) / (totalBid + totalAsk) * 100) : 0

  return (
    <div style={{
      background: CYB.panel,
      border: `1px solid ${CYB.glowBorder}`,
      borderRadius: '6px',
      padding: '12px',
      backgroundImage: CYB.scanline,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px', flexWrap: 'wrap', gap: '6px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
          <span style={{ fontSize: '8px', fontWeight: 700, color: CYB.glow, letterSpacing: '0.15em' }}>{'//DEPTH'}</span>
        </div>
        <span style={{
          fontSize: '9px', fontWeight: 700, fontFamily: 'monospace',
          color: imb > 5 ? 'var(--bull)' : imb < -5 ? 'var(--bear)' : 'var(--text3)',
        }}>
          OBI {imb >= 0 ? '+' : ''}{imb.toFixed(0)}%
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', fontSize: '10px', fontFamily: 'monospace' }}>
        <div>
          <div style={{ fontSize: '8px', color: CYB.glow, letterSpacing: '0.1em', opacity: 0.5, marginBottom: '4px' }}>BID</div>
          {depth.buy.slice(0, 5).map((l, i) => (
            <div key={i} style={{ position: 'relative', display: 'flex', gap: '4px', alignItems: 'center', marginBottom: '2px', padding: '1px 4px' }}>
              <div style={{
                position: 'absolute', left: 0, top: 0, bottom: 0,
                width: `${(l.quantity / maxQty) * 100}%`,
                background: 'rgba(34,197,94,0.12)',
                borderRadius: '2px', minWidth: '2px',
              }} />
              <span style={{ color: 'var(--bull)', minWidth: '44px', position: 'relative', fontSize: '10px' }}>{l.price.toFixed(0)}</span>
              <span style={{ color: 'var(--text3)', position: 'relative', fontSize: '10px' }}>{fmtNum(l.quantity, 0)}</span>
            </div>
          ))}
        </div>
        <div>
          <div style={{ fontSize: '8px', color: CYB.glow, letterSpacing: '0.1em', opacity: 0.5, marginBottom: '4px' }}>ASK</div>
          {depth.sell.slice(0, 5).map((l, i) => (
            <div key={i} style={{ position: 'relative', display: 'flex', gap: '4px', alignItems: 'center', marginBottom: '2px', padding: '1px 4px' }}>
              <div style={{
                position: 'absolute', left: 0, top: 0, bottom: 0,
                width: `${(l.quantity / maxQty) * 100}%`,
                background: 'rgba(239,68,68,0.12)',
                borderRadius: '2px', minWidth: '2px',
              }} />
              <span style={{ color: 'var(--bear)', minWidth: '44px', position: 'relative', fontSize: '10px' }}>{l.price.toFixed(0)}</span>
              <span style={{ color: 'var(--text3)', position: 'relative', fontSize: '10px' }}>{fmtNum(l.quantity, 0)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function ChainPanel({ chain, spot, product, role = 'admin' }: { chain: CrudeChain; spot: number; product: string; role?: string }) {
  const [orderStatus, setOrderStatus] = useState<string | null>(null)
  const oi = chain.oiAnalytics

  const handleOrder = async (sym: string, type: 'BUY' | 'SELL') => {
    if (!confirm(`${type} 1 lot ${sym}?`)) return
    setOrderStatus('placing...')
    try {
      const res = await fetch('/api/crude/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tradingsymbol: sym, transaction_type: type, product }),
      })
      const data = await res.json()
      if (data.success) {
        setOrderStatus(`${type} ${sym} @ ${data.price} — order ${data.order_id}`)
      } else {
        setOrderStatus(`ERR: ${data.error}`)
      }
    } catch (err) {
      setOrderStatus(`ERR: ${err instanceof Error ? err.message : 'failed'}`)
    }
    setTimeout(() => setOrderStatus(null), 8000)
  }

  const maxOI = oi ? Math.max(...oi.strikes.map(s => Math.max(s.callOI, s.putOI)), 1) : 1
  const pcrColor = oi ? (oi.pcr > 1.2 ? 'var(--bull)' : oi.pcr < 0.8 ? 'var(--bear)' : 'var(--text2)') : 'var(--text3)'
  const pcrSignal = oi ? (oi.pcr > 1.2 ? 'BULL' : oi.pcr < 0.8 ? 'BEAR' : 'NEUTRAL') : '—'

  return (
    <div style={{
      background: CYB.panel,
      border: `1px solid ${CYB.glowBorder}`,
      borderRadius: '6px',
      padding: '12px',
      backgroundImage: CYB.scanline,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px', flexWrap: 'wrap', gap: '6px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
          <span style={{ fontSize: '8px', fontWeight: 700, color: CYB.glow, letterSpacing: '0.15em' }}>{'//CHAIN_OI'}</span>
        </div>
        <span style={{ fontSize: '11px', color: 'var(--text3)', fontFamily: 'monospace' }}>
          exp {chain.expiry} · ATM {chain.atmStrike} · lot {chain.lotSize}
        </span>
      </div>

      {/* OI Analytics summary bar */}
      {oi && (
        <div style={{
          display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '8px',
          padding: '8px 10px', borderRadius: '4px',
          background: 'rgba(0,0,0,0.15)', border: `1px solid ${CYB.glowBorder}`,
          fontFamily: 'monospace', fontSize: '11px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
            <span style={{ color: CYB.glow, opacity: 0.5, fontSize: '9px', letterSpacing: '0.1em' }}>MAX PAIN</span>
            <span style={{ color: 'var(--text)', fontWeight: 700 }}>{oi.maxPainStrike}</span>
            <span style={{ color: 'var(--text3)', fontSize: '10px' }}>
              ({spot > oi.maxPainStrike ? '▼' : '▲'}{Math.abs(spot - oi.maxPainStrike).toFixed(0)}pt)
            </span>
            {oi.maxPainPull != null && oi.maxPainPull > 0 && (
              <span
                title="Pain gradient: % increase in option writer losses at adjacent strikes vs max pain. Higher = stronger gravitational pull."
                style={{
                  fontSize: '9px', fontWeight: 700, cursor: 'help',
                  color: oi.maxPainPull >= 20 ? CYB.accent : oi.maxPainPull >= 8 ? 'var(--text)' : 'var(--text3)',
                }}
              >
                pull:{oi.maxPainPull}%
              </span>
            )}
          </div>
          <span style={{ color: 'var(--border)' }}>|</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
            <span style={{ color: CYB.glow, opacity: 0.5, fontSize: '9px', letterSpacing: '0.1em' }}>PCR</span>
            <span style={{ color: pcrColor, fontWeight: 700 }}>{oi.pcr.toFixed(2)}</span>
            <span style={{ color: pcrColor, fontSize: '10px', fontWeight: 600 }}>{pcrSignal}</span>
          </div>
          <span style={{ color: 'var(--border)' }}>|</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
            <span style={{ color: 'var(--bull)', fontSize: '10px' }}>CE {fmtNum(oi.totalCallOI, 0)}</span>
            <span style={{ color: 'var(--text3)' }}>/</span>
            <span style={{ color: 'var(--bear)', fontSize: '10px' }}>PE {fmtNum(oi.totalPutOI, 0)}</span>
          </div>
        </div>
      )}

      {orderStatus && (
        <div style={{
          fontSize: '10px', padding: '4px 8px', borderRadius: '3px', marginBottom: '8px',
          background: orderStatus.startsWith('ERR') ? CYB.redDim : CYB.accentDim,
          color: orderStatus.startsWith('ERR') ? CYB.redGlow : CYB.accent,
          border: `1px solid ${orderStatus.startsWith('ERR') ? 'rgba(255,0,60,0.3)' : 'rgba(0,255,159,0.25)'}`,
          fontFamily: 'monospace',
        }}>
          {orderStatus}
        </div>
      )}

      {/* Chain header */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: oi ? '1fr 50px 50px auto 50px 50px 1fr' : '1fr auto 1fr',
        gap: '2px', fontSize: '12px', fontFamily: 'monospace',
      }}>
        {oi ? (
          <>
            <div style={{ color: 'var(--bull)', fontWeight: 700, textAlign: 'center', padding: '5px', fontSize: '10px', letterSpacing: '0.1em' }}>CE OI</div>
            <div style={{ color: 'var(--bull)', fontWeight: 700, textAlign: 'center', padding: '5px', fontSize: '10px', letterSpacing: '0.1em' }}>LTP</div>
            <div style={{ color: 'var(--bull)', fontWeight: 700, textAlign: 'center', padding: '5px', fontSize: '10px', letterSpacing: '0.1em' }}>VOL</div>
            <div style={{ color: CYB.glow, textAlign: 'center', padding: '5px', fontWeight: 700, fontSize: '10px', letterSpacing: '0.1em' }}>STRIKE</div>
            <div style={{ color: 'var(--bear)', fontWeight: 700, textAlign: 'center', padding: '5px', fontSize: '10px', letterSpacing: '0.1em' }}>VOL</div>
            <div style={{ color: 'var(--bear)', fontWeight: 700, textAlign: 'center', padding: '5px', fontSize: '10px', letterSpacing: '0.1em' }}>LTP</div>
            <div style={{ color: 'var(--bear)', fontWeight: 700, textAlign: 'center', padding: '5px', fontSize: '10px', letterSpacing: '0.1em' }}>PE OI</div>
          </>
        ) : (
          <>
            <div style={{ color: 'var(--bull)', fontWeight: 700, textAlign: 'center', padding: '5px', fontSize: '11px', letterSpacing: '0.1em' }}>CALLS</div>
            <div style={{ color: CYB.glow, textAlign: 'center', padding: '5px', fontWeight: 700, fontSize: '11px', letterSpacing: '0.1em' }}>STRIKE</div>
            <div style={{ color: 'var(--bear)', fontWeight: 700, textAlign: 'center', padding: '5px', fontSize: '11px', letterSpacing: '0.1em' }}>PUTS</div>
          </>
        )}

        {/* Rows */}
        {chain.calls.map((call, i) => {
          const put = chain.puts[i]
          const strike = call.strike
          const isAtm = strike === chain.atmStrike
          const isMaxPain = oi && strike === oi.maxPainStrike
          const oiRow = oi?.strikes.find(s => s.strike === strike)

          if (oi && oiRow) {
            const callBarW = maxOI > 0 ? (oiRow.callOI / maxOI) * 100 : 0
            const putBarW = maxOI > 0 ? (oiRow.putOI / maxOI) * 100 : 0
            return (
              <div key={strike} style={{ display: 'contents' }}>
                {/* CE OI bar */}
                <div style={{
                  position: 'relative', padding: '4px 5px', display: 'flex', alignItems: 'center',
                  justifyContent: 'flex-end', borderRadius: '2px',
                  background: isAtm ? 'rgba(34,197,94,0.06)' : 'transparent',
                }}>
                  <div style={{
                    position: 'absolute', right: 0, top: 0, bottom: 0,
                    width: `${callBarW}%`, background: 'rgba(34,197,94,0.15)',
                    borderRadius: '2px', minWidth: callBarW > 0 ? '2px' : '0',
                  }} />
                  <span style={{ position: 'relative', fontSize: '11px', color: 'var(--bull)', fontWeight: oiRow.callOI > 0 ? 600 : 400 }}>
                    {oiRow.callOI > 0 ? fmtNum(oiRow.callOI, 0) : '—'}
                  </span>
                  {role !== 'viewer' && (
                    <button onClick={() => handleOrder(call.tradingsymbol, 'BUY')} style={{
                      position: 'relative', marginLeft: '3px', background: CYB.glowDim, border: `1px solid ${CYB.glowBorder}`,
                      borderRadius: '2px', color: CYB.glow, fontSize: '7px', fontWeight: 700,
                      padding: '1px 4px', cursor: 'pointer', fontFamily: 'monospace', flexShrink: 0,
                    }}>B</button>
                  )}
                </div>
                {/* CE LTP */}
                <div style={{ textAlign: 'center', padding: '4px 3px', fontSize: '11px', color: 'var(--text2)' }}>
                  {oiRow.callLTP > 0 ? oiRow.callLTP.toFixed(1) : '—'}
                </div>
                {/* CE Vol */}
                <div style={{ textAlign: 'center', padding: '4px 3px', fontSize: '10px', color: 'var(--text3)' }}>
                  {oiRow.callVol > 0 ? fmtNum(oiRow.callVol, 0) : '—'}
                </div>

                {/* Strike */}
                <div style={{
                  textAlign: 'center', padding: '4px 6px',
                  fontWeight: isAtm || isMaxPain ? 800 : 500,
                  color: isMaxPain ? CYB.redGlow : isAtm ? 'var(--text)' : 'var(--text2)',
                  background: isMaxPain ? CYB.redDim : isAtm ? 'rgba(255,255,255,0.06)' : 'transparent',
                  borderRadius: '3px',
                  border: isMaxPain ? `1px solid rgba(255,0,60,0.3)` : isAtm ? `1px solid ${CYB.glowBorder}` : 'none',
                  fontSize: '12px', whiteSpace: 'nowrap',
                }}>
                  {strike}{isMaxPain && ' ⊗'}
                </div>

                {/* PE Vol */}
                <div style={{ textAlign: 'center', padding: '4px 3px', fontSize: '10px', color: 'var(--text3)' }}>
                  {oiRow.putVol > 0 ? fmtNum(oiRow.putVol, 0) : '—'}
                </div>
                {/* PE LTP */}
                <div style={{ textAlign: 'center', padding: '4px 3px', fontSize: '11px', color: 'var(--text2)' }}>
                  {oiRow.putLTP > 0 ? oiRow.putLTP.toFixed(1) : '—'}
                </div>
                {/* PE OI bar */}
                <div style={{
                  position: 'relative', padding: '4px 5px', display: 'flex', alignItems: 'center',
                  borderRadius: '2px',
                  background: isAtm ? 'rgba(239,68,68,0.06)' : 'transparent',
                }}>
                  <div style={{
                    position: 'absolute', left: 0, top: 0, bottom: 0,
                    width: `${putBarW}%`, background: 'rgba(239,68,68,0.15)',
                    borderRadius: '2px', minWidth: putBarW > 0 ? '2px' : '0',
                  }} />
                  {role !== 'viewer' && put && (
                    <button onClick={() => handleOrder(put.tradingsymbol, 'BUY')} style={{
                      position: 'relative', marginRight: '3px', background: CYB.redDim, border: '1px solid rgba(255,0,60,0.3)',
                      borderRadius: '2px', color: CYB.redGlow, fontSize: '8px', fontWeight: 700,
                      padding: '2px 5px', cursor: 'pointer', fontFamily: 'monospace', flexShrink: 0,
                    }}>B</button>
                  )}
                  <span style={{ position: 'relative', fontSize: '11px', color: 'var(--bear)', fontWeight: oiRow.putOI > 0 ? 600 : 400 }}>
                    {oiRow.putOI > 0 ? fmtNum(oiRow.putOI, 0) : '—'}
                  </span>
                </div>
              </div>
            )
          }

          // Fallback: no OI data (3-column layout)
          const callGreeks = estimateGreeks(spot, strike, 'CE', chain.expiry, chain.lotSize)
          const putGreeks = put ? estimateGreeks(spot, strike, 'PE', chain.expiry, chain.lotSize) : null
          return (
            <div key={strike} style={{ display: 'contents' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 6px', gap: '4px' }}>
                <span style={{ color: 'var(--text3)', fontSize: '9px' }}>{callGreeks.itm ? 'ITM' : 'OTM'} d{callGreeks.delta >= 0 ? '+' : ''}{callGreeks.delta.toFixed(2)}</span>
                {role !== 'viewer' && (
                  <button onClick={() => handleOrder(call.tradingsymbol, 'BUY')} style={{
                    background: CYB.glowDim, border: `1px solid ${CYB.glowBorder}`, borderRadius: '2px',
                    color: CYB.glow, fontSize: '8px', fontWeight: 700, padding: '2px 6px', cursor: 'pointer', fontFamily: 'monospace',
                  }}>BUY</button>
                )}
              </div>
              <div style={{ textAlign: 'center', padding: '3px 8px', fontWeight: isAtm ? 800 : 400, color: isAtm ? 'var(--text)' : 'var(--text2)', background: isAtm ? 'rgba(255,255,255,0.06)' : 'transparent', borderRadius: '3px', border: isAtm ? `1px solid ${CYB.glowBorder}` : 'none' }}>{strike}</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 6px', gap: '4px' }}>
                {put ? (
                  <>
                    {role !== 'viewer' && <button onClick={() => handleOrder(put.tradingsymbol, 'BUY')} style={{ background: CYB.redDim, border: '1px solid rgba(255,0,60,0.3)', borderRadius: '2px', color: CYB.redGlow, fontSize: '8px', fontWeight: 700, padding: '2px 6px', cursor: 'pointer', fontFamily: 'monospace' }}>BUY</button>}
                    <span style={{ color: 'var(--text3)', fontSize: '9px' }}>d{putGreeks?.delta.toFixed(2)} {putGreeks?.itm ? 'ITM' : 'OTM'}</span>
                  </>
                ) : <span style={{ color: 'var(--text3)' }}>—</span>}
              </div>
            </div>
          )
        })}
      </div>

      {/* ATM Greeks + OI summary */}
      <div style={{ marginTop: '8px', fontSize: '11px', color: 'var(--text3)', fontFamily: 'monospace', padding: '8px 10px', background: 'rgba(0,0,0,0.15)', borderRadius: '3px', border: `1px solid ${CYB.glowBorder}`, display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {(() => {
          const cg = estimateGreeks(spot, chain.atmStrike, 'CE', chain.expiry, chain.lotSize)
          const pg = estimateGreeks(spot, chain.atmStrike, 'PE', chain.expiry, chain.lotSize)
          return (
            <div>
              <span style={{ color: CYB.glow, opacity: 0.5, fontSize: '9px', letterSpacing: '0.1em' }}>ATM </span>
              {chain.atmStrike}: CE d{cg.delta >= 0 ? '+' : ''}{cg.delta.toFixed(2)} {cg.perPoint.toFixed(0)}/pt · PE d{pg.delta.toFixed(2)} {pg.perPoint.toFixed(0)}/pt · {cg.dte}d
            </div>
          )
        })()}
        {oi && (
          <div>
            <span style={{ color: CYB.glow, opacity: 0.5, fontSize: '9px', letterSpacing: '0.1em' }}>OI READ </span>
            <span style={{ color: pcrColor }}>
              PCR {oi.pcr.toFixed(2)} → {pcrSignal}
            </span>
            {' · '}
            max pain {oi.maxPainStrike} ({spot > oi.maxPainStrike ? 'spot above' : 'spot below'} by {Math.abs(spot - oi.maxPainStrike).toFixed(0)}pt)
            {' · '}
            {oi.pcr > 1.2 ? 'heavy put writing = support' : oi.pcr < 0.8 ? 'heavy call writing = resistance' : 'balanced'}
          </div>
        )}
      </div>

      {/* Explanation */}
      {oi && (() => {
        const painDist = spot - oi.maxPainStrike
        const painPct = Math.abs(painDist / spot * 100)
        const maxCallStrike = oi.strikes.reduce((a, b) => b.callOI > a.callOI ? b : a, oi.strikes[0])
        const maxPutStrike = oi.strikes.reduce((a, b) => b.putOI > a.putOI ? b : a, oi.strikes[0])

        const lines: string[] = []

        if (painDist > 0) {
          lines.push(`Spot is ${painPct.toFixed(1)}% above max pain (${oi.maxPainStrike}). Option writers profit most if price pulls back toward ${oi.maxPainStrike}. Expect gravitational drag downward near expiry.`)
        } else if (painDist < 0) {
          lines.push(`Spot is ${painPct.toFixed(1)}% below max pain (${oi.maxPainStrike}). Option writers profit most if price drifts up toward ${oi.maxPainStrike}. Expect upward pull near expiry.`)
        } else {
          lines.push(`Spot is at max pain (${oi.maxPainStrike}). Price is at the equilibrium where option writers lose the least. Expect low volatility / range-bound action.`)
        }

        if (oi.pcr > 1.5) {
          lines.push(`PCR ${oi.pcr.toFixed(2)} is very high — put writers are aggressively selling downside. This creates a floor of support. Contrarian bullish signal.`)
        } else if (oi.pcr > 1.2) {
          lines.push(`PCR ${oi.pcr.toFixed(2)} is elevated — more puts written than calls. Put sellers expect support below. Mild bullish bias.`)
        } else if (oi.pcr < 0.6) {
          lines.push(`PCR ${oi.pcr.toFixed(2)} is very low — call writers dominate. Heavy resistance above from call selling. Contrarian bearish signal.`)
        } else if (oi.pcr < 0.8) {
          lines.push(`PCR ${oi.pcr.toFixed(2)} is low — more calls written than puts. Call sellers expect a ceiling. Mild bearish bias.`)
        } else {
          lines.push(`PCR ${oi.pcr.toFixed(2)} is balanced — no strong directional bias from option writers.`)
        }

        if (maxCallStrike.callOI > 0) {
          lines.push(`Highest call OI at ${maxCallStrike.strike} (${fmtNum(maxCallStrike.callOI, 0)}) — this is the resistance level where call writers have the most at stake. Price crossing above this strike forces short covering.`)
        }
        if (maxPutStrike.putOI > 0) {
          lines.push(`Highest put OI at ${maxPutStrike.strike} (${fmtNum(maxPutStrike.putOI, 0)}) — this is the support level where put writers defend. Price dropping below triggers unwinding.`)
        }

        return (
          <div style={{
            marginTop: '6px', padding: '8px 10px', borderRadius: '3px',
            background: 'rgba(0,0,0,0.1)', border: `1px solid ${CYB.glowBorder}`,
            fontSize: '11px', color: 'var(--text3)', fontFamily: 'monospace',
            lineHeight: '1.6', display: 'flex', flexDirection: 'column', gap: '5px',
          }}>
            <span style={{ color: CYB.glow, opacity: 0.5, fontSize: '9px', letterSpacing: '0.1em' }}>{'//ANALYSIS'}</span>
            {lines.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
        )
      })()}
    </div>
  )
}

const MCX_LOT: Record<string, number> = { CRUDEOIL: 100, CRUDEOILM: 10 }

function mcxOptFees(entryPremium: number, exitPremium: number, lotSize: number): number {
  const buyT = entryPremium * lotSize
  const sellT = exitPremium * lotSize
  const brokerage = 40                            // ₹20/order × 2
  const exchg     = (buyT + sellT) * 0.00021      // MCX non-agri options 0.021%
  const ctt       = sellT * 0.0005                // CTT 0.05% on sell side
  const gst       = (brokerage + exchg) * 0.18   // GST 18% on brokerage+exchange
  const sebi      = (buyT + sellT) * 0.000001     // ₹10/crore
  const stamp     = buyT * 0.00003                // stamp duty 0.003% on buy
  return brokerage + exchg + ctt + gst + sebi + stamp
}

// ── Game Theory Analysis Panel (admin only) ───────────────────────────────────

interface GTAnalysis {
  maxPainStrike: number | null
  maxPainDir: 'BULL' | 'BEAR' | 'NEUTRAL' | null
  maxPainDistPct: number | null
  maxPainPull: number
  pcr: number | null
  pcrSignal: 'BULL' | 'BEAR' | 'NEUTRAL' | null
  pcrInterp: string
  callWallStrike: number | null
  callWallOI: number
  putWallStrike: number | null
  putWallOI: number
  wallPosition: 'ABOVE_RESISTANCE' | 'BELOW_SUPPORT' | 'IN_RANGE' | null
  wallRangeUsed: number        // 0–1 how far through the range (0=at put wall, 1=at call wall)
  regime: 'TRENDING_BULL' | 'TRENDING_BEAR' | 'CHOP' | 'UNKNOWN'
  oracleAlignment: 'ALIGNED' | 'DIVERGING' | 'NEUTRAL' | null
  gtScore: number              // –1..+1
  gtDirection: 'BULL' | 'BEAR' | 'NEUTRAL'
  gtConviction: 'HIGH' | 'MEDIUM' | 'LOW'
  components: { mpC: number; pcrC: number; schC: number; orcC: number }
  oracleTarget: number | null       // spot × (1 + oracle predictedMove/100)
  oracleTargetPct: number | null
  nashTarget: number | null         // max pain strike
  nashTargetPct: number | null
  gtTarget: number | null           // weighted blend of oracle + Nash
  gtTargetPct: number | null
}

function computeGT(
  spot: number,
  oi: OIAnalytics | undefined,
  composite: CrudeComposite,
  technicals: CrudeTechnicals,
): GTAnalysis {
  // ── 1. Max Pain (Nash Equilibrium gravity) ────────────────────────────────
  const mpStrike = oi?.maxPainStrike ?? null
  const mpPull   = oi?.maxPainPull   ?? 0
  let mpDir: GTAnalysis['maxPainDir'] = null
  let mpDistPct: number | null = null
  let mpC = 0
  if (mpStrike != null) {
    mpDistPct = (mpStrike - spot) / spot * 100   // + = spot below maxPain → bullish gravity
    mpDir = mpDistPct > 0.15 ? 'BULL' : mpDistPct < -0.15 ? 'BEAR' : 'NEUTRAL'
    const pullNorm = Math.min(1, mpPull / 30)     // 30% pull = full weight
    mpC = Math.max(-1, Math.min(1, (mpDistPct / 1.5) * pullNorm))
  }

  // ── 2. PCR (Kyle costly signal) ──────────────────────────────────────────
  const pcr = oi?.pcr ?? null
  let pcrSignal: GTAnalysis['pcrSignal'] = null
  let pcrInterp = ''
  let pcrC = 0
  if (pcr != null) {
    if (pcr >= 1.5)      { pcrSignal = 'BEAR'; pcrInterp = 'Heavy put buying — bears paying real premium (costly signal)'; pcrC = -Math.min(1, (pcr - 1) * 0.7) }
    else if (pcr >= 1.2) { pcrSignal = 'BEAR'; pcrInterp = 'Moderate put bias — downside hedging elevated'; pcrC = -0.35 }
    else if (pcr <= 0.6) { pcrSignal = 'BULL'; pcrInterp = 'Heavy call buying — bulls paying real premium (costly signal)'; pcrC = Math.min(1, (1 - pcr) * 0.7) }
    else if (pcr <= 0.8) { pcrSignal = 'BULL'; pcrInterp = 'Moderate call bias — upside speculation elevated'; pcrC = 0.35 }
    else                 { pcrSignal = 'NEUTRAL'; pcrInterp = 'Balanced options market — no informed directional bias' }
  }

  // ── 3. Schelling Focal Points (max-OI walls as coordination anchors) ──────
  const strikes = oi?.strikes ?? []
  let callWallStrike: number | null = null; let callWallOI = 0
  let putWallStrike: number | null  = null; let putWallOI  = 0
  let wallPosition: GTAnalysis['wallPosition'] = null
  let wallRangeUsed = 0.5
  let schC = 0
  if (strikes.length > 0) {
    const maxCall = strikes.reduce((b, s) => s.callOI > b.callOI ? s : b)
    const maxPut  = strikes.reduce((b, s) => s.putOI  > b.putOI  ? s : b)
    callWallStrike = maxCall.strike; callWallOI = maxCall.callOI
    putWallStrike  = maxPut.strike;  putWallOI  = maxPut.putOI
    if (spot > callWallStrike) {
      wallPosition = 'ABOVE_RESISTANCE'; wallRangeUsed = 1; schC = 0.8
    } else if (spot < putWallStrike) {
      wallPosition = 'BELOW_SUPPORT'; wallRangeUsed = 0; schC = -0.8
    } else {
      wallPosition = 'IN_RANGE'
      const rangeW = callWallStrike - putWallStrike || 1
      wallRangeUsed = (spot - putWallStrike) / rangeW
      // Bias: closer to put wall → support holding → slight bull; closer to call wall → resistance overhead → slight bear
      schC = (wallRangeUsed - 0.5) * -0.6   // 0=at put wall→+0.3, 1=at call wall→-0.3
    }
  }

  // ── 4. Regime from technicals ─────────────────────────────────────────────
  const mom5m = technicals.momentum5m ?? 0
  const emaCross = technicals.emaCrossover
  let regime: GTAnalysis['regime'] = 'UNKNOWN'
  if (Math.abs(mom5m) > 0.004 || emaCross) {
    regime = (mom5m > 0 || emaCross === 'BULL') ? 'TRENDING_BULL' : 'TRENDING_BEAR'
  } else if (Math.abs(mom5m) < 0.002) {
    regime = 'CHOP'
  }
  // In CHOP, reduce all signal weights (noisy environment)
  const regimeMult = regime === 'CHOP' ? 0.5 : 1.0

  // ── 5. Oracle contribution ────────────────────────────────────────────────
  const orcC = composite.direction === 'BULL'
    ? composite.confidence
    : composite.direction === 'BEAR' ? -composite.confidence : 0

  // ── 6. GT Score: weighted combination ─────────────────────────────────────
  const w = { mp: 0.25, pcr: 0.25, sch: 0.20, orc: 0.30 }
  const gtScore = regimeMult * (w.mp * mpC + w.pcr * pcrC + w.sch * schC) + w.orc * orcC
  const clampedScore = Math.max(-1, Math.min(1, gtScore))
  const gtDirection: GTAnalysis['gtDirection'] = clampedScore > 0.15 ? 'BULL' : clampedScore < -0.15 ? 'BEAR' : 'NEUTRAL'
  const abs = Math.abs(clampedScore)
  const gtConviction: GTAnalysis['gtConviction'] = abs > 0.5 ? 'HIGH' : abs > 0.25 ? 'MEDIUM' : 'LOW'

  const oracleAlignment: GTAnalysis['oracleAlignment'] =
    composite.direction == null ? null :
    composite.direction === gtDirection ? 'ALIGNED' :
    gtDirection === 'NEUTRAL' || composite.direction === null ? 'NEUTRAL' : 'DIVERGING'

  // ── 7. Price prediction ───────────────────────────────────────────────────
  const oracleTarget = spot > 0 ? spot * (1 + composite.predictedMove / 100) : null
  const oracleTargetPct = oracleTarget != null ? composite.predictedMove : null
  const nashTarget = mpStrike ?? null
  const nashTargetPct = (nashTarget != null && spot > 0) ? (nashTarget - spot) / spot * 100 : null

  let gtTarget: number | null = null
  let gtTargetPct: number | null = null
  if (spot > 0 && gtDirection !== 'NEUTRAL') {
    const isBull = gtDirection === 'BULL'
    // Only blend components that are directionally consistent with gtDirection.
    // Using |absC| for a component pointing the wrong way would drag the target
    // price opposite to the overall direction (e.g. BEAR signal, bullish Nash
    // target above spot → blended target ends up above spot — contradictory).
    const orcW = (isBull ? orcC > 0 : orcC < 0) ? Math.abs(orcC) : 0
    const mpW  = (isBull ? mpC  > 0 : mpC  < 0) ? Math.abs(mpC)  : 0
    const total = orcW + mpW
    if (total > 0 && oracleTarget != null && nashTarget != null) {
      gtTarget = (oracleTarget * orcW + nashTarget * mpW) / total
    } else if (orcW > 0 && oracleTarget != null) {
      gtTarget = oracleTarget
    } else if (mpW > 0 && nashTarget != null) {
      gtTarget = nashTarget
    }
    if (gtTarget != null) {
      gtTargetPct = (gtTarget - spot) / spot * 100
      // Sanity check: target must agree with gtDirection
      if ((isBull && gtTargetPct <= 0) || (!isBull && gtTargetPct >= 0)) {
        gtTarget = null
        gtTargetPct = null
      }
    }
  }

  return {
    maxPainStrike: mpStrike, maxPainDir: mpDir, maxPainDistPct: mpDistPct, maxPainPull: mpPull,
    pcr, pcrSignal, pcrInterp,
    callWallStrike, callWallOI, putWallStrike, putWallOI, wallPosition, wallRangeUsed,
    regime, oracleAlignment,
    gtScore: clampedScore, gtDirection, gtConviction,
    components: { mpC, pcrC, schC, orcC },
    oracleTarget, oracleTargetPct, nashTarget, nashTargetPct, gtTarget, gtTargetPct,
  }
}

// ── GT Explanation Modal ───────────────────────────────────────────────────────

function GTExplanationModal({ gt, spot, onClose }: { gt: GTAnalysis; spot: number; onClose: () => void }) {
  const gtColor = gt.gtDirection === 'BULL' ? 'var(--bull)' : gt.gtDirection === 'BEAR' ? 'var(--bear)' : 'var(--text3)'
  const convColor = gt.gtConviction === 'HIGH' ? CYB.accent : gt.gtConviction === 'MEDIUM' ? 'var(--text2)' : 'var(--text3)'
  const S: Record<string, React.CSSProperties> = {
    overlay: { position: 'fixed', inset: 0, zIndex: 9500, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '12px' },
    modal: { background: 'var(--bg)', border: `1px solid ${CYB.glowBorder}`, borderRadius: '10px', maxWidth: '600px', width: '100%', maxHeight: '90vh', overflowY: 'auto', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '14px' },
    sec: { display: 'flex', flexDirection: 'column', gap: '5px', paddingBottom: '12px', borderBottom: '1px solid rgba(255,255,255,0.05)' },
    secTitle: { fontSize: '9px', fontWeight: 700, color: CYB.glow, letterSpacing: '0.12em', marginBottom: '2px' },
    body: { fontSize: '11px', color: 'var(--text2)', lineHeight: 1.6 },
    row: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' },
    closeBtn: { background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '5px', color: 'var(--text2)', cursor: 'pointer', fontSize: '11px', padding: '3px 10px', flexShrink: 0 },
  }
  const gtChip = (c: string): React.CSSProperties => ({ display: 'inline-block', fontSize: '9px', padding: '2px 6px', borderRadius: '3px', fontWeight: 700, background: `${c}22`, border: `1px solid ${c}44`, color: c })
  const compBar = (val: number, weight: number, label: string) => {
    const c = val > 0 ? 'var(--bull)' : val < 0 ? 'var(--bear)' : 'var(--text3)'
    const contribution = val * weight
    return (
      <div key={label} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '10px' }}>
        <span style={{ width: '60px', color: 'var(--text3)', textAlign: 'right' }}>{label}</span>
        <div style={{ position: 'relative', width: '120px', height: '8px', background: 'rgba(255,255,255,0.06)', borderRadius: '4px' }}>
          <div style={{ position: 'absolute', top: 0, height: '100%', width: `${Math.abs(val) * 60}px`, [val >= 0 ? 'left' : 'right']: val >= 0 ? '50%' : 'calc(50%)', background: c, borderRadius: '4px', maxWidth: '50%' }} />
          <div style={{ position: 'absolute', top: 0, left: '50%', width: '1px', height: '100%', background: 'rgba(255,255,255,0.2)' }} />
        </div>
        <span style={{ color: c, fontWeight: 700, minWidth: '40px' }}>{val >= 0 ? '+' : ''}{val.toFixed(2)}</span>
        <span style={{ color: 'var(--text3)' }}>×{weight}</span>
        <span style={{ color: contribution > 0 ? 'var(--bull)' : contribution < 0 ? 'var(--bear)' : 'var(--text3)', fontWeight: 700 }}>= {contribution >= 0 ? '+' : ''}{contribution.toFixed(3)}</span>
      </div>
    )
  }

  return (
    <div style={S.overlay} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={S.modal}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: '8px', fontWeight: 700, color: CYB.glow, letterSpacing: '0.15em' }}>{'//GT_ANALYSIS  ·  EXPLANATION'}</div>
            <div style={{ fontSize: '14px', fontWeight: 900, color: gtColor, marginTop: '4px' }}>
              {gt.gtDirection} — {gt.gtConviction} CONVICTION
            </div>
            <div style={{ fontSize: '10px', color: 'var(--text3)', marginTop: '2px' }}>
              spot ₹{spot.toFixed(0)}  ·  GT score: {gt.gtScore >= 0 ? '+' : ''}{gt.gtScore.toFixed(3)}  ·  range −1..+1
            </div>
          </div>
          <button style={S.closeBtn} onClick={onClose}>✕ close</button>
        </div>

        {/* Framework overview */}
        <div style={S.sec}>
          <div style={S.secTitle}>WHAT IS GAME THEORY ANALYSIS?</div>
          <div style={S.body}>
            Standard technical analysis treats price as pattern output. Game theory treats price as the outcome of a negotiation between participants with objectives, capital, and private information. This panel synthesises four game-theoretic signals — each grounded in a different branch of market microstructure theory — into a single conviction score.
          </div>
        </div>

        {/* 1. Max Pain */}
        <div style={S.sec}>
          <div style={S.secTitle}>① MAX PAIN — NASH EQUILIBRIUM (weight 25%)</div>
          <div style={S.row}>
            <span style={{ fontSize: '12px', fontWeight: 700, color: gt.maxPainDir === 'BULL' ? 'var(--bull)' : gt.maxPainDir === 'BEAR' ? 'var(--bear)' : 'var(--text3)' }}>
              {gt.maxPainDir ?? 'NO DATA'}
            </span>
            {gt.maxPainStrike != null && <span style={{ fontSize: '10px', color: 'var(--text2)' }}>₹{gt.maxPainStrike.toFixed(0)} ({gt.maxPainDistPct != null ? `spot ${gt.maxPainDistPct > 0 ? '+' : ''}${gt.maxPainDistPct.toFixed(2)}% away` : '—'})</span>}
            {gt.maxPainPull > 0 && <span style={gtChip(gt.maxPainPull >= 15 ? CYB.accent : 'var(--text3)')}>pull:{gt.maxPainPull.toFixed(1)}%</span>}
          </div>
          <div style={S.body}>
            Max pain is the strike price where option writers (sellers) collectively lose the least money at expiry. Every option seller delta-hedges their position in a way that pulls price toward this level — not by conspiracy, but because it is the Nash Equilibrium of the hedging game: no individual seller has incentive to hedge differently, yet their collective hedging creates gravitational pull. This effect strengthens in the final 5 days before expiry. The <b>pull %</b> measures how steeply the pain function slopes at adjacent strikes — higher pull means stronger gravitational force.
          </div>
          {gt.maxPainStrike == null && <div style={{ fontSize: '10px', color: 'var(--text3)', fontStyle: 'italic' }}>OI chain data not yet loaded — max pain unavailable</div>}
        </div>

        {/* 2. PCR */}
        <div style={S.sec}>
          <div style={S.secTitle}>② PCR — KYLE COSTLY SIGNAL (weight 25%)</div>
          <div style={S.row}>
            <span style={{ fontSize: '12px', fontWeight: 700, color: gt.pcrSignal === 'BULL' ? 'var(--bull)' : gt.pcrSignal === 'BEAR' ? 'var(--bear)' : 'var(--text3)' }}>
              {gt.pcrSignal ?? 'NO DATA'}
            </span>
            {gt.pcr != null && <span style={{ fontSize: '10px', color: 'var(--text2)' }}>PCR: {gt.pcr.toFixed(2)}</span>}
          </div>
          <div style={S.body}>
            {gt.pcrInterp || 'No PCR data available.'} The Kyle (1985) model distinguishes costly signals from cheap talk. Placing a large order in the book is free — it can be cancelled. But buying a put or call requires paying real premium that is lost if you are wrong. A high PCR (≥1.2) means real money is being committed to downside protection — that is informed, costly signalling. Contrast with the order book (OBI) where walls are free to place and pull. PCR is harder to fake.
          </div>
        </div>

        {/* 3. Schelling Walls */}
        <div style={S.sec}>
          <div style={S.secTitle}>③ SCHELLING FOCAL POINTS — OI WALLS (weight 20%)</div>
          {gt.callWallStrike != null && gt.putWallStrike != null ? (
            <>
              <div style={S.row}>
                <span style={gtChip('var(--bear)')}>CALL WALL ₹{gt.callWallStrike.toFixed(0)}</span>
                <span style={{ fontSize: '10px', color: 'var(--text3)' }}>{(gt.callWallOI / 1000).toFixed(0)}K OI — resistance ceiling</span>
              </div>
              <div style={S.row}>
                <span style={gtChip('var(--bull)')}>PUT WALL ₹{gt.putWallStrike.toFixed(0)}</span>
                <span style={{ fontSize: '10px', color: 'var(--text3)' }}>{(gt.putWallOI / 1000).toFixed(0)}K OI — support floor</span>
              </div>
              <div style={{ marginTop: '4px', fontSize: '10px', color: gt.wallPosition === 'ABOVE_RESISTANCE' ? 'var(--bull)' : gt.wallPosition === 'BELOW_SUPPORT' ? 'var(--bear)' : 'var(--text3)' }}>
                Spot ₹{spot.toFixed(0)}: {gt.wallPosition === 'ABOVE_RESISTANCE' ? '↑ ABOVE resistance — bullish breakout' : gt.wallPosition === 'BELOW_SUPPORT' ? '↓ BELOW support — bearish breakdown' : `IN RANGE (${(gt.wallRangeUsed * 100).toFixed(0)}% used from put wall)`}
              </div>
            </>
          ) : <div style={{ fontSize: '10px', color: 'var(--text3)', fontStyle: 'italic' }}>OI chain data not yet loaded</div>}
          <div style={S.body}>
            Strikes with large open interest become Schelling focal points — natural coordination anchors that multiple independent players converge on because they expect others to care about them, which makes them self-fulfilling. The strike with highest call OI acts as a ceiling (writers hedge above it to suppress price). The strike with highest put OI acts as a floor (writers defend below it). A break above the call wall means the coordination failed — bulls overwhelmed it — often triggering a cascade of short covering above. Breaking below the put wall triggers the symmetric cascade.
          </div>
        </div>

        {/* 4. Regime */}
        <div style={S.sec}>
          <div style={S.secTitle}>④ REGIME FILTER (applied as multiplier)</div>
          <div style={S.row}>
            <span style={{ fontSize: '12px', fontWeight: 700, color: gt.regime === 'TRENDING_BULL' ? 'var(--bull)' : gt.regime === 'TRENDING_BEAR' ? 'var(--bear)' : gt.regime === 'CHOP' ? 'var(--text3)' : 'rgba(255,255,255,0.3)' }}>
              {gt.regime}
            </span>
            {gt.regime === 'CHOP' && <span style={{ fontSize: '10px', color: 'var(--text3)' }}>signal weights halved</span>}
          </div>
          <div style={S.body}>
            In a CHOP regime, all three market microstructure signals (max pain, PCR, Schelling walls) are less reliable — players are ranging rather than positioning directionally, and OI builds without follow-through. The regime filter halves the contribution of max pain, PCR, and Schelling signals in CHOP, while keeping the oracle weight unchanged. In a TRENDING regime, full weights apply.
          </div>
        </div>

        {/* 5. Oracle alignment */}
        <div style={S.sec}>
          <div style={S.secTitle}>⑤ ORACLE ALIGNMENT (weight 30%)</div>
          <div style={S.row}>
            <span style={{ fontSize: '12px', fontWeight: 700, color: gt.oracleAlignment === 'ALIGNED' ? 'var(--bull)' : gt.oracleAlignment === 'DIVERGING' ? 'var(--bear)' : 'var(--text3)' }}>
              {gt.oracleAlignment ?? 'UNKNOWN'}
            </span>
          </div>
          <div style={S.body}>
            The Oracle is the pattern-memory system (softmax kNN over historical microstructure snapshots). It is independent of the three game theory signals above. When all four components agree in direction, the GT score approaches +1 or −1 (HIGH conviction). When the oracle diverges from the structural signals, the score pulls toward NEUTRAL and conviction drops to LOW — the system is self-hedging against a noisy or transitioning environment.
          </div>
        </div>

        {/* Component breakdown */}
        <div style={{ ...S.sec, borderBottom: 'none', paddingBottom: 0 }}>
          <div style={S.secTitle}>COMPONENT BREAKDOWN — WEIGHTED SCORE</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '4px' }}>
            {compBar(gt.components.mpC,  0.25, 'Max Pain')}
            {compBar(gt.components.pcrC, 0.25, 'PCR')}
            {compBar(gt.components.schC, 0.20, 'Schelling')}
            {compBar(gt.components.orcC, 0.30, 'Oracle')}
          </div>
          <div style={{ marginTop: '10px', display: 'flex', alignItems: 'baseline', gap: '8px' }}>
            <span style={{ fontSize: '10px', color: 'var(--text3)' }}>GT SCORE</span>
            <span style={{ fontSize: '16px', fontWeight: 900, color: gtColor }}>{gt.gtScore >= 0 ? '+' : ''}{gt.gtScore.toFixed(3)}</span>
            <span style={{ fontSize: '10px', color: convColor, fontWeight: 700 }}>{gt.gtConviction} CONVICTION</span>
          </div>
          <div style={{ fontSize: '9px', color: 'var(--text3)', marginTop: '4px', lineHeight: 1.5 }}>
            Score range: −1 (strong BEAR) to +1 (strong BULL). HIGH conviction = |score| &gt; 0.5. MEDIUM = 0.25–0.5. LOW = &lt; 0.25. In CHOP regime, max pain + PCR + Schelling contributions are halved before weighting.
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Oracle V2 Panel ────────────────────────────────────────────────────────────

function OracleV2Panel({ state }: { state: CrudeState & { v2: CrudeV2 } }) {
  const { v2, spot, product } = state
  const { prediction, sessionKey, sessionPatternCount, kalmanVelocity } = v2

  const dirColor2 = (d: 'BULL' | 'BEAR' | null) =>
    d === 'BULL' ? 'var(--bull)' : d === 'BEAR' ? 'var(--bear)' : 'var(--text3)'

  const fmtPct2 = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(3)}%`

  const sessionEmoji: Record<MCXSession, string> = { morning: '🌅', afternoon: '🌤', evening: '🌙' }

  return (
    <div style={{ fontFamily: 'monospace', padding: '10px', display: 'flex', flexDirection: 'column', gap: '8px', background: CYB.scanline }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '4px', minWidth: 0 }}>
        <span style={{ fontSize: '8px', color: CYB.glow, letterSpacing: '0.15em', flexShrink: 0 }}>
          //ORACLE_V2 · {sessionEmoji[sessionKey]} {sessionKey.toUpperCase()} · {sessionPatternCount}pat
        </span>
        <span style={{ fontSize: '8px', color: 'var(--text3)', minWidth: 0 }}>
          kalman drift {kalmanVelocity >= 0 ? '+' : ''}{(kalmanVelocity / spot * 100).toFixed(4)}%/min
        </span>
      </div>

      {/* Main prediction */}
      {prediction.status === 'ready' && prediction.h20 ? (
        <>
          {/* 20m prediction */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div style={{ fontSize: '8px', color: CYB.glow, letterSpacing: '0.12em' }}>20M DETRENDED</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ fontSize: '22px', color: dirColor2(prediction.direction), fontWeight: 700, letterSpacing: '-0.02em' }}>
                {prediction.direction === 'BULL' ? '▲' : prediction.direction === 'BEAR' ? '▼' : '·'}
                {' '}{fmtPct2(prediction.predictedMove)}
              </span>
              <span style={{ fontSize: '10px', color: 'var(--text2)' }}>
                → ₹{(spot * (1 + prediction.predictedMove / 100)).toFixed(0)}
              </span>
            </div>
            {/* Bull/Bear bar */}
            <div style={{ display: 'flex', height: '6px', borderRadius: '3px', overflow: 'hidden', gap: '1px' }}>
              <div style={{ flex: prediction.bullProb, background: 'var(--bull)', opacity: 0.7 }} />
              <div style={{ flex: prediction.bearProb, background: 'var(--bear)', opacity: 0.7 }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '8px' }}>
              <span style={{ color: 'var(--bull)' }}>bull {(prediction.bullProb * 100).toFixed(0)}%</span>
              <span style={{ color: CYB.glow }}>sim={prediction.topSim.toFixed(2)} conf={(prediction.confidence * 100).toFixed(0)}%</span>
              <span style={{ color: 'var(--bear)' }}>bear {(prediction.bearProb * 100).toFixed(0)}%</span>
            </div>
          </div>

          {/* Multi-horizon detrended */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(80px, 1fr))', gap: '6px' }}>
            {([['5m', prediction.h5], ['15m', prediction.h15], ['20m', prediction.h20]] as const).map(([label, h]) => (
              h ? (
                <div key={label} style={{ background: CYB.glowDim, borderRadius: '4px', padding: '5px 6px', display: 'flex', flexDirection: 'column', gap: '3px' }}>
                  <div style={{ fontSize: '8px', color: CYB.glow }}>{label} detrended</div>
                  <div style={{ fontSize: '10px', color: dirColor2(h.bullProb > 0.55 ? 'BULL' : h.bearProb > 0.55 ? 'BEAR' : null), fontWeight: 600 }}>
                    {fmtPct2(h.predictedMove)}
                  </div>
                  <div style={{ fontSize: '8px', color: 'var(--text3)' }}>
                    ▲{(h.bullProb * 100).toFixed(0)}% ▼{(h.bearProb * 100).toFixed(0)}%
                  </div>
                </div>
              ) : null
            ))}
          </div>

          {/* V1 vs V2 comparison hint */}
          <div style={{ fontSize: '8px', color: 'var(--text3)', borderTop: `1px solid ${CYB.glowBorder}`, paddingTop: '6px', display: 'flex', gap: '6px' }}>
            <span>v1→</span>
            <span style={{ color: dirColor2(state.prediction.direction) }}>
              {fmtPct2(state.prediction.predictedMove)} ({(state.prediction.bullProb * 100).toFixed(0)}%b)
            </span>
            <span>v2→</span>
            <span style={{ color: dirColor2(prediction.direction) }}>
              {fmtPct2(prediction.predictedMove)} ({(prediction.bullProb * 100).toFixed(0)}%b)
            </span>
          </div>
        </>
      ) : (
        <div style={{ fontSize: '9px', color: 'var(--text3)', padding: '12px 0', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {/* Progress bar toward activation */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ flex: 1, height: '4px', background: 'rgba(255,255,255,0.06)', borderRadius: '2px', overflow: 'hidden' }}>
              <div style={{
                height: '100%',
                width: `${Math.min(100, prediction.nResolved / 3 * 100)}%`,
                background: prediction.nResolved > 0 ? 'rgba(99,102,241,0.7)' : 'rgba(255,255,255,0.1)',
                transition: 'width 0.4s',
                borderRadius: '2px',
              }} />
            </div>
            <span style={{ fontSize: '9px', color: 'rgba(99,102,241,0.9)', fontWeight: 600, minWidth: '28px' }}>
              {prediction.nResolved}/3
            </span>
          </div>
          <div style={{ textAlign: 'center', opacity: 0.6 }}>
            {prediction.status === 'warming'
              ? `WARMING · ${prediction.nResolved} resolved · ${sessionKey} session`
              : `ACCUMULATING · ${sessionPatternCount} snapshots · waiting 20min for outcomes · ${sessionKey}`}
          </div>
          <div style={{ textAlign: 'center', fontSize: '8px', opacity: 0.4 }}>
            {prediction.nResolved === 0
              ? `first prediction in ~${Math.max(1, 3 - sessionPatternCount)} snapshot${Math.max(1, 3 - sessionPatternCount) !== 1 ? 's' : ''} + 20min`
              : `${3 - prediction.nResolved} more resolved pattern${3 - prediction.nResolved !== 1 ? 's' : ''} needed`}
          </div>
        </div>
      )}
    </div>
  )
}

// ── GT Flow Panel ──────────────────────────────────────────────────────────────

function GTFlowPanel({ v2 }: { v2: CrudeV2 }) {
  const { flowState, sessionKey, sessionPatternCount, kalmanVelocity, featureVec, prediction } = v2

  const sessionLabel: Record<MCXSession, string> = {
    morning: '09-14 IST · Indian session',
    afternoon: '14-18 IST · London overlap',
    evening: '18-23:30 IST · US session',
  }

  const barPct = (v: number, max: number) =>
    Math.min(100, Math.abs(v) / max * 100)

  const fmtDelta = (n: number) => {
    if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}K`
    return n.toFixed(0)
  }

  const alarm = flowState?.cusumAlarm
  const alarmColor = alarm === 'BULL' ? 'var(--bull)' : alarm === 'BEAR' ? 'var(--bear)' : CYB.glow

  const v2Vec = featureVec

  return (
    <div style={{ fontFamily: 'monospace', padding: '10px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {/* Session context */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <div style={{ fontSize: '8px', color: CYB.glow, letterSpacing: '0.15em' }}>//SESSION</div>
        <div style={{ fontSize: '10px', color: 'var(--text)', fontWeight: 700, textTransform: 'uppercase' }}>
          {sessionKey}
        </div>
        <div style={{ fontSize: '9px', color: 'var(--text3)' }}>{sessionLabel[sessionKey]}</div>
        <div style={{ fontSize: '9px', color: CYB.glow }}>
          {sessionPatternCount} resolved patterns · kalman drift {kalmanVelocity > 0 ? '+' : ''}{(kalmanVelocity / 1).toFixed(2)}₹/min
        </div>
      </div>

      {/* Flow state — only when bot is running */}
      {flowState ? (
        <>
          {/* Cumulative Delta */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div style={{ fontSize: '8px', color: CYB.glow, letterSpacing: '0.15em' }}>//CUMULATIVE_DELTA</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: '11px', color: flowState.cumDelta >= 0 ? 'var(--bull)' : 'var(--bear)', fontWeight: 700, minWidth: '60px' }}>
                {flowState.cumDelta >= 0 ? '+' : ''}{fmtDelta(flowState.cumDelta)}
              </span>
              <span style={{ fontSize: '9px', color: CYB.glow }}>
                z={flowState.cdZScore >= 0 ? '+' : ''}{flowState.cdZScore.toFixed(2)}σ
              </span>
            </div>
            {/* CD bar */}
            <div style={{ height: '4px', background: 'rgba(255,255,255,0.06)', borderRadius: '2px', position: 'relative' }}>
              <div style={{
                position: 'absolute', height: '100%', borderRadius: '2px',
                background: flowState.cumDelta >= 0 ? 'var(--bull)' : 'var(--bear)',
                width: `${barPct(flowState.cumDelta, 50000)}%`,
                [flowState.cumDelta >= 0 ? 'left' : 'right']: '50%',
              }} />
              <div style={{ position: 'absolute', left: '50%', top: '-1px', height: '6px', width: '1px', background: 'rgba(255,255,255,0.3)' }} />
            </div>
          </div>

          {/* Aggression */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div style={{ fontSize: '8px', color: CYB.glow, letterSpacing: '0.15em' }}>//AGGRESSION</div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <span style={{ fontSize: '10px', color: flowState.aggressionRatio >= 0 ? 'var(--bull)' : 'var(--bear)' }}>
                {flowState.aggressionRatio >= 0 ? '▲' : '▼'} {Math.abs(flowState.aggressionRatio * 100).toFixed(1)}%
              </span>
              <span style={{ fontSize: '9px', color: 'var(--text3)' }}>
                {Math.abs(flowState.aggressionRatio) < 0.15 ? 'balanced' : flowState.aggressionRatio > 0 ? 'buy absorbing' : 'sell absorbing'}
              </span>
            </div>
          </div>

          {/* CUSUM */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div style={{ fontSize: '8px', color: CYB.glow, letterSpacing: '0.15em' }}>//CUSUM · momentum persistence</div>
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              <span style={{ fontSize: '9px', color: alarm ? alarmColor : 'var(--text3)', fontWeight: alarm ? 700 : 400 }}>
                {alarm ? `⚡ ${alarm} ALARM` : 'no alarm'}
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px' }}>
              {[['↑', flowState.cusumPos, 'var(--bull)'], ['↓', flowState.cusumNeg, 'var(--bear)']] .map(([dir, val, col]) => (
                <div key={String(dir)} style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  <div style={{ fontSize: '9px', color: String(col) }}>{String(dir)} {Number(val).toFixed(4)}</div>
                  <div style={{ height: '3px', background: 'rgba(255,255,255,0.06)', borderRadius: '2px' }}>
                    <div style={{ height: '100%', width: `${Math.min(100, Number(val) / 0.012 * 100)}%`, background: String(col), borderRadius: '2px' }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : (
        <div style={{ fontSize: '9px', color: 'var(--text3)', padding: '8px 0', opacity: 0.6 }}>
          {'> FLOW_STATE: bot offline — cdZScore not available'}
          <br />{'> using momentum5m as cdZ proxy'}
        </div>
      )}

      {/* V2 feature vector preview */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <div style={{ fontSize: '8px', color: CYB.glow, letterSpacing: '0.15em' }}>//FEATURE_VEC_V2 [14-dim]</div>
        <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' } as React.CSSProperties}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(36px, 1fr))', gap: '2px', minWidth: '252px' }}>
          {v2Vec.map((v, i) => {
            const labels = ['cdZ','mpE','sprd','qpo','m1','m5','rsi','ema','vwap','rng','atr','tod','agg','cusum']
            const bg = v > 0.15 ? 'rgba(0,200,100,0.2)' : v < -0.15 ? 'rgba(255,0,60,0.2)' : 'rgba(255,255,255,0.04)'
            return (
              <div key={i} style={{ background: bg, borderRadius: '2px', padding: '2px 3px', textAlign: 'center' }}>
                <div style={{ fontSize: '7px', color: 'var(--text3)' }}>{labels[i]}</div>
                <div style={{ fontSize: '8px', color: v > 0.15 ? 'var(--bull)' : v < -0.15 ? 'var(--bear)' : 'var(--text2)', fontWeight: 600 }}>
                  {v.toFixed(2)}
                </div>
              </div>
            )
          })}
        </div>
        </div>
      </div>

      {/* V2 prediction summary */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <div style={{ fontSize: '8px', color: CYB.glow, letterSpacing: '0.15em' }}>//V2_KNN · session-scoped · detrended</div>
        <div style={{ fontSize: '9px', color: 'var(--text3)' }}>
          {prediction.status === 'ready'
            ? `n=${prediction.nResolved} · sim=${prediction.topSim.toFixed(2)} · conf=${(prediction.confidence * 100).toFixed(0)}%`
            : prediction.status === 'warming'
              ? `warming… ${prediction.nResolved}/${10} resolved`
              : 'no session data yet'}
        </div>
      </div>
    </div>
  )
}

// ── GT Panel ───────────────────────────────────────────────────────────────────

function GameTheoryPanel({ spot, chain, composite, technicals }: {
  spot: number
  chain: CrudeChain | null
  composite: CrudeComposite
  technicals: CrudeTechnicals
}) {
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)
  const [showModal, setShowModal] = useState(false)

  useEffect(() => {
    const close = () => setCtxMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [])
  useEffect(() => {
    if (!showModal) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowModal(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showModal])

  const gt = computeGT(spot, chain?.oiAnalytics, composite, technicals)

  const gtColor = gt.gtDirection === 'BULL' ? 'var(--bull)' : gt.gtDirection === 'BEAR' ? 'var(--bear)' : 'var(--text3)'
  const convColor = gt.gtConviction === 'HIGH' ? CYB.accent : gt.gtConviction === 'MEDIUM' ? 'var(--text2)' : 'var(--text3)'
  const regimeColor = gt.regime === 'TRENDING_BULL' ? 'var(--bull)' : gt.regime === 'TRENDING_BEAR' ? 'var(--bear)' : gt.regime === 'CHOP' ? 'var(--text3)' : 'rgba(255,255,255,0.25)'

  const noOI = !chain?.oiAnalytics

  // Mini score bar — centred, bull right / bear left
  const scoreBarW = 160
  const scoreFill = Math.abs(gt.gtScore) * (scoreBarW / 2)

  // Component row renderer
  const compRow = (label: string, val: number, signal: string | null, sigColor: string, extra?: string) => (
    <div style={{ display: 'grid', gridTemplateColumns: '72px 1fr 60px', alignItems: 'center', gap: '6px', fontSize: '10px' }}>
      <span style={{ color: 'var(--text3)', textAlign: 'right' }}>{label}</span>
      <div style={{ position: 'relative', height: '6px', background: 'rgba(255,255,255,0.06)', borderRadius: '3px' }}>
        <div style={{ position: 'absolute', top: 0, height: '100%', background: val > 0 ? 'var(--bull)' : val < 0 ? 'var(--bear)' : 'var(--text3)', borderRadius: '3px', width: `${Math.abs(val) * 50}%`, [val >= 0 ? 'left' : 'right']: val >= 0 ? '50%' : 0, maxWidth: '50%' }} />
        <div style={{ position: 'absolute', top: 0, left: '50%', width: '1px', height: '100%', background: 'rgba(255,255,255,0.15)' }} />
      </div>
      <span style={{ color: sigColor, fontWeight: 700, fontSize: '9px' }}>{signal ?? '—'}{extra ? ` ${extra}` : ''}</span>
    </div>
  )

  return (
    <>
      <div
        onContextMenu={e => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY }) }}
        style={{ padding: '8px 10px', background: CYB.panel, borderRadius: '6px', border: `1px solid ${CYB.glowBorder}`, display: 'flex', flexDirection: 'column', gap: '8px', cursor: 'context-menu' }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '8px', fontWeight: 700, color: CYB.glow, letterSpacing: '0.15em' }}>{'//GT_ANALYSIS'}</span>
          <span style={{ fontSize: '8px', color: CYB.accent, border: `1px solid ${CYB.accent}44`, borderRadius: '3px', padding: '0 4px', fontWeight: 700 }}>ADMIN</span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: '8px', color: 'var(--text3)', opacity: 0.5 }}>right-click to explain</span>
        </div>

        {/* GT Score row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
            <span style={{ fontSize: '18px', fontWeight: 900, color: gtColor, lineHeight: 1 }}>{gt.gtDirection}</span>
            <span style={{ fontSize: '11px', fontWeight: 700, color: convColor }}>{gt.gtConviction}</span>
          </div>
          {/* Score bar */}
          <div style={{ position: 'relative', width: `${scoreBarW}px`, height: '8px', background: 'rgba(255,255,255,0.06)', borderRadius: '4px', flexShrink: 0 }}>
            <div style={{ position: 'absolute', top: 0, height: '100%', width: `${scoreFill}px`, background: gtColor, borderRadius: '4px', [gt.gtScore >= 0 ? 'left' : 'right']: gt.gtScore >= 0 ? '50%' : 0, maxWidth: '50%' }} />
            <div style={{ position: 'absolute', top: 0, left: '50%', width: '1px', height: '100%', background: 'rgba(255,255,255,0.2)' }} />
          </div>
          <span style={{ fontSize: '10px', color: 'var(--text3)' }}>{gt.gtScore >= 0 ? '+' : ''}{gt.gtScore.toFixed(3)}</span>
        </div>

        {/* Price prediction */}
        {gt.gtTarget != null && gt.gtDirection !== 'NEUTRAL' && (
          <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: '4px', padding: '5px 8px', display: 'flex', flexDirection: 'column', gap: '3px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '8px', color: 'var(--text3)', letterSpacing: '0.1em', fontWeight: 700 }}>GT TARGET</span>
              <span style={{ fontSize: '14px', fontWeight: 900, color: gt.gtTargetPct! > 0 ? 'var(--bull)' : 'var(--bear)', lineHeight: 1 }}>
                ₹{gt.gtTarget.toFixed(0)}
              </span>
              <span style={{ fontSize: '11px', fontWeight: 700, color: gt.gtTargetPct! > 0 ? 'var(--bull)' : 'var(--bear)' }}>
                {gt.gtTargetPct! >= 0 ? '+' : ''}{gt.gtTargetPct!.toFixed(2)}%
              </span>
            </div>
            <div style={{ display: 'flex', gap: '8px', fontSize: '9px', color: 'var(--text3)', flexWrap: 'wrap' }}>
              {gt.oracleTargetPct != null && (
                <span>oracle {gt.oracleTargetPct >= 0 ? '+' : ''}{gt.oracleTargetPct.toFixed(2)}% → ₹{gt.oracleTarget!.toFixed(0)}</span>
              )}
              {gt.nashTargetPct != null && (
                <span>·  nash {gt.nashTargetPct >= 0 ? '+' : ''}{gt.nashTargetPct.toFixed(2)}% → ₹{gt.nashTarget!.toFixed(0)}</span>
              )}
            </div>
          </div>
        )}

        {/* Component breakdown */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {compRow('max pain', gt.components.mpC,
            gt.maxPainDir ?? (noOI ? 'no OI' : '—'),
            gt.maxPainDir === 'BULL' ? 'var(--bull)' : gt.maxPainDir === 'BEAR' ? 'var(--bear)' : 'var(--text3)',
            gt.maxPainStrike != null ? `₹${gt.maxPainStrike.toFixed(0)} pull:${gt.maxPainPull.toFixed(0)}%` : undefined,
          )}
          {compRow('PCR',
            gt.components.pcrC,
            gt.pcr != null ? `${gt.pcr.toFixed(2)}` : (noOI ? 'no OI' : '—'),
            gt.pcrSignal === 'BULL' ? 'var(--bull)' : gt.pcrSignal === 'BEAR' ? 'var(--bear)' : 'var(--text3)',
            gt.pcrSignal != null ? `(${gt.pcrSignal})` : undefined,
          )}
          {compRow('walls',
            gt.components.schC,
            gt.wallPosition === 'ABOVE_RESISTANCE' ? '↑BREAK' : gt.wallPosition === 'BELOW_SUPPORT' ? '↓BREAK' : gt.wallPosition === 'IN_RANGE' ? `${(gt.wallRangeUsed * 100).toFixed(0)}%` : (noOI ? 'no OI' : '—'),
            gt.wallPosition === 'ABOVE_RESISTANCE' ? 'var(--bull)' : gt.wallPosition === 'BELOW_SUPPORT' ? 'var(--bear)' : 'var(--text3)',
            gt.callWallStrike != null ? `${gt.putWallStrike?.toFixed(0)}–${gt.callWallStrike?.toFixed(0)}` : undefined,
          )}
          {compRow('oracle',
            gt.components.orcC,
            composite.direction ?? 'NEUTRAL',
            composite.direction === 'BULL' ? 'var(--bull)' : composite.direction === 'BEAR' ? 'var(--bear)' : 'var(--text3)',
            `${(composite.confidence * 100).toFixed(0)}%conf`,
          )}
        </div>

        {/* Regime + alignment footer */}
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '5px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '9px', color: 'var(--text3)' }}>regime:</span>
          <span style={{ fontSize: '9px', fontWeight: 700, color: regimeColor }}>{gt.regime}</span>
          {gt.regime === 'CHOP' && <span style={{ fontSize: '8px', color: 'var(--text3)' }}>→ weights ½</span>}
          <span style={{ flex: 1 }} />
          {gt.oracleAlignment && (
            <span style={{ fontSize: '9px', fontWeight: 700, color: gt.oracleAlignment === 'ALIGNED' ? 'var(--bull)' : gt.oracleAlignment === 'DIVERGING' ? 'var(--bear)' : 'var(--text3)' }}>
              {gt.oracleAlignment === 'ALIGNED' ? '✓ ALIGNED' : gt.oracleAlignment === 'DIVERGING' ? '⚠ DIVERGING' : '~ NEUTRAL'}
            </span>
          )}
        </div>

        {noOI && (
          <div style={{ fontSize: '9px', color: 'var(--text3)', opacity: 0.6, fontStyle: 'italic' }}>
            max pain + PCR + wall signals pending OI chain load
          </div>
        )}
      </div>

      {/* Context menu */}
      {ctxMenu && (
        <div style={{
          position: 'fixed', left: ctxMenu.x, top: ctxMenu.y, zIndex: 8500,
          background: 'var(--bg)', border: `1px solid ${CYB.glowBorder}`,
          borderRadius: '6px', padding: '4px', minWidth: '180px', boxShadow: '0 4px 20px rgba(0,0,0,0.6)',
        }} onClick={e => e.stopPropagation()}>
          <button onClick={() => { setShowModal(true); setCtxMenu(null) }} style={{
            display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none',
            cursor: 'pointer', padding: '7px 12px', fontSize: '12px', color: 'var(--text)', borderRadius: '4px',
          }}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.08)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'none')}>
            🎯 Explain GT analysis
          </button>
          <div style={{ height: '1px', background: 'rgba(255,255,255,0.08)', margin: '3px 0' }} />
          <div style={{ padding: '5px 12px 4px', fontSize: '9px', color: 'var(--text3)' }}>
            Components: max pain · PCR · Schelling walls · oracle
          </div>
        </div>
      )}

      {/* Explanation modal */}
      {showModal && (
        <GTExplanationModal gt={gt} spot={spot} onClose={() => setShowModal(false)} />
      )}
    </>
  )
}

// ── Elliott Wave Panel ────────────────────────────────────────────────────────

const EW_WAVE_COLORS: Record<string, string> = {
  '1': 'var(--bull)', '2': 'var(--text3)', '3': '#00e5ff', '4': 'var(--text3)',
  '5': '#b388ff', 'A': 'var(--bear)', 'B': 'var(--text3)', 'C': '#ff6d00',
  '0': 'var(--text3)', '?': 'var(--text3)',
}

const BIAS_COLOR: Record<ElliottWaveState['combinedBias'], string> = {
  'STRONG_BULL': 'var(--bull)', 'BULL': 'var(--bull)', 'NEUTRAL': 'var(--text3)',
  'BEAR': 'var(--bear)', 'STRONG_BEAR': 'var(--bear)',
}

const PATTERN_LABEL: Record<ElliottWaveState['pattern'], string> = {
  'IMPULSE_BULL': '5-Wave Impulse ▲', 'IMPULSE_BEAR': '5-Wave Impulse ▼',
  'CORRECTIVE_BULL': 'ABC Correction ▲', 'CORRECTIVE_BEAR': 'ABC Correction ▼',
  'UNKNOWN': 'Pattern unclear',
}

const EW_WAVE_EXPLAIN: Record<string, { title: string; body: string }> = {
  '1': { title: 'Wave 1 — First Motive Leg', body: 'The initial move in the trend direction. Often weak and widely misidentified as a counter-trend move. Volume may be below average. Most traders still think the prior trend is intact.' },
  '2': { title: 'Wave 2 — First Corrective Pullback', body: 'Retraces Wave 1, typically 38.2%–61.8% (Fibonacci). Looks like the old trend resuming. Must not close below Wave 1\'s start — that would invalidate the count. This is where Elliott wave traders look for entries.' },
  '3': { title: 'Wave 3 — Strongest Motive Leg', body: 'The strongest, longest, and highest-volume wave. Fundamentals usually confirm the trend here. In commodities like crude, Wave 3 often extends 1.618× or 2.618× of Wave 1. Never the shortest impulse wave by rule.' },
  '4': { title: 'Wave 4 — Second Corrective Pullback', body: 'Consolidation after Wave 3\'s strong move. Usually shallower than Wave 2 (38.2% of Wave 3 is common). By rule, Wave 4 must not overlap Wave 1\'s price territory in an impulse. Triangles and flats are common here.' },
  '5': { title: 'Wave 5 — Final Motive Leg', body: 'The last push in the trend direction. Often accompanied by weakening momentum (RSI divergence) even as price makes new highs/lows. Typically equals Wave 1 in length, or extends to 1.618× Wave 1. After Wave 5 completes, expect a significant ABC correction.' },
  'A': { title: 'Wave A — First Corrective Leg', body: 'The opening move of a correction against the prior impulse. Looks like a normal pullback. Internally structured as a 5-wave impulse (in a zigzag) or 3 waves (in a flat). The start of the corrective phase.' },
  'B': { title: 'Wave B — Counter-Trend Bounce', body: 'A retracement against Wave A — the "sucker rally" or "dead cat bounce" in a bear correction. Wave B often retraces 50%–78.6% of Wave A. It is the weakest and most variable wave. Structurally messy (can be flat, triangle, or complex). Trading with Wave B is risky — the C wave follows.' },
  'C': { title: 'Wave C — Final Corrective Leg', body: 'Completes the ABC correction. Moves in the same direction as Wave A. Usually equals Wave A in length (1:1 relationship is the most common projection). Internally a 5-wave structure. After Wave C, the market is set up for a new impulse in the original trend direction.' },
}

const EW_PATTERN_EXPLAIN: Record<ElliottWaveState['pattern'], { short: string; detail: string }> = {
  'IMPULSE_BULL': {
    short: '5-wave bullish impulse — trend is UP',
    detail: 'Classic Elliott 5-wave impulse structure in the BULL direction. Waves 1, 3, 5 are motive (follow the trend upward). Waves 2, 4 are corrective pullbacks. Rule checks: Wave 3 is never the shortest; Wave 4 does not overlap Wave 1; Wave 2 does not go below Wave 1\'s origin. The impulse confirms upward trend structure.',
  },
  'IMPULSE_BEAR': {
    short: '5-wave bearish impulse — trend is DOWN',
    detail: 'Classic Elliott 5-wave impulse in the BEAR direction. Waves 1, 3, 5 drive price lower. Waves 2, 4 are bounces within the downtrend. Same structural rules apply in reverse. A completed 5-wave bear impulse is typically followed by a 3-wave ABC correction upward (a relief rally).',
  },
  'CORRECTIVE_BULL': {
    short: 'ABC correction moving UP — correcting a prior bear impulse',
    detail: 'A 3-wave ABC correction that retraces a prior 5-wave bear impulse. Wave A moves up, Wave B pulls back (partial retracement), and Wave C completes the correction upward. The typical target for the full correction is 38.2%–61.8% of the prior bear impulse. After ABC completes, the prior bear trend often resumes.',
  },
  'CORRECTIVE_BEAR': {
    short: 'ABC correction moving DOWN — correcting a prior bull impulse',
    detail: 'A 3-wave ABC correction retracing a prior 5-wave bull impulse. Wave A drops, Wave B bounces (trap for bulls), and Wave C completes the correction lower. Common C-wave target = Wave A\'s length projected from Wave B\'s end. After ABC ends, expect a new bull impulse to emerge.',
  },
  'UNKNOWN': { short: 'Pattern unclear', detail: 'Insufficient pivot history to classify the wave structure.' },
}

function EWContextMenu({ ctxMenu, selectedTF, availableTFs, onExplain, onSelectTF }: {
  ctxMenu: { x: number; y: number }
  selectedTF: string
  availableTFs: string[]
  onExplain: (() => void) | null
  onSelectTF: (tf: EWTimeframe) => void
}) {
  const btnStyle = (active: boolean, disabled: boolean): React.CSSProperties => ({
    display: 'block', width: '100%', textAlign: 'left',
    background: active ? `${CYB.accent}22` : 'none',
    border: 'none', cursor: disabled ? 'default' : 'pointer',
    padding: '5px 12px', fontSize: '11px',
    color: disabled ? 'var(--text3)' : active ? CYB.accent : 'var(--text)',
    borderRadius: '3px', opacity: disabled ? 0.4 : 1,
  })
  return (
    <div style={{
      position: 'fixed', left: ctxMenu.x, top: ctxMenu.y, zIndex: 8000,
      background: 'var(--bg)', border: `1px solid ${CYB.glowBorder}`,
      borderRadius: '6px', padding: '4px', minWidth: '170px', boxShadow: '0 4px 20px rgba(0,0,0,0.6)',
    }} onClick={e => e.stopPropagation()}>
      {onExplain && (
        <>
          <button style={btnStyle(false, false)} onClick={onExplain}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.08)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'none')}>
            📖 Explain this analysis
          </button>
          <div style={{ height: '1px', background: 'rgba(255,255,255,0.08)', margin: '3px 0' }} />
        </>
      )}
      <div style={{ padding: '3px 12px 4px', fontSize: '9px', color: 'var(--text3)', letterSpacing: '0.1em', fontWeight: 700 }}>TIMEFRAME</div>
      {EW_TF_LABELS.map(tf => {
        const hasData = availableTFs.includes(tf)
        const isActive = tf === selectedTF
        return (
          <button key={tf} style={btnStyle(isActive, !hasData)} onClick={() => hasData && onSelectTF(tf as EWTimeframe)}
            onMouseEnter={e => { if (hasData && !isActive) e.currentTarget.style.background = 'rgba(255,255,255,0.08)' }}
            onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'none' }}>
            {isActive ? '◉' : hasData ? '○' : '·'} {tf}
            {!hasData && <span style={{ fontSize: '9px', opacity: 0.5, marginLeft: '6px' }}>loading…</span>}
          </button>
        )
      })}
    </div>
  )
}

function EWExplanationModal({ ew, spot, composite, onClose }: {
  ew: ElliottWaveState; spot: number; composite: CrudeComposite; onClose: () => void
}) {
  const biasColor = BIAS_COLOR[ew.combinedBias]
  const waveColor = EW_WAVE_COLORS[ew.currentWave] ?? 'var(--text)'
  const patternInfo = EW_PATTERN_EXPLAIN[ew.pattern]
  const waveInfo = EW_WAVE_EXPLAIN[ew.currentWave]

  // Oracle vs EW alignment
  const ewBullish = ew.combinedBias === 'STRONG_BULL' || ew.combinedBias === 'BULL'
  const ewBearish = ew.combinedBias === 'STRONG_BEAR' || ew.combinedBias === 'BEAR'
  const oracleBullish = composite.direction === 'BULL'
  const oracleBearish = composite.direction === 'BEAR'
  const aligned = (ewBullish && oracleBullish) || (ewBearish && oracleBearish)
  const diverged = (ewBullish && oracleBearish) || (ewBearish && oracleBullish)
  const alignColor = aligned ? 'var(--bull)' : diverged ? 'var(--bear)' : 'var(--text3)'
  const alignLabel = aligned ? '✓ ALIGNED' : diverged ? '⚠ DIVERGING' : '~ NEUTRAL'

  // Fibonacci levels grouped
  const w2Levels = ew.levels.filter(l => l.label.includes('W2'))
  const w3Levels = ew.levels.filter(l => l.label.includes('W3') || l.label.includes('1.618') || l.label.includes('2.618'))
  const otherLevels = ew.levels.filter(l => !l.label.includes('W2') && !l.label.includes('W3') && !l.label.includes('1.618') && !l.label.includes('2.618'))

  // Current spot position relative to levels
  const nearestLevel = ew.levels.reduce<EWLevel | null>((best, lv) => {
    if (!best) return lv
    return Math.abs(lv.price - spot) < Math.abs(best.price - spot) ? lv : best
  }, null)
  const distPct = nearestLevel ? ((spot - nearestLevel.price) / nearestLevel.price * 100) : null

  const S: Record<string, React.CSSProperties> = {
    overlay: { position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(0,0,0,0.82)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '12px' },
    modal: { background: 'var(--bg)', border: `1px solid ${CYB.glowBorder}`, borderRadius: '10px', maxWidth: '560px', width: '100%', maxHeight: '88vh', overflowY: 'auto', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '14px' },
    header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' },
    sectionTitle: { fontSize: '9px', fontWeight: 700, color: CYB.glow, letterSpacing: '0.12em', marginBottom: '4px' },
    section: { display: 'flex', flexDirection: 'column', gap: '4px', paddingBottom: '12px', borderBottom: '1px solid rgba(255,255,255,0.05)' },
    body: { fontSize: '11px', color: 'var(--text2)', lineHeight: 1.55 },
    chip: { display: 'inline-block', fontSize: '9px', padding: '2px 6px', borderRadius: '3px', fontWeight: 700, marginRight: '4px' },
    closeBtn: { background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '5px', color: 'var(--text2)', cursor: 'pointer', fontSize: '11px', padding: '3px 10px', flexShrink: 0 },
    levelRow: { display: 'flex', alignItems: 'center', gap: '6px', padding: '3px 0', fontSize: '11px' },
    pivotRow: { display: 'flex', gap: '4px', flexWrap: 'wrap', alignItems: 'center' },
  }

  return (
    <div style={S.overlay} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={S.modal}>
        {/* ── Header ── */}
        <div style={S.header}>
          <div>
            <div style={{ fontSize: '8px', fontWeight: 700, color: CYB.glow, letterSpacing: '0.15em', marginBottom: '4px' }}>{'//ELLIOTT_WAVE  ·  EXPLANATION'}</div>
            <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text)' }}>{PATTERN_LABEL[ew.pattern]}</div>
            <div style={{ fontSize: '10px', color: 'var(--text3)', marginTop: '2px' }}>conf:{Math.round(ew.confidence * 100)}%  ·  {ew.pivots.length} pivots  ·  spot ₹{spot.toFixed(0)}</div>
          </div>
          <button style={S.closeBtn} onClick={onClose}>✕ close</button>
        </div>

        {/* ── Pattern ── */}
        <div style={S.section}>
          <div style={S.sectionTitle}>PATTERN</div>
          <div style={{ fontSize: '11px', color: 'var(--bull)', fontWeight: 700, marginBottom: '3px' }}>{patternInfo.short}</div>
          <div style={S.body}>{patternInfo.detail}</div>
        </div>

        {/* ── Current Wave ── */}
        {waveInfo && (
          <div style={S.section}>
            <div style={S.sectionTitle}>CURRENT WAVE</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '4px' }}>
              <span style={{ fontSize: '22px', fontWeight: 900, color: waveColor, lineHeight: 1 }}>{ew.currentWave}</span>
              <span style={{ fontSize: '11px', fontWeight: 700, color: waveColor }}>{waveInfo.title}</span>
            </div>
            <div style={S.body}>{waveInfo.body}</div>
            <div style={{ marginTop: '6px', fontSize: '10px', color: biasColor, fontWeight: 700 }}>
              Combined bias: {ew.combinedBias.replace('_', ' ')}
            </div>
            <div style={{ fontSize: '10px', color: 'var(--text2)', marginTop: '2px' }}>{ew.combinedNote}</div>
          </div>
        )}

        {/* ── Pivot Sequence ── */}
        {ew.pivots.length >= 2 && (
          <div style={S.section}>
            <div style={S.sectionTitle}>PIVOT SEQUENCE ({ew.pivots.length} pivots)</div>
            <div style={S.pivotRow}>
              {ew.pivots.map((pv, i) => {
                const col = EW_WAVE_COLORS[pv.wave] ?? 'var(--text3)'
                const isLast = i === ew.pivots.length - 1
                const wname = EW_WAVE_EXPLAIN[pv.wave]?.title.split(' — ')[0] ?? `Wave ${pv.wave}`
                return (
                  <span key={pv.ts} title={wname} style={{
                    ...S.chip,
                    background: `${col}22`, border: `1px solid ${col}55`,
                    color: isLast ? col : 'var(--text2)',
                    fontWeight: isLast ? 800 : 600,
                  }}>
                    {pv.wave !== '?' && pv.wave !== '0' ? pv.wave : '?'} {pv.type === 'H' ? '▲' : '▼'} ₹{pv.price.toFixed(0)} <span style={{ opacity: 0.6 }}>{pv.timeStr}</span>
                  </span>
                )
              })}
              <span style={{ ...S.chip, background: `${CYB.accent}22`, border: `1px dashed ${CYB.accent}`, color: CYB.accent }}>
                NOW ₹{spot.toFixed(0)}
              </span>
            </div>
            <div style={{ fontSize: '10px', color: 'var(--text3)', marginTop: '4px' }}>
              Each chip = a confirmed 15-min swing high/low. Hover for wave name.
            </div>
          </div>
        )}

        {/* ── Fibonacci Key Levels ── */}
        {(ew.invalidation != null || ew.primaryTarget != null || ew.levels.length > 0) && (
          <div style={S.section}>
            <div style={S.sectionTitle}>FIBONACCI KEY LEVELS</div>
            {ew.invalidation != null && (
              <div style={S.levelRow}>
                <span style={{ ...S.chip, background: 'rgba(255,80,80,0.15)', border: '1px solid rgba(255,80,80,0.35)', color: 'var(--bear)' }}>INV</span>
                <span style={{ color: 'var(--bear)', fontWeight: 700 }}>₹{ew.invalidation.toFixed(0)}</span>
                <span style={{ color: 'var(--text3)', fontSize: '10px' }}>— Invalidation: if price closes beyond this, the current wave count is wrong. The structure must be re-labelled from scratch.</span>
              </div>
            )}
            {ew.primaryTarget != null && (
              <div style={S.levelRow}>
                <span style={{ ...S.chip, background: `${biasColor}22`, border: `1px solid ${biasColor}44`, color: biasColor }}>TGT</span>
                <span style={{ color: biasColor, fontWeight: 700 }}>₹{ew.primaryTarget.toFixed(0)}</span>
                <span style={{ color: 'var(--text3)', fontSize: '10px' }}>— Primary Elliott wave target for the current wave's completion.</span>
              </div>
            )}
            {w2Levels.length > 0 && (
              <>
                <div style={{ fontSize: '10px', color: 'var(--text3)', marginTop: '4px', marginBottom: '2px' }}>Wave 2 retracement zones (38.2% and 61.8% of Wave 1) — typical pullback targets if Wave 2 is forming:</div>
                {w2Levels.map((lv, i) => {
                  const near = Math.abs(lv.price - spot) / spot < 0.005
                  const rc = lv.role === 'support' ? 'var(--bull)' : 'var(--bear)'
                  return (
                    <div key={i} style={{ ...S.levelRow, opacity: near ? 1 : 0.7 }}>
                      <span style={{ ...S.chip, background: `${rc}15`, border: `1px solid ${rc}33`, color: rc }}>{lv.label}</span>
                      <span style={{ color: near ? rc : 'var(--text)', fontWeight: near ? 700 : 400 }}>₹{lv.price.toFixed(0)}</span>
                      {near && <span style={{ fontSize: '9px', color: CYB.accent }}>← near spot</span>}
                    </div>
                  )
                })}
              </>
            )}
            {w3Levels.length > 0 && (
              <>
                <div style={{ fontSize: '10px', color: 'var(--text3)', marginTop: '4px', marginBottom: '2px' }}>Wave 3 extension targets (1.618× and 2.618× of Wave 1) — where Wave 3 typically terminates:</div>
                {w3Levels.map((lv, i) => {
                  const near = Math.abs(lv.price - spot) / spot < 0.005
                  const rc = lv.role === 'target' ? 'var(--bull)' : 'var(--bear)'
                  return (
                    <div key={i} style={{ ...S.levelRow, opacity: near ? 1 : 0.7 }}>
                      <span style={{ ...S.chip, background: `${rc}15`, border: `1px solid ${rc}33`, color: rc }}>{lv.label}</span>
                      <span style={{ color: near ? rc : 'var(--text)', fontWeight: near ? 700 : 400 }}>₹{lv.price.toFixed(0)}</span>
                      {near && <span style={{ fontSize: '9px', color: CYB.accent }}>← near spot</span>}
                    </div>
                  )
                })}
              </>
            )}
            {otherLevels.length > 0 && otherLevels.map((lv, i) => {
              const near = Math.abs(lv.price - spot) / spot < 0.005
              const rc = lv.role === 'target' || lv.role === 'support' ? 'var(--bull)' : 'var(--bear)'
              return (
                <div key={i} style={{ ...S.levelRow, opacity: near ? 1 : 0.7 }}>
                  <span style={{ ...S.chip, background: `${rc}15`, border: `1px solid ${rc}33`, color: rc }}>{lv.label}</span>
                  <span style={{ color: near ? rc : 'var(--text)', fontWeight: near ? 700 : 400 }}>₹{lv.price.toFixed(0)}</span>
                  {near && <span style={{ fontSize: '9px', color: CYB.accent }}>← near spot</span>}
                </div>
              )
            })}
            {nearestLevel && distPct != null && (
              <div style={{ marginTop: '6px', fontSize: '10px', color: 'var(--text3)' }}>
                Nearest level: <span style={{ color: 'var(--text)' }}>{nearestLevel.label} ₹{nearestLevel.price.toFixed(0)}</span>
                {' '}— spot is <span style={{ color: Math.abs(distPct) < 0.3 ? CYB.accent : 'var(--text2)', fontWeight: 700 }}>{distPct > 0 ? '+' : ''}{distPct.toFixed(2)}%</span> away
              </div>
            )}
          </div>
        )}

        {/* ── Oracle alignment ── */}
        <div style={{ ...S.section, borderBottom: 'none', paddingBottom: 0 }}>
          <div style={S.sectionTitle}>ORACLE vs ELLIOTT WAVE</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '6px' }}>
            <span style={{ fontSize: '13px', fontWeight: 900, color: alignColor }}>{alignLabel}</span>
            <span style={{ fontSize: '10px', color: 'var(--text3)' }}>
              EW: <span style={{ color: biasColor, fontWeight: 700 }}>{ew.combinedBias.replace('_', ' ')}</span>
              {'  ·  '}Oracle: <span style={{ color: composite.direction ? dirColor(composite.direction) : 'var(--text3)', fontWeight: 700 }}>
                {dirArrow(composite.direction)} {(composite.bullProb * 100).toFixed(0)}%B / {(composite.bearProb * 100).toFixed(0)}%Be
              </span>
              {'  ·  '}conf:{Math.round(composite.confidence * 100)}%
            </span>
          </div>
          <div style={S.body}>
            {aligned
              ? `Both the Elliott Wave structure and the Oracle pattern memory agree: ${ewBullish ? 'BULLISH' : 'BEARISH'} bias. When wave structure and historical pattern probability align, the trade setup has higher structural conviction. The Fibonacci ${ew.primaryTarget != null ? `target ₹${ew.primaryTarget.toFixed(0)}` : 'levels above'} serve as a natural exit zone.`
              : diverged
              ? `Elliott Wave structure says ${ewBullish ? 'BULLISH' : 'BEARISH'} but Oracle pattern probability says ${oracleBullish ? 'BULLISH' : 'BEARISH'}. This divergence means the wave count may be at a transition point, or the pattern memory is detecting a regime that contradicts the visible wave structure. Exercise caution — wait for alignment before entering a directional position.`
              : 'No strong directional read from either system at this moment. Market is likely in a corrective or ranging phase. The Elliott wave count is valid but the oracle has low confidence. Best to wait for Wave 3 (if in Wave 2) or post-Wave 5 ABC setup.'}
          </div>
          <div style={{ marginTop: '8px', fontSize: '9px', color: 'var(--text3)', lineHeight: 1.5 }}>
            Elliott Wave is a structural framework (wave labelling from 15-min pivot highs/lows). The Oracle is a pattern-memory system (softmax-weighted kNN over historical microstructure snapshots). They are independent — agreement raises confidence, divergence is a warning.
          </div>
        </div>
      </div>
    </div>
  )
}

const EW_TF_LABELS = ['15m', '1h', '4h', '1d', '1w', '1M'] as const
type EWTimeframe = typeof EW_TF_LABELS[number]

function ElliottWavePanel({ ew, ewByTF, spot, composite }: {
  ew: ElliottWaveState | null | undefined
  ewByTF?: Partial<Record<string, ElliottWaveState>>
  spot: number
  composite: CrudeComposite
}) {
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)
  const [showModal, setShowModal] = useState(false)
  const [selectedTF, setSelectedTF] = useState<EWTimeframe>('15m')

  // Active EW data for the selected timeframe
  const activeEW: ElliottWaveState | null | undefined =
    selectedTF === '15m' ? ew : (ewByTF?.[selectedTF] ?? null)

  useEffect(() => {
    const close = () => setCtxMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [])

  useEffect(() => {
    if (!showModal) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowModal(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showModal])

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY })
  }

  // Which TFs have data available
  const availableTFs = EW_TF_LABELS.filter(tf =>
    tf === '15m' ? (ew && ew.pattern !== 'UNKNOWN') : !!(ewByTF?.[tf] && ewByTF[tf]!.pattern !== 'UNKNOWN')
  )

  if (!activeEW || activeEW.pattern === 'UNKNOWN') {
    return (
      <>
        <div onContextMenu={handleContextMenu} style={{ padding: '8px 10px', background: CYB.panel, borderRadius: '6px', border: `1px solid ${CYB.glowBorder}`, cursor: 'context-menu' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '8px', fontWeight: 700, color: CYB.glow, letterSpacing: '0.15em' }}>{'//ELLIOTT_WAVE'}</span>
            <span style={{ fontSize: '9px', color: 'var(--text3)' }}>
              {selectedTF === '15m' ? 'accumulating 15-min candle history…' : `loading ${selectedTF} data…`}
            </span>
            <span style={{ flex: 1 }} />
            {/* Timeframe pills */}
            <div style={{ display: 'flex', gap: '2px' }}>
              {EW_TF_LABELS.map(tf => {
                const hasData = tf === '15m' ? !!(ew && ew.pattern !== 'UNKNOWN') : !!(ewByTF?.[tf] && ewByTF[tf]!.pattern !== 'UNKNOWN')
                return (
                  <button key={tf} onClick={() => setSelectedTF(tf)} style={{
                    background: selectedTF === tf ? `${CYB.accent}33` : 'transparent',
                    border: `1px solid ${selectedTF === tf ? CYB.accent : 'rgba(255,255,255,0.12)'}`,
                    color: selectedTF === tf ? CYB.accent : hasData ? 'var(--text2)' : 'var(--text3)',
                    borderRadius: '3px', padding: '1px 5px', fontSize: '8px', cursor: 'pointer', fontWeight: selectedTF === tf ? 700 : 400,
                    opacity: hasData ? 1 : 0.4,
                  }}>{tf}</button>
                )
              })}
            </div>
          </div>
        </div>
        {ctxMenu && (
          <EWContextMenu ctxMenu={ctxMenu} selectedTF={selectedTF} availableTFs={availableTFs}
            onExplain={activeEW && activeEW.pattern !== 'UNKNOWN' ? () => { setShowModal(true); setCtxMenu(null) } : null}
            onSelectTF={(tf: EWTimeframe) => { setSelectedTF(tf); setCtxMenu(null) }} />
        )}
      </>
    )
  }

  const biasColor = BIAS_COLOR[activeEW.combinedBias]
  const isStrong = activeEW.combinedBias === 'STRONG_BULL' || activeEW.combinedBias === 'STRONG_BEAR'
  const waveColor = EW_WAVE_COLORS[activeEW.currentWave] ?? 'var(--text)'

  const pivots = activeEW.pivots
  const minP = Math.min(...pivots.map(p => p.price))
  const maxP = Math.max(...pivots.map(p => p.price))
  const range = maxP - minP || 1

  return (
    <>
      <div onContextMenu={handleContextMenu} style={{ padding: '8px 10px', background: CYB.panel, borderRadius: '6px', border: `1px solid ${CYB.glowBorder}`, display: 'flex', flexDirection: 'column', gap: '6px', cursor: 'context-menu' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '8px', fontWeight: 700, color: CYB.glow, letterSpacing: '0.15em' }}>{'//ELLIOTT_WAVE'}</span>
          <span style={{ fontSize: '10px', color: 'var(--text2)', fontWeight: 600 }}>{PATTERN_LABEL[activeEW.pattern]}</span>
          <span style={{ fontSize: '9px', color: 'var(--text3)' }}>conf:{Math.round(activeEW.confidence * 100)}%</span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: '9px', color: 'var(--text3)' }}>{selectedTF} pivots:{activeEW.pivots.length}</span>
          {/* Timeframe pills */}
          <div style={{ display: 'flex', gap: '2px' }}>
            {EW_TF_LABELS.map(tf => {
              const hasData = tf === '15m' ? !!(ew && ew.pattern !== 'UNKNOWN') : !!(ewByTF?.[tf] && ewByTF[tf]!.pattern !== 'UNKNOWN')
              return (
                <button key={tf} onClick={e => { e.stopPropagation(); setSelectedTF(tf) }} style={{
                  background: selectedTF === tf ? `${CYB.accent}33` : 'transparent',
                  border: `1px solid ${selectedTF === tf ? CYB.accent : 'rgba(255,255,255,0.12)'}`,
                  color: selectedTF === tf ? CYB.accent : hasData ? 'var(--text2)' : 'var(--text3)',
                  borderRadius: '3px', padding: '1px 5px', fontSize: '8px', cursor: 'pointer', fontWeight: selectedTF === tf ? 700 : 400,
                  opacity: hasData ? 1 : 0.4,
                }}>{tf}</button>
              )
            })}
          </div>
        </div>

        {/* Current wave badge + combined bias */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
            <span style={{ fontSize: '9px', color: 'var(--text3)' }}>WAVE</span>
            <span style={{ fontSize: '20px', fontWeight: 900, color: waveColor, lineHeight: 1 }}>{activeEW.currentWave}</span>
          </div>
          <div style={{ width: '1px', height: '24px', background: 'rgba(255,255,255,0.1)' }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: '10px', fontWeight: 700, color: biasColor }}>
              {isStrong ? '⚡ ' : ''}{activeEW.combinedBias.replace('_', ' ')}
            </span>
            <span style={{ fontSize: '9px', color: 'var(--text2)', lineHeight: 1.3 }}>{activeEW.combinedNote}</span>
          </div>
        </div>

        {/* Pivot sequence mini-chart */}
        {pivots.length >= 3 && (
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: '2px', overflowX: 'auto' }}>
            {pivots.map((pv, i) => {
              const heightPct = (pv.price - minP) / range
              const barH = Math.max(12, Math.round(heightPct * 40) + 12)
              const isH = pv.type === 'H'
              const col = EW_WAVE_COLORS[pv.wave] ?? 'var(--text3)'
              const isCurrent = i === pivots.length - 1
              return (
                <div key={pv.ts} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1px', minWidth: '28px' }}>
                  <span style={{ fontSize: '9px', fontWeight: 700, color: col, opacity: isCurrent ? 1 : 0.75 }}>
                    {pv.wave !== '?' && pv.wave !== '0' ? pv.wave : ''}
                  </span>
                  <div style={{
                    width: '20px', height: `${barH}px`,
                    background: isH ? `linear-gradient(180deg, ${col}99, ${col}44)` : `linear-gradient(0deg, ${col}99, ${col}44)`,
                    border: isCurrent ? `1px solid ${col}` : '1px solid rgba(255,255,255,0.1)',
                    borderRadius: '2px',
                    position: 'relative',
                  }}>
                    <span style={{ position: 'absolute', top: isH ? '-1px' : 'auto', bottom: isH ? 'auto' : '-1px', left: '50%', transform: 'translateX(-50%)', fontSize: '7px', color: col }}>
                      {isH ? '▲' : '▼'}
                    </span>
                  </div>
                  <span style={{ fontSize: '7px', color: 'var(--text3)', whiteSpace: 'nowrap' }}>
                    {pv.price >= 1000 ? pv.price.toFixed(0) : pv.price.toFixed(1)}
                  </span>
                  <span style={{ fontSize: '7px', color: 'var(--text3)', opacity: 0.7 }}>{pv.timeStr}</span>
                </div>
              )
            })}
            {/* Current spot marker */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1px', minWidth: '28px' }}>
              <span style={{ fontSize: '9px', color: CYB.accent }}>NOW</span>
              <div style={{ width: '20px', height: `${Math.max(12, Math.round(((spot - minP) / range) * 40) + 12)}px`, border: `1px dashed ${CYB.accent}`, borderRadius: '2px', background: `${CYB.accent}22` }} />
              <span style={{ fontSize: '7px', color: CYB.accent }}>{spot.toFixed(0)}</span>
            </div>
          </div>
        )}

        {/* Key levels */}
        {activeEW.levels.length > 0 && (
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {activeEW.primaryTarget != null && (
              <span style={{ fontSize: '9px', padding: '1px 5px', background: `${biasColor}22`, border: `1px solid ${biasColor}44`, borderRadius: '3px', color: biasColor, fontWeight: 700 }}>
                TGT ₹{activeEW.primaryTarget.toFixed(0)}
              </span>
            )}
            {activeEW.invalidation != null && (
              <span style={{ fontSize: '9px', padding: '1px 5px', background: 'rgba(255,100,100,0.1)', border: '1px solid rgba(255,100,100,0.3)', borderRadius: '3px', color: 'var(--bear)', fontWeight: 700 }}>
                INV ₹{activeEW.invalidation.toFixed(0)}
              </span>
            )}
            {activeEW.levels.slice(0, 4).map((lv, i) => {
              const isNearSpot = Math.abs(lv.price - spot) / spot < 0.005
              const roleColor = lv.role === 'target' ? 'var(--bull)' : lv.role === 'support' ? 'var(--bull)' : 'var(--bear)'
              return (
                <span key={i} style={{ fontSize: '9px', padding: '1px 5px', background: isNearSpot ? `${roleColor}22` : 'transparent', border: `1px solid ${roleColor}44`, borderRadius: '3px', color: isNearSpot ? roleColor : 'var(--text3)' }}>
                  {lv.label} ₹{lv.price.toFixed(0)}
                </span>
              )
            })}
          </div>
        )}

        {/* Oracle context row */}
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '4px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '8px', color: 'var(--text3)' }}>ORACLE</span>
          <span style={{ fontSize: '10px', fontWeight: 700, color: composite.direction ? dirColor(composite.direction) : 'var(--text3)' }}>
            {dirArrow(composite.direction)} {(composite.bullProb * 100).toFixed(0)}%B / {(composite.bearProb * 100).toFixed(0)}%Be
          </span>
          <span style={{ fontSize: '9px', color: 'var(--text3)' }}>conf:{Math.round(composite.confidence * 100)}%</span>
          <span style={{ fontSize: '9px', color: 'var(--text3)' }}>pred:{fmtPct(composite.predictedMove, 2)}</span>
        </div>
      </div>

      {/* Right-click context menu */}
      {ctxMenu && (
        <EWContextMenu ctxMenu={ctxMenu} selectedTF={selectedTF} availableTFs={availableTFs}
          onExplain={() => { setShowModal(true); setCtxMenu(null) }}
          onSelectTF={tf => { setSelectedTF(tf); setCtxMenu(null) }} />
      )}

      {/* Explanation modal */}
      {showModal && activeEW && (
        <EWExplanationModal ew={activeEW} spot={spot} composite={composite} onClose={() => setShowModal(false)} />
      )}
    </>
  )
}

function SysLogPanel({ entries, product }: { entries: SysLogEntry[]; product: string }) {
  const [showCount, setShowCount] = useState(4)

  const reversed = entries.length > 0 ? [...entries].reverse() : []
  const visible = reversed.slice(0, showCount)
  const hasMore = showCount < reversed.length
  const resolved = entries.filter(e => e.resolved)
  const correctCount = resolved.filter(e => e.correct).length
  const targetHitCount = resolved.filter(e => e.targetHit).length
  const accuracy = resolved.length > 0 ? Math.round((correctCount / resolved.length) * 100) : 0

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: '4px',
      padding: '8px 10px', background: CYB.panel, borderRadius: '6px',
      border: `1px solid ${CYB.glowBorder}`,
    }}>
      <style>{`
        @media (max-width: 640px) {
          .syslog-head { display: none !important; }
          .syslog-entries > div {
            display: flex !important;
            flex-wrap: wrap !important;
            gap: 5px !important;
            font-size: 9px !important;
            grid-template-columns: unset !important;
          }
        }
      `}</style>
      {/* HEADER */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '2px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '8px', fontWeight: 700, color: CYB.glow, letterSpacing: '0.15em' }}>{'//SYS_LOG'}</span>
        <span style={{ fontSize: '8px', color: 'var(--text3)' }}>
          {resolved.length} resolved · {accuracy}% win
          {targetHitCount > 0 && ` · ${targetHitCount} target-hit`}
        </span>
        <span style={{ flex: 1 }} />
      </div>

      {/* Scrollable table wrapper for mobile */}
      <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>

      {/* COLUMN HEADERS */}
      <div className="syslog-head" style={{
        display: 'grid', gridTemplateColumns: '44px 90px 68px 68px 68px 52px 70px 60px 62px 62px 72px',
        gap: '4px', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.08)',
        fontSize: '11px', color: 'var(--text3)', fontWeight: 600, letterSpacing: '0.08em',
        minWidth: '720px',
      }}>
        <span>TIME</span><span>PRED</span><span>ENTRY</span><span>TARGET</span><span>NOW</span><span>%→TGT</span><span>STATUS</span><span>STRIKE</span><span>OPT IN</span><span>OPT TGT</span><span>P&amp;L</span>
      </div>

      {/* ENTRIES */}
      <div className="syslog-entries" style={{ minWidth: '720px' }}>
        {visible.map(e => {
          const pending = !e.resolved
          const liveInDir = (pending ? e.liveMove : e.outcomeMove) ?? 0
          const sameDir = (e.predMove > 0 && liveInDir > 0) || (e.predMove < 0 && liveInDir < 0)
          const targetPct = e.predMove !== 0 && sameDir
            ? Math.max(0, Math.min(100, Math.round(Math.abs(liveInDir / e.predMove) * 100)))
            : 0

          const spotNow = pending ? e.liveSpot : e.spotAtOutcome
          const targetSpot = e.predSpot
          const nowColor = spotNow != null
            ? (sameDir ? 'var(--bull)' : liveInDir === 0 ? 'var(--text3)' : 'var(--bear)')
            : 'var(--text3)'
          const pctColor = targetPct >= 80 ? 'var(--bull)' : targetPct >= 50 ? 'var(--text)' : 'var(--text3)'

          const hasOpt = e.optStrike != null && e.optType != null
          const optColor = dirColor(e.predMove >= 0 ? 'BULL' : 'BEAR')

          // P&L computation: resolved entries — use originalOptEntry (chain start) → final optTarget
          const lotSize = MCX_LOT[product] ?? 100
          const chainOptEntry = e.originalOptEntry ?? e.optEntry  // chain start price
          const rc = e.repeatCount ?? 1
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let pnlNode: any = '—'
          if (hasOpt && chainOptEntry != null && e.optTarget != null) {
            if (!e.resolved) {
              pnlNode = <span style={{ color: 'var(--text3)', fontSize: '11px' }}>LIVE</span>
            } else {
              const gross = (e.optTarget - chainOptEntry) * lotSize
              const fees  = mcxOptFees(chainOptEntry, e.optTarget, lotSize)
              const net   = gross - fees
              const col   = net >= 0 ? 'var(--bull)' : 'var(--bear)'
              const label = `${net >= 0 ? '+' : ''}₹${Math.round(net)}`
              const feeTip = `chain entry ₹${chainOptEntry.toFixed(1)} → exit ₹${e.optTarget.toFixed(1)}  gross ₹${Math.round(gross)}  fees ₹${Math.round(fees)}  lot=${lotSize}  ×${rc} cycles`
              pnlNode = (
                <span title={feeTip} style={{ color: col, fontWeight: 700, fontSize: '12px', cursor: 'help' }}>
                  {label}
                </span>
              )
            }
          }

          return (
            <div key={e.cycleTs} style={{
              padding: '5px 0', borderBottom: '1px solid rgba(255,255,255,0.03)',
              opacity: e.resolved ? 1 : 0.8,
            }}>
              {/* EXTENSION SUB-ROWS — prior hit segments (oldest first) */}
              {e.extends && e.extends.map((ext, i) => {
                // Always use parent trade direction — sub-rows are segments of the same trade
                const tradeDir = e.predDir ?? (e.predMove >= 0 ? 'BULL' : 'BEAR')
                const extColor = dirColor(tradeDir)
                return (
                  <div key={ext.ts} style={{
                    display: 'grid', gridTemplateColumns: '44px 90px 68px 68px 68px 52px 70px 60px 62px 62px 72px',
                    gap: '4px', alignItems: 'center', fontSize: '11px', opacity: 0.65,
                    paddingLeft: '2px', marginBottom: '1px',
                  }}>
                    <span style={{ color: 'var(--text3)', fontSize: '10px' }}>└{ext.cycleTime}</span>
                    <span style={{ color: extColor }}>
                      {tradeDir === 'BULL' ? '▲' : '▼'} {fmtPct(ext.prevPredMove, 3)}
                    </span>
                    <span style={{ color: 'var(--text)' }}>₹{ext.spotAtExtend.toFixed(0)}</span>
                    <span style={{ color: extColor, opacity: 0.7 }}>—</span>
                    <span />
                    <span style={{ color: CYB.accent, fontWeight: 700, textAlign: 'right' }}>100%</span>
                    <span style={{ color: CYB.accent, fontWeight: 700, fontSize: '11px' }}>🎯×{e.extends!.length - i}</span>
                    <span /><span /><span />
                  </div>
                )
              })}

              {/* MAIN ROW — current cycle state */}
              <div style={{
                display: 'grid', gridTemplateColumns: '44px 90px 68px 68px 68px 52px 70px 60px 62px 62px 72px',
                gap: '4px', alignItems: 'center', fontSize: '13px',
              }}>
                {/* TIME + repeat badge */}
                <span style={{ color: 'var(--text3)', fontSize: '12px' }}>
                  {e.cycleTime}
                  {rc > 1 && (
                    <span style={{ color: CYB.accent, fontSize: '9px', fontWeight: 800, marginLeft: '2px' }}>×{rc}</span>
                  )}
                </span>

                {/* PREDICTION — direction + predicted % */}
                <span style={{
                  color: dirColor(e.predMove >= 0 ? 'BULL' : 'BEAR'), fontWeight: 700, fontSize: '13px',
                }}>
                  {e.predMove >= 0 ? '▲' : '▼'} {fmtPct(e.predMove, 3)}
                </span>

                {/* ENTRY PRICE */}
                <span style={{ color: 'var(--text)', fontSize: '12px', fontWeight: 600 }}>
                  ₹{e.spotAtPred.toFixed(0)}
                </span>

                {/* TARGET PRICE */}
                <span style={{ color: dirColor(e.predMove >= 0 ? 'BULL' : 'BEAR'), fontSize: '12px', fontWeight: 600, opacity: 0.85 }}>
                  ₹{targetSpot.toFixed(0)}
                </span>

                {/* CURRENT PRICE */}
                <span style={{ color: nowColor, fontSize: '12px', fontWeight: 600 }}>
                  {spotNow != null ? `₹${spotNow.toFixed(0)}` : '—'}
                </span>

                {/* % TO TARGET */}
                <span style={{ color: pctColor, fontSize: '12px', fontWeight: 700, textAlign: 'right' }}>
                  {e.resolved
                    ? (e.targetHit ? '100%' : (sameDir ? `${targetPct}%` : '0%'))
                    : `${targetPct}%`
                  }
                </span>

                {/* STATUS */}
                <span style={{ fontSize: '12px', fontWeight: 700 }}>
                  {e.resolved ? (
                    e.targetHit
                      ? <span style={{ color: CYB.accent }}>🎯HIT</span>
                      : <span style={{ color: e.correct ? 'var(--bull)' : 'var(--bear)' }}>{e.correct ? '✓' : '✗'}</span>
                  ) : (
                    e.targetHit
                      ? <span style={{ color: CYB.accent }}>🎯HIT</span>
                      : <span style={{ color: CYB.accent }}>LIVE</span>
                  )}
                </span>

                {/* STRIKE */}
                <span style={{ color: hasOpt ? optColor : 'var(--text3)', fontWeight: hasOpt ? 700 : 400, fontSize: '12px' }}>
                  {hasOpt ? `${e.optStrike}${e.optType}` : '—'}
                </span>

                {/* OPT IN — show chain start price for extended trades */}
                <span style={{ color: 'var(--text2)', fontSize: '12px' }}>
                  {hasOpt && chainOptEntry != null ? `₹${chainOptEntry.toFixed(1)}` : '—'}
                </span>

                {/* OPT TGT */}
                <span style={{ color: hasOpt ? optColor : 'var(--text3)', fontSize: '12px', fontWeight: hasOpt ? 600 : 400 }}>
                  {hasOpt && e.optTarget != null ? `₹${e.optTarget.toFixed(1)}` : '—'}
                </span>

                {/* P&L */}
                <span>{pnlNode}</span>
              </div>
            </div>
          )
        })}

        {/* MORE BUTTON */}
        {hasMore && (
          <button onClick={() => setShowCount(c => c + 3)} style={{
            display: 'block', width: '100%', marginTop: '4px', padding: '3px 0',
            fontSize: '8px', fontWeight: 700, fontFamily: 'inherit', letterSpacing: '0.1em',
            color: CYB.glow, background: 'transparent', border: `1px solid ${CYB.glowBorder}`,
            borderRadius: '2px', cursor: 'pointer', opacity: 0.7,
          }}>
            +{Math.min(3, reversed.length - showCount)} MORE ({reversed.length - showCount} remaining)
          </button>
        )}
      </div> {/* end scroll wrapper */}

        {/* EMPTY STATE */}
        {entries.length === 0 && (
          <div style={{ fontSize: '9px', color: 'var(--text3)', textAlign: 'center', padding: '4px 0' }}>first prediction in ~20m</div>
        )}
      </div>
    </div>
  )
}

// ── SysLog V2 Panel ───────────────────────────────────────────────────────────
// Scrollable event feed built from v2 oracle snapshots accumulated in-browser.
// Each new `v2` prop update is pushed into a 50-entry ring buffer held in useRef.

interface SyslogV2Entry {
  ts: number
  timeStr: string
  sessionKey: MCXSession
  dir: 'BULL' | 'BEAR' | null
  bullPct: number
  bearPct: number
  sim: number
  n: number
  move20: number
  cdZ: number
  cusumAlarm: 'BULL' | 'BEAR' | null
  kalmanVel: number
  warming: boolean
}

const SESSION_EMOJI: Record<MCXSession, string> = { morning: '🌅', afternoon: '🌤', evening: '🌙' }
const SYSLOG_V2_MAX = 50

function SyslogV2Panel({ v2 }: { v2: CrudeV2 | null | undefined }) {
  const ringRef = useRef<SyslogV2Entry[]>([])
  const lastTsRef = useRef<number>(0)
  const [, forceUpdate] = useState(0)

  useEffect(() => {
    if (!v2) return
    const now = Date.now()
    // Gate: only log during MCX market hours (09:00–23:30 IST, weekdays)
    // IST = UTC + 5:30
    const istMs = now + 5.5 * 3_600_000
    const d = new Date(istMs)
    const dow = d.getUTCDay() // 0=Sun, 6=Sat
    if (dow === 0 || dow === 6) return // weekend: MCX closed
    const istH = d.getUTCHours()
    const istM = d.getUTCMinutes()
    const minuteOfDay = istH * 60 + istM
    if (minuteOfDay < 9 * 60 || minuteOfDay >= 23 * 60 + 30) return // outside 09:00–23:30
    // Deduplicate: only push if at least 15s since last entry (avoids flooding on fast polls)
    if (now - lastTsRef.current < 15_000) return

    const pred = v2.prediction
    const flow = v2.flowState
    const warming = pred.status !== 'ready' || pred.nResolved < 3

    // reuse d / istMs already computed above in the market-hours gate
    const hh = String(d.getUTCHours()).padStart(2, '0')
    const mm = String(d.getUTCMinutes()).padStart(2, '0')
    const ss = String(d.getUTCSeconds()).padStart(2, '0')

    const entry: SyslogV2Entry = {
      ts: now,
      timeStr: `${hh}:${mm}:${ss}`,
      sessionKey: v2.sessionKey,
      dir: warming ? null : pred.direction,
      bullPct: Math.round(pred.bullProb * 100),
      bearPct: Math.round(pred.bearProb * 100),
      sim: pred.topSim,
      n: pred.nResolved,
      move20: pred.predictedMove,
      cdZ: flow?.cdZScore ?? 0,
      cusumAlarm: flow?.cusumAlarm ?? null,
      kalmanVel: v2.kalmanVelocity,
      warming,
    }

    const ring = ringRef.current
    ring.push(entry)
    if (ring.length > SYSLOG_V2_MAX) ring.splice(0, ring.length - SYSLOG_V2_MAX)
    lastTsRef.current = now
    forceUpdate(n => n + 1)
  }, [v2])

  const entries = [...ringRef.current].reverse()  // newest first

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: '4px',
      padding: '8px 10px', background: CYB.panel, borderRadius: '6px',
      border: `1px solid ${CYB.glowBorder}`, fontFamily: 'monospace',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '2px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '8px', fontWeight: 700, color: CYB.glow, letterSpacing: '0.15em' }}>{'//SYSLOG_V2'}</span>
        <span style={{ fontSize: '8px', color: 'var(--text3)' }}>
          oracle v2 · session-scoped · detrended · {entries.length} events
        </span>
        {v2 && (
          <span style={{ fontSize: '8px', color: CYB.glow, marginLeft: 'auto' }}>
            {SESSION_EMOJI[v2.sessionKey]} {v2.sessionKey} · {v2.sessionPatternCount}pat
          </span>
        )}
      </div>

      {/* Warming notice */}
      {v2 && (v2.prediction.status !== 'ready' || v2.prediction.nResolved < 3) && (
        <div style={{
          fontSize: '9px', color: 'var(--text3)', padding: '5px 8px', borderRadius: '3px',
          background: 'rgba(255,255,255,0.03)', border: `1px solid ${CYB.glowBorder}`,
        }}>
          {'> '}{v2.prediction.nResolved === 0
            ? `ACCUMULATING · ${v2.sessionPatternCount} snapshots · waiting 20min for outcomes`
            : `WARMING UP · ${v2.prediction.nResolved}/3 resolved patterns`}
        </div>
      )}

      {/* Scrollable log */}
      <div style={{
        maxHeight: '320px', overflowY: 'auto', overflowX: 'hidden',
        display: 'flex', flexDirection: 'column', gap: '1px',
        scrollbarWidth: 'thin',
        scrollbarColor: 'rgba(255,255,255,0.1) transparent',
      } as React.CSSProperties}>
        {entries.length === 0 ? (
          <div style={{ fontSize: '9px', color: 'var(--text3)', padding: '8px 0', textAlign: 'center', opacity: 0.6 }}>
            {'> waiting for first v2 oracle snapshot...'}
          </div>
        ) : entries.map(e => {
          const rowBg = e.warming
            ? 'transparent'
            : e.dir === 'BULL'
              ? 'rgba(34,197,94,0.06)'
              : e.dir === 'BEAR'
                ? 'rgba(239,68,68,0.06)'
                : 'transparent'
          const dirCol = e.dir === 'BULL' ? 'var(--bull)' : e.dir === 'BEAR' ? 'var(--bear)' : 'var(--text3)'
          const confPct = e.dir === 'BULL' ? e.bullPct : e.dir === 'BEAR' ? e.bearPct : Math.max(e.bullPct, e.bearPct)
          const kvSign = e.kalmanVel >= 0 ? '+' : ''
          const cdZSign = e.cdZ >= 0 ? '+' : ''

          return (
            <div key={e.ts} style={{
              padding: '3px 6px', borderRadius: '3px',
              background: rowBg,
              border: '1px solid transparent',
              borderColor: e.warming ? 'transparent' : CYB.glowBorder,
              fontSize: '11px',
              display: 'flex', alignItems: 'baseline', gap: '6px',
              flexWrap: 'wrap',
              lineHeight: '1.4',
            }}>
              {/* Timestamp */}
              <span style={{ color: 'var(--text3)', fontSize: '10px', flexShrink: 0, minWidth: '60px' }}>
                [{e.timeStr}]
              </span>

              {/* Session */}
              <span style={{ color: CYB.glow, fontSize: '9px', flexShrink: 0 }}>
                {SESSION_EMOJI[e.sessionKey]}{e.sessionKey.slice(0, 3).toUpperCase()}
              </span>

              {/* Direction + confidence */}
              {e.warming ? (
                <span style={{ color: 'var(--text3)', fontSize: '10px', opacity: 0.7 }}>
                  WARM {e.n}/3
                </span>
              ) : (
                <>
                  <span style={{ color: dirCol, fontWeight: 700, flexShrink: 0 }}>
                    {e.dir === 'BULL' ? '▲' : e.dir === 'BEAR' ? '▼' : '·'}
                    {' '}{e.dir ?? 'NEUT'}{' '}{confPct}%
                  </span>

                  {/* Predicted move */}
                  <span style={{ color: e.move20 >= 0 ? 'var(--bull)' : 'var(--bear)', fontSize: '10px', flexShrink: 0 }}>
                    {e.move20 >= 0 ? '+' : ''}{e.move20.toFixed(3)}%
                  </span>

                  {/* Similarity + patterns */}
                  <span style={{ color: 'var(--text3)', fontSize: '10px', flexShrink: 0 }}>
                    sim={e.sim.toFixed(2)} n={e.n}
                  </span>

                  {/* CD Z-score */}
                  <span style={{ color: e.cdZ >= 0 ? 'var(--bull)' : 'var(--bear)', fontSize: '10px', flexShrink: 0 }}>
                    cd={cdZSign}{e.cdZ.toFixed(1)}σ
                  </span>

                  {/* Kalman velocity */}
                  <span style={{ color: 'var(--text3)', fontSize: '10px', flexShrink: 0 }}>
                    kv={kvSign}{e.kalmanVel.toFixed(1)}
                  </span>

                  {/* CUSUM alarm */}
                  {e.cusumAlarm && (
                    <span style={{
                      color: e.cusumAlarm === 'BULL' ? 'var(--bull)' : 'var(--bear)',
                      fontSize: '9px', fontWeight: 700, flexShrink: 0,
                    }}>
                      ⚡{e.cusumAlarm}
                    </span>
                  )}
                </>
              )}
            </div>
          )
        })}
      </div>

      {/* Live current state summary */}
      {v2 && v2.prediction.status === 'ready' && v2.prediction.nResolved >= 3 && (() => {
        const p = v2.prediction
        const f = v2.flowState
        const d = p.direction
        const dc = d === 'BULL' ? 'var(--bull)' : d === 'BEAR' ? 'var(--bear)' : 'var(--text3)'
        const conf = d === 'BULL' ? Math.round(p.bullProb * 100) : d === 'BEAR' ? Math.round(p.bearProb * 100) : Math.round(Math.max(p.bullProb, p.bearProb) * 100)
        return (
          <div style={{
            marginTop: '4px', padding: '5px 8px', borderRadius: '3px',
            background: 'rgba(255,255,255,0.03)', border: `1px solid ${CYB.glowBorder}`,
            fontSize: '10px', display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center',
          }}>
            <span style={{ color: CYB.glow, fontSize: '8px', letterSpacing: '0.1em' }}>NOW</span>
            <span style={{ color: dc, fontWeight: 700 }}>{d === 'BULL' ? '▲' : d === 'BEAR' ? '▼' : '·'} {d ?? 'NEUT'} {conf}%</span>
            <span style={{ color: 'var(--text3)' }}>sim={p.topSim.toFixed(2)}</span>
            {f && (
              <>
                <span style={{ color: f.cdZScore >= 0 ? 'var(--bull)' : 'var(--bear)' }}>
                  cd={f.cdZScore >= 0 ? '+' : ''}{f.cdZScore.toFixed(1)}σ
                </span>
                {f.cusumAlarm && (
                  <span style={{ color: f.cusumAlarm === 'BULL' ? 'var(--bull)' : 'var(--bear)', fontWeight: 700 }}>
                    ⚡{f.cusumAlarm}
                  </span>
                )}
              </>
            )}
            <span style={{ color: 'var(--text3)' }}>kv={v2.kalmanVelocity >= 0 ? '+' : ''}{v2.kalmanVelocity.toFixed(1)}</span>
          </div>
        )
      })()}
    </div>
  )
}

// ── P20C Swing Log Panel ──────────────────────────────────────────────────────

function P20CSysLogPanel({ entries, product }: { entries: P20CSwingEntry[]; product: string }) {
  const [showCount, setShowCount] = useState(6)
  const lotSize = MCX_LOT[product] ?? 100
  const reversed = [...entries].reverse()
  const visible = reversed.slice(0, showCount)

  const resolved  = entries.filter(e => e.resolved)
  const correct   = resolved.filter(e => e.correct).length
  const accuracy  = resolved.length > 0 ? Math.round((correct / resolved.length) * 100) : 0
  const totalPnl  = resolved.reduce((s, e) => s + (e.pnlNet ?? 0), 0)
  const pnlColor  = totalPnl >= 0 ? 'var(--bull)' : 'var(--bear)'

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: '4px',
      padding: '8px 10px', background: CYB.panel, borderRadius: '6px',
      border: `1px solid ${CYB.glowBorder}`,
    }}>
      {/* HEADER */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '2px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '8px', fontWeight: 700, color: CYB.glow, letterSpacing: '0.15em' }}>{'//P20C_SWINGS'}</span>
        <span style={{ fontSize: '8px', color: 'var(--text3)' }}>
          {resolved.length} resolved · {accuracy}% win
          {resolved.length > 0 && <span style={{ color: pnlColor, marginLeft: '4px' }}>· {totalPnl >= 0 ? '+' : ''}₹{Math.round(totalPnl)}</span>}
        </span>
      </div>

      <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
        {/* COLUMN HEADERS */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '44px 58px 58px 58px 58px 42px 58px 58px 58px 60px',
          gap: '4px', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.08)',
          fontSize: '11px', color: 'var(--text3)', fontWeight: 600, letterSpacing: '0.08em',
          minWidth: '580px',
        }}>
          <span>TIME</span><span>DIR</span><span>SCALED</span><span>ENTRY</span>
          <span>EXIT</span><span>DUR</span><span>MOVE%</span>
          <span>OPT IN</span><span>OPT OUT</span><span>P&amp;L</span>
        </div>

        {/* ROWS */}
        <div style={{ minWidth: '580px' }}>
          {visible.map(e => {
            const dCol = dirColor(e.direction)
            const scaledEnd = e.scaledAtEnd ?? null
            const isLive = !e.resolved
            const moveCol = e.outcomeMove == null ? 'var(--text3)'
              : (e.direction === 'BULL' ? (e.outcomeMove >= 0 ? 'var(--bull)' : 'var(--bear)')
                                        : (e.outcomeMove <= 0 ? 'var(--bull)' : 'var(--bear)'))
            const pnlVal = e.pnlNet
            const pnlCol = pnlVal == null ? 'var(--text3)' : pnlVal >= 0 ? 'var(--bull)' : 'var(--bear)'
            const pnlTip = pnlVal != null && e.pnlGross != null
              ? `gross ₹${Math.round(e.pnlGross)}  lot=${lotSize}`
              : undefined

            return (
              <div key={e.id} style={{
                padding: '5px 0', borderBottom: '1px solid rgba(255,255,255,0.03)',
                opacity: e.resolved ? 1 : 0.85,
              }}>
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: '44px 58px 58px 58px 58px 42px 58px 58px 58px 60px',
                  gap: '4px', alignItems: 'center', fontSize: '12px',
                }}>
                  {/* TIME */}
                  <span style={{ color: 'var(--text3)', fontSize: '11px' }}>{e.startTime}</span>

                  {/* DIR */}
                  <span style={{ color: dCol, fontWeight: 700 }}>
                    {e.direction === 'BULL' ? '▲BULL' : '▼BEAR'}
                  </span>

                  {/* SCALED at start → end */}
                  <span style={{ color: 'var(--text2)', fontSize: '11px' }}>
                    {e.scaledAtStart >= 0 ? '+' : ''}{e.scaledAtStart.toFixed(2)}
                    {scaledEnd != null && (
                      <span style={{ color: 'var(--text3)' }}>→{scaledEnd >= 0 ? '+' : ''}{scaledEnd.toFixed(2)}</span>
                    )}
                  </span>

                  {/* ENTRY SPOT */}
                  <span style={{ color: 'var(--text)', fontWeight: 600 }}>₹{e.spotAtStart.toFixed(0)}</span>

                  {/* EXIT SPOT */}
                  <span style={{ color: isLive ? CYB.accent : 'var(--text2)', fontWeight: isLive ? 700 : 400 }}>
                    {isLive ? 'LIVE' : e.spotAtEnd != null ? `₹${e.spotAtEnd.toFixed(0)}` : '—'}
                  </span>

                  {/* DURATION */}
                  <span style={{ color: 'var(--text3)', fontSize: '11px' }}>
                    {isLive ? '…' : e.durationMin != null ? `${e.durationMin}m` : '—'}
                  </span>

                  {/* MOVE % */}
                  <span style={{ color: moveCol, fontWeight: 600 }}>
                    {e.outcomeMove != null
                      ? `${e.outcomeMove >= 0 ? '+' : ''}${e.outcomeMove.toFixed(2)}%`
                      : '—'}
                  </span>

                  {/* OPT IN */}
                  <span style={{ color: 'var(--text2)', fontSize: '11px' }}>
                    {e.optEntry != null ? `₹${e.optEntry.toFixed(1)}` : '—'}
                  </span>

                  {/* OPT OUT */}
                  <span style={{ color: e.optExit != null ? dCol : 'var(--text3)', fontSize: '11px', fontWeight: e.optExit != null ? 600 : 400 }}>
                    {e.optExit != null ? `₹${e.optExit.toFixed(1)}` : isLive ? '…' : '—'}
                  </span>

                  {/* P&L */}
                  <span title={pnlTip} style={{ color: pnlCol, fontWeight: 700, cursor: pnlTip ? 'help' : 'default' }}>
                    {pnlVal != null
                      ? `${pnlVal >= 0 ? '+' : ''}₹${Math.round(pnlVal)}`
                      : isLive ? '…' : '—'}
                  </span>
                </div>
              </div>
            )
          })}

          {entries.length === 0 && (
            <div style={{ fontSize: '9px', color: 'var(--text3)', textAlign: 'center', padding: '4px 0' }}>
              first swing when pat-20-con crosses ±0.16
            </div>
          )}
        </div>

        {showCount < reversed.length && (
          <button onClick={() => setShowCount(c => c + 4)} style={{
            display: 'block', width: '100%', marginTop: '4px', padding: '3px 0',
            fontSize: '8px', fontWeight: 700, fontFamily: 'inherit', letterSpacing: '0.1em',
            color: CYB.glow, background: 'transparent', border: `1px solid ${CYB.glowBorder}`,
            borderRadius: '2px', cursor: 'pointer', opacity: 0.7,
          }}>
            +{Math.min(4, reversed.length - showCount)} MORE ({reversed.length - showCount} remaining)
          </button>
        )}
      </div>
    </div>
  )
}

function RangeBar({ low, high, current }: { low: number; high: number; current: number }) {
  if (high <= low) return null
  const pct = Math.max(0, Math.min(100, ((current - low) / (high - low)) * 100))
  const nearHigh = pct > 75
  const nearLow = pct < 25

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontFamily: 'monospace' }}>
      <span style={{ fontSize: '9px', color: 'var(--bear)', fontWeight: 600, minWidth: '36px', textAlign: 'right' }}>{low.toFixed(0)}</span>
      <div style={{ flex: 1, position: 'relative', height: '6px', background: 'rgba(255,255,255,0.06)', borderRadius: '3px', border: `1px solid ${CYB.glowBorder}` }}>
        {/* Track fill */}
        <div style={{
          position: 'absolute', left: 0, top: 0, bottom: 0,
          width: `${pct}%`, borderRadius: '3px',
          background: nearHigh ? 'rgba(34,197,94,0.25)' : nearLow ? 'rgba(239,68,68,0.25)' : 'rgba(255,255,255,0.08)',
          transition: 'width 0.3s',
        }} />
        {/* Current price marker */}
        <div style={{
          position: 'absolute',
          left: `calc(${pct}% - 3px)`, top: '-3px',
          width: '6px', height: '12px', borderRadius: '2px',
          background: 'var(--text)', boxShadow: '0 0 4px rgba(255,255,255,0.3)',
          transition: 'left 0.3s',
        }} />
      </div>
      <span style={{ fontSize: '9px', color: 'var(--bull)', fontWeight: 600, minWidth: '36px' }}>{high.toFixed(0)}</span>
    </div>
  )
}

// ── Expandable Panel wrapper — double-click/tap opens modal ─────────────────

function ExpandablePanel({ children, label }: { children: React.ReactNode; label: string }) {
  const [expanded, setExpanded] = useState(false)
  const lastTapRef = useRef(0)

  const handleInteraction = () => {
    const now = Date.now()
    if (now - lastTapRef.current < 400) {
      setExpanded(true)
      lastTapRef.current = 0
    } else {
      lastTapRef.current = now
    }
  }

  return (
    <>
      <div
        onDoubleClick={() => setExpanded(true)}
        onTouchEnd={handleInteraction}
        style={{ cursor: 'pointer', position: 'relative' }}
      >
        {children}
        {/* Expand hint */}
        <div style={{
          position: 'absolute', top: '6px', right: '6px',
          fontSize: '7px', color: CYB.glow, opacity: 0.3,
          letterSpacing: '0.1em', fontFamily: 'monospace',
          pointerEvents: 'none',
        }}>
          2×TAP
        </div>
      </div>

      {/* Modal overlay */}
      {expanded && (
        <div
          onClick={() => setExpanded(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 100,
            background: 'rgba(0,0,0,0.85)',
            backdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '12px',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: '100%', maxWidth: '92vw', maxHeight: '92vh',
              overflowY: 'auto', overflowX: 'hidden',
              borderRadius: '8px',
              border: `1px solid ${CYB.glowBorder}`,
              boxShadow: '0 0 20px rgba(0,0,0,0.5)',
              background: 'var(--bg)',
            }}
          >
            {/* Modal header */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '10px 16px',
              borderBottom: `1px solid ${CYB.glowBorder}`,
              background: CYB.panel,
              position: 'sticky', top: 0, zIndex: 1,
            }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
                <span style={{ fontSize: '14px', fontWeight: 700, color: CYB.glow, letterSpacing: '0.15em' }}>{'//'}{label}</span>
              </div>
              <button
                onClick={() => setExpanded(false)}
                style={{
                  background: 'transparent', border: `1px solid ${CYB.glowBorder}`,
                  color: CYB.glow, fontSize: '13px', fontWeight: 700,
                  padding: '5px 14px', borderRadius: '3px', cursor: 'pointer',
                  fontFamily: 'monospace', letterSpacing: '0.1em',
                }}
              >
                CLOSE
              </button>
            </div>
            {/* Scaled-up content — CSS zoom for uniform scaling */}
            <div style={{ padding: '20px', zoom: 1.6 }}>
              {children}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// ── Shared button style (matches N50 conviction) ────────────────────────────

const btnStyle: React.CSSProperties = {
  border: '1px solid var(--border)', borderRadius: '4px',
  padding: '4px 10px', fontSize: '11px', fontFamily: 'inherit',
  cursor: 'pointer', letterSpacing: '0.05em', transition: 'all 0.15s',
  background: 'transparent', color: 'var(--text2)', textDecoration: 'none',
  display: 'inline-block',
}

// ── Main Client ───────────────────────────────────────────────────────────────

export default function CrudeConvictionClient({ role = 'admin' }: { role?: string }) {
  const router = useRouter()
  const [state, setState] = useState<CrudeState | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [product, setProduct] = useState<'CRUDEOIL' | 'CRUDEOILM'>('CRUDEOILM')
  const [status, setStatus] = useState<'connecting' | 'live' | 'stale'>('connecting')

  const switchProduct = (p: 'CRUDEOIL' | 'CRUDEOILM') => {
    if (p === product) return
    setProduct(p)
    setState(null)
    setLoading(true)
  }
  const timerRef = useRef<NodeJS.Timeout | null>(null)

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch(`/api/crude?product=${product}`)
      if (!res.ok) throw new Error(`${res.status}`)
      const data = await res.json()
      setState(data)
      setError(null)
      setStatus('live')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'fetch failed')
      setStatus('stale')
    } finally {
      setLoading(false)
    }
  }, [product])

  useEffect(() => {
    fetchState()
    timerRef.current = setInterval(fetchState, 2000)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [fetchState])

  const handleSignOut = async () => {
    await fetch('/api/auth/logout', { method: 'POST' })
    router.push('/')
  }

  const updatedAt = state ? Date.now() : null

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', flexDirection: 'column' }}>
      {/* Header — matches N50 conviction sticky header */}
      <header style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexWrap: 'wrap', gap: '6px', padding: '8px 12px',
        borderBottom: '1px solid var(--border)', background: 'var(--bg2)',
        position: 'sticky', top: 0, zIndex: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
          <a href="/dashboard" style={{ fontWeight: 700, fontSize: '14px', letterSpacing: '-0.02em', color: 'var(--text)', textDecoration: 'none' }}>Z</a>
          <span style={{ color: 'var(--text3)', fontSize: '9px' }}>/</span>
          <span style={{ fontSize: '11px', color: 'var(--text)', letterSpacing: '0.08em', fontWeight: 700 }}>CRUDE</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
          {[{ href: '/dashboard', label: '📊' }, { href: '/dashboard/backtest', label: 'BT' }, { href: '/dashboard/conviction', label: 'N50' }, { href: '/dashboard/live', label: '◉' }].map(l => (
            <a key={l.href} href={l.href} style={{ ...btnStyle, padding: '3px 6px', fontSize: '10px' }}>{l.label}</a>
          ))}
          <ThemeToggle />
          <button onClick={handleSignOut} style={{ ...btnStyle, cursor: 'pointer', padding: '3px 6px', fontSize: '9px' }}>OUT</button>
        </div>
      </header>

      {/* Status bar + product toggle — matches N50 filter bar */}
      <div style={{
        padding: '6px 12px', borderBottom: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column', gap: '6px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <div style={{
            width: '6px', height: '6px', borderRadius: '50%', flexShrink: 0,
            background: status === 'live' ? 'var(--bull)' : status === 'connecting' ? 'var(--mixed)' : 'var(--bear)',
          }} />
          <span style={{ fontSize: '9px', color: 'var(--text3)' }}>
            {status === 'live' && updatedAt ? new Date(updatedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : status}
          </span>
          {state && (
            <span style={{ fontSize: '9px', color: 'var(--text3)' }}>
              {state.marketOpen ? 'MCX OPEN' : 'MCX CLOSED'} · {product === 'CRUDEOIL' ? '100bbl' : '10bbl'}
              {state.patternCount > 0 ? ` · ${state.patternCount}pat (${state.resolvedCount}res)` : ''}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: '3px', flexWrap: 'wrap' }}>
          {/* Product toggle */}
          {(['CRUDEOIL', 'CRUDEOILM'] as const).map(p => (
            <button
              key={p}
              onClick={() => switchProduct(p)}
              style={{
                ...btnStyle, padding: '3px 8px', fontSize: '9px',
                background: product === p ? 'rgba(255,255,255,0.12)' : 'transparent',
                color: product === p ? 'var(--text)' : 'var(--text3)',
                border: `1px solid ${product === p ? 'rgba(255,255,255,0.2)' : CYB.glowBorder}`,
                fontWeight: 700, letterSpacing: '0.1em',
              }}
            >
              {p === 'CRUDEOIL' ? 'STD' : 'MINI'}
            </button>
          ))}
        </div>
      </div>

      {/* Loading / Error */}
      {loading && <div style={{ color: CYB.glow, fontSize: '10px', textAlign: 'center', padding: '40px', fontFamily: 'monospace', opacity: 0.6 }}>{'> CONNECTING TO CRUDE FEED...'}</div>}
      {error && !state && <div style={{ color: CYB.redGlow, fontSize: '10px', textAlign: 'center', padding: '20px', fontFamily: 'monospace' }}>{'> ERR: '}{error}</div>}

      {/* Content — all panels */}
      {state && !loading && (
        <div style={{ padding: '8px 10px', flex: 1 }}>
          <DraggablePanelLayout
            storageKey="zd-crude-panels-v6"
            isAdmin={role === 'admin'}
            gap={10}
            panels={([
              {
                id: 'oracle',
                visible: true,
                defaultColSpan: 8,
                node: (
                  <ExpandablePanel label="ORACLE">
                    <OraclePanel state={state} role={role} />
                  </ExpandablePanel>
                ),
              },
              {
                id: 'depth',
                visible: true,
                defaultColSpan: 4,
                node: (
                  <ExpandablePanel label="DEPTH">
                    <DepthPanel depth={state.depth} spot={state.spot} />
                  </ExpandablePanel>
                ),
              },
              {
                id: 'elliott_wave',
                visible: true,
                node: (
                  <ExpandablePanel label="ELLIOTT_WAVE">
                    <ElliottWavePanel ew={state.elliottWave} ewByTF={state.elliottWaveByTF} spot={state.spot} composite={state.composite} />
                  </ExpandablePanel>
                ),
              },
              {
                id: 'sys_log',
                visible: true,
                node: (
                  <ExpandablePanel label="SYS_LOG">
                    <SysLogPanel entries={state.sysLog} product={state.product} />
                  </ExpandablePanel>
                ),
              },
              {
                id: 'syslog_v2',
                visible: role === 'admin',
                defaultColSpan: 12,
                node: (
                  <ExpandablePanel label="SYSLOG_V2">
                    <SyslogV2Panel v2={state.v2} />
                  </ExpandablePanel>
                ),
              },
              {
                id: 'chain',
                visible: true,
                node: state.chain ? (
                  <ExpandablePanel label="CHAIN">
                    <ChainPanel chain={state.chain} spot={state.spot} product={state.product} role={role} />
                  </ExpandablePanel>
                ) : (
                  <div style={{ color: CYB.glow, fontSize: '10px', padding: '16px', background: CYB.panel, border: `1px solid ${CYB.glowBorder}`, borderRadius: '6px', fontFamily: 'monospace', opacity: 0.6 }}>
                    {'> CHAIN UNAVAILABLE — instruments CSV may be stale or market closed'}
                  </div>
                ),
              },
              {
                id: 'gt_analysis',
                visible: role === 'admin',
                node: (
                  <ExpandablePanel label="GT_ANALYSIS">
                    <GameTheoryPanel
                      spot={state.spot}
                      chain={state.chain}
                      composite={state.composite}
                      technicals={state.technicals}
                    />
                  </ExpandablePanel>
                ),
              },
              {
                id: 'oracle_v2',
                visible: role === 'admin',
                defaultColSpan: 8,
                node: state.v2 ? (
                  <ExpandablePanel label="ORACLE_V2">
                    <OracleV2Panel state={state as CrudeState & { v2: CrudeV2 }} />
                  </ExpandablePanel>
                ) : (
                  <div style={{ color: CYB.glow, fontSize: '10px', padding: '16px', background: CYB.panel, border: `1px solid ${CYB.glowBorder}`, borderRadius: '6px', fontFamily: 'monospace', opacity: 0.6 }}>{'> ORACLE_V2: no data yet'}</div>
                ),
              },
              {
                id: 'gt_flow',
                visible: role === 'admin',
                defaultColSpan: 4,
                node: state.v2 ? (
                  <ExpandablePanel label="GT_FLOW">
                    <GTFlowPanel v2={state.v2} />
                  </ExpandablePanel>
                ) : (
                  <div style={{ color: CYB.glow, fontSize: '10px', padding: '16px', background: CYB.panel, border: `1px solid ${CYB.glowBorder}`, borderRadius: '6px', fontFamily: 'monospace', opacity: 0.6 }}>{'> GT_FLOW: no data yet'}</div>
                ),
              },
            ] satisfies PanelDef[])}
          />
        </div>
      )}
    </div>
  )
}
