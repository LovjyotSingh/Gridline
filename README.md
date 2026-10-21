# Gridline

**A spreadsheet that runs in the browser, built from scratch.** No spreadsheet or grid library: the virtualized grid, the formula parser, the evaluator and the recalculation engine are all hand-written in TypeScript.

**Live:** [gridline-pearl.vercel.app](https://gridline-pearl.vercel.app) · Built by [Lovjyot Singh](https://lovjyotsingh.github.io)

## What you can do

- Scroll 10,000 rows smoothly. Press **Add 10,000 rows** to fill a column and total it.
- Write formulas like `=SUM(B2:D2)`, `=IF(E2>=$B$10, "On track", "Behind")` or `=ROUND(AVERAGE(B2:D6), 0)`.
- While typing a formula, click a cell or drag a range to insert it. The cells a formula reads are outlined in colour.
- Copy and paste with Excel or Google Sheets. Pasting a formula moves its relative references, like `A1` → `B2`, and keeps absolute ones like `$B$10`.
- Select a range to see its sum, average and count.
- Undo and redo, import and export CSV. The sheet saves in your browser.

## How it works

**Virtualized grid** (`src/Grid.tsx`). A full-size spacer gives the browser a real 300,000-pixel scroll area, and only the rows and columns in view (plus a small margin) are rendered. Grid lines are a CSS background, so empty cells cost nothing. Scrolling 10,000 rows renders about 100 elements at a time.

**Formula parser** (`src/engine/formula.ts`). A tokenizer and a Pratt parser turn the text after `=` into a syntax tree, with Excel's operator precedence: comparison, then `&`, then `+ -`, then `* /`, then right-associative `^`, with unary minus binding tightest (`=-2^2` is 4).

**Evaluator** (`src/engine/evaluate.ts`). Walks the tree with Excel-style rules. Ranges skip text in `SUM`, empty cells act as 0, and errors (`#DIV/0!`, `#VALUE!`, `#REF!`, `#NAME?`, `#NUM!`) flow through to anything that uses them. `IF` and `IFERROR` only evaluate the branch they need.

**Dependency graph** (`src/engine/sheet.ts`). The sheet keeps two maps: which cells each formula reads, and which formulas read each cell. An edit:

1. collects the edited cells and everything downstream of them,
2. orders that set with Kahn's algorithm (topological sort), so each cell is computed after its inputs,
3. computes them in that order, and
4. marks whatever is left over as `#CYCLE!`, because it sits in or behind a loop.

So changing one value in a 10,000-row column recalculates 2 cells (the value and its total), not 10,000. The status bar shows how many cells the last edit touched and how long it took.

## Stack

React 19, TypeScript, Vite, Vitest. No runtime dependencies besides React. Deployed on Vercel.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # engine tests
npm run build
```

## Tests

`src/engine/engine.test.ts` covers operator precedence, functions and error propagation, recalculating only what an edit affects, cycles that recover once broken, a 10,000-row sum, reference shifting on paste, and CSV round-trips with quotes and newlines.

## Layout

```
src/
  engine/
    ref.ts         cell addresses (A1 notation)
    formula.ts     tokenizer, Pratt parser, reference shifting
    evaluate.ts    evaluator and functions
    sheet.ts       cell store and dependency graph
    csv.ts         CSV and clipboard (tab-separated) text
  Grid.tsx         virtualized grid
  App.tsx          formula bar, keyboard, clipboard, undo, CSV, saving
  sample.ts        sample sheet and 10,000-row test data
```
