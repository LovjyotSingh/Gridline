// The virtualized grid. The page scrolls a full-size spacer natively, and only the rows and
// columns in view (plus a small margin) are rendered, so 10,000 rows cost the same as 30.

import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { display, isErr } from './engine/evaluate'
import type { Sheet } from './engine/sheet'
import { COLS, ROWS, colName, normRect, type Rect } from './engine/ref'

export const ROW_H = 30
export const HEAD_H = 30
export const GUTTER = 52
const REF_COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)']

export interface Sel { r: number; c: number; er: number; ec: number }

interface Props {
  sheet: Sheet
  version: number
  colW: number
  sel: Sel
  refRects: Rect[]
  editor: ReactNode
  editorWidth: number
  scrollerRef: RefObject<HTMLDivElement | null>
  onCell: (r: number, c: number, how: { shift: boolean; drag: boolean }) => boolean
  onSelect: (sel: Sel) => void
  onEdit: () => void
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

export function Grid(p: Props) {
  const { sheet, colW, sel } = p
  const [view, setView] = useState({ top: 0, left: 0, w: 1200, h: 800 })
  const bodyRef = useRef<HTMLDivElement>(null)
  const lastPointer = useRef('mouse')

  useLayoutEffect(() => {
    const el = p.scrollerRef.current!
    const measure = () => setView(v => ({ ...v, w: el.clientWidth, h: el.clientHeight }))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [p.scrollerRef])

  const onScroll = () => {
    const el = p.scrollerRef.current!
    setView(v => ({ ...v, top: el.scrollTop, left: el.scrollLeft }))
  }

  const r0 = Math.max(0, Math.floor(view.top / ROW_H) - 6)
  const r1 = Math.min(ROWS - 1, Math.ceil((view.top + view.h) / ROW_H) + 6)
  const c0 = Math.max(0, Math.floor(view.left / colW) - 1)
  const c1 = Math.min(COLS - 1, Math.ceil((view.left + view.w) / colW) + 1)

  // cells the last edit recalculated flash briefly, so you can watch the dependency graph work
  const recent = sheet.lastRecalc
  const flashing = recent.keys.size <= 500 && performance.now() - recent.at < 900

  const cells: ReactNode[] = []
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (!sheet.raw(r, c)) continue
      const v = sheet.value(r, c)
      const kind = isErr(v) ? 'err' : typeof v === 'number' ? 'num' : typeof v === 'boolean' ? 'bool' : 'text'
      // text runs on into empty cells to its right, like in Sheets
      let spill = 0
      if (kind === 'text') while (spill < 8 && c + spill + 1 < COLS && !sheet.raw(r, c + spill + 1)) spill++
      const k = r * COLS + c, flash = flashing && recent.keys.has(k)
      cells.push(
        <div
          key={flash ? `${k}@${recent.at}` : k} className={`cell ${kind}${flash ? ' flash' : ''}`}
          style={{ top: r * ROW_H, left: c * colW, width: colW * (spill + 1) }}
        >
          {display(v)}
        </div>
      )
    }
  }

  const rect = normRect({ r: sel.r, c: sel.c }, { r: sel.er, c: sel.ec })
  const multi = rect.r1 !== rect.r2 || rect.c1 !== rect.c2
  const box = (x: Rect): CSSProperties => ({
    top: x.r1 * ROW_H, left: x.c1 * colW, width: (x.c2 - x.c1 + 1) * colW, height: (x.r2 - x.r1 + 1) * ROW_H
  })

  const cellAt = (e: { clientX: number; clientY: number }) => {
    const b = bodyRef.current!.getBoundingClientRect()
    return {
      r: clamp(Math.floor((e.clientY - b.top) / ROW_H), 0, ROWS - 1),
      c: clamp(Math.floor((e.clientX - b.left) / colW), 0, COLS - 1)
    }
  }

  const onPointerDown = (e: React.PointerEvent) => {
    lastPointer.current = e.pointerType
    if (e.pointerType !== 'mouse' || e.button !== 0 || (e.target as HTMLElement).closest('.editor')) return
    let last = cellAt(e)
    if (p.onCell(last.r, last.c, { shift: e.shiftKey, drag: false })) e.preventDefault()
    const move = (ev: PointerEvent) => {
      const q = cellAt(ev)
      if (q.r === last.r && q.c === last.c) return
      last = q
      p.onCell(q.r, q.c, { shift: true, drag: true })
    }
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up) }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
  }

  // touch taps select on click, so a swipe to scroll doesn't move the selection
  const onClick = (e: React.MouseEvent) => {
    if (lastPointer.current === 'mouse' || (e.target as HTMLElement).closest('.editor')) return
    const q = cellAt(e)
    p.onCell(q.r, q.c, { shift: false, drag: false })
  }

  const cols: number[] = [], rows: number[] = []
  for (let c = c0; c <= c1; c++) cols.push(c)
  for (let r = r0; r <= r1; r++) rows.push(r)

  return (
    <div
      className="scroller" ref={p.scrollerRef} tabIndex={0} onScroll={onScroll} onKeyDown={p.onKeyDown}
      role="grid" aria-label="Spreadsheet" aria-rowcount={ROWS} aria-colcount={COLS}
    >
      <div className="sizer" style={{ width: GUTTER + COLS * colW, height: HEAD_H + ROWS * ROW_H }}>
        <div className="colhead" style={{ width: GUTTER + COLS * colW }}>
          <button className="corner" tabIndex={-1} aria-label="Select all" onClick={() => p.onSelect({ r: 0, c: 0, er: ROWS - 1, ec: COLS - 1 })} />
          {cols.map(c => (
            <div
              key={c} className={'ch' + (c >= rect.c1 && c <= rect.c2 ? ' on' : '')} style={{ left: GUTTER + c * colW, width: colW }}
              onClick={e => p.onSelect(e.shiftKey ? { ...sel, er: ROWS - 1, ec: c } : { r: 0, c, er: ROWS - 1, ec: c })}
            >{colName(c)}</div>
          ))}
        </div>
        <div className="rowhead" style={{ height: ROWS * ROW_H }}>
          {rows.map(r => (
            <div
              key={r} className={'rh' + (r >= rect.r1 && r <= rect.r2 ? ' on' : '')} style={{ top: r * ROW_H }}
              onClick={e => p.onSelect(e.shiftKey ? { ...sel, er: r, ec: COLS - 1 } : { r, c: 0, er: r, ec: COLS - 1 })}
            >{r + 1}</div>
          ))}
        </div>
        <div
          className="body" ref={bodyRef}
          style={{ width: COLS * colW, height: ROWS * ROW_H, backgroundSize: `${colW}px ${ROW_H}px` }}
          onPointerDown={onPointerDown} onClick={onClick} onDoubleClick={p.onEdit}
        >
          {cells}
          {p.refRects.map((x, i) => (
            <div key={'ref' + i} className="refbox" style={{ ...box(x), '--rc': REF_COLORS[i % REF_COLORS.length] } as CSSProperties} />
          ))}
          {multi && <div className="range" style={box(rect)} />}
          <div className="active" style={box({ r1: sel.r, c1: sel.c, r2: sel.r, c2: sel.c })} />
          {p.editor && (
            <div className="editor" style={{ top: sel.r * ROW_H, left: sel.c * colW, width: p.editorWidth, height: ROW_H }}>{p.editor}</div>
          )}
        </div>
      </div>
    </div>
  )
}
