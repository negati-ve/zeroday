'use client'
import React, { useState, useEffect, useRef, useCallback } from 'react'

// ── Types ──────────────────────────────────────────────────────────────────────

export type ColSpan = 3 | 4 | 6 | 8 | 9 | 12

export interface PanelDef {
  id: string
  node: React.ReactNode
  /** When false, panel is hidden (no handle, no content). Default: true */
  visible?: boolean
  /** Default column span (out of 12). Default: 12 (full width) */
  defaultColSpan?: ColSpan
  /** Snap panel to left or right edge of the grid */
  snapEdge?: 'left' | 'right'
}

interface StoredState {
  order: string[]
  locked: string[]
  widths: Record<string, ColSpan>
}

const WIDTH_OPTIONS: { label: string; frac: string; span: ColSpan }[] = [
  { label: 'Full',  frac: '█ Full',  span: 12 },
  { label: '3/4',   frac: '▊ 3/4',  span: 9  },
  { label: '2/3',   frac: '▋ 2/3',  span: 8  },
  { label: '1/2',   frac: '▌ 1/2',  span: 6  },
  { label: '1/3',   frac: '▍ 1/3',  span: 4  },
  { label: '1/4',   frac: '▎ 1/4',  span: 3  },
]

// ── Helpers ────────────────────────────────────────────────────────────────────

function loadState(key: string, allIds: string[], defaults: Record<string, ColSpan>): {
  order: string[]
  locked: Set<string>
  widths: Record<string, ColSpan>
} {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null
    if (!raw) return { order: allIds, locked: new Set(), widths: { ...defaults } }
    const { order, locked, widths } = JSON.parse(raw) as StoredState
    const valid = new Set(allIds)
    const filtered = (order ?? []).filter(id => valid.has(id))
    const missing = allIds.filter(id => !filtered.includes(id))
    const mergedWidths: Record<string, ColSpan> = { ...defaults }
    for (const [id, span] of Object.entries(widths ?? {})) {
      if (valid.has(id)) mergedWidths[id] = span as ColSpan
    }
    return {
      order: [...filtered, ...missing],
      locked: new Set((locked ?? []).filter(id => valid.has(id))),
      widths: mergedWidths,
    }
  } catch {
    return { order: allIds, locked: new Set(), widths: { ...defaults } }
  }
}

function persist(key: string, order: string[], locked: Set<string>, widths: Record<string, ColSpan>) {
  try {
    localStorage.setItem(key, JSON.stringify({ order, locked: [...locked], widths } satisfies StoredState))
  } catch {}
}

// ── Component ──────────────────────────────────────────────────────────────────

/**
 * DraggablePanelLayout
 *
 * Renders panels in a user-configurable order on a 12-column grid.
 * - Admin: thin drag-handle strip above each panel (⠿ grab cursor on desktop, ↑↓ buttons on mobile)
 * - Right-click handle → context menu (lock/unlock, move, reset all, set width)
 * - Order + locked + widths persisted to localStorage under `storageKey`
 * - Panels with `visible === false` are fully hidden (no handle, no DOM node)
 */
export default function DraggablePanelLayout({
  panels,
  storageKey,
  isAdmin,
  gap = 10,
}: {
  panels: PanelDef[]
  storageKey: string
  isAdmin: boolean
  gap?: number
}) {
  const allIds = panels.map(p => p.id)
  const defaultWidths: Record<string, ColSpan> = Object.fromEntries(
    panels.map(p => [p.id, p.defaultColSpan ?? 12])
  )

  // ── State ──────────────────────────────────────────────────────────────────

  const [order, setOrder] = useState<string[]>(allIds)
  const [locked, setLocked] = useState<Set<string>>(new Set())
  const [widths, setWidths] = useState<Record<string, ColSpan>>(defaultWidths)
  const [isMobile, setIsMobile] = useState(false)

  // HTML5 drag state
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropId, setDropId] = useState<string | null>(null)
  /** Live-preview reorder during drag — panels visually shift to show drop target */
  const [previewOrder, setPreviewOrder] = useState<string[] | null>(null)
  const dragStartOrder = useRef<string[]>([])

  // Masonry: measured row heights for each visible panel
  const [masonryStyles, setMasonryStyles] = useState<Record<string, React.CSSProperties>>({})
  const gridRef = useRef<HTMLDivElement>(null)
  const panelRefs = useRef<Record<string, HTMLDivElement | null>>({})

  // Context menu
  const [ctxMenu, setCtxMenu] = useState<{ id: string; x: number; y: number } | null>(null)

  // ── Init ───────────────────────────────────────────────────────────────────

  const initialized = useRef(false)
  useEffect(() => {
    if (initialized.current) return
    initialized.current = true
    const saved = loadState(storageKey, allIds, defaultWidths)
    setOrder(saved.order)
    setLocked(saved.locked)
    setWidths(saved.widths)
    setIsMobile(
      typeof window !== 'undefined' &&
      ('ontouchstart' in window || navigator.maxTouchPoints > 0)
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey])

  // ── JS Masonry: measure each panel and compute CSS row-span ──────────────────
  // grid-auto-rows: 1px means each track is 1px. With row-gap G, a span-N item has
  // rendered height = N × 1 + (N-1) × G = N(1+G) - G.
  // Solving for N: N = ceil((contentH + G) / (1 + G))
  // We measure the inner content element (not the wrapper that has gridRowEnd set)
  // to avoid measuring our own inflated span.
  const computeMasonry = useCallback(() => {
    if (!gridRef.current) return
    const G = gap  // row-gap in px (gap prop, default 10)
    const ROW_UNIT = 1  // grid-auto-rows value in px
    const styles: Record<string, React.CSSProperties> = {}
    for (const [id, el] of Object.entries(panelRefs.current)) {
      if (!el) continue
      // scrollHeight = natural content height, unaffected by container clipping or
      // the outer wrapper's gridRowEnd span (avoids circular measurement dependency).
      const h = el.scrollHeight
      if (!h) continue
      // N row tracks needed so height = N×ROW_UNIT + (N-1)×G ≥ h
      // Solving: N = ceil((h + G) / (ROW_UNIT + G))
      const span = Math.max(1, Math.ceil((h + G) / (ROW_UNIT + G)))
      styles[id] = { gridRowEnd: `span ${span}` }
    }
    setMasonryStyles(styles)
  }, [gap])

  // Recompute masonry on layout changes
  useEffect(() => {
    computeMasonry()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order, widths, previewOrder, panels.length])

  // ResizeObserver: watch EACH panel's inner content for height changes
  // (content can change height when data loads, panels expand/collapse, etc.)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const ro = new ResizeObserver(() => computeMasonry())
    // Observe all current panel wrappers
    for (const el of Object.values(panelRefs.current)) {
      if (el) ro.observe(el)
    }
    // Also observe grid container for column-width changes (window resize)
    if (gridRef.current) ro.observe(gridRef.current)
    return () => ro.disconnect()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computeMasonry])

  // When new panel IDs appear, append them at end if not yet tracked
  useEffect(() => {
    setOrder(prev => {
      const prevSet = new Set(prev)
      const missing = allIds.filter(id => !prevSet.has(id))
      if (missing.length === 0) return prev
      return [...prev, ...missing]
    })
    setWidths(prev => {
      const next = { ...prev }
      for (const p of panels) {
        if (!(p.id in next)) next[p.id] = p.defaultColSpan ?? 12
      }
      return next
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panels.length])

  // ── Actions ────────────────────────────────────────────────────────────────

  const applyOrder = useCallback((newOrder: string[], newLocked?: Set<string>, newWidths?: Record<string, ColSpan>) => {
    const l = newLocked ?? locked
    const w = newWidths ?? widths
    setOrder(newOrder)
    persist(storageKey, newOrder, l, w)
  }, [storageKey, locked, widths])

  const toggleLock = useCallback((id: string) => {
    const nl = new Set(locked)
    if (nl.has(id)) nl.delete(id)
    else nl.add(id)
    setLocked(nl)
    persist(storageKey, order, nl, widths)
    setCtxMenu(null)
  }, [locked, order, storageKey, widths])

  const setWidth = useCallback((id: string, span: ColSpan) => {
    const nw = { ...widths, [id]: span }
    setWidths(nw)
    persist(storageKey, order, locked, nw)
    setCtxMenu(null)
  }, [widths, storageKey, order, locked])

  const movePanel = useCallback((id: string, dir: -1 | 1) => {
    const visibleOrder = order.filter(pid => panels.find(p => p.id === pid)?.visible !== false)
    const idx = visibleOrder.indexOf(id)
    const newIdx = idx + dir
    if (newIdx < 0 || newIdx >= visibleOrder.length) return

    const newOrder = [...order]
    const globalIdx = newOrder.indexOf(id)
    const targetId = visibleOrder[newIdx]
    const globalTargetIdx = newOrder.indexOf(targetId)
    ;[newOrder[globalIdx], newOrder[globalTargetIdx]] = [newOrder[globalTargetIdx], newOrder[globalIdx]]
    applyOrder(newOrder)
    setCtxMenu(null)
  }, [order, panels, applyOrder])

  const resetAll = useCallback(() => {
    const defaultOrder = panels.map(p => p.id)
    const emptyLocked = new Set<string>()
    const resetWidths = Object.fromEntries(panels.map(p => [p.id, p.defaultColSpan ?? 12 as ColSpan]))
    setOrder(defaultOrder)
    setLocked(emptyLocked)
    setWidths(resetWidths)
    persist(storageKey, defaultOrder, emptyLocked, resetWidths)
    setCtxMenu(null)
  }, [panels, storageKey])

  // ── HTML5 drag handlers ────────────────────────────────────────────────────

  const onDragStart = (e: React.DragEvent, id: string) => {
    if (locked.has(id)) { e.preventDefault(); return }
    setDragId(id)
    dragStartOrder.current = [...order] // snapshot for preview computation
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
    const el = e.currentTarget as HTMLElement
    el.style.opacity = '0.01'
    requestAnimationFrame(() => { el.style.opacity = '' })
  }

  const onDragOver = (e: React.DragEvent, id: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (!dragId || dragId === id || locked.has(id)) return
    setDropId(id)
    // Compute live preview: reorder panels so dragId appears before id
    // Always use snapshot (not current order) to avoid compounding partial moves
    const base = dragStartOrder.current
    const from = base.indexOf(dragId)
    const to = base.indexOf(id)
    if (from === -1 || to === -1 || from === to) return
    const next = [...base]
    next.splice(from, 1)
    next.splice(to, 0, dragId)
    setPreviewOrder(next)
  }

  const onDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault()
    if (!dragId || locked.has(dragId)) {
      setDragId(null); setDropId(null); setPreviewOrder(null); return
    }
    // Persist the live-preview order (or fall back to a fresh reorder if no preview)
    const finalOrder = previewOrder ?? (() => {
      const o = [...order]
      const from = o.indexOf(dragId)
      const to = o.indexOf(targetId)
      if (from !== -1 && to !== -1) { o.splice(from, 1); o.splice(to, 0, dragId) }
      return o
    })()
    applyOrder(finalOrder)
    setDragId(null)
    setDropId(null)
    setPreviewOrder(null)
  }

  const onDragEnd = () => { setDragId(null); setDropId(null); setPreviewOrder(null) }

  // ── Render ─────────────────────────────────────────────────────────────────

  const panelMap = new Map(panels.map(p => [p.id, p]))
  // Use previewOrder during active drag so panels visually shift to show the drop target
  const renderOrder = previewOrder ?? order
  const visibleIds = renderOrder.filter(id => panelMap.get(id)?.visible !== false)

  return (
    <div
      ref={gridRef}
      onClick={() => setCtxMenu(null)}
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(12, 1fr)',
        gridAutoFlow: 'row dense',
        // 1px auto rows: each panel sets gridRowEnd: 'span N' to match its natural height.
        // This gives true masonry gap-filling: short panels leave 1px rows that taller
        // panels in later positions can fill up into.
        gridAutoRows: '1px',
        gap,
        alignItems: 'start',
      }}
    >
      {renderOrder.map((id) => {
        const panelDef = panelMap.get(id)
        if (!panelDef || panelDef.visible === false) return null

        const isLocked = locked.has(id)
        const isDragging = dragId === id
        const isOver = dropId === id
        const visIdx = visibleIds.indexOf(id)
        const canDrag = isAdmin && !isLocked
        const span = isMobile ? 12 : (widths[id] ?? 12)
        const snapEdge = isMobile ? undefined : panelDef.snapEdge
        const gridColumn = snapEdge === 'left'
          ? `1 / span ${span}`
          : snapEdge === 'right'
            ? `${13 - span} / 13`
            : `span ${span}`

        return (
          <div
            key={id}
            ref={el => { panelRefs.current[id] = el }}
            draggable={canDrag && !isMobile}
            onDragStart={e => onDragStart(e, id)}
            onDragOver={e => onDragOver(e, id)}
            onDrop={e => onDrop(e, id)}
            onDragEnd={onDragEnd}
            style={{
              gridColumn,
              // JS masonry: gridRowEnd spans enough 1px rows to cover natural height
              ...masonryStyles[id],
              opacity: isDragging ? 0.25 : 1,
              outline: isOver && !isDragging ? '2px solid rgba(99,102,241,0.7)' : undefined,
              outlineOffset: '3px',
              borderRadius: '6px',
              transition: 'opacity 0.12s, outline 0.08s',
              transform: isOver && !isDragging ? 'scale(1.005)' : undefined,
              minWidth: 0,
              overflow: 'hidden',
            }}
          >
            {/* Admin drag handle strip */}
            {isAdmin && (
              <div
                data-drag-handle="true"
                onContextMenu={e => {
                  e.preventDefault()
                  e.stopPropagation()
                  setCtxMenu({ id, x: e.clientX, y: e.clientY })
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  padding: '1px 8px 2px 6px',
                  fontSize: '7px',
                  color: 'var(--text3)',
                  letterSpacing: '0.1em',
                  userSelect: 'none',
                  cursor: isLocked ? 'not-allowed' : isMobile ? 'default' : 'grab',
                  opacity: 0.5,
                  fontFamily: 'monospace',
                  minHeight: isMobile ? '20px' : '14px',
                }}
              >
                {/* Grip / lock icon */}
                <span style={{ fontSize: '10px', opacity: isLocked ? 1 : 0.6, flexShrink: 0 }}>
                  {isLocked ? '🔒' : '⠿'}
                </span>

                {/* Panel label */}
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {id.replace(/_/g, ' ')}
                </span>

                {/* Width indicator (non-full only) */}
                {!isMobile && span !== 12 && (
                  <span style={{ fontSize: '7px', color: 'var(--text3)', opacity: 0.7, flexShrink: 0 }}>
                    {WIDTH_OPTIONS.find(o => o.span === span)?.label ?? `${span}/12`}
                  </span>
                )}

                {/* Mobile ↑↓ move buttons */}
                {isMobile && !isLocked && (
                  <span style={{ display: 'flex', gap: '2px', flexShrink: 0 }}>
                    <button
                      onClick={e => { e.stopPropagation(); movePanel(id, -1) }}
                      disabled={visIdx === 0}
                      aria-label="Move panel up"
                      style={arrowBtn(visIdx === 0)}
                    >▲</button>
                    <button
                      onClick={e => { e.stopPropagation(); movePanel(id, 1) }}
                      disabled={visIdx === visibleIds.length - 1}
                      aria-label="Move panel down"
                      style={arrowBtn(visIdx === visibleIds.length - 1)}
                    >▼</button>
                  </span>
                )}
              </div>
            )}

            {/* Panel content */}
            {panelDef.node}
          </div>
        )
      })}

      {/* Context menu */}
      {ctxMenu && isAdmin && (
        <>
          {/* Backdrop */}
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 8990, gridColumn: 'span 12' }}
            onPointerDown={() => setCtxMenu(null)}
          />
          {/* Menu */}
          <div
            onClick={e => e.stopPropagation()}
            style={{
              position: 'fixed',
              left: Math.min(ctxMenu.x, (typeof window !== 'undefined' ? window.innerWidth : 800) - 190),
              top: Math.min(ctxMenu.y, (typeof window !== 'undefined' ? window.innerHeight : 600) - 260),
              zIndex: 8999,
              background: 'var(--bg2)',
              border: '1px solid var(--border)',
              borderRadius: '6px',
              padding: '4px',
              minWidth: '180px',
              boxShadow: '0 4px 20px rgba(0,0,0,0.55)',
              fontFamily: 'monospace',
              gridColumn: 'span 12',
            }}
          >
            {/* Header */}
            <div style={{
              padding: '4px 10px 5px',
              fontSize: '7px',
              color: 'var(--text3)',
              letterSpacing: '0.1em',
              borderBottom: '1px solid var(--border)',
              marginBottom: '3px',
              textTransform: 'uppercase',
            }}>
              {ctxMenu.id.replace(/_/g, ' ')}
            </div>

            {/* Lock */}
            <CtxBtn onClick={() => toggleLock(ctxMenu.id)}>
              {locked.has(ctxMenu.id) ? '🔓 Unlock panel' : '🔒 Lock panel'}
            </CtxBtn>

            {/* Move up/down */}
            {!locked.has(ctxMenu.id) && (() => {
              const vi = visibleIds.indexOf(ctxMenu.id)
              return (
                <>
                  <CtxBtn disabled={vi === 0} onClick={() => movePanel(ctxMenu.id, -1)}>↑ Move up</CtxBtn>
                  <CtxBtn disabled={vi === visibleIds.length - 1} onClick={() => movePanel(ctxMenu.id, 1)}>↓ Move down</CtxBtn>
                </>
              )
            })()}

            {/* Width picker */}
            <div style={{ borderTop: '1px solid var(--border)', marginTop: '3px', paddingTop: '3px' }}>
              <div style={{ padding: '2px 10px 4px', fontSize: '7px', color: 'var(--text3)', letterSpacing: '0.1em' }}>
                WIDTH
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '2px', padding: '0 4px 2px' }}>
                {WIDTH_OPTIONS.map(opt => {
                  const active = (widths[ctxMenu.id] ?? 12) === opt.span
                  return (
                    <button
                      key={opt.span}
                      onClick={() => setWidth(ctxMenu.id, opt.span)}
                      style={{
                        border: `1px solid ${active ? 'var(--text2)' : 'var(--border)'}`,
                        background: active ? 'var(--bg3)' : 'transparent',
                        color: active ? 'var(--text)' : 'var(--text3)',
                        borderRadius: '3px',
                        padding: '4px 2px',
                        fontSize: '9px',
                        cursor: 'pointer',
                        fontFamily: 'monospace',
                        fontWeight: active ? 700 : 400,
                        textAlign: 'center',
                        letterSpacing: 0,
                      }}
                      onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.background = 'var(--bg3)' }}
                      onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
                    >
                      {opt.frac}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Reset all */}
            <div style={{ borderTop: '1px solid var(--border)', marginTop: '3px', paddingTop: '3px' }}>
              <CtxBtn onClick={resetAll} danger>↺ Reset all panels</CtxBtn>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function CtxBtn({
  children,
  onClick,
  disabled,
  danger,
}: {
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'block',
        width: '100%',
        padding: '6px 10px',
        border: 'none',
        background: 'transparent',
        color: danger ? 'var(--bear)' : disabled ? 'var(--text3)' : 'var(--text)',
        fontFamily: 'monospace',
        fontSize: '11px',
        textAlign: 'left',
        cursor: disabled ? 'not-allowed' : 'pointer',
        borderRadius: '3px',
        opacity: disabled ? 0.4 : 1,
      }}
      onMouseEnter={e => {
        if (!disabled) (e.currentTarget as HTMLElement).style.background = 'var(--bg3)'
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLElement).style.background = 'transparent'
      }}
    >
      {children}
    </button>
  )
}

function arrowBtn(disabled: boolean): React.CSSProperties {
  return {
    border: '1px solid var(--border)',
    background: 'transparent',
    color: disabled ? 'var(--text3)' : 'var(--text2)',
    borderRadius: '3px',
    padding: '0 5px',
    fontSize: '8px',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.25 : 0.8,
    lineHeight: '16px',
    height: '16px',
    fontFamily: 'monospace',
  }
}
