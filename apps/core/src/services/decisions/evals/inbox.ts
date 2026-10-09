import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { relative } from 'node:path'
import { listCandidates, setCandidateStatus } from './capture'
import type { RawEvalCase } from './define'
import { casesFiles, type LoadedEval } from './run'

const repoPath = (file: string) => relative(process.cwd(), file)

/** `--inbox`: saved corrections waiting for review, newest first. */
export async function listInbox(): Promise<number> {
  const candidates = await listCandidates(['new'])
  if (!candidates.length) {
    console.log(
      'No saved corrections. Turn on "Save corrections as eval cases" in Settings → Decision Providers to collect them.'
    )
    return 0
  }
  for (const candidate of candidates)
    console.log(
      `${candidate.id.slice(0, 8)}  ${candidate.createdAt.toISOString().slice(0, 16)}  ${candidate.evalName.padEnd(22)} ` +
        `${candidate.summary}  → ${JSON.stringify(candidate.expected)}`
    )
  console.log(
    `\n${candidates.length} waiting. Keep one with --accept <id> (to a gitignored local cases file), or --accept <id> --shared ` +
      '(to the committed one: only after checking it holds nothing private). Drop one with --dismiss <id>.'
  )
  return 0
}

async function findCandidate(id: string) {
  const matches = (await listCandidates(['new'])).filter((candidate) => candidate.id.startsWith(id))
  if (matches.length !== 1)
    throw new Error(matches.length ? `"${id}" matches ${matches.length} candidates` : `No waiting candidate "${id}"`)
  return matches[0]!
}

/** `--accept`: add the candidate to its eval's cases, then mark it accepted. */
export async function acceptCandidate(
  id: string,
  evals: LoadedEval[],
  options: { shared?: boolean; name?: string } = {}
): Promise<number> {
  const candidate = await findCandidate(id)
  const target = evals.find(({ evaluation }) => evaluation.name === candidate.evalName)
  if (!target) throw new Error(`No eval named "${candidate.evalName}" for this candidate`)
  const file = casesFiles(target.file)[options.shared ? 'shared' : 'local']
  const existing = existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as { cases?: RawEvalCase<unknown>[] })
    : {}
  const cases = existing.cases ?? []
  const name =
    options.name ?? `saved ${candidate.createdAt.toISOString().slice(0, 10)}: ${candidate.summary.slice(0, 60)}`
  if (cases.some((c) => c.name === name))
    throw new Error(`${repoPath(file)} already has a case named "${name}"; pass --name`)
  cases.push({
    name,
    request: candidate.request,
    ...(candidate.context !== null ? { context: candidate.context } : {}),
    ...candidate.expected,
    note: `Saved from a correction (${candidate.source ? JSON.stringify(candidate.source) : 'unknown source'}).`,
  } as RawEvalCase<unknown>)
  writeFileSync(file, JSON.stringify({ cases }, null, 2) + '\n')
  await setCandidateStatus(candidate.id, 'accepted')
  console.log(`Added "${name}" to ${repoPath(file)}.`)
  if (options.shared) console.log('This file is committed: check the case holds nothing private before you commit it.')
  return 0
}

/** `--dismiss`: drop a candidate from the inbox. */
export async function dismissCandidate(id: string): Promise<number> {
  const candidate = await findCandidate(id)
  await setCandidateStatus(candidate.id, 'dismissed')
  console.log(`Dismissed ${candidate.id.slice(0, 8)}.`)
  return 0
}
