import type { Edit } from './engine/sheet'
import { ROWS } from './engine/ref'

const at = (name: string, raw: string): Edit => ({ r: Number(name.slice(1)) - 1, c: name.charCodeAt(0) - 65, raw })

const REGIONS: Array<[string, number, number, number]> = [
  ['North', 12400, 13150, 14020],
  ['South', 9800, 9420, 10110],
  ['East', 15300, 16010, 15880],
  ['West', 7600, 8340, 9120],
  ['Central', 11200, 10870, 11950]
]

/** A small quarterly sales sheet that shows off ranges, IF, text and absolute refs. */
export function sampleEdits(): Edit[] {
  const out = ['Region', 'Jul', 'Aug', 'Sep', 'Q3 total', 'Monthly avg', 'Growth', 'Status'].map((h, i) => at(String.fromCharCode(65 + i) + '1', h))
  REGIONS.forEach(([name, jul, aug, sep], i) => {
    const n = i + 2
    out.push(
      at(`A${n}`, name), at(`B${n}`, String(jul)), at(`C${n}`, String(aug)), at(`D${n}`, String(sep)),
      at(`E${n}`, `=SUM(B${n}:D${n})`),
      at(`F${n}`, `=ROUND(AVERAGE(B${n}:D${n}), 0)`),
      at(`G${n}`, `=ROUND((D${n}-B${n})/B${n}*100, 1)&"%"`),
      at(`H${n}`, `=IF(E${n}>=$B$10, "On track", "Behind")`)
    )
  })
  out.push(
    at('A7', 'Total'), at('B7', '=SUM(B2:B6)'), at('C7', '=SUM(C2:C6)'), at('D7', '=SUM(D2:D6)'),
    at('E7', '=SUM(E2:E6)'), at('F7', '=ROUND(AVERAGE(F2:F6), 0)'), at('G7', '=ROUND((D7-B7)/B7*100, 1)&"%"'),
    at('H7', '=COUNT(E2:E6)&" regions"'),
    at('A9', 'Settings'),
    at('A10', 'Target'), at('B10', '33000'),
    at('A11', 'Best month'), at('B11', '=IF(MAX(B7:D7)=D7, "Sep", IF(MAX(B7:D7)=C7, "Aug", "Jul"))'),
    at('A13', 'Try it: change a month or the target in B10. Only the cells that depend on it recalculate.')
  )
  return out
}

/** 10,000 numbers in column K with totals beside them. */
export function stressEdits(): Edit[] {
  const out: Edit[] = []
  for (let r = 0; r < ROWS; r++) out.push({ r, c: 10, raw: String(Math.round(Math.random() * 1000)) })
  out.push(
    at('L1', '=SUM(K1:K10000)'), at('M1', 'sum of K1:K10000'),
    at('L2', '=ROUND(AVERAGE(K1:K10000), 2)'), at('M2', 'average'),
    at('L3', '=MAX(K1:K10000)'), at('M3', 'largest'),
    at('L4', '=COUNTA(K1:K10000)'), at('M4', 'cells counted')
  )
  return out
}
