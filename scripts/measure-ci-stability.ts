/** Read-only measurement; run again after enough merged-head CI jobs exist. */
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    repo: { type: 'string', default: 'ficushq/ficus' },
    branch: { type: 'string', default: 'main' },
    limit: { type: 'string', default: '200' },
  },
})
const limit = Number(values.limit)
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error('limit must be 1..1000')
if (!/^[\w.-]+\/[\w.-]+$/.test(values.repo!)) throw new Error('invalid repository')

async function api<T>(path: string): Promise<T> {
  const child = Bun.spawn(['gh', 'api', path], { stdout: 'pipe', stderr: 'pipe' })
  const [code, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0 || child.signalCode) throw new Error(`GitHub API failed (${code}): ${error}`)
  return JSON.parse(output) as T
}
type Run = { id: number; head_sha: string; run_attempt: number; created_at: string }
type Job = {
  id: number
  name: string
  conclusion: string | null
  status: string
  started_at: string | null
  completed_at: string | null
  html_url: string
}
const samples: Array<Job & { runId: number; sha: string; attempt: number }> = []
const lanes: Record<string, Record<string, number>> = {}
let runCount = 0
// Latest attempts only, matching gh run view's default. Include skipped,
// canceled, and incomplete jobs explicitly; none count as successful evidence.
for (let page = 1; samples.length < limit; page++) {
  const data = await api<{ workflow_runs: Run[] }>(
    `repos/${values.repo}/actions/workflows/ci.yml/runs?branch=${encodeURIComponent(values.branch!)}&per_page=100&page=${page}`
  )
  if (!data.workflow_runs.length) break
  for (let offset = 0; offset < data.workflow_runs.length && samples.length < limit; offset += 4) {
    await Promise.all(
      data.workflow_runs.slice(offset, offset + 4).map(async (run) => {
        const { jobs } = await api<{ jobs: Job[] }>(
          `repos/${values.repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`
        )
        runCount++
        for (const job of jobs) {
          if (
            job.name === 'test' ||
            job.name.startsWith('test-') ||
            job.name.startsWith('test / ') ||
            job.name === 'subprocess-tests'
          ) {
            const counts = (lanes[job.name] ??= {})
            const result = job.status === 'completed' ? (job.conclusion ?? 'unknown') : 'not_completed'
            counts[result] = (counts[result] ?? 0) + 1
          }
          if (job.name === 'test') samples.push({ ...job, runId: run.id, sha: run.head_sha, attempt: run.run_attempt })
        }
      })
    )
  }
}
const selected = samples.sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? '')).slice(0, limit)
const counts: Record<string, number> = {}
for (const job of selected) {
  const key = job.status === 'completed' ? (job.conclusion ?? 'unknown') : 'not_completed'
  counts[key] = (counts[key] ?? 0) + 1
}
console.log(
  JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      repository: values.repo,
      branch: values.branch,
      requestedJobs: limit,
      sampledJobs: selected.length,
      inspectedRuns: runCount,
      counts,
      failedPercent: selected.length ? (100 * (counts.failure ?? 0)) / selected.length : null,
      nonSuccessPercent: selected.length ? (100 * (selected.length - (counts.success ?? 0))) / selected.length : null,
      completeSample: selected.length === limit,
      caveat:
        'Failure rate is not a flake rate. test changed from an executing job to an aggregate after #1426; inspect lane outcomes and exact SHAs. This measures latest attempts, not retried-away failures.',
      inspectedLaneCounts: lanes,
      jobs: selected,
    },
    null,
    2
  )
)
if (selected.length !== limit) process.exitCode = 1
