// Evaluates a parsed formula against the current cell values.

import type { ErrorCode, Node } from './formula'

export type CellErr = { err: ErrorCode }
export type Value = number | string | boolean | null | CellErr
type Arg = Value | Value[]

export const isErr = (v: unknown): v is CellErr => typeof v === 'object' && v !== null && 'err' in v
const E = (err: ErrorCode): CellErr => ({ err })

export type Getter = (r: number, c: number) => Value

export function evaluate(node: Node, get: Getter): Value {
  const v = ev(node, get)
  return Array.isArray(v) ? E('#VALUE!') : v
}

function ev(n: Node, get: Getter): Arg {
  switch (n.k) {
    case 'num': return n.v
    case 'str': return n.v
    case 'bool': return n.v
    case 'err': return E(n.v)
    case 'name': return E('#NAME?')
    case 'ref': return get(n.r, n.c)
    case 'range': {
      const vals: Value[] = []
      for (let r = n.r1; r <= n.r2; r++) for (let c = n.c1; c <= n.c2; c++) vals.push(get(r, c))
      return vals
    }
    case 'neg': { const x = num(one(ev(n.e, get))); return isErr(x) ? x : -x }
    case 'pct': { const x = num(one(ev(n.e, get))); return isErr(x) ? x : x / 100 }
    case 'bin': return binary(n.op, one(ev(n.l, get)), one(ev(n.r, get)))
    case 'call': return call(n.name, n.args, get)
  }
}

const one = (a: Arg): Value => (Array.isArray(a) ? E('#VALUE!') : a)

function num(v: Value): number | CellErr {
  if (isErr(v)) return v
  if (v === null || v === '') return 0
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  const n = Number(v.trim())
  return Number.isNaN(n) ? E('#VALUE!') : n
}

function str(v: Value): string | CellErr {
  if (isErr(v)) return v
  if (v === null) return ''
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (typeof v === 'number') return formatNumber(v)
  return v
}

function bool(v: Value): boolean | CellErr {
  if (isErr(v)) return v
  if (v === null) return false
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  const u = v.toUpperCase()
  return u === 'TRUE' ? true : u === 'FALSE' ? false : E('#VALUE!')
}

const finite = (x: number): number | CellErr => (Number.isFinite(x) ? x : E('#NUM!'))

function binary(op: string, a: Value, b: Value): Value {
  if (op === '&') {
    const x = str(a), y = str(b)
    return isErr(x) ? x : isErr(y) ? y : x + y
  }
  if (op === '=' || op === '<>' || op === '<' || op === '>' || op === '<=' || op === '>=') {
    if (isErr(a)) return a
    if (isErr(b)) return b
    const d = compare(a, b)
    switch (op) {
      case '=': return d === 0
      case '<>': return d !== 0
      case '<': return d < 0
      case '>': return d > 0
      case '<=': return d <= 0
      default: return d >= 0
    }
  }
  const x = num(a), y = num(b)
  if (isErr(x)) return x
  if (isErr(y)) return y
  switch (op) {
    case '+': return finite(x + y)
    case '-': return finite(x - y)
    case '*': return finite(x * y)
    case '/': return y === 0 ? E('#DIV/0!') : finite(x / y)
    case '^': return finite(Math.pow(x, y))
  }
  return E('#ERROR!')
}

// numbers sort before text, text before booleans, like Excel; empty acts as 0 or ""
function compare(a: Value, b: Value): number {
  const rank = (v: Value) => (v === null ? -1 : typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2)
  if (a === null) a = typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0
  if (b === null) b = typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0
  const ra = rank(a), rb = rank(b)
  if (ra !== rb) return ra - rb
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b, undefined, { sensitivity: 'accent' })
  return Number(a) - Number(b)
}

/** Numbers for SUM and friends: ranges skip text and blanks, direct arguments must be numbers. */
function numbers(args: Arg[]): number[] | CellErr {
  const out: number[] = []
  for (const a of args) {
    if (Array.isArray(a)) {
      for (const v of a) { if (isErr(v)) return v; if (typeof v === 'number') out.push(v) }
    } else {
      if (a === null) continue
      const x = num(a)
      if (isErr(x)) return x
      out.push(x)
    }
  }
  return out
}

function flat(args: Arg[]): Value[] {
  return args.flatMap(a => (Array.isArray(a) ? a : [a]))
}

function call(name: string, nodes: Node[], get: Getter): Arg {
  const arity = (min: number, max = min) => nodes.length >= min && nodes.length <= max
  // IF and IFERROR only evaluate the branch they need
  if (name === 'IF') {
    if (!arity(2, 3)) return E('#N/A')
    const c = bool(one(ev(nodes[0], get)))
    if (isErr(c)) return c
    return c ? one(ev(nodes[1], get)) : nodes[2] ? one(ev(nodes[2], get)) : false
  }
  if (name === 'IFERROR') {
    if (!arity(2)) return E('#N/A')
    const v = one(ev(nodes[0], get))
    return isErr(v) ? one(ev(nodes[1], get)) : v
  }

  const args = nodes.map(n => ev(n, get))
  const nums = () => numbers(args)
  const scalar = (i: number) => num(one(args[i]))

  switch (name) {
    case 'SUM': { const xs = nums(); return isErr(xs) ? xs : finite(xs.reduce((s, x) => s + x, 0)) }
    case 'AVERAGE': {
      const xs = nums(); if (isErr(xs)) return xs
      return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : E('#DIV/0!')
    }
    case 'MIN': { const xs = nums(); return isErr(xs) ? xs : xs.length ? Math.min(...xs) : 0 }
    case 'MAX': { const xs = nums(); return isErr(xs) ? xs : xs.length ? Math.max(...xs) : 0 }
    case 'MEDIAN': {
      const xs = nums(); if (isErr(xs)) return xs
      if (!xs.length) return E('#NUM!')
      xs.sort((a, b) => a - b)
      const m = xs.length >> 1
      return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2
    }
    case 'COUNT': return flat(args).filter(v => typeof v === 'number').length
    case 'COUNTA': return flat(args).filter(v => v !== null && v !== '').length
    case 'AND': case 'OR': {
      const bs: boolean[] = []
      for (const v of flat(args)) {
        if (v === null) continue
        const b = bool(v)
        if (isErr(b)) return b
        bs.push(b)
      }
      if (!bs.length) return E('#VALUE!')
      return name === 'AND' ? bs.every(Boolean) : bs.some(Boolean)
    }
    case 'NOT': { if (!arity(1)) return E('#N/A'); const b = bool(one(args[0])); return isErr(b) ? b : !b }
    case 'ROUND': {
      if (!arity(1, 2)) return E('#N/A')
      const x = scalar(0), d = args[1] === undefined ? 0 : scalar(1)
      if (isErr(x)) return x
      if (isErr(d)) return d
      const f = Math.pow(10, Math.trunc(d))
      return (Math.sign(x) * Math.round(Math.abs(x) * f + 1e-9)) / f
    }
    case 'ABS': { if (!arity(1)) return E('#N/A'); const x = scalar(0); return isErr(x) ? x : Math.abs(x) }
    case 'SQRT': {
      if (!arity(1)) return E('#N/A')
      const x = scalar(0); if (isErr(x)) return x
      return x < 0 ? E('#NUM!') : Math.sqrt(x)
    }
    case 'POWER': {
      if (!arity(2)) return E('#N/A')
      const x = scalar(0), y = scalar(1)
      return isErr(x) ? x : isErr(y) ? y : finite(Math.pow(x, y))
    }
    case 'MOD': {
      if (!arity(2)) return E('#N/A')
      const x = scalar(0), y = scalar(1)
      if (isErr(x)) return x
      if (isErr(y)) return y
      return y === 0 ? E('#DIV/0!') : x - y * Math.floor(x / y)
    }
    case 'CONCAT': {
      let s = ''
      for (const v of flat(args)) { const t = str(v); if (isErr(t)) return t; s += t }
      return s
    }
    case 'LEN': case 'UPPER': case 'LOWER': case 'TRIM': {
      if (!arity(1)) return E('#N/A')
      const t = str(one(args[0])); if (isErr(t)) return t
      return name === 'LEN' ? t.length : name === 'UPPER' ? t.toUpperCase() : name === 'LOWER' ? t.toLowerCase() : t.trim().replace(/\s+/g, ' ')
    }
  }
  return E('#NAME?')
}

export const FUNCTIONS = [
  'SUM', 'AVERAGE', 'MIN', 'MAX', 'MEDIAN', 'COUNT', 'COUNTA', 'IF', 'IFERROR', 'AND', 'OR', 'NOT',
  'ROUND', 'ABS', 'SQRT', 'POWER', 'MOD', 'CONCAT', 'LEN', 'UPPER', 'LOWER', 'TRIM'
]

export function formatNumber(n: number): string {
  if (Object.is(n, -0)) return '0'
  return String(Number(n.toPrecision(12)))
}

export function display(v: Value): string {
  if (v === null) return ''
  if (typeof v === 'number') return formatNumber(v)
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (isErr(v)) return v.err
  return v
}
