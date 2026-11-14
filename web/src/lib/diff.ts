export type DiffLine = { kind: ' ' | '+' | '-'; text: string }

/** Line diff via LCS; fine for config-sized inputs (a few thousand lines). */
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a.split('\n'), y = b.split('\n')
  const n = x.length, m = y.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: DiffLine[] = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ kind: ' ', text: x[i] }); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ kind: '-', text: x[i++] })
    else out.push({ kind: '+', text: y[j++] })
  }
  while (i < n) out.push({ kind: '-', text: x[i++] })
  while (j < m) out.push({ kind: '+', text: y[j++] })
  return out
}

/** Keep only changed lines plus `ctx` lines of context, marking gaps with null. */
export function compact(d: DiffLine[], ctx = 3): (DiffLine | null)[] {
  const keep = new Array(d.length).fill(false)
  d.forEach((l, i) => {
    if (l.kind !== ' ') for (let k = Math.max(0, i - ctx); k <= Math.min(d.length - 1, i + ctx); k++) keep[k] = true
  })
  const out: (DiffLine | null)[] = []
  let gap = false
  d.forEach((l, i) => {
    if (keep[i]) { out.push(l); gap = false } else if (!gap) { out.push(null); gap = true }
  })
  return out
}
