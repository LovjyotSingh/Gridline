// The sheet: what each cell holds, what it evaluates to, and the dependency graph between cells.
// An edit recalculates only the edited cells and everything downstream of them, in dependency
// order (Kahn's algorithm), and anything left over sits in or behind a cycle.

import { evaluate, type Value } from './evaluate'
import { FormulaError, parse, references, type Node } from './formula'
import { COLS, key, unkey, type Rect } from './ref'

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

export interface Edit { r: number; c: number; raw: string }

export class Sheet {
  private raws = new Map<number, string>()
  private trees = new Map<number, Node | null>() // null = the formula didn't parse
  private deps = new Map<number, number[]>() // cells this cell reads
  private rdeps = new Map<number, Set<number>>() // cells that read this cell
  private vals = new Map<number, Value>()
  lastRecalc = { cells: 0, ms: 0 }

  raw(r: number, c: number) { return this.raws.get(key(r, c)) ?? '' }
  value(r: number, c: number): Value { return this.vals.get(key(r, c)) ?? null }
  get size() { return this.raws.size }

  precedents(r: number, c: number) { return this.deps.get(key(r, c))?.length ?? 0 }
  dependents(r: number, c: number) { return this.rdeps.get(key(r, c))?.size ?? 0 }

  /** Apply a batch of edits, then recalculate what they affect. */
  set(edits: Edit[]) {
    const touched: number[] = []
    for (const { r, c, raw } of edits) {
      const k = key(r, c)
      for (const d of this.deps.get(k) ?? []) this.rdeps.get(d)?.delete(k)
      this.deps.delete(k)
      this.trees.delete(k)
      if (raw === '') this.raws.delete(k)
      else this.raws.set(k, raw)
      if (raw.length > 1 && raw.startsWith('=')) {
        let tree: Node | null = null
        try { tree = parse(raw.slice(1)) } catch (e) { if (!(e instanceof FormulaError)) throw e }
        this.trees.set(k, tree)
        if (tree) {
          const ds = [...new Set(references(tree).map(([rr, cc]) => key(rr, cc)))]
          this.deps.set(k, ds)
          for (const d of ds) {
            let s = this.rdeps.get(d)
            if (!s) this.rdeps.set(d, (s = new Set()))
            s.add(k)
          }
        }
      }
      touched.push(k)
    }
    this.recalc(touched)
  }

  private recalc(start: number[]) {
    const t0 = performance.now()
    const affected = new Set<number>()
    const stack = [...start]
    while (stack.length) {
      const k = stack.pop()!
      if (affected.has(k)) continue
      affected.add(k)
      for (const d of this.rdeps.get(k) ?? []) stack.push(d)
    }
    const waiting = new Map<number, number>()
    const ready: number[] = []
    for (const k of affected) {
      let n = 0
      for (const d of this.deps.get(k) ?? []) if (affected.has(d)) n++
      waiting.set(k, n)
      if (n === 0) ready.push(k)
    }
    for (let i = 0; i < ready.length; i++) {
      const k = ready[i]
      this.compute(k)
      for (const d of this.rdeps.get(k) ?? []) {
        if (!affected.has(d)) continue
        const n = waiting.get(d)! - 1
        waiting.set(d, n)
        if (n === 0) ready.push(d)
      }
    }
    for (const [k, n] of waiting) if (n > 0) this.vals.set(k, { err: '#CYCLE!' })
    this.lastRecalc = { cells: affected.size, ms: performance.now() - t0 }
  }

  private compute(k: number) {
    const raw = this.raws.get(k)
    if (raw === undefined) { this.vals.delete(k); return }
    if (this.trees.has(k)) {
      const tree = this.trees.get(k)
      this.vals.set(k, tree ? evaluate(tree, (r, c) => this.vals.get(key(r, c)) ?? null) : { err: '#ERROR!' })
    } else if (NUMBER.test(raw.trim())) this.vals.set(k, Number(raw))
    else if (/^(true|false)$/i.test(raw)) this.vals.set(k, raw.toUpperCase() === 'TRUE')
    else this.vals.set(k, raw)
  }

  /** Filled cells inside a rectangle, without walking every empty cell of a huge selection. */
  *filledIn(x: Rect): Generator<{ r: number; c: number }> {
    const area = (x.r2 - x.r1 + 1) * (x.c2 - x.c1 + 1)
    if (area > this.raws.size) {
      for (const k of this.raws.keys()) {
        const p = unkey(k)
        if (p.r >= x.r1 && p.r <= x.r2 && p.c >= x.c1 && p.c <= x.c2) yield p
      }
    } else {
      for (let r = x.r1; r <= x.r2; r++)
        for (let c = x.c1; c <= x.c2; c++) if (this.raws.has(key(r, c))) yield { r, c }
    }
  }

  /** Bottom-right corner of the data, for export. */
  extent() {
    let rows = 0, cols = 0
    for (const k of this.raws.keys()) { rows = Math.max(rows, Math.floor(k / COLS) + 1); cols = Math.max(cols, (k % COLS) + 1) }
    return { rows, cols }
  }

  /** Last filled row in a column, or -1, for Ctrl+Down. */
  lastRow(c: number) {
    let last = -1
    for (const k of this.raws.keys()) if (k % COLS === c) last = Math.max(last, Math.floor(k / COLS))
    return last
  }

  entries(): Edit[] {
    return [...this.raws].map(([k, raw]) => ({ ...unkey(k), raw }))
  }
}
