import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { decisionPricePerMillion, type DecisionAnswer } from '@ficus/shared'
import {
  caseName,
  decideFor,
  isRawCase,
  margin,
  passes,
  requestFor,
  requestHash,
  type DecisionEval,
  type EvalCase,
  type RawEvalCase,
} from './define'
import type { EvalProvider } from './providers'

/** Where eval files live: next to the feature they test, named `<feature>.decision-eval.ts`. */
export const EVAL_FILE_GLOB = '**/*.decision-eval.ts'
const SRC_ROOT = join(import.meta.dir, '../../..')
const ESTIMATED_TOKENS_PER_IMAGE = 1_000

export interface LoadedEval {
  file: string
  evaluation: DecisionEval<unknown, unknown>
}

/** Every eval in the Core source tree, with the cases saved next to it merged in. */
export async function discoverEvals(root = SRC_ROOT): Promise<LoadedEval[]> {
  const files = [...new Bun.Glob(EVAL_FILE_GLOB).scanSync({ cwd: root, absolute: true })].sort()
  const loaded: LoadedEval[] = []
  for (const file of files) {
    const evaluation = (await import(file)).default as DecisionEval<unknown, unknown> | undefined
    if (!evaluation?.name || !evaluation.build) throw new Error(`${file} must export default defineDecisionEval({...})`)
    loaded.push({ file, evaluation: { ...evaluation, cases: [...evaluation.cases, ...savedCases(file)] } })
  }
  const names = loaded.map((entry) => entry.evaluation.name)
  const duplicate = names.find((name, index) => names.indexOf(name) !== index)
  if (duplicate) throw new Error(`Two evals are named "${duplicate}"`)
  return loaded
}

/**
 * Cases accepted from saved corrections (`decisions:eval --accept`): `<base>.decision-cases.json`
 * is committed and shared; `<base>.decision-cases.local.json` is gitignored and stays on this
 * machine, because a saved case holds what someone actually typed.
 */
export function casesFiles(evalFile: string) {
  const base = evalFile.replace(/\.decision-eval\.ts$/, '')
  return { shared: `${base}.decision-cases.json`, local: `${base}.decision-cases.local.json` }
}

function savedCases(evalFile: string): RawEvalCase<unknown>[] {
  const files = casesFiles(evalFile)
  return [files.shared, files.local].flatMap((file) =>
    existsSync(file) ? ((JSON.parse(readFileSync(file, 'utf8')) as { cases?: RawEvalCase<unknown>[] }).cases ?? []) : []
  )
}

export interface CaseResult {
  eval: string
  case: string
  provider: string
  providerKey: string
  variant?: string
  attempt: number
  hash: string
  answers?: Record<string, DecisionAnswer>
  error?: string
  skipped?: string
  outcome?: unknown
  /** Null when the case has no labels (recorded only). */
  pass: boolean | null
  must: boolean
  margin: number | null
  latencyMs: number
  costNanodollars: number | null
}

/** Snapshots and diffs key providers by kind and model, not by an instance's provider ID. */
export const providerKey = (provider: Pick<EvalProvider, 'kind' | 'model'>, variant?: string) =>
  `${provider.kind}:${provider.model}${variant ? `#${variant}` : ''}`

function costOf(provider: EvalProvider, request: { images?: unknown[] }, inputTokens: number | undefined) {
  const price = decisionPricePerMillion(provider)
  if (price === null) return null
  const tokens =
    inputTokens ??
    Math.ceil(JSON.stringify({ ...request, images: undefined }).length / 4) +
      (request.images?.length ?? 0) * ESTIMATED_TOKENS_PER_IMAGE
  return Math.round(tokens * price * 1000)
}

export interface RunOptions {
  repeat?: number
  variant?: string
  concurrency?: number
  timeoutMs?: number
  /** Stop asking once this many dollars are spent. */
  maxCostDollars?: number
  onResult?: (result: CaseResult) => void
}

/** Ask every provider every case (`repeat` times), a few at a time. */
export async function runEval(
  evaluation: DecisionEval<unknown, unknown>,
  providers: EvalProvider[],
  options: RunOptions = {}
): Promise<CaseResult[]> {
  const { repeat = 1, variant, concurrency = 4, timeoutMs = 20_000 } = options
  if (variant && !evaluation.variants?.[variant]) throw new Error(`${evaluation.name} has no variant "${variant}"`)
  const decide = decideFor(evaluation, variant)
  const jobs: Array<() => Promise<CaseResult>> = []
  let spent = 0
  evaluation.cases.forEach((c, index) => {
    const name = caseName(evaluation, c, index)
    const built = requestFor(evaluation, c, variant)
    const hash = requestHash(built.request)
    for (const provider of providers)
      for (let attempt = 1; attempt <= repeat; attempt++)
        jobs.push(async () => {
          const base = {
            eval: evaluation.name,
            case: name,
            provider: provider.id,
            providerKey: providerKey(provider, variant),
            ...(variant ? { variant } : {}),
            attempt,
            hash,
            must: Boolean(c.must),
            margin: null,
            latencyMs: 0,
            costNanodollars: null,
          }
          if (built.request.images?.length && !provider.readsImages)
            return { ...base, pass: null, skipped: 'does not read images' }
          if (options.maxCostDollars !== undefined && spent / 1e9 >= options.maxCostDollars)
            return { ...base, pass: null, skipped: 'cost limit reached' }
          const started = Date.now()
          try {
            const result = await provider.ask(built.request, AbortSignal.timeout(timeoutMs), evaluation.purpose)
            const outcome = decide(result.answers, built.context)
            const cost = costOf(provider, built.request, result.usage?.inputTokens)
            spent += cost ?? 0
            return {
              ...base,
              answers: result.answers,
              outcome,
              pass: passes(c, outcome),
              margin: margin(result.answers, evaluation.thresholds, (answers) => decide(answers, built.context)),
              latencyMs: Date.now() - started,
              costNanodollars: cost,
            }
          } catch (error) {
            return {
              ...base,
              pass: false,
              error: error instanceof Error ? error.message : String(error),
              latencyMs: Date.now() - started,
            }
          }
        })
  })
  const results: CaseResult[] = []
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
      while (next < jobs.length) {
        const result = await jobs[next++]!()
        results.push(result)
        options.onResult?.(result)
      }
    })
  )
  const order = new Map(evaluation.cases.map((c, index) => [caseName(evaluation, c, index), index]))
  return results.sort(
    (a, b) =>
      (order.get(a.case) ?? 0) - (order.get(b.case) ?? 0) ||
      a.provider.localeCompare(b.provider) ||
      a.attempt - b.attempt
  )
}

/* Snapshots: the last recorded answers per case and provider, keyed by the request's hash. */

export interface SnapshotEntry {
  hash: string
  answers: Record<string, DecisionAnswer>
  /** Whether the case passed when it was recorded; the replay test holds passing entries to it. */
  passed: boolean | null
  recordedAt: string
}

export interface Snapshot {
  version: 1
  eval: string
  entries: Record<string, Record<string, SnapshotEntry>>
}

export function snapshotPath(evalFile: string, name: string) {
  return join(dirname(evalFile), '__decision-snapshots__', `${basename(name)}.json`)
}

export function readSnapshot(evalFile: string, name: string): Snapshot | null {
  const path = snapshotPath(evalFile, name)
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Snapshot) : null
}

/**
 * Record the first answered attempt per case and provider. Only cases defined in the eval file
 * are recorded: saved cases (from corrections) hold someone's real text and stay out of snapshots.
 */
export function writeSnapshot(evalFile: string, evaluation: DecisionEval<unknown, unknown>, results: CaseResult[]) {
  const snapshot = readSnapshot(evalFile, evaluation.name) ?? { version: 1, eval: evaluation.name, entries: {} }
  const defined = new Set(
    evaluation.cases.flatMap((c, index) => (isRawCase(c) ? [] : [caseName(evaluation, c, index)]))
  )
  const recordedAt = new Date().toISOString()
  for (const result of results) {
    if (!result.answers || result.attempt !== 1 || !defined.has(result.case)) continue
    snapshot.entries[result.case] ??= {}
    snapshot.entries[result.case]![result.providerKey] = {
      hash: result.hash,
      answers: result.answers,
      passed: result.pass,
      recordedAt,
    }
  }
  const path = snapshotPath(evalFile, evaluation.name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(snapshot, null, 2) + '\n')
  return path
}

/** Replay recorded answers through the current rule: offline, no provider, no key. */
export function replaySnapshot(evaluation: DecisionEval<unknown, unknown>, snapshot: Snapshot) {
  const replayed: Array<{
    case: string
    providerKey: string
    outcome?: unknown
    pass: boolean | null
    stale: boolean
    passedWhenRecorded: boolean | null
  }> = []
  evaluation.cases.forEach((c: EvalCase<unknown, unknown>, index) => {
    const name = caseName(evaluation, c, index)
    const entries = snapshot.entries[name]
    if (!entries) return
    for (const [key, entry] of Object.entries(entries)) {
      const variant = key.includes('#') ? key.split('#')[1] : undefined
      if (variant && !evaluation.variants?.[variant]) continue
      const built = requestFor(evaluation, c, variant)
      if (requestHash(built.request) !== entry.hash) {
        replayed.push({ case: name, providerKey: key, pass: null, stale: true, passedWhenRecorded: entry.passed })
        continue
      }
      const outcome = decideFor(evaluation, variant)(entry.answers, built.context)
      replayed.push({
        case: name,
        providerKey: key,
        outcome,
        pass: passes(c, outcome),
        stale: false,
        passedWhenRecorded: entry.passed,
      })
    }
  })
  return replayed
}
