import { describe, expect, it } from 'vitest'
import { parseDelimited, toDelimited } from './csv'
import { display } from './evaluate'
import { parse, referencedRects, shiftFormula } from './formula'
import { Sheet } from './sheet'

function sheetWith(cells: Record<string, string>) {
  const s = new Sheet()
  s.set(Object.entries(cells).map(([name, raw]) => ({ r: Number(name.slice(1)) - 1, c: name.charCodeAt(0) - 65, raw })))
  return s
}
const show = (s: Sheet, name: string) => display(s.value(Number(name.slice(1)) - 1, name.charCodeAt(0) - 65))

describe('parser', () => {
  it('respects precedence and associativity', () => {
    const s = sheetWith({ A1: '=1+2*3', A2: '=2^3^2', A3: '=-2^2', A4: '=(1+2)*3', A5: '=10-4-3', A6: '=50%' })
    expect(show(s, 'A1')).toBe('7')
    expect(show(s, 'A2')).toBe('512')
    expect(show(s, 'A3')).toBe('4')
    expect(show(s, 'A4')).toBe('9')
    expect(show(s, 'A5')).toBe('3')
    expect(show(s, 'A6')).toBe('0.5')
  })

  it('rejects malformed formulas', () => {
    expect(() => parse('1+')).toThrow()
    expect(() => parse('SUM(1,2')).toThrow()
    expect(() => parse('"open')).toThrow()
    const s = sheetWith({ A1: '=1+*2' })
    expect(show(s, 'A1')).toBe('#ERROR!')
  })

  it('finds the refs a formula draws on the grid', () => {
    expect(referencedRects('SUM(A1:B3)+$C$4')).toEqual([{ r1: 0, c1: 0, r2: 2, c2: 1 }, { r1: 3, c1: 2, r2: 3, c2: 2 }])
  })
})

describe('evaluation', () => {
  it('handles functions, ranges and text', () => {
    const s = sheetWith({
      A1: '10', A2: '20', A3: 'apples', A4: '30',
      B1: '=SUM(A1:A4)', B2: '=AVERAGE(A1:A4)', B3: '=COUNT(A1:A4)', B4: '=COUNTA(A1:A4)',
      B5: '=MAX(A1:A4)-MIN(A1:A4)', B6: '=MEDIAN(A1:A4)', B7: '=IF(B1>50,"big","small")',
      B8: '=UPPER(A3)&"!"', B9: '=ROUND(2/3,2)', B10: '=0.1+0.2', B11: '=CONCAT(A1,"-",A2)', B12: '=AND(A1>5,A2>5)'
    })
    expect(show(s, 'B1')).toBe('60')
    expect(show(s, 'B2')).toBe('20')
    expect(show(s, 'B3')).toBe('3')
    expect(show(s, 'B4')).toBe('4')
    expect(show(s, 'B5')).toBe('20')
    expect(show(s, 'B6')).toBe('20')
    expect(show(s, 'B7')).toBe('big')
    expect(show(s, 'B8')).toBe('APPLES!')
    expect(show(s, 'B9')).toBe('0.67')
    expect(show(s, 'B10')).toBe('0.3')
    expect(show(s, 'B11')).toBe('10-20')
    expect(show(s, 'B12')).toBe('TRUE')
  })

  it('reports errors and lets IFERROR catch them', () => {
    const s = sheetWith({ A1: '=1/0', A2: '=A1+1', A3: '=IFERROR(A1,0)', A4: '=NOPE(1)', A5: '="a"*2', A6: '=SQRT(-1)', A7: '=B9999999' })
    expect(show(s, 'A1')).toBe('#DIV/0!')
    expect(show(s, 'A2')).toBe('#DIV/0!')
    expect(show(s, 'A3')).toBe('0')
    expect(show(s, 'A4')).toBe('#NAME?')
    expect(show(s, 'A5')).toBe('#VALUE!')
    expect(show(s, 'A6')).toBe('#NUM!')
    expect(show(s, 'A7')).toBe('#REF!')
  })
})

describe('dependency graph', () => {
  it('recalculates only what depends on an edit, in order', () => {
    const s = sheetWith({ A1: '1', A2: '=A1*2', A3: '=A2+A1', B1: '=5', C1: '=A3*10' })
    expect(show(s, 'C1')).toBe('30')
    s.set([{ r: 0, c: 0, raw: '2' }])
    expect(show(s, 'C1')).toBe('60')
    expect(s.lastRecalc.cells).toBe(4) // A1, A2, A3, C1, and not B1
  })

  it('marks cycles and recovers when they are broken', () => {
    const s = sheetWith({ A1: '=B1+1', B1: '=A1+1', C1: '=A1', D1: '=D1' })
    expect(show(s, 'A1')).toBe('#CYCLE!')
    expect(show(s, 'C1')).toBe('#CYCLE!')
    expect(show(s, 'D1')).toBe('#CYCLE!')
    s.set([{ r: 0, c: 1, raw: '5' }])
    expect(show(s, 'A1')).toBe('6')
    expect(show(s, 'C1')).toBe('6')
  })

  it('updates the graph when a formula changes', () => {
    const s = sheetWith({ A1: '1', B1: '2', C1: '=A1' })
    s.set([{ r: 0, c: 2, raw: '=B1' }])
    s.set([{ r: 0, c: 0, raw: '100' }])
    expect(show(s, 'C1')).toBe('2')
    expect(s.dependents(0, 0)).toBe(0)
    expect(s.dependents(0, 1)).toBe(1)
  })

  it('keeps a 10,000-row sum fast to update', () => {
    const s = new Sheet()
    s.set(Array.from({ length: 10_000 }, (_, r) => ({ r, c: 0, raw: String(r + 1) })).concat({ r: 0, c: 1, raw: '=SUM(A1:A10000)' }))
    expect(show(s, 'B1')).toBe('50005000')
    s.set([{ r: 4999, c: 0, raw: '0' }])
    expect(show(s, 'B1')).toBe(String(50005000 - 5000))
    expect(s.lastRecalc.cells).toBe(2)
  })
})

describe('pasting formulas', () => {
  it('shifts relative refs and keeps absolute ones', () => {
    expect(shiftFormula('=A1+$B$2+C$3+$D4', 2, 1)).toBe('=B3+$B$2+D$3+$D6')
    expect(shiftFormula('=SUM(A1:A3)', 0, 1)).toBe('=SUM(B1:B3)')
    expect(shiftFormula('=A1', -1, 0)).toBe('=#REF!')
    expect(shiftFormula('plain text', 3, 3)).toBe('plain text')
  })
})

describe('csv', () => {
  it('round-trips quotes, commas and newlines', () => {
    const rows = [['name', 'note'], ['Riya', 'said "hi", then left'], ['multi', 'line\nvalue']]
    expect(parseDelimited(toDelimited(rows, ','), ',')).toEqual(rows)
    expect(parseDelimited('a\tb\r\nc\td\r\n', '\t')).toEqual([['a', 'b'], ['c', 'd']])
  })
})
