// Cell addressing. Columns are single letters (A to Z) and rows are 1-based in A1 notation.

export const COLS = 26
export const ROWS = 10_000

export const colName = (c: number) => String.fromCharCode(65 + c)
export const cellName = (r: number, c: number) => colName(c) + (r + 1)
export const key = (r: number, c: number) => r * COLS + c
export const unkey = (k: number) => ({ r: Math.floor(k / COLS), c: k % COLS })

export function inBounds(r: number, c: number) {
  return r >= 0 && r < ROWS && c >= 0 && c < COLS
}

export interface Rect { r1: number; c1: number; r2: number; c2: number }

export function normRect(a: { r: number; c: number }, b: { r: number; c: number }): Rect {
  return { r1: Math.min(a.r, b.r), c1: Math.min(a.c, b.c), r2: Math.max(a.r, b.r), c2: Math.max(a.c, b.c) }
}

export function rectName(x: Rect) {
  const a = cellName(x.r1, x.c1), b = cellName(x.r2, x.c2)
  return a === b ? a : `${a}:${b}`
}
