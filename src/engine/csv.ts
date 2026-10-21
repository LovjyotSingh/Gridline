// CSV for import/export and tab-separated text for the clipboard (what Excel and Sheets use).

export function parseDelimited(text: string, sep: ',' | '\t'): string[][] {
  const rows: string[][] = []
  let row: string[] = [], field = '', i = 0, quoted = false
  while (i < text.length) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue }
        quoted = false; i++; continue
      }
      field += ch; i++; continue
    }
    if (ch === '"' && field === '') { quoted = true; i++; continue }
    if (ch === sep) { row.push(field); field = ''; i++; continue }
    if (ch === '\r' || ch === '\n') {
      row.push(field); rows.push(row); row = []; field = ''
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1
      continue
    }
    field += ch; i++
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows
}

export function toDelimited(rows: string[][], sep: ',' | '\t'): string {
  const needs = sep === ',' ? /[",\r\n]/ : /["\t\r\n]/
  return rows.map(row => row.map(f => (needs.test(f) ? `"${f.replace(/"/g, '""')}"` : f)).join(sep)).join('\r\n')
}
