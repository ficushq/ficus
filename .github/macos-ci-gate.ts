import { appendFile } from 'node:fs/promises'

export const MACOS_RELEVANT_PATTERNS = [
  '.github/workflows/ci.yml',
  '.github/macos-ci-gate.ts',
  '.github/macos-ci-gate.test.ts',
  '.github/actions/**',
  '.github/bunfig.toml',
  '.github/exe-lifecycle-*.ts',
  '.github/native-resize-supervisor-signal.test.ts',
  '.github/native-local-supervisor-launchd.test.ts',
  'apps/cli/src/local-server/**',
  'packages/shared/src/local-instance*',
  'apps/core/src/services/updates/deployment-flavor*',
  'apps/core/src/services/updates/change-detector*',
  'apps/core/src/services/updates/command-runner*',
  'apps/core/src/services/updates/local-updater*',
  '.bun-version',
  'bunfig.toml',
  'bun.lock',
  'package.json',
  'apps/*/package.json',
  'packages/*/package.json',
  'config/agent/extensions/**/package.json',
  'patches/**',
  'scripts/setup/setup-host.sh',
  'apps/core/src/services/machines/providers/exe*.ts',
  'apps/core/src/services/attachments/materialize.ts',
  'apps/core/src/services/attachments/materialize.test.ts',
  'apps/core/src/services/attachments/blob-storage.ts',
  'apps/core/src/services/attachments/blob-storage.test.ts',
  'apps/core/src/routes/agent-files.test.ts',
  'apps/core/src/services/machines/provider.ts',
  'apps/core/src/lib/infra/logger.ts',
] as const

type EventDecision =
  { mode: 'always'; reason: string } | { mode: 'diff'; base: string; head: string; separator: '..' | '...' }

type Outcome = { ok: true } | { ok: false; reason: string }

export function classifyPaths(paths: string[]): boolean {
  return paths.some((path) => MACOS_RELEVANT_PATTERNS.some((pattern) => new Bun.Glob(pattern).match(path)))
}

const validSha = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{40}$/.test(value) && value !== '0'.repeat(40)

export function classifyEvent(eventName: string, payload: any): EventDecision {
  if (eventName === 'schedule' || eventName === 'workflow_dispatch') {
    return { mode: 'always', reason: eventName }
  }

  let base: unknown
  let head: unknown
  let separator: '..' | '...' = '..'
  if (eventName === 'pull_request') {
    base = payload?.pull_request?.base?.sha
    head = payload?.pull_request?.head?.sha
    separator = '...'
  } else if (eventName === 'push') {
    base = payload?.before
    head = payload?.after
  } else if (eventName === 'merge_group') {
    base = payload?.merge_group?.base_sha
    head = payload?.merge_group?.head_sha
  } else {
    return { mode: 'always', reason: 'unsupported-event' }
  }

  if (!validSha(base) || !validSha(head)) return { mode: 'always', reason: 'invalid-range' }
  return { mode: 'diff', base, head, separator }
}

export function validateRequiredOutcome(classifierResult: string, runMacos: string, macosResult: string): Outcome {
  if (classifierResult === 'success' && runMacos === 'false' && macosResult === 'skipped') return { ok: true }
  if (classifierResult === 'success' && runMacos === 'true' && macosResult === 'success') return { ok: true }
  return {
    ok: false,
    reason: `rejected classifier=${classifierResult || 'missing'}, run_macos=${runMacos || 'missing'}, macos=${macosResult || 'missing'}`,
  }
}

async function appendOutput(runMacos: boolean, reason: string): Promise<void> {
  const output = process.env.GITHUB_OUTPUT
  if (!output) throw new Error('GITHUB_OUTPUT is not set')
  await appendFile(output, `run_macos=${runMacos}\nreason=${reason}\n`)
}

async function runClassifier(): Promise<void> {
  try {
    const eventName = process.env.GITHUB_EVENT_NAME ?? ''
    const eventPath = process.env.GITHUB_EVENT_PATH
    if (!eventPath) throw new Error('GITHUB_EVENT_PATH is not set')
    const payload = await Bun.file(eventPath).json()
    const decision = classifyEvent(eventName, payload)
    if (decision.mode === 'always') {
      if (decision.reason === 'invalid-range') {
        console.warn('::warning::macOS path classification failed closed: invalid-range')
      }
      await appendOutput(true, decision.reason)
      return
    }

    const range = `${decision.base}${decision.separator}${decision.head}`
    const child = Bun.spawn(['git', 'diff', '--name-only', '-z', range], { stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (exitCode !== 0) throw new Error(`git diff failed (${exitCode}): ${stderr.trim()}`)
    const paths = new TextDecoder().decode(stdout).split('\0').filter(Boolean)
    const runMacos = classifyPaths(paths)
    await appendOutput(runMacos, runMacos ? 'relevant-path' : 'irrelevant-paths')
  } catch (error) {
    console.warn(
      `::warning::macOS path classification failed closed: ${error instanceof Error ? error.message : String(error)}`
    )
    await appendOutput(true, 'classification-error')
  }
}

function verifyResult(): void {
  const outcome = validateRequiredOutcome(
    process.env.CLASSIFIER_RESULT ?? '',
    process.env.RUN_MACOS ?? '',
    process.env.MACOS_RESULT ?? ''
  )
  if (!outcome.ok) {
    console.error(`::error::macOS portability requirement failed: ${outcome.reason}`)
    process.exit(1)
  }
}

if (import.meta.main) {
  const mode = process.argv[2]
  if (mode === 'classify') await runClassifier()
  else if (mode === 'verify-result') verifyResult()
  else {
    console.error('Usage: bun .github/macos-ci-gate.ts <classify|verify-result>')
    process.exit(2)
  }
}
