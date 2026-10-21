// Formula tokenizer and Pratt parser. Turns "SUM(A1:A3)*2" (the text after "=") into a tree.

import { COLS, ROWS, colName } from './ref'

export type ErrorCode = '#ERROR!' | '#REF!' | '#NAME?' | '#VALUE!' | '#DIV/0!' | '#NUM!' | '#N/A' | '#CYCLE!'

export type Node =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'err'; v: ErrorCode }
  | { k: 'ref'; r: number; c: number }
  | { k: 'range'; r1: number; c1: number; r2: number; c2: number }
  | { k: 'name'; v: string }
  | { k: 'neg'; e: Node }
  | { k: 'pct'; e: Node }
  | { k: 'bin'; op: string; l: Node; r: Node }
  | { k: 'call'; name: string; args: Node[] }

export type Token =
  | { t: 'num'; v: number; s: number; e: number }
  | { t: 'str'; v: string; s: number; e: number }
  | { t: 'ref'; r: number; c: number; absR: boolean; absC: boolean; s: number; e: number }
  | { t: 'err'; v: ErrorCode; s: number; e: number }
  | { t: 'id'; v: string; s: number; e: number }
  | { t: 'op'; v: string; s: number; e: number }

export class FormulaError extends Error {}

const NUM = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/
const REF = /^(\$?)([A-Za-z])(\$?)(\d+)(?![A-Za-z0-9_(])/
const ID = /^[A-Za-z_][A-Za-z0-9_.]*/
const OPS = ['<=', '>=', '<>', '+', '-', '*', '/', '^', '&', '=', '<', '>', '(', ')', ',', ':', '%']

export function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (ch === ' ' || ch === '\t' || ch === '\n') { i++; continue }
    const rest = src.slice(i)
    let m: RegExpExecArray | null
    if ((m = NUM.exec(rest))) {
      out.push({ t: 'num', v: Number(m[0]), s: i, e: i + m[0].length }); i += m[0].length; continue
    }
    if (ch === '"') {
      let j = i + 1, v = ''
      for (;;) {
        if (j >= src.length) throw new FormulaError('unterminated string')
        if (src[j] === '"') { if (src[j + 1] === '"') { v += '"'; j += 2; continue } break }
        v += src[j++]
      }
      out.push({ t: 'str', v, s: i, e: j + 1 }); i = j + 1; continue
    }
    if (rest.toUpperCase().startsWith('#REF!')) {
      out.push({ t: 'err', v: '#REF!', s: i, e: i + 5 }); i += 5; continue
    }
    if ((m = REF.exec(rest))) {
      const r = Number(m[4]) - 1, c = m[2].toUpperCase().charCodeAt(0) - 65
      if (r < 0 || r >= ROWS) out.push({ t: 'err', v: '#REF!', s: i, e: i + m[0].length })
      else out.push({ t: 'ref', r, c, absR: m[3] === '$', absC: m[1] === '$', s: i, e: i + m[0].length })
      i += m[0].length; continue
    }
    if ((m = ID.exec(rest))) {
      out.push({ t: 'id', v: m[0].toUpperCase(), s: i, e: i + m[0].length }); i += m[0].length; continue
    }
    const op = OPS.find(o => rest.startsWith(o))
    if (!op) throw new FormulaError(`unexpected "${ch}"`)
    out.push({ t: 'op', v: op, s: i, e: i + op.length }); i += op.length
  }
  return out
}

const INFIX: Record<string, [number, number]> = {
  '=': [10, 11], '<>': [10, 11], '<': [10, 11], '>': [10, 11], '<=': [10, 11], '>=': [10, 11],
  '&': [20, 21],
  '+': [30, 31], '-': [30, 31],
  '*': [40, 41], '/': [40, 41],
  '^': [51, 50] // right-associative
}
const PREFIX_BP = 60, POSTFIX_BP = 70

export function parse(src: string): Node {
  const toks = tokenize(src)
  let p = 0
  const peek = () => toks[p]
  const isOp = (v: string) => { const t = toks[p]; return t !== undefined && t.t === 'op' && t.v === v }
  const expect = (v: string) => { if (!isOp(v)) throw new FormulaError(`expected "${v}"`); p++ }

  function primary(): Node {
    const t = toks[p++]
    if (!t) throw new FormulaError('unexpected end of formula')
    switch (t.t) {
      case 'num': return { k: 'num', v: t.v }
      case 'str': return { k: 'str', v: t.v }
      case 'err': return { k: 'err', v: t.v }
      case 'ref': {
        if (isOp(':')) {
          p++
          const u = toks[p++]
          if (!u || (u.t !== 'ref' && u.t !== 'err')) throw new FormulaError('bad range')
          if (u.t === 'err') return { k: 'err', v: u.v }
          return { k: 'range', r1: Math.min(t.r, u.r), c1: Math.min(t.c, u.c), r2: Math.max(t.r, u.r), c2: Math.max(t.c, u.c) }
        }
        return { k: 'ref', r: t.r, c: t.c }
      }
      case 'id': {
        if (isOp('(')) {
          p++
          const args: Node[] = []
          if (!isOp(')')) {
            for (;;) { args.push(expr(0)); if (isOp(',')) { p++; continue } break }
          }
          expect(')')
          return { k: 'call', name: t.v, args }
        }
        if (t.v === 'TRUE' || t.v === 'FALSE') return { k: 'bool', v: t.v === 'TRUE' }
        return { k: 'name', v: t.v }
      }
      case 'op':
        if (t.v === '(') { const e = expr(0); expect(')'); return e }
        if (t.v === '-') return { k: 'neg', e: expr(PREFIX_BP) }
        if (t.v === '+') return expr(PREFIX_BP)
        throw new FormulaError(`unexpected "${t.v}"`)
    }
  }

  function expr(minBp: number): Node {
    let left = primary()
    for (;;) {
      const t = peek()
      if (!t || t.t !== 'op') break
      if (t.v === '%') { if (POSTFIX_BP < minBp) break; p++; left = { k: 'pct', e: left }; continue }
      const bp = INFIX[t.v]
      if (!bp || bp[0] < minBp) break
      p++
      left = { k: 'bin', op: t.v, l: left, r: expr(bp[1]) }
    }
    return left
  }

  const node = expr(0)
  if (p < toks.length) throw new FormulaError(`unexpected "${src.slice(toks[p].s, toks[p].e)}"`)
  return node
}

/** Every cell a formula reads, ranges expanded. */
export function references(node: Node, out: Array<[number, number]> = []): Array<[number, number]> {
  switch (node.k) {
    case 'ref': out.push([node.r, node.c]); break
    case 'range':
      for (let r = node.r1; r <= node.r2; r++) for (let c = node.c1; c <= node.c2; c++) out.push([r, c])
      break
    case 'neg': case 'pct': references(node.e, out); break
    case 'bin': references(node.l, out); references(node.r, out); break
    case 'call': node.args.forEach(a => references(a, out)); break
  }
  return out
}

/** The refs and ranges a formula mentions, for drawing them on the grid. */
export function referencedRects(src: string) {
  const rects: Array<{ r1: number; c1: number; r2: number; c2: number }> = []
  let toks: Token[]
  try { toks = tokenize(src) } catch { return rects }
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (t.t !== 'ref') continue
    const colon = toks[i + 1], u = toks[i + 2]
    if (colon?.t === 'op' && colon.v === ':' && u?.t === 'ref') {
      rects.push({ r1: Math.min(t.r, u.r), c1: Math.min(t.c, u.c), r2: Math.max(t.r, u.r), c2: Math.max(t.c, u.c) })
      i += 2
    } else rects.push({ r1: t.r, c1: t.c, r2: t.r, c2: t.c })
  }
  return rects
}

/** Move relative references by (dr, dc), the way pasting a formula into another cell does. */
export function shiftFormula(raw: string, dr: number, dc: number): string {
  if (!raw.startsWith('=') || (dr === 0 && dc === 0)) return raw
  const body = raw.slice(1)
  let toks: Token[]
  try { toks = tokenize(body) } catch { return raw }
  let out = '', last = 0
  for (const t of toks) {
    if (t.t !== 'ref') continue
    const r = t.absR ? t.r : t.r + dr, c = t.absC ? t.c : t.c + dc
    const text = r < 0 || r >= ROWS || c < 0 || c >= COLS
      ? '#REF!'
      : (t.absC ? '$' : '') + colName(c) + (t.absR ? '$' : '') + (r + 1)
    out += body.slice(last, t.s) + text
    last = t.e
  }
  return '=' + out + body.slice(last)
}
