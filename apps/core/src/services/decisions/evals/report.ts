import { shortAnswer, type DecisionEval } from './define'
import type { CaseResult, Snapshot } from './run'

/** Margins below this are flagged: the answer passed, but close to a threshold. */
export const THIN_MARGIN = 0.1

const pad = (text: string, width: number) => (text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width))

function outcomeLabel(evaluation: DecisionEval<unknown, unknown>, outcome: unknown) {
  if (outcome === undefined) return '—'
  return evaluation.label ? evaluation.label(outcome) : JSON.stringify(outcome)
}

function expectedLabel(evaluation: DecisionEval<unknown, unknown>, c: { expect?: unknown; accept?: unknown[] }) {
  const options = [...(c.expect !== undefined ? [c.expect] : []), ...(c.accept ?? [])]
  if (!options.length) return '(unlabelled)'
  return options
    .map((option) =>
      option !== null && typeof option === 'object' ? JSON.stringify(option) : outcomeLabel(evaluation, option)
    )
    .join(' | ')
}

function answersLabel(answers: CaseResult['answers']) {
  return answers
    ? Object.entries(answers)
        .map(([name, answer]) => `${name} ${shortAnswer(answer)}`)
        .join(', ')
    : ''
}

export interface ProviderSummary {
  provider: string
  labelled: number
  passed: number
  mustFailures: string[]
  thin: number
  flips: number
  errors: number
  skipped: number
  latencyMs: number
  costNanodollars: number
}

/** Accuracy per provider: a case passes for a provider only when every attempt passed. */
export function summarize(results: CaseResult[]): ProviderSummary[] {
  const byProvider = new Map<string, CaseResult[]>()
  for (const result of results) byProvider.set(result.provider, [...(byProvider.get(result.provider) ?? []), result])
  return [...byProvider].map(([provider, rows]) => {
    const byCase = new Map<string, CaseResult[]>()
    for (const row of rows) byCase.set(row.case, [...(byCase.get(row.case) ?? []), row])
    let labelled = 0
    let passed = 0
    let flips = 0
    const mustFailures: string[] = []
    for (const [name, attempts] of byCase) {
      const answered = attempts.filter((attempt) => !attempt.skipped)
      if (!answered.length || answered.every((attempt) => attempt.pass === null && !attempt.error)) continue
      labelled++
      const ok = answered.every((attempt) => attempt.pass === true)
      if (ok) passed++
      else if (answered.some((attempt) => attempt.must)) mustFailures.push(name)
      if (new Set(answered.map((attempt) => JSON.stringify(attempt.outcome))).size > 1) flips++
    }
    const answered = rows.filter((row) => row.answers)
    return {
      provider,
      labelled,
      passed,
      mustFailures,
      thin: answered.filter((row) => row.pass === true && row.margin !== null && row.margin < THIN_MARGIN).length,
      flips,
      errors: rows.filter((row) => row.error).length,
      skipped: rows.filter((row) => row.skipped).length,
      latencyMs: answered.length
        ? Math.round(answered.reduce((sum, row) => sum + row.latencyMs, 0) / answered.length)
        : 0,
      costNanodollars: rows.reduce((sum, row) => sum + (row.costNanodollars ?? 0), 0),
    }
  })
}

/** Whether the run should fail: a `must` case failed, or a provider fell below the eval's floor. */
export function failures(evaluation: DecisionEval<unknown, unknown>, summaries: ProviderSummary[]): string[] {
  return summaries.flatMap((summary) => [
    ...summary.mustFailures.map((name) => `${summary.provider}: must-pass case failed: ${name}`),
    ...(evaluation.floor !== undefined && summary.labelled && summary.passed / summary.labelled < evaluation.floor
      ? [
          `${summary.provider}: ${summary.passed}/${summary.labelled} is below the floor of ${Math.round(evaluation.floor * 100)}%`,
        ]
      : []),
  ])
}

const dollars = (nanodollars: number) => `$${(nanodollars / 1e9).toFixed(5)}`

/** The terminal table: one row per case, attempt and provider, then a summary per provider. */
export function formatRun(
  evaluation: DecisionEval<unknown, unknown>,
  results: CaseResult[],
  options: { snapshot?: Snapshot | null; diff?: boolean } = {}
): string {
  const lines = [
    `== ${evaluation.name} (${evaluation.purpose})${results[0]?.variant ? ` variant ${results[0].variant}` : ''}`,
  ]
  const cases = new Map(
    evaluation.cases.map((c, index) => [
      c.name ?? (evaluation.caseName && !('request' in c) ? evaluation.caseName(c) : `case ${index + 1}`),
      c,
    ])
  )
  let previousCase = ''
  for (const row of results) {
    const c = cases.get(row.case)
    const caseCell = row.case === previousCase ? '' : row.case
    const want = row.case === previousCase ? '' : c ? expectedLabel(evaluation, c) : ''
    previousCase = row.case
    const status = row.skipped ? 'skip' : row.error ? 'ERR ' : row.pass === null ? '  · ' : row.pass ? ' ok ' : 'FAIL'
    const thin = row.pass === true && row.margin !== null && row.margin < THIN_MARGIN ? ' thin' : ''
    const detail = row.skipped
      ? row.skipped
      : row.error
        ? row.error
        : `${outcomeLabel(evaluation, row.outcome)}  [${answersLabel(row.answers)}]  margin ${row.margin?.toFixed(2) ?? '—'}${thin}`
    let line = `${pad(caseCell, 46)} ${pad(want, 22)} ${pad(row.provider + (row.attempt > 1 ? ` #${row.attempt}` : ''), 22)} ${status} ${detail}`
    const recorded = options.diff ? options.snapshot?.entries[row.case]?.[row.providerKey] : undefined
    if (options.diff && row.answers)
      line += recorded
        ? recorded.hash === row.hash
          ? `  (recorded: ${answersLabel(recorded.answers)})`
          : `  (request changed; was ${answersLabel(recorded.answers)})`
        : '  (not recorded)'
    lines.push(line)
  }
  lines.push('')
  for (const summary of summarize(results))
    lines.push(
      `${pad(summary.provider, 24)} ${summary.passed}/${summary.labelled} right` +
        `${summary.thin ? `, ${summary.thin} thin` : ''}${summary.flips ? `, ${summary.flips} flipped between attempts` : ''}` +
        `${summary.errors ? `, ${summary.errors} errors` : ''}${summary.skipped ? `, ${summary.skipped} skipped` : ''}` +
        `, ${summary.latencyMs}ms avg, ${dollars(summary.costNanodollars)}`
    )
  return lines.join('\n')
}

/** The same as Markdown, for a GitHub job summary. */
export function formatMarkdown(evaluation: DecisionEval<unknown, unknown>, results: CaseResult[]): string {
  const providers = [...new Set(results.map((row) => row.provider))]
  const header = `| case | expected | ${providers.join(' | ')} |\n|---|---|${providers.map(() => '---').join('|')}|`
  const cases = [...new Set(results.map((row) => row.case))]
  const byName = new Map(
    evaluation.cases.map((c, index) => [
      c.name ?? (evaluation.caseName && !('request' in c) ? evaluation.caseName(c) : `case ${index + 1}`),
      c,
    ])
  )
  const rows = cases.map((name) => {
    const cells = providers.map((provider) => {
      const attempts = results.filter((row) => row.case === name && row.provider === provider)
      return attempts
        .map((row) =>
          row.skipped
            ? '–'
            : row.error
              ? '⚠️ error'
              : `${row.pass === false ? '❌' : row.pass ? '✅' : '·'} ${outcomeLabel(evaluation, row.outcome)}`
        )
        .join('<br>')
    })
    const c = byName.get(name)
    return `| ${name.replaceAll('|', '\\|')} | ${c ? expectedLabel(evaluation, c).replaceAll('|', '\\|') : ''} | ${cells.join(' | ')} |`
  })
  const summary = summarize(results)
    .map(
      (s) =>
        `- **${s.provider}**: ${s.passed}/${s.labelled} right${s.thin ? `, ${s.thin} thin` : ''}, ${dollars(s.costNanodollars)}`
    )
    .join('\n')
  return `### ${evaluation.name}\n\n${header}\n${rows.join('\n')}\n\n${summary}\n`
}
