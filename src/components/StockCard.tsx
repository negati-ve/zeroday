'use client'
import { useState, useEffect, useRef, useCallback } from 'react'
import type { StockState, WallData, DepthWall, MetaRegimeData } from '@/lib/stockState'

interface Props {
  name: string
  stock: StockState & { name: string }
  pinned?: boolean
  onPin?: () => void
  role?: string
}

// ── Strike helpers ─────────────────────────────────────────────────────────
function floorToStep(v: number, step: number) { return Math.floor(v / step) * step }
function ceilToStep(v: number, step: number)  { return Math.ceil(v / step) * step }

function strikeOptions(ltp: number, step: number) {
  const ceItm = floorToStep(ltp, step)
  const ceOtm = ceItm + step
  const peItm = ceilToStep(ltp, step)
  const peOtm = peItm - step
  return { ceItm, ceOtm, peItm, peOtm }
}

// ── Highlight persistence (localStorage) ──────────────────────────────────
const HIGHLIGHT_KEY = 'zeroday:highlighted'

function readHighlighted(): Set<string> {
  if (typeof window === 'undefined') return new Set()
  try { return new Set(JSON.parse(localStorage.getItem(HIGHLIGHT_KEY) ?? '[]')) } catch { return new Set() }
}

function writeHighlighted(s: Set<string>) {
  localStorage.setItem(HIGHLIGHT_KEY, JSON.stringify([...s]))
}

// ── PatBar ────────────────────────────────────────────────────────────────

function fmtAge(sec: number): string {
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return m > 0 ? `${h}h${m}m` : `${h}h`
}

function PatBar({ label, data, ltp, role }: { label: string; data: NonNullable<StockState['pat5']> | null; ltp?: number; role?: string }) {
  if (!data) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', opacity: 0.35 }}>
        <span style={{ width: '46px', color: 'var(--text3)', fontSize: '10px', flexShrink: 0 }}>{label}</span>
        <span style={{ color: 'var(--text3)', fontSize: '10px' }}>—</span>
      </div>
    )
  }
  const isBull = data.move >= 0
  const dominant = data.bull > data.bear ? 'bull' : data.bear > data.bull ? 'bear' : 'flat'
  const pct = dominant === 'bull' ? data.bull : dominant === 'bear' ? data.bear : 50
  const barColor = dominant === 'bull' ? 'var(--bull)' : dominant === 'bear' ? 'var(--bear)' : 'var(--text3)'
  const impliedPrice = ltp != null ? ltp * (1 + data.move / 100) : null
  const hasPred = data.predDir != null && data.predAge != null && data.predAge > 0
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <span style={{ width: '46px', color: 'var(--text3)', fontSize: '10px', flexShrink: 0 }}>{label}</span>
      <div style={{ width: '64px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '1px' }}>
        <span style={{ color: isBull ? 'var(--bull)' : 'var(--bear)', fontSize: '11px', fontWeight: 600 }}>
          {isBull ? '▲' : '▼'} {Math.abs(data.move).toFixed(2)}%
        </span>
        {impliedPrice != null && (
          <span style={{ fontSize: '9px', color: 'var(--text3)' }}>₹{impliedPrice.toFixed(1)}</span>
        )}
      </div>
      <div style={{ flex: 1, position: 'relative', height: '5px', background: 'var(--bg3)', borderRadius: '3px', overflow: 'hidden' }}>
        <div style={{
          position: 'absolute',
          left: dominant === 'bull' ? 0 : undefined, right: dominant === 'bear' ? 0 : undefined,
          width: `${pct}%`, height: '100%', background: barColor,
          borderRadius: '3px', transition: 'width 0.4s ease',
        }} />
      </div>
      <span style={{ width: '60px', textAlign: 'right', fontSize: '10px', color: 'var(--text2)', flexShrink: 0 }}>
        <span style={{ color: 'var(--bull)' }}>{data.bull}%</span>
        <span style={{ color: 'var(--text3)' }}> / </span>
        <span style={{ color: 'var(--bear)' }}>{data.bear}%</span>
      </span>
      {hasPred ? (
        <span className="zd-pat-sim" style={{ width: '80px', textAlign: 'right', fontSize: '10px', flexShrink: 0,
          color: data.agrees ? 'var(--bull)' : 'var(--bear)' }}>
          {fmtAge(data.predAge!)} {(data.actualMove ?? 0) >= 0 ? '+' : ''}{(data.actualMove ?? 0).toFixed(2)}%
        </span>
      ) : (
        <span className="zd-pat-sim" style={{ width: '80px', textAlign: 'right', fontSize: '10px', color: 'var(--text3)', flexShrink: 0 }}>
          {role !== 'viewer' ? <>{data.sim.toFixed(2)} n={data.n}</> : null}
        </span>
      )}
    </div>
  )
}

// ── RegimeBadge ───────────────────────────────────────────────────────────

const REGIME_EMOJI: Record<string, string> = {
  ACCUMULATION: '📦', MARKUP: '🚀', DISTRIBUTION: '📤', MARKDOWN: '📉', CHOP: '〰️', UNKNOWN: '❓',
}
const REGIME_SHORT: Record<string, string> = {
  ACCUMULATION: 'acc', MARKUP: 'mkp', DISTRIBUTION: 'dist', MARKDOWN: 'mkdn', CHOP: 'chop', UNKNOWN: '?',
}

function regimeColor(regime: string): string {
  if (regime === 'ACCUMULATION' || regime === 'MARKUP') return 'var(--bull)'
  if (regime === 'DISTRIBUTION' || regime === 'MARKDOWN') return 'var(--bear)'
  return 'var(--text3)'
}

function RegimeBadge({ data }: { data: MetaRegimeData | null | undefined }) {
  if (!data || data.regime === 'UNKNOWN') return null
  const emoji = REGIME_EMOJI[data.regime] ?? '❓'
  const short = REGIME_SHORT[data.regime] ?? data.regime.toLowerCase()
  const conf  = Math.round(data.confidence * 100)
  return (
    <span style={{ color: regimeColor(data.regime), fontSize: '10px' }}>
      {emoji}{short}·{conf}%
    </span>
  )
}

// ── AlignBar ──────────────────────────────────────────────────────────────

function AlignBar({ score, dir }: { score: number; dir: StockState['alignDir'] }) {
  const color = dir === 'BULL' ? 'var(--bull)' : dir === 'BEAR' ? 'var(--bear)' : dir === 'MIXED' ? 'var(--mixed)' : 'var(--text3)'
  const pct = Math.round(score * 100)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px', paddingTop: '8px', borderTop: '1px solid var(--border)' }}>
      <span style={{ width: '46px', color: 'var(--text3)', fontSize: '10px', flexShrink: 0 }}>ALIGN</span>
      <div style={{ flex: 1, height: '5px', background: 'var(--bg3)', borderRadius: '3px', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: '3px', transition: 'width 0.4s ease' }} />
      </div>
      <span style={{ width: '60px', textAlign: 'right', fontSize: '10px', color, fontWeight: 700, flexShrink: 0 }}>
        {dir === 'NONE' ? '—' : `${dir} ${pct}%`}
      </span>
    </div>
  )
}

// ── ExpandedPanel ─────────────────────────────────────────────────────────

function StatPill({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', minWidth: '48px' }}>
      <span style={{ fontSize: '9px', color: 'var(--text3)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>{label}</span>
      <span style={{ fontSize: '11px', fontWeight: 600, color: color ?? 'var(--text2)' }}>{value}</span>
    </div>
  )
}

function signed(v: number | null | undefined, d = 2) {
  if (v == null) return '—'
  return `${v >= 0 ? '+' : ''}${v.toFixed(d)}`
}

function ExpandedPanel({ stock: s, role = 'admin' }: { stock: StockState; role?: string }) {
  const rangeStr = s.intradayHigh != null && s.intradayLow != null
    ? `₹${s.intradayLow} — ₹${s.intradayHigh} (${(((s.intradayHigh - s.intradayLow) / s.intradayLow) * 100).toFixed(1)}%)`
    : null
  return (
    <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {/* Signal stats */}
      <div>
        <div style={{ fontSize: '9px', color: 'var(--text3)', letterSpacing: '0.1em', marginBottom: '6px' }}>SIGNAL STATS</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
          <StatPill label="OBI"   value={signed(s.imbalance, 2)} color={s.imbalance >= 0.1 ? 'var(--bull)' : s.imbalance <= -0.1 ? 'var(--bear)' : 'var(--text2)'} />
          <StatPill label="MP"    value={s.mpEdgeTicks != null ? `${signed(s.mpEdgeTicks, 2)}t` : '—'} color={s.mpEdgeTicks != null && s.mpEdgeTicks >= 0 ? 'var(--bull)' : 'var(--bear)'} />
          <StatPill label="AGG"   value={signed(s.emaAgg, 2)} color={s.emaAgg >= 0.05 ? 'var(--bull)' : s.emaAgg <= -0.05 ? 'var(--bear)' : 'var(--text2)'} />
          <StatPill label="CDZ"   value={`${signed(s.cdZ, 1)}σ`} color={s.cdZ >= 0 ? 'var(--bull)' : 'var(--bear)'} />
          <StatPill label="VEL-Z" value={`${signed(s.cdVelZ, 1)}σ`} color={s.cdVelZ >= 0 ? 'var(--bull)' : 'var(--bear)'} />
          <StatPill label="CD"    value={s.cumDelta != null ? `${s.cumDelta >= 0 ? '+' : ''}${(s.cumDelta / 1000).toFixed(1)}K` : '—'} color={s.cumDelta != null && s.cumDelta >= 0 ? 'var(--bull)' : 'var(--bear)'} />
          <StatPill label="COS"   value={signed(s.cosineBull, 2)} color={s.cosineBull > 0 ? 'var(--bull)' : 'var(--bear)'} />
          {(s.cusumBull || s.cusumBear) && (
            <StatPill label="CUSUM" value={s.cusumBull ? '⚡BULL' : '⚡BEAR'} color={s.cusumBull ? 'var(--bull)' : 'var(--bear)'} />
          )}
        </div>
      </div>
      {/* Meta regime */}
      {(s.metaRegime || s.sessionRegime) && (
        <div>
          <div style={{ fontSize: '9px', color: 'var(--text3)', letterSpacing: '0.1em', marginBottom: '6px' }}>META REGIME</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
            {s.metaRegime && s.metaRegime.regime !== 'UNKNOWN' && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
                <span style={{ fontSize: '10px', color: 'var(--text3)', width: '46px', flexShrink: 0 }}>15-min</span>
                <span style={{ fontSize: '11px', fontWeight: 600, color: regimeColor(s.metaRegime.regime) }}>
                  {REGIME_EMOJI[s.metaRegime.regime]} {s.metaRegime.regime}
                </span>
                <span style={{ fontSize: '10px', color: 'var(--text3)' }}>{Math.round(s.metaRegime.confidence * 100)}%</span>
                <span style={{ fontSize: '10px', color: s.metaRegime.avgCdZ >= 0 ? 'var(--bull)' : 'var(--bear)' }}>cdZ:{signed(s.metaRegime.avgCdZ, 2)}</span>
                <span style={{ fontSize: '10px', color: s.metaRegime.avgObi >= 0 ? 'var(--bull)' : 'var(--bear)' }}>obi:{signed(s.metaRegime.avgObi, 2)}</span>
                <span style={{ fontSize: '10px', color: 'var(--text3)' }}>div:{(s.metaRegime.divergenceScore * 100).toFixed(0)}%</span>
                <span style={{ fontSize: '10px', color: s.metaRegime.momentumSlope >= 0 ? 'var(--bull)' : 'var(--bear)' }}>
                  mom:{s.metaRegime.momentumSlope >= 0 ? '+' : ''}{(s.metaRegime.momentumSlope * 1000).toFixed(1)}‰
                </span>
              </div>
            )}
            {s.sessionRegime && s.sessionRegime.regime !== 'UNKNOWN' && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
                <span style={{ fontSize: '10px', color: 'var(--text3)', width: '46px', flexShrink: 0 }}>session</span>
                <span style={{ fontSize: '11px', fontWeight: 600, color: regimeColor(s.sessionRegime.regime) }}>
                  {REGIME_EMOJI[s.sessionRegime.regime]} {s.sessionRegime.regime}
                </span>
                <span style={{ fontSize: '10px', color: 'var(--text3)' }}>{Math.round(s.sessionRegime.confidence * 100)}%</span>
                <span style={{ fontSize: '10px', color: s.sessionRegime.avgCdZ >= 0 ? 'var(--bull)' : 'var(--bear)' }}>cdZ:{signed(s.sessionRegime.avgCdZ, 2)}</span>
                <span style={{ fontSize: '10px', color: s.sessionRegime.avgObi >= 0 ? 'var(--bull)' : 'var(--bear)' }}>obi:{signed(s.sessionRegime.avgObi, 2)}</span>
                <span style={{ fontSize: '10px', color: 'var(--text3)' }}>div:{(s.sessionRegime.divergenceScore * 100).toFixed(0)}%</span>
              </div>
            )}
          </div>
        </div>
      )}
      {/* Volume profile */}
      {(s.hvn || s.va || s.poc) && (
        <div>
          <div style={{ fontSize: '9px', color: 'var(--text3)', letterSpacing: '0.1em', marginBottom: '6px' }}>VOLUME PROFILE</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '10px' }}>
            {s.hvn && (
              <div style={{ display: 'flex', gap: '8px' }}>
                <span style={{ color: 'var(--text3)', width: '34px', flexShrink: 0 }}>HVN</span>
                <span style={{ color: 'var(--text2)' }}>₹{s.hvn.price}</span>
                <span style={{ color: s.hvn.dev < 0.3 ? 'var(--mixed)' : 'var(--bull)' }}>
                  {s.hvn.dev < 0.3 ? '🔒' : '✓'} dev:{s.hvn.dev.toFixed(2)}%
                </span>
              </div>
            )}
            {s.va && (
              <div style={{ display: 'flex', gap: '8px' }}>
                <span style={{ color: 'var(--text3)', width: '34px', flexShrink: 0 }}>VA</span>
                <span style={{ color: 'var(--text2)' }}>[₹{s.va.low} – ₹{s.va.high}]</span>
                <span style={{ color: s.va.inside ? 'var(--mixed)' : 'var(--bull)' }}>{s.va.inside ? '🔒 inside' : '✓ outside'}</span>
              </div>
            )}
            {(s.poc || s.shortPoc) && (
              <div style={{ display: 'flex', gap: '8px' }}>
                <span style={{ color: 'var(--text3)', width: '34px', flexShrink: 0 }}>POC</span>
                {s.poc && <span style={{ color: 'var(--text2)' }}>₹{s.poc}</span>}
                {s.shortPoc && s.poc && (
                  <span style={{ color: s.shortPoc > s.poc ? 'var(--bull)' : s.shortPoc < s.poc ? 'var(--bear)' : 'var(--text3)' }}>
                    rec:₹{s.shortPoc} ({s.shortPoc > s.poc ? '+' : ''}{(s.shortPoc - s.poc).toFixed(1)}){s.shortPoc > s.poc ? ' 📈' : s.shortPoc < s.poc ? ' 📉' : ' ↔'}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      )}
      {/* Walls */}
      {(s.wallAsk || s.wallBid || s.depthWalls.length > 0) && (
        <div>
          <div style={{ fontSize: '9px', color: 'var(--text3)', letterSpacing: '0.1em', marginBottom: '6px' }}>WALLS</div>
          {(s.wallAsk || s.wallBid) && (
            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: s.depthWalls.length ? '4px' : 0 }}>
              {s.wallAsk && <WallTag w={s.wallAsk} side="ASK" />}
              {s.wallBid && <WallTag w={s.wallBid} side="BID" />}
            </div>
          )}
          {s.depthWalls.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {s.depthWalls.map((w, i) => (
                <span key={i} style={{ fontSize: '10px', color: w.status === 'BREAKING' ? 'var(--bear)' : w.status === 'GROWING' ? 'var(--bull)' : 'var(--text2)' }}>
                  {w.side === 'BID' ? '📗' : '📕'}
                  {w.status === 'GROWING' ? '📈' : w.status === 'BREAKING' ? '💥' : w.status === 'DEFENDING' ? '🛡️' : '·'}
                  ₹{w.price}({w.ratio}×{w.defenseCount > 0 ? ` d${w.defenseCount}` : ''})
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      {s.squeezeActive && (
        <div style={{ fontSize: '10px', color: s.squeezeActive === 'BULL' ? 'var(--bull)' : 'var(--bear)' }}>
          🌀 SQUEEZE: {s.squeezeActive === 'BULL' ? 'CE' : 'PE'} short-covering — {s.squeezeConsec} ticks
        </div>
      )}
      {s.pat30 && (
        <div>
          <div style={{ fontSize: '9px', color: 'var(--text3)', letterSpacing: '0.1em', marginBottom: '6px' }}>SESSION PATTERN (8-dim)</div>
          <PatBar label="PAT-30m" data={s.pat30} role={role} />
        </div>
      )}
      {/* Technical indicators */}
      {s.indicators && (
        <div>
          <div style={{ fontSize: '9px', color: 'var(--text3)', letterSpacing: '0.1em', marginBottom: '6px' }}>INDICATORS</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
            {s.indicators.emaShort != null && (
              <StatPill label={`EMA ${s.indicators.emaCrossover === 'BULL' ? '↗' : s.indicators.emaCrossover === 'BEAR' ? '↘' : '—'}`}
                value={`${s.indicators.emaShort.toFixed(1)} / ${s.indicators.emaLong?.toFixed(1) ?? '—'}`}
                color={s.indicators.emaCrossover === 'BULL' ? 'var(--bull)' : s.indicators.emaCrossover === 'BEAR' ? 'var(--bear)' : 'var(--text2)'} />
            )}
            {s.indicators.vwap != null && (
              <StatPill label="VWAP" value={`₹${s.indicators.vwap.toFixed(1)}`}
                color={s.indicators.vwapAlign === 'BULL' ? 'var(--bull)' : s.indicators.vwapAlign === 'BEAR' ? 'var(--bear)' : 'var(--text2)'} />
            )}
            {s.indicators.rsi != null && (
              <StatPill label="RSI" value={s.indicators.rsi.toFixed(1)}
                color={s.indicators.rsi > 70 ? 'var(--bear)' : s.indicators.rsi < 30 ? 'var(--bull)' : 'var(--text2)'} />
            )}
            {s.indicators.atr != null && (
              <StatPill label="ATR" value={`₹${s.indicators.atr.toFixed(2)} (${s.indicators.atrPct?.toFixed(2) ?? '—'}%)`}
                color={s.indicators.atrPct != null && s.indicators.atrPct >= 0.15 ? 'var(--text2)' : 'var(--text3)'} />
            )}
          </div>
        </div>
      )}
      {rangeStr && <div style={{ fontSize: '10px', color: 'var(--text3)' }}>Range {rangeStr}</div>}
    </div>
  )
}

function WallTag({ w, side }: { w: WallData; side: 'ASK' | 'BID' }) {
  const color = side === 'ASK' ? 'var(--bear)' : 'var(--bull)'
  const tag = w.iceberg ? `🧊×${w.resets}` : w.drainPct >= 15 ? `⬇${w.drainPct}%` : '~stable'
  return (
    <span style={{ fontSize: '10px', color }}>
      {side.toLowerCase()}:{tag}@₹{w.price}{w.absRatio != null && w.absRatio > 0 ? ` abs:${w.absRatio}×` : ''}
    </span>
  )
}

// ── ContextMenu ───────────────────────────────────────────────────────────

interface CtxPos { x: number; y: number }

interface TradeAction {
  label: string; optType: 'CE' | 'PE'; strike: number; strikeLabel: 'ITM' | 'OTM'; color: string
}

function ContextMenu({ pos, name, stock, highlighted, pinned, onHighlight, onPin, onTrade, onClose }: {
  pos: CtxPos; name: string; stock: StockState; highlighted: boolean; pinned: boolean
  onHighlight: () => void; onPin: () => void; onTrade: (a: TradeAction) => void; onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const click = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const esc   = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', click)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', click); document.removeEventListener('keydown', esc) }
  }, [onClose])

  const step = stock.strikeStep || 10
  const { ceItm, ceOtm, peItm, peOtm } = strikeOptions(stock.ltp, step)
  const actions: TradeAction[] = [
    { label: `CE ITM  ₹${ceItm}`, optType: 'CE', strike: ceItm, strikeLabel: 'ITM', color: 'var(--bull)' },
    { label: `CE OTM  ₹${ceOtm}`, optType: 'CE', strike: ceOtm, strikeLabel: 'OTM', color: 'var(--bull)' },
    { label: `PE ITM  ₹${peItm}`, optType: 'PE', strike: peItm, strikeLabel: 'ITM', color: 'var(--bear)' },
    { label: `PE OTM  ₹${peOtm}`, optType: 'PE', strike: peOtm, strikeLabel: 'OTM', color: 'var(--bear)' },
  ]

  const menuW = 210, menuH = 230
  const left = Math.min(pos.x, window.innerWidth  - menuW - 8)
  const top  = Math.min(pos.y, window.innerHeight - menuH - 8)

  const btn: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: '8px',
    width: '100%', padding: '7px 12px', border: 'none',
    background: 'transparent', borderRadius: '4px',
    fontFamily: 'inherit', fontSize: '11px', letterSpacing: '0.03em',
    cursor: 'pointer', textAlign: 'left',
  }

  return (
    <div ref={ref} style={{
      position: 'fixed', left, top, zIndex: 1000,
      background: 'var(--bg2)', border: '1px solid var(--border)',
      borderRadius: '6px', padding: '4px',
      boxShadow: '0 4px 24px rgba(0,0,0,0.35)', minWidth: `${menuW}px`,
    }}>
      <div style={{ padding: '6px 12px 4px', fontSize: '10px', color: 'var(--text3)', letterSpacing: '0.06em' }}>
        {name} · ₹{stock.ltp.toFixed(1)}
      </div>

      <button
        style={{ ...btn, color: pinned ? 'var(--bull)' : 'var(--text2)' }}
        onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg3)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
        onClick={() => { onPin(); onClose() }}
      >
        <span>{pinned ? '📌' : '📍'}</span>
        <span>{pinned ? 'Unpin from top' : 'Pin to top'}</span>
      </button>

      <button
        style={{ ...btn, color: highlighted ? 'var(--mixed)' : 'var(--text2)' }}
        onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg3)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
        onClick={() => { onHighlight(); onClose() }}
      >
        <span>{highlighted ? '★' : '☆'}</span>
        <span>{highlighted ? 'Remove highlight' : 'Highlight card'}</span>
      </button>

      <div style={{ height: '1px', background: 'var(--border)', margin: '4px 0' }} />
      <div style={{ padding: '4px 12px 2px', fontSize: '9px', color: 'var(--text3)', letterSpacing: '0.1em' }}>
        PAPER TRADE ENTRY
      </div>

      {actions.map(a => (
        <button
          key={`${a.optType}${a.strikeLabel}`}
          style={{ ...btn, color: a.color }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg3)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          onClick={() => { onTrade(a); onClose() }}
        >
          <span style={{ fontSize: '10px', opacity: 0.7, width: '12px' }}>{a.optType === 'CE' ? '▲' : '▼'}</span>
          <span>{a.label}</span>
          <span style={{ marginLeft: 'auto', fontSize: '9px', opacity: 0.6 }}>{a.strikeLabel}</span>
        </button>
      ))}
    </div>
  )
}

// ── Toast ─────────────────────────────────────────────────────────────────

function Toast({ msg, onDone }: { msg: string; onDone: () => void }) {
  useEffect(() => { const t = setTimeout(onDone, 2500); return () => clearTimeout(t) }, [onDone])
  return (
    <div style={{
      position: 'fixed', bottom: '20px', right: '20px', zIndex: 2000,
      background: 'var(--bg2)', border: '1px solid var(--border)',
      borderRadius: '6px', padding: '10px 16px',
      fontSize: '12px', color: 'var(--text2)',
      boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
    }}>
      {msg}
    </div>
  )
}

// ── Main card ─────────────────────────────────────────────────────────────

export default function StockCard({ name, stock, pinned = false, onPin, role = 'admin' }: Props) {
  const [expanded,    setExpanded]    = useState(false)
  const [highlighted, setHighlighted] = useState(() => readHighlighted().has(name))
  const [ctxPos,      setCtxPos]      = useState<CtxPos | null>(null)
  const [toast,       setToast]       = useState<string | null>(null)

  const doHighlight = useCallback(() => {
    const s = readHighlighted()
    const next = !s.has(name)
    if (next) s.add(name); else s.delete(name)
    writeHighlighted(s)
    setHighlighted(next)
  }, [name])

  const doTrade = useCallback(async (a: TradeAction) => {
    try {
      const res = await fetch('/api/paper-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stock: name, optType: a.optType, strike: a.strike, strikeLabel: a.strikeLabel, ltp: stock.ltp }),
      })
      setToast(res.ok
        ? `✓ Logged — ${name} ${a.optType} ${a.strikeLabel} ₹${a.strike}`
        : `✗ Failed to log paper trade`)
    } catch {
      setToast('✗ Network error')
    }
  }, [name, stock.ltp])

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setCtxPos({ x: e.clientX, y: e.clientY })
  }, [])

  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const touchMoved = useRef(false)

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    touchMoved.current = false
    const touch = e.touches[0]
    const x = touch.clientX, y = touch.clientY
    longPressRef.current = setTimeout(() => {
      if (!touchMoved.current) setCtxPos({ x, y })
    }, 500)
  }, [])

  const onTouchMove = useCallback(() => {
    touchMoved.current = true
    if (longPressRef.current) { clearTimeout(longPressRef.current); longPressRef.current = null }
  }, [])

  const onTouchEnd = useCallback(() => {
    if (longPressRef.current) { clearTimeout(longPressRef.current); longPressRef.current = null }
  }, [])

  const sigColor = signalColor(stock.signal)
  const alignBg  = stock.alignDir === 'BULL' ? 'rgba(34,197,94,0.06)' : stock.alignDir === 'BEAR' ? 'rgba(239,68,68,0.06)' : 'transparent'

  return (
    <>
      <div
        onContextMenu={onContextMenu}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        style={{
          background: 'color-mix(in srgb, var(--bg2) 100%, transparent)',
          backgroundImage: `linear-gradient(135deg, ${alignBg}, transparent 60%)`,
          border: `1px solid ${pinned ? 'var(--text2)' : highlighted ? 'var(--mixed)' : 'var(--border)'}`,
          borderRadius: '8px', padding: '16px',
          display: 'flex', flexDirection: 'column', gap: '6px',
          transition: 'border-color 0.2s, box-shadow 0.2s',
          boxShadow: pinned ? '0 0 0 1px var(--text2), 0 0 12px rgba(255,255,255,0.08)' : highlighted ? '0 0 0 1px var(--mixed), 0 0 18px rgba(234,179,8,0.15)' : undefined,
        }}
      >
        {/* Header */}
        <div onClick={() => setExpanded(e => !e)} style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', cursor: 'pointer' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
            {pinned && <span style={{ fontSize: '11px', color: 'var(--text2)', lineHeight: 1 }}>📌</span>}
            {highlighted && <span style={{ fontSize: '11px', color: 'var(--mixed)', lineHeight: 1 }}>★</span>}
            <span style={{ fontSize: '15px', fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--text)' }}>{name}</span>
            <span style={{ fontSize: '11px', color: sigColor, fontWeight: 600 }}>
              {stock.signal === 'NEUTRAL' ? '◌' : stock.signal === 'BULL' ? '▲' : '▼'} {stock.signal}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
            <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)', tabularNums: true } as React.CSSProperties}>
              ₹{stock.ltp.toFixed(2)}
            </span>
            <span style={{ fontSize: '10px', color: 'var(--text3)', lineHeight: 1 }}>{expanded ? '▲' : '▼'}</span>
          </div>
        </div>

        {/* Meta row */}
        <div style={{ display: 'flex', gap: '12px', fontSize: '10px', color: 'var(--text3)', marginBottom: '4px' }}>
          <span>Trend {stock.trend === 'BULL' ? '↑' : stock.trend === 'BEAR' ? '↓' : '→'} {stock.trend}</span>
          <span>OBI {stock.imbalance != null ? `${stock.imbalance >= 0 ? '+' : ''}${stock.imbalance.toFixed(2)}` : '—'}</span>
          <span>CDZ {stock.cdZ != null ? `${stock.cdZ >= 0 ? '+' : ''}${stock.cdZ.toFixed(1)}σ` : '—'}</span>
          <span>×{stock.confirmCount}</span>
          <RegimeBadge data={stock.metaRegime} />
        </div>

        {/* Indicators row */}
        {stock.indicators && (stock.indicators.emaCrossover || stock.indicators.vwapAlign || stock.indicators.rsi != null || stock.indicators.atrPct != null) && (
          <div style={{ display: 'flex', gap: '10px', fontSize: '10px', marginBottom: '2px', flexWrap: 'wrap' }}>
            {stock.indicators.emaCrossover && (
              <span style={{ color: stock.indicators.emaCrossover === 'BULL' ? 'var(--bull)' : 'var(--bear)' }}>
                EMA {stock.indicators.emaCrossover === 'BULL' ? '↗' : '↘'}
              </span>
            )}
            {stock.indicators.vwapAlign && (
              <span style={{ color: stock.indicators.vwapAlign === 'BULL' ? 'var(--bull)' : 'var(--bear)' }}>
                VWAP {stock.indicators.vwapAlign === 'BULL' ? '▲' : '▼'}
              </span>
            )}
            {stock.indicators.rsi != null && (
              <span style={{ color: stock.indicators.rsi > 70 ? 'var(--bear)' : stock.indicators.rsi < 30 ? 'var(--bull)' : 'var(--text3)' }}>
                RSI {stock.indicators.rsi.toFixed(0)}
              </span>
            )}
            {stock.indicators.atrPct != null && (
              <span style={{ color: stock.indicators.atrPct >= 0.15 ? 'var(--text2)' : 'var(--text3)' }}>
                ATR {stock.indicators.atrPct.toFixed(2)}%
              </span>
            )}
          </div>
        )}

        {/* Pat bars — collapsed: PAT-30→5 + PAT-60→20 + PAT-30v2 */}
        {stock.pat30_5 == null && stock.pat60_20 == null && stock.pat30v2 == null && stock.pat30 == null ? (
          <div style={{ fontSize: '10px', color: 'var(--text3)', padding: '6px 0', fontStyle: 'italic' }}>
            No pattern history yet — building…
          </div>
        ) : (
          <>
            <PatBar label="PAT-30→5"  data={stock.pat30_5 ?? null}  ltp={stock.ltp} role={role} />
            <PatBar label="PAT-60→20" data={stock.pat60_20 ?? null} ltp={stock.ltp} role={role} />
            <PatBar label="PAT-30v2"  data={stock.pat30v2 ?? null}  ltp={stock.ltp} role={role} />
          </>
        )}

        <AlignBar score={stock.alignScore} dir={stock.alignDir} />
        {expanded && (
          <>
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: '6px', marginTop: '2px' }}>
              <PatBar label="PAT-5m"  data={stock.pat5}  ltp={stock.ltp} role={role} />
              <PatBar label="PAT-15m" data={stock.pat15} ltp={stock.ltp} role={role} />
              {stock.pat30 && !stock.pat30v2 && <PatBar label="PAT-30m" data={stock.pat30} ltp={stock.ltp} role={role} />}
            </div>
            <ExpandedPanel stock={stock} role={role} />
          </>
        )}
      </div>

      {ctxPos && (
        <ContextMenu
          pos={ctxPos} name={name} stock={stock} highlighted={highlighted} pinned={pinned}
          onHighlight={doHighlight} onPin={() => onPin?.()} onTrade={doTrade} onClose={() => setCtxPos(null)}
        />
      )}

      {toast && <Toast msg={toast} onDone={() => setToast(null)} />}
    </>
  )
}

function signalColor(sig: string) {
  return sig === 'BULL' ? 'var(--bull)' : sig === 'BEAR' ? 'var(--bear)' : 'var(--text3)'
}
