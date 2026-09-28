import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expandTilde } from '@ficus/shared/node'

interface HarnessRun {
  exitCode: number
  stdout: string
  stderr: string
}

const PROBE_REGISTRATION = `
program
  .command('__tau-lifecycle-probe')
  .action(async () => {
    await Bun.sleep(25)
    const markerPath = process.env.AMTP_NODE_CANDIDATE_MARKER_PATH
    if (!markerPath) throw new Error('candidate-probe:marker-path-missing')
    appendFileSync(markerPath, 'action-settled\\n')
  })

`

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function instrumentCandidate(candidateRoot: string): void {
  const entrypoint = join(candidateRoot, 'src', 'index.ts')
  let source = readFileSync(entrypoint, 'utf8')
  const firstImport = "import { Command } from 'commander'"
  if (source.split(firstImport).length !== 2) throw new Error('candidate-regression:commander-import-not-unique')
  source = source.replace(firstImport, `import { appendFileSync } from 'node:fs'\n${firstImport}`)
  const parseBarrier = 'await program.parseAsync()'
  if (source.split(parseBarrier).length !== 2) throw new Error('candidate-regression:parse-async-not-unique')
  source = source.replace(parseBarrier, `${PROBE_REGISTRATION}${parseBarrier}`)
  writeFileSync(entrypoint, source)
}

function mutateCandidateToSynchronous(candidateRoot: string): void {
  const entrypoint = join(candidateRoot, 'src', 'index.ts')
  const source = readFileSync(entrypoint, 'utf8')
  const asyncBarrier = 'await program.parseAsync()'
  if (source.split(asyncBarrier).length !== 2) throw new Error('candidate-regression:parse-async-not-unique')
  writeFileSync(entrypoint, source.replace(asyncBarrier, 'program.parse()'))
}

async function runHarness(candidateRoot: string, digest: string): Promise<HarnessRun> {
  const harnessPath = join(import.meta.dir, 'node-conformance-entrypoint-candidate-harness.ts')
  const child = Bun.spawn([process.execPath, harnessPath], {
    cwd: candidateRoot,
    env: {
      ...process.env,
      AMTP_NODE_CANDIDATE_ROOT: candidateRoot,
      AMTP_NODE_CANDIDATE_SHA256: digest,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

function requireGreen(run: HarnessRun, phase: string): void {
  if (run.exitCode !== 0 || !run.stdout.includes('"kind":"amtp-node-candidate-harness-pass"')) {
    throw new Error(`candidate-regression:${phase}-failed:${run.exitCode}:${run.stderr.trim()}`)
  }
}

const sourceRootValue = process.env.AMTP_NODE_SOURCE_ROOT
if (!sourceRootValue) throw new Error('candidate-regression:amtp_node_source_root-missing')
const sourceRoot = resolve(expandTilde(sourceRootValue))
const sourceEntrypoint = join(sourceRoot, 'src', 'index.ts')
if (!readFileSync(sourceEntrypoint, 'utf8').includes('await program.parseAsync()')) {
  throw new Error('candidate-regression:source-missing-parse-async')
}

// Keep candidates below the repository so their package imports resolve through
// the normalized worktree dependency tree, but never place them in node_modules.
const candidateParent = mkdtempSync(join(process.cwd(), '.amtp-node-candidates-'))
const greenRoot = join(candidateParent, 'green')
const redRoot = join(candidateParent, 'red')
try {
  cpSync(sourceRoot, greenRoot, { recursive: true, dereference: true })
  instrumentCandidate(greenRoot)
  cpSync(greenRoot, redRoot, { recursive: true, dereference: true })
  mutateCandidateToSynchronous(redRoot)

  const greenDigest = sha256(join(greenRoot, 'src', 'index.ts'))
  const redDigest = sha256(join(redRoot, 'src', 'index.ts'))
  if (greenDigest === redDigest) throw new Error('candidate-regression:mutation-digest-unchanged')

  const greenBefore = await runHarness(greenRoot, greenDigest)
  requireGreen(greenBefore, 'green-before')

  const red = await runHarness(redRoot, redDigest)
  if (red.exitCode === 0) throw new Error('candidate-regression:red-unexpectedly-green')
  if (!red.stderr.includes('candidate-harness:lifecycle-order:import-settled->action-settled')) {
    throw new Error(`candidate-regression:red-wrong-failure:${red.exitCode}:${red.stderr.trim()}`)
  }

  const greenAfter = await runHarness(greenRoot, greenDigest)
  requireGreen(greenAfter, 'green-after')

  console.log(
    JSON.stringify({
      kind: 'amtp-node-candidate-regression-pass',
      greenDigest,
      redDigest,
      redFailure: 'candidate-harness:lifecycle-order:import-settled->action-settled',
    })
  )
} finally {
  rmSync(candidateParent, { recursive: true, force: true })
}
