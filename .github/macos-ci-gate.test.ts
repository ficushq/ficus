import { describe, expect, test } from 'bun:test'
import { classifyEvent, classifyPaths, validateRequiredOutcome } from './macos-ci-gate'

const BASE = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)
const relevantPaths = [
  '.github/workflows/ci.yml',
  '.github/macos-ci-gate.ts',
  '.github/actions/setup/action.yml',
  '.github/bunfig.toml',
  '.github/exe-lifecycle-preload.ts',
  '.github/native-resize-supervisor-signal.test.ts',
  '.bun-version',
  'bunfig.toml',
  'bun.lock',
  'package.json',
  'apps/core/package.json',
  'packages/shared/package.json',
  'config/agent/extensions/code-ast/package.json',
  'patches/example.patch',
  'scripts/setup/setup-host.sh',
  'apps/core/src/services/machines/providers/exe-api.ts',
  'apps/core/src/services/machines/providers/exe-api-exec.test.ts',
  'apps/core/src/services/machines/provider.ts',
  'apps/core/src/services/attachments/materialize.ts',
  'apps/core/src/services/attachments/materialize.test.ts',
  'apps/core/src/services/attachments/blob-storage.ts',
  'apps/core/src/services/attachments/blob-storage.test.ts',
  'apps/core/src/routes/agent-files.test.ts',
  'apps/core/src/lib/infra/logger.ts',
  'apps/cli/src/local-server/launchd.ts',
  'packages/shared/src/local-instance.ts',
  'apps/core/src/services/updates/deployment-flavor.ts',
  'apps/core/src/services/updates/change-detector.ts',
  'apps/core/src/services/updates/command-runner.ts',
  'apps/core/src/services/updates/local-updater.ts',
  '.github/native-local-supervisor-launchd.test.ts',
  'apps/cli/src/local-server/prompt.ts',
  'apps/cli/src/local-server/prompt.test.ts',
]

describe('macOS path classification', () => {
  test.each(relevantPaths)('runs macOS for %s', (path) => expect(classifyPaths([path])).toBe(true))
  test.each(['docs/readme.md', 'apps/web/src/App.tsx', 'apps/cli/src/index.ts'])(
    'skips costly macOS for irrelevant %s',
    (path) => expect(classifyPaths([path])).toBe(false)
  )
  test('runs for a mixed path list', () => expect(classifyPaths(['docs/readme.md', relevantPaths[0]])).toBe(true))
  test('handles whitespace and newline filenames without joining records', () => {
    expect(classifyPaths(['docs/file with spaces.md', 'docs/file\nname.md'])).toBe(false)
    expect(classifyPaths(['docs/file\nname.md', '.github/actions/action with spaces.yml'])).toBe(true)
  })
})

describe('event classification', () => {
  test('always runs scheduled and manual coverage', () => {
    expect(classifyEvent('schedule', {})).toEqual({ mode: 'always', reason: 'schedule' })
    expect(classifyEvent('workflow_dispatch', {})).toEqual({ mode: 'always', reason: 'workflow_dispatch' })
  })
  test('selects safe event-specific ranges', () => {
    expect(classifyEvent('pull_request', { pull_request: { base: { sha: BASE }, head: { sha: HEAD } } })).toEqual({
      mode: 'diff',
      base: BASE,
      head: HEAD,
      separator: '...',
    })
    expect(classifyEvent('push', { before: BASE, after: HEAD })).toEqual({
      mode: 'diff',
      base: BASE,
      head: HEAD,
      separator: '..',
    })
    expect(classifyEvent('merge_group', { merge_group: { base_sha: BASE, head_sha: HEAD } })).toEqual({
      mode: 'diff',
      base: BASE,
      head: HEAD,
      separator: '..',
    })
  })
  test.each([
    ['pull_request', {}],
    ['push', { before: '0'.repeat(40), after: HEAD }],
    ['push', { before: BASE, after: 'not-a-sha' }],
    ['merge_group', { merge_group: { base_sha: BASE } }],
    ['unknown', {}],
  ])('fails closed for %s with invalid data', (event, payload) =>
    expect(classifyEvent(event, payload).mode).toBe('always')
  )
})

describe('classifier CLI', () => {
  test('warns while failing closed for an invalid event range', async () => {
    const directory = await Bun.$`mktemp -d`.text()
    const eventPath = `${directory.trim()}/event.json`
    const outputPath = `${directory.trim()}/output`
    await Bun.write(eventPath, JSON.stringify({ before: '0'.repeat(40), after: HEAD }))
    const process = Bun.spawn(['bun', new URL('./macos-ci-gate.ts', import.meta.url).pathname, 'classify'], {
      env: {
        ...Bun.env,
        GITHUB_EVENT_NAME: 'push',
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: outputPath,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ])
    expect(exitCode).toBe(0)
    expect(await Bun.file(outputPath).text()).toContain('run_macos=true')
    expect(`${stdout}${stderr}`).toContain('::warning::macOS path classification failed closed: invalid-range')
  })
})

describe('required aggregate outcome', () => {
  test('accepts only an intentional skip or successful requested run', () => {
    expect(validateRequiredOutcome('success', 'false', 'skipped')).toEqual({ ok: true })
    expect(validateRequiredOutcome('success', 'true', 'success')).toEqual({ ok: true })
  })
  test.each(['failure', 'cancelled', 'skipped'])('rejects requested macOS result %s', (result) => {
    expect(validateRequiredOutcome('success', 'true', result).ok).toBe(false)
  })
  test.each([
    ['failure', '', 'skipped'],
    ['success', 'maybe', 'skipped'],
    ['success', 'false', 'failure'],
  ])('rejects invalid tuple %s/%s/%s', (classifier, runMacos, macos) => {
    expect(validateRequiredOutcome(classifier, runMacos, macos).ok).toBe(false)
  })
})

interface Step {
  id?: string
  name?: string
  uses?: string
  run?: string
  if?: string
  shell?: string
  'continue-on-error'?: boolean
  'working-directory'?: string
  with?: Record<string, unknown>
  env?: Record<string, unknown>
}
interface Job {
  name?: string
  needs?: string | string[]
  if?: string
  'runs-on'?: string
  outputs?: Record<string, unknown>
  steps?: Step[]
}
interface Workflow {
  on?: Record<string, any>
  permissions?: Record<string, unknown>
  jobs?: Record<string, Job>
}

const requiredTriggers = ['push', 'pull_request', 'merge_group', 'schedule', 'workflow_dispatch']
const ATTACHMENT_SUITE_COMMAND = `set -o pipefail
bun test ../apps/core/src/services/attachments/materialize.test.ts ../apps/core/src/services/attachments/blob-storage.test.ts 2>&1 | tee /tmp/attachment-materialization-macos.log
grep -E '^[[:space:]]*[0-9]+ (pass|fail|skip)' /tmp/attachment-materialization-macos.log >> "$GITHUB_STEP_SUMMARY"
if grep -qE '^[[:space:]]*[1-9][0-9]* skip' /tmp/attachment-materialization-macos.log; then
  echo "Portable attachment materialization tests must not skip on macOS." >&2
  exit 1
fi
`
const PROMPT_SUITE_COMMAND = `set -o pipefail
bun test src/local-server/prompt.test.ts 2>&1 | tee /tmp/cli-prompt-macos.log
grep -E '^[[:space:]]*[0-9]+ (pass|fail|skip)' /tmp/cli-prompt-macos.log >> "$GITHUB_STEP_SUMMARY"
if grep -qE '^[[:space:]]*[1-9][0-9]* skip' /tmp/cli-prompt-macos.log; then
  echo "Terminal prompt tests must not skip on macOS." >&2
  exit 1
fi
`
const suiteStep = (job: Job | undefined, name: string) => job?.steps?.find((step) => step.name === name)
const stepCount = (job: Job | undefined, predicate: (step: Step) => boolean) =>
  job?.steps?.filter(predicate).length ?? 0

export function validateMacosWorkflow(workflow: Workflow): string[] {
  const errors: string[] = []
  const triggers = workflow.on ?? {}
  for (const trigger of requiredTriggers) if (!(trigger in triggers)) errors.push(`missing ${trigger} trigger`)
  for (const [name, config] of Object.entries(triggers)) {
    if (config && typeof config === 'object' && ('paths' in config || 'paths-ignore' in config)) {
      errors.push(`${name} must not filter paths at workflow level`)
    }
  }
  if (JSON.stringify(workflow.permissions) !== JSON.stringify({ contents: 'read' })) {
    errors.push('top-level permissions must be exactly contents: read')
  }

  const jobs = workflow.jobs ?? {}
  const classifier = jobs['macos-paths']
  if (classifier?.['runs-on'] !== 'ubuntu-24.04') errors.push('classifier must use cheap Linux')
  if (classifier?.outputs?.run_macos !== '${{ steps.classify.outputs.run_macos }}')
    errors.push('classifier output is missing')
  const classifierCheckout = classifier?.steps?.find((step) => step.uses?.startsWith('actions/checkout@'))
  if (classifierCheckout?.with?.['fetch-depth'] !== 0) errors.push('classifier checkout must fetch full history')
  if (
    !classifier?.steps?.some((step) => step.uses === 'oven-sh/setup-bun@v2' && step.with?.['bun-version'] === '1.4.2')
  )
    errors.push('classifier Bun must be pinned')
  const classifySteps = classifier?.steps?.filter((step) => step.run === 'bun .github/macos-ci-gate.ts classify') ?? []
  if (
    classifySteps.length !== 1 ||
    classifySteps[0].id !== 'classify' ||
    classifySteps[0].if ||
    classifySteps[0]['continue-on-error']
  )
    errors.push('classifier command must run once unconditionally')

  if (Object.values(jobs).filter((job) => job['runs-on'] === 'macos-14').length !== 1)
    errors.push('workflow must contain exactly one macos-14 job')
  const suite = jobs['macos-portability-suite']
  if (suite?.needs !== 'macos-paths') errors.push('macOS suite must need classifier')
  if (suite?.if !== "${{ needs.macos-paths.result == 'success' && needs.macos-paths.outputs.run_macos == 'true' }}")
    errors.push('macOS suite condition must require a true classifier output')
  if (stepCount(suite, (step) => step.run === 'bun install --frozen-lockfile') !== 1)
    errors.push('macOS suite must install exactly once')
  const installIndex = suite?.steps?.findIndex((step) => step.run === 'bun install --frozen-lockfile') ?? -1
  const nativeLaunchd = suiteStep(suite, 'Run native local launchd lifecycle')
  if (
    nativeLaunchd?.run !== 'bun test native-local-supervisor-launchd.test.ts' ||
    nativeLaunchd['working-directory'] !== '.github' ||
    nativeLaunchd.if ||
    nativeLaunchd['continue-on-error'] ||
    !suite?.steps ||
    suite.steps.indexOf(nativeLaunchd) <= installIndex
  )
    errors.push('native launchd lifecycle must run unconditionally after install')
  const exe = suiteStep(suite, 'Run real exe lobby subprocess lifecycle tests')
  if (
    exe?.['working-directory'] !== '.github' ||
    exe.run !==
      'bun test exe-lifecycle-config-probe.test.ts ../apps/core/src/services/machines/providers/exe-api-exec.test.ts' ||
    exe.if ||
    exe['continue-on-error']
  )
    errors.push('exe lifecycle suite contract changed')
  const attachments = suiteStep(suite, 'Run portable attachment materialization tests')
  const attachmentRun = attachments?.run ?? ''
  if (attachmentRun !== ATTACHMENT_SUITE_COMMAND) errors.push('attachment materialization suite contract changed')
  if (attachments?.['working-directory'] !== '.github' || attachments.if || attachments['continue-on-error'])
    errors.push('attachment materialization suite must run unconditionally from .github')
  for (const contract of [
    'set -o pipefail',
    '$GITHUB_STEP_SUMMARY',
    "grep -qE '^[[:space:]]*[1-9][0-9]* skip'",
    'exit 1',
  ]) {
    if (!attachmentRun.includes(contract)) errors.push(`attachment materialization suite missing ${contract}`)
  }
  // The /dev/tty prompt regression reproduces only on Darwin (kqueue), so this
  // is the one lane where its pty case can fail; a skip means it did not run.
  const prompt = suiteStep(suite, 'Run terminal prompt tests')
  if (prompt?.run !== PROMPT_SUITE_COMMAND) errors.push('terminal prompt suite contract changed')
  if (prompt?.['working-directory'] !== 'apps/cli' || prompt.if || prompt['continue-on-error'])
    errors.push('terminal prompt suite must run unconditionally from apps/cli')

  const aggregate = jobs['macos-portability-required']
  if (aggregate?.name !== 'macOS portability') errors.push('aggregate must have stable check name')
  if (JSON.stringify(aggregate?.needs) !== JSON.stringify(['macos-paths', 'macos-portability-suite']))
    errors.push('aggregate must need classifier and macOS suite')
  if (aggregate?.if !== '${{ always() }}') errors.push('aggregate must always run')
  const verify = aggregate?.steps?.find((step) => step.run === 'bun .github/macos-ci-gate.ts verify-result')
  if (
    verify?.env?.CLASSIFIER_RESULT !== '${{ needs.macos-paths.result }}' ||
    verify?.env?.RUN_MACOS !== '${{ needs.macos-paths.outputs.run_macos }}' ||
    verify?.env?.MACOS_RESULT !== '${{ needs.macos-portability-suite.result }}'
  )
    errors.push('aggregate must verify all dependency outcomes')

  const linux = jobs['test-gates']
  if (linux?.['runs-on'] !== 'ubuntu-24.04') errors.push('test job runner changed')
  const validation = linux?.steps?.filter((step) => step.name === 'Validate macOS portability gate') ?? []
  if (
    validation.length !== 1 ||
    validation[0].run !== 'bun test ./macos-ci-gate.test.ts' ||
    validation[0]['working-directory'] !== '.github' ||
    validation[0].if ||
    validation[0]['continue-on-error']
  )
    errors.push('Linux self-validation step missing or weakened')
  return errors
}

const workflowPath = new URL('./workflows/ci.yml', import.meta.url)
const readWorkflow = async () => Bun.YAML.parse(await Bun.file(workflowPath).text())
const clone = <T>(value: T): T => structuredClone(value)

describe('workflow mutation contract', () => {
  test('the real workflow preserves the macOS portability contract', async () => {
    expect(validateMacosWorkflow((await readWorkflow()) as Workflow)).toEqual([])
  })

  const mutations: [string, (workflow: Workflow) => void][] = [
    ['delete schedule', (w) => delete w.on!.schedule],
    ['delete workflow_dispatch', (w) => delete w.on!.workflow_dispatch],
    ['delete merge_group', (w) => delete w.on!.merge_group],
    ['add pull_request.paths', (w) => (w.on!.pull_request.paths = ['apps/core/**'])],
    ['give contents write permission', (w) => (w.permissions!.contents = 'write')],
    ['remove classifier full-history checkout', (w) => delete w.jobs!['macos-paths'].steps![0].with],
    ['make schedule depend on a false diff output', (w) => (w.jobs!['macos-portability-suite'].if = '${{ false }}')],
    ['add a second macos-14 job', (w) => (w.jobs!.duplicate = { 'runs-on': 'macos-14' })],
    [
      'remove exe suite step',
      (w) =>
        (w.jobs!['macos-portability-suite'].steps = w.jobs!['macos-portability-suite'].steps!.filter(
          (s) => !s.name?.startsWith('Run real exe')
        )),
    ],
    [
      'remove attachment materialization suite step',
      (w) =>
        (w.jobs!['macos-portability-suite'].steps = w.jobs!['macos-portability-suite'].steps!.filter(
          (s) => s.name !== 'Run portable attachment materialization tests'
        )),
    ],
    [
      'remove portable suite step',
      (w) =>
        (w.jobs!['macos-portability-suite'].steps = w.jobs!['macos-portability-suite'].steps!.filter(
          (s) => !s.name?.startsWith('Run portable')
        )),
    ],
    [
      'narrow the attachment test list',
      (w) => {
        const step = suiteStep(w.jobs!['macos-portability-suite'], 'Run portable attachment materialization tests')!
        step.run = step.run!.replace('../apps/core/src/services/attachments/blob-storage.test.ts', '')
      },
    ],
    [
      'remove set -o pipefail',
      (w) => {
        const s = suiteStep(w.jobs!['macos-portability-suite'], 'Run portable attachment materialization tests')!
        s.run = s.run!.replace('set -o pipefail', '')
      },
    ],
    [
      'remove positive skip-count rejection',
      (w) => {
        const s = suiteStep(w.jobs!['macos-portability-suite'], 'Run portable attachment materialization tests')!
        s.run = s.run!.replace("grep -qE '^[[:space:]]*[1-9][0-9]* skip'", "grep -qE '^[[:space:]]*0 skip'")
      },
    ],
    [
      'remove terminal prompt suite step',
      (w) =>
        (w.jobs!['macos-portability-suite'].steps = w.jobs!['macos-portability-suite'].steps!.filter(
          (s) => s.name !== 'Run terminal prompt tests'
        )),
    ],
    [
      'allow the terminal prompt pty case to skip',
      (w) => {
        const s = suiteStep(w.jobs!['macos-portability-suite'], 'Run terminal prompt tests')!
        s.run = s.run!.replace("grep -qE '^[[:space:]]*[1-9][0-9]* skip'", "grep -qE '^[[:space:]]*0 skip'")
      },
    ],
    [
      'gate the terminal prompt suite behind a condition',
      (w) => (suiteStep(w.jobs!['macos-portability-suite'], 'Run terminal prompt tests')!.if = '${{ false }}'),
    ],
    [
      'add continue-on-error to a suite',
      (w) =>
        (suiteStep(w.jobs!['macos-portability-suite'], 'Run real exe lobby subprocess lifecycle tests')![
          'continue-on-error'
        ] = true),
    ],
    ['remove always() from aggregate', (w) => delete w.jobs!['macos-portability-required'].if],
    [
      'remove macOS result from aggregate env',
      (w) => delete w.jobs!['macos-portability-required'].steps!.at(-1)!.env!.MACOS_RESULT,
    ],
    [
      'remove the Linux self-validation step',
      (w) =>
        (w.jobs!['test-gates']!.steps = w.jobs!['test-gates']!.steps!.filter(
          (s) => s.name !== 'Validate macOS portability gate'
        )),
    ],
  ]

  test.each(mutations)('rejects mutation: %s', async (_name, mutate) => {
    const workflow = clone((await readWorkflow()) as Workflow)
    mutate(workflow)
    expect(validateMacosWorkflow(workflow).length).toBeGreaterThan(0)
  })
})
