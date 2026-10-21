import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent } from 'react'
import { GUTTER, Grid, HEAD_H, ROW_H, type Sel } from './Grid'
import { parseDelimited, toDelimited } from './engine/csv'
import { FUNCTIONS, display, formatNumber } from './engine/evaluate'
import { referencedRects, shiftFormula } from './engine/formula'
import { COLS, ROWS, cellName, key, normRect, rectName } from './engine/ref'
import { Sheet, type Edit } from './engine/sheet'
import { sampleEdits, stressEdits } from './sample'

interface EditState { draft: string; mode: 'quick' | 'full'; where: 'cell' | 'bar' }
interface Step { before: Edit[]; after: Edit[] }
interface Clip { text: string; raws: string[][]; r: number; c: number; cut: boolean }

const STORE = 'gridline:v1'
const ARROWS: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }
const clampR = (r: number) => Math.max(0, Math.min(ROWS - 1, r))
const clampC = (c: number) => Math.max(0, Math.min(COLS - 1, c))

function loadSheet() {
  const s = new Sheet()
  let saved: Edit[] | null = null
  try {
    const json = localStorage.getItem(STORE)
    if (json) saved = (JSON.parse(json) as Array<[number, number, string]>).map(([r, c, raw]) => ({ r, c, raw }))
  } catch { /* private mode or bad data: start from the sample */ }
  s.set(saved ?? sampleEdits())
  return s
}

const useNarrow = () => {
  const q = '(max-width: 600px)'
  const [narrow, setNarrow] = useState(() => matchMedia(q).matches)
  useEffect(() => {
    const m = matchMedia(q), on = () => setNarrow(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return narrow
}

export default function App() {
  const [sheet] = useState(loadSheet)
  const [version, bump] = useReducer((x: number) => x + 1, 0)
  const [sel, setSel] = useState<Sel>({ r: 1, c: 4, er: 1, ec: 4 })
  const [edit, setEdit] = useState<EditState | null>(null)
  const [notice, setNotice] = useState('')
  const [help, setHelp] = useState(false)
  const colW = useNarrow() ? 96 : 116

  const scrollerRef = useRef<HTMLDivElement>(null)
  const cellInput = useRef<HTMLInputElement>(null)
  const barInput = useRef<HTMLInputElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const history = useRef<{ undo: Step[]; redo: Step[] }>({ undo: [], redo: [] })
  const clip = useRef<Clip | null>(null)
  const caret = useRef<number | null>(null)
  const inserting = useRef<{ from: number; to: number; r: number; c: number } | null>(null)
  const noticeTimer = useRef(0)

  // handlers registered once (clipboard, pointer drags) read the latest state through these
  const selRef = useRef(sel), editRef = useRef(edit)
  selRef.current = sel
  editRef.current = edit

  const notify = (text: string) => {
    setNotice(text)
    clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(''), 4000)
  }

  /* ---------- changes and history ---------- */

  function commit(edits: Edit[]) {
    const last = new Map<number, Edit>()
    for (const e of edits) last.set(key(e.r, e.c), e)
    const after = [...last.values()].filter(e => sheet.raw(e.r, e.c) !== e.raw)
    if (!after.length) return
    const before = after.map(e => ({ r: e.r, c: e.c, raw: sheet.raw(e.r, e.c) }))
    sheet.set(after)
    const h = history.current
    h.undo.push({ before, after })
    if (h.undo.length > 200) h.undo.shift()
    h.redo = []
    bump()
  }

  function travel(back: boolean) {
    const h = history.current
    const step = (back ? h.undo : h.redo).pop()
    if (!step) return notify(back ? 'Nothing to undo' : 'Nothing to redo')
    sheet.set(back ? step.before : step.after)
    ;(back ? h.redo : h.undo).push(step)
    const first = step.after[0]
    select({ r: first.r, c: first.c, er: first.r, ec: first.c })
    bump()
  }

  useEffect(() => {
    const t = setTimeout(() => {
      try { localStorage.setItem(STORE, JSON.stringify(sheet.entries().map(e => [e.r, e.c, e.raw]))) } catch { /* storage full or blocked */ }
    }, 400)
    return () => clearTimeout(t)
  }, [version, sheet])

  /* ---------- selection ---------- */

  function ensureVisible(r: number, c: number) {
    const el = scrollerRef.current
    if (!el) return
    const viewH = el.clientHeight - HEAD_H, viewW = el.clientWidth - GUTTER
    const top = r * ROW_H, left = c * colW
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + ROW_H > el.scrollTop + viewH) el.scrollTop = top + ROW_H - viewH
    if (left < el.scrollLeft) el.scrollLeft = left
    else if (left + colW > el.scrollLeft + viewW) el.scrollLeft = left + colW - viewW
  }

  function select(next: Sel, reveal = true) {
    selRef.current = next
    setSel(next)
    if (reveal) ensureVisible(next.er, next.ec)
  }

  const focusGrid = () => scrollerRef.current?.focus({ preventScroll: true })
  const rect = normRect({ r: sel.r, c: sel.c }, { r: sel.er, c: sel.ec })

  /* ---------- editing ---------- */

  function startEdit(draft: string, mode: EditState['mode'], where: EditState['where'] = 'cell', caretAt: number | null = draft.length) {
    const e = { draft, mode, where }
    editRef.current = e
    caret.current = caretAt
    inserting.current = null
    setEdit(e)
  }

  function setDraft(draft: string, where: EditState['where']) {
    const e = { ...editRef.current!, draft, where }
    editRef.current = e
    inserting.current = null
    setEdit(e)
  }

  function finishEdit(dr: number, dc: number, focus = true) {
    const e = editRef.current
    if (!e) return
    const s = selRef.current
    editRef.current = null
    inserting.current = null
    setEdit(null)
    commit([{ r: s.r, c: s.c, raw: e.draft }])
    if (dr || dc) {
      const r = clampR(s.r + dr), c = clampC(s.c + dc)
      select({ r, c, er: r, ec: c })
    }
    if (focus) focusGrid()
  }

  function cancelEdit() {
    editRef.current = null
    inserting.current = null
    setEdit(null)
    focusGrid()
  }

  // put focus and the caret where the edit wants them
  useLayoutEffect(() => {
    if (!edit) return
    const el = edit.where === 'cell' ? cellInput.current : barInput.current
    if (!el) return
    if (document.activeElement !== el) el.focus({ preventScroll: true })
    if (caret.current !== null) { el.setSelectionRange(caret.current, caret.current); caret.current = null }
  }, [edit])

  const onEditBlur = () => requestAnimationFrame(() => {
    const a = document.activeElement
    if (editRef.current && a !== cellInput.current && a !== barInput.current) finishEdit(0, 0, false)
  })

  function onEditKey(e: KeyboardEvent<HTMLInputElement>) {
    const ed = editRef.current
    if (!ed) return
    if (e.key === 'Enter') { e.preventDefault(); finishEdit(e.shiftKey ? -1 : 1, 0) }
    else if (e.key === 'Tab') { e.preventDefault(); finishEdit(0, e.shiftKey ? -1 : 1) }
    else if (e.key === 'Escape') { e.preventDefault(); cancelEdit() }
    else if (ed.mode === 'quick' && ed.where === 'cell' && e.key in ARROWS && !ed.draft.startsWith('=')) {
      e.preventDefault()
      const [dr, dc] = ARROWS[e.key]
      finishEdit(dr, dc)
    }
  }

  /** Mouse or tap on a cell. Returns true when it inserted a reference into the formula being typed. */
  function onCell(r: number, c: number, how: { shift: boolean; drag: boolean }) {
    const ed = editRef.current
    if (ed && ed.draft.startsWith('=')) {
      const ins = inserting.current
      if (how.drag && ins) {
        const text = rectName(normRect({ r: ins.r, c: ins.c }, { r, c }))
        const draft = ed.draft.slice(0, ins.from) + text + ed.draft.slice(ins.to)
        inserting.current = { ...ins, to: ins.from + text.length }
        caret.current = ins.from + text.length
        const e = { ...ed, draft }
        editRef.current = e
        setEdit(e)
        return true
      }
      const input = ed.where === 'cell' ? cellInput.current : barInput.current
      const at = input?.selectionStart ?? ed.draft.length, end = input?.selectionEnd ?? at
      if (!how.drag && /[=(,+\-*/^&<>:]\s*$/.test(ed.draft.slice(0, at))) {
        const text = cellName(r, c)
        const e = { ...ed, draft: ed.draft.slice(0, at) + text + ed.draft.slice(end) }
        inserting.current = { from: at, to: at + text.length, r, c }
        caret.current = at + text.length
        editRef.current = e
        setEdit(e)
        return true
      }
    }
    if (how.drag) {
      if (!ed) select({ ...selRef.current, er: r, ec: c }, false)
      return false
    }
    if (ed) finishEdit(0, 0, false)
    const s = selRef.current
    select(how.shift ? { ...s, er: r, ec: c } : { r, c, er: r, ec: c }, false)
    focusGrid()
    return false
  }

  /* ---------- keyboard on the grid ---------- */

  function onGridKey(e: KeyboardEvent<HTMLDivElement>) {
    if (editRef.current || e.target !== scrollerRef.current) return
    const mod = e.ctrlKey || e.metaKey, k = e.key, s = selRef.current
    if (mod && k.toLowerCase() === 'z') { e.preventDefault(); travel(!e.shiftKey); return }
    if (mod && k.toLowerCase() === 'y') { e.preventDefault(); travel(false); return }
    if (mod && k.toLowerCase() === 'a') { e.preventDefault(); select({ r: 0, c: 0, er: ROWS - 1, ec: COLS - 1 }, false); return }
    if (k in ARROWS) {
      e.preventDefault()
      const [dr, dc] = ARROWS[k]
      const fr = e.shiftKey ? s.er : s.r, fc = e.shiftKey ? s.ec : s.c
      let r = fr + dr, c = fc + dc
      if (mod) {
        if (dr < 0) r = 0
        if (dc < 0) c = 0
        if (dc > 0) c = COLS - 1
        if (dr > 0) { const last = sheet.lastRow(fc); r = last > fr ? last : ROWS - 1 }
      }
      r = clampR(r); c = clampC(c)
      select(e.shiftKey ? { ...s, er: r, ec: c } : { r, c, er: r, ec: c })
      return
    }
    const page = Math.max(1, Math.floor((scrollerRef.current!.clientHeight - HEAD_H) / ROW_H) - 1)
    switch (k) {
      case 'Tab': { e.preventDefault(); const c = clampC(s.c + (e.shiftKey ? -1 : 1)); select({ r: s.r, c, er: s.r, ec: c }); return }
      case 'Enter': case 'F2': e.preventDefault(); startEdit(sheet.raw(s.r, s.c), 'full'); return
      case 'Delete': case 'Backspace': e.preventDefault(); clearSelection(); return
      case 'Escape': select({ ...s, er: s.r, ec: s.c }, false); return
      case 'PageDown': case 'PageUp': {
        e.preventDefault()
        const r = clampR(s.r + (k === 'PageDown' ? page : -page))
        select({ r, c: s.c, er: r, ec: s.c })
        return
      }
      case 'Home': { e.preventDefault(); const r = mod ? 0 : s.r; select({ r, c: 0, er: r, ec: 0 }); return }
    }
    if (k.length === 1 && !mod && !e.altKey) { e.preventDefault(); startEdit(k, 'quick') }
  }

  function clearSelection() {
    const x = normRect({ r: selRef.current.r, c: selRef.current.c }, { r: selRef.current.er, c: selRef.current.ec })
    commit([...sheet.filledIn(x)].map(p => ({ ...p, raw: '' })))
  }

  /* ---------- clipboard: tab-separated text, so it works with Excel and Google Sheets ---------- */

  useEffect(() => {
    const ready = () => document.activeElement === scrollerRef.current && !editRef.current
    const current = () => { const s = selRef.current; return normRect({ r: s.r, c: s.c }, { r: s.er, c: s.ec }) }

    function copy(e: ClipboardEvent, cut: boolean) {
      if (!ready()) return
      e.preventDefault()
      const x = current()
      if ((x.r2 - x.r1 + 1) * (x.c2 - x.c1 + 1) > 300_000) return notify('That selection is too large to copy')
      const values: string[][] = [], raws: string[][] = []
      for (let r = x.r1; r <= x.r2; r++) {
        const vr: string[] = [], rr: string[] = []
        for (let c = x.c1; c <= x.c2; c++) { vr.push(display(sheet.value(r, c))); rr.push(sheet.raw(r, c)) }
        values.push(vr); raws.push(rr)
      }
      const text = toDelimited(values, '\t')
      e.clipboardData?.setData('text/plain', text)
      clip.current = { text, raws, r: x.r1, c: x.c1, cut }
      notify(cut ? `Cut ${rectName(x)}. Paste to move it.` : `Copied ${rectName(x)}`)
    }

    function paste(e: ClipboardEvent) {
      if (!ready()) return
      const text = e.clipboardData?.getData('text/plain') ?? ''
      if (!text) return
      e.preventDefault()
      const x = current(), same = (a: string) => a.replace(/\r\n/g, '\n').replace(/\n$/, '')
      const own = clip.current && same(clip.current.text) === same(text) ? clip.current : null
      const src = own ? own.raws : parseDelimited(text.replace(/\r?\n$/, ''), '\t')
      const h = src.length, w = Math.max(...src.map(row => row.length))
      // one copied cell fills the whole selection
      const fill = h === 1 && w === 1 && (x.r2 > x.r1 || x.c2 > x.c1)
      const rows = fill ? x.r2 - x.r1 + 1 : h, cols = fill ? x.c2 - x.c1 + 1 : w
      const edits: Edit[] = []
      if (own?.cut) for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) edits.push({ r: own.r + i, c: own.c + j, raw: '' })
      for (let i = 0; i < rows; i++) {
        for (let j = 0; j < cols; j++) {
          const r = x.r1 + i, c = x.c1 + j
          if (r >= ROWS || c >= COLS) continue
          const si = fill ? 0 : i, sj = fill ? 0 : j
          let raw = src[si][sj] ?? ''
          if (own && !own.cut) raw = shiftFormula(raw, r - (own.r + si), c - (own.c + sj))
          edits.push({ r, c, raw })
        }
      }
      if (own?.cut) clip.current = null
      commit(edits)
      select({ r: x.r1, c: x.c1, er: clampR(x.r1 + rows - 1), ec: clampC(x.c1 + cols - 1) }, false)
      notify(`Pasted ${rows * cols} cell${rows * cols === 1 ? '' : 's'}`)
    }

    const onCopy = (e: ClipboardEvent) => copy(e, false), onCut = (e: ClipboardEvent) => copy(e, true)
    document.addEventListener('copy', onCopy)
    document.addEventListener('cut', onCut)
    document.addEventListener('paste', paste)
    return () => {
      document.removeEventListener('copy', onCopy)
      document.removeEventListener('cut', onCut)
      document.removeEventListener('paste', paste)
    }
  })

  /* ---------- toolbar ---------- */

  const clearAll = () => sheet.entries().map(e => ({ ...e, raw: '' }))

  function loadSample() {
    commit([...clearAll(), ...sampleEdits()])
    select({ r: 1, c: 4, er: 1, ec: 4 })
    notify('Loaded the sample sheet. Undo brings back what you had.')
  }

  function loadStress() {
    commit(stressEdits())
    const { cells, ms } = sheet.lastRecalc
    select({ r: 0, c: 11, er: 0, ec: 11 })
    notify(`Added 10,000 rows and computed ${cells.toLocaleString()} cells in ${ms.toFixed(0)} ms. Now edit any cell in column K.`)
  }

  function exportCsv() {
    const { rows, cols } = sheet.extent()
    if (!rows) return notify('The sheet is empty')
    const out: string[][] = []
    for (let r = 0; r < rows; r++) {
      const row: string[] = []
      for (let c = 0; c < cols; c++) row.push(display(sheet.value(r, c)))
      out.push(row)
    }
    const url = URL.createObjectURL(new Blob([toDelimited(out, ',')], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'gridline.csv'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    notify(`Exported ${rows} rows as CSV`)
  }

  async function importCsv(file: File) {
    const rows = parseDelimited(await file.text(), ',').slice(0, ROWS)
    const edits = clearAll()
    rows.forEach((row, r) => row.slice(0, COLS).forEach((raw, c) => { if (raw !== '') edits.push({ r, c, raw }) }))
    commit(edits)
    select({ r: 0, c: 0, er: 0, ec: 0 })
    notify(`Imported ${rows.length} rows from ${file.name}. Undo to go back.`)
  }

  useEffect(() => {
    if (!help) return
    const close = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') setHelp(false) }
    addEventListener('keydown', close)
    return () => removeEventListener('keydown', close)
  }, [help])

  useEffect(() => { focusGrid() }, [])

  /* ---------- derived view ---------- */

  const activeRaw = sheet.raw(sel.r, sel.c)
  const source = edit ? edit.draft : activeRaw
  const refRects = source.startsWith('=') ? referencedRects(source.slice(1)) : []

  const stats = useMemo(() => {
    if (rect.r1 === rect.r2 && rect.c1 === rect.c2) return null
    let sum = 0, count = 0, filled = 0
    for (const p of sheet.filledIn(rect)) {
      filled++
      const v = sheet.value(p.r, p.c)
      if (typeof v === 'number') { sum += v; count++ }
    }
    return { sum, count, filled }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, rect.r1, rect.c1, rect.r2, rect.c2, sheet])

  const { cells: recalcCells, ms } = sheet.lastRecalc
  const reads = sheet.precedents(sel.r, sel.c), feeds = sheet.dependents(sel.r, sel.c)
  const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`

  const editor = edit && (
    <input
      ref={cellInput} value={edit.draft} spellCheck={false} autoComplete="off" aria-label={`Edit ${cellName(sel.r, sel.c)}`}
      onChange={e => setDraft(e.target.value, 'cell')}
      onFocus={() => { if (editRef.current && editRef.current.where !== 'cell') setDraft(editRef.current.draft, 'cell') }}
      onKeyDown={onEditKey} onBlur={onEditBlur}
    />
  )

  return (
    <div className="app">
      <header className="top">
        <a className="brand" href="https://lovjyotsingh.github.io" target="_blank" rel="noopener" title="Built by Lovjyot Singh">
          <svg viewBox="0 0 32 32" aria-hidden="true">
            <defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#FF8A3D" /><stop offset=".5" stopColor="#FF3D81" /><stop offset="1" stopColor="#8B5CFF" /></linearGradient></defs>
            <rect x="1" y="1" width="30" height="30" rx="8" fill="#0A0A0B" stroke="url(#lg)" strokeWidth="2" />
            <path d="M1 11.5h30M1 20.5h30M11.5 1v30M20.5 1v30" stroke="url(#lg)" strokeWidth="1.5" opacity=".7" />
            <rect x="11.5" y="11.5" width="9" height="9" fill="url(#lg)" />
          </svg>
          <span><b>Gridline</b><small>A spreadsheet engine built from scratch</small></span>
        </a>
        <nav className="tools" aria-label="Sheet actions">
          <button className="btn" onClick={loadSample}>Sample</button>
          <button className="btn" onClick={loadStress}>Add 10,000 rows</button>
          <button className="btn" onClick={() => fileInput.current?.click()}>Import CSV</button>
          <button className="btn" onClick={exportCsv}>Export CSV</button>
          <button className="btn" onClick={() => { commit(clearAll()); notify('Cleared. Undo brings it back.') }}>Clear</button>
          <button className="btn" onClick={() => travel(true)} aria-label="Undo" title="Undo (Ctrl+Z)">↶</button>
          <button className="btn" onClick={() => travel(false)} aria-label="Redo" title="Redo (Ctrl+Y)">↷</button>
          <button className={'btn' + (help ? ' on' : '')} onClick={() => setHelp(h => !h)} aria-expanded={help} aria-controls="help">How it works</button>
        </nav>
        <input ref={fileInput} type="file" accept=".csv,text/csv" hidden onChange={e => { const f = e.target.files?.[0]; if (f) importCsv(f); e.target.value = '' }} />
      </header>

      <div className="fbar">
        <span className="namebox" aria-label="Selection">{rectName(rect)}</span>
        <span className="fx" aria-hidden="true">fx</span>
        <input
          ref={barInput} spellCheck={false} autoComplete="off" aria-label="Formula bar"
          value={edit ? edit.draft : activeRaw}
          onFocus={() => {
            const ed = editRef.current
            if (!ed) startEdit(sheet.raw(selRef.current.r, selRef.current.c), 'full', 'bar', null)
            else if (ed.where !== 'bar') setDraft(ed.draft, 'bar')
          }}
          onChange={e => setDraft(e.target.value, 'bar')}
          onKeyDown={onEditKey} onBlur={onEditBlur}
        />
      </div>

      <Grid
        sheet={sheet} version={version} colW={colW} sel={sel} refRects={refRects}
        editor={editor} editorWidth={edit ? Math.min(520, Math.max(colW, edit.draft.length * 8 + 28)) : colW}
        scrollerRef={scrollerRef} onCell={onCell} onKeyDown={onGridKey}
        onSelect={s => { if (editRef.current) finishEdit(0, 0, false); select(s, false); focusGrid() }}
        onEdit={() => { if (!editRef.current) startEdit(sheet.raw(selRef.current.r, selRef.current.c), 'full') }}
      />

      <footer className="status">
        <span className="left">
          {stats ? (
            <>Sum <b>{formatNumber(stats.sum)}</b> · Average <b>{stats.count ? formatNumber(stats.sum / stats.count) : '–'}</b> · Count <b>{stats.count}</b> · Filled <b>{stats.filled}</b></>
          ) : (
            <><b>{cellName(sel.r, sel.c)}</b>{activeRaw.startsWith('=') ? <> reads <b>{plural(reads, 'cell')}</b></> : null}{feeds ? <> · feeds <b>{plural(feeds, 'formula')}</b></> : null}</>
          )}
        </span>
        <span className="right" aria-live="polite">
          {notice || <>Last edit recalculated <b>{plural(recalcCells, 'cell')}</b> in <b>{ms < 1 ? ms.toFixed(2) : ms.toFixed(1)} ms</b></>}
        </span>
      </footer>

      {help && (
        <section className="help" id="help" aria-label="How Gridline works">
          <button className="close" onClick={() => setHelp(false)} aria-label="Close">×</button>
          <h2>How it works</h2>
          <p><b>Only what you see is drawn.</b> The grid has 10,000 rows, but only the cells on screen are in the page, so scrolling stays smooth.</p>
          <p><b>Formulas are parsed, not guessed.</b> Each formula becomes a tree, and the sheet keeps a graph of which cells read which. An edit recalculates just the cells downstream of it, in dependency order. A loop shows <code>#CYCLE!</code> instead of hanging.</p>
          <h3>Keys</h3>
          <ul>
            <li><kbd>Arrows</kbd> move, <kbd>Shift</kbd> + arrows select, <kbd>Ctrl</kbd> + arrows jump</li>
            <li>Start typing to replace a cell, <kbd>Enter</kbd> or <kbd>F2</kbd> to edit it</li>
            <li>While typing a formula, click a cell (or drag a range) to insert it</li>
            <li><kbd>Ctrl</kbd> + <kbd>C</kbd> / <kbd>X</kbd> / <kbd>V</kbd> work with Excel and Google Sheets</li>
            <li><kbd>Ctrl</kbd> + <kbd>Z</kbd> undo, <kbd>Ctrl</kbd> + <kbd>Y</kbd> redo, <kbd>Delete</kbd> clears</li>
            <li>On a phone, tap a cell and type in the formula bar, or double-tap the cell</li>
          </ul>
          <h3>Functions</h3>
          <p className="fns">{FUNCTIONS.join(' · ')}</p>
          <p className="by">Built by <a href="https://lovjyotsingh.github.io" target="_blank" rel="noopener">Lovjyot Singh</a>. Your sheet is saved in this browser.</p>
        </section>
      )}
    </div>
  )
}
