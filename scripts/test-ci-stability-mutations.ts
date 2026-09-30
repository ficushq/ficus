/** Mutation proofs run in temporary copies, never by editing an active worktree. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { assertTestCompletion } from './test-runner'

const root = resolve(import.meta.dir, '..')
const scratch = mkdtempSync(join(tmpdir(), 'tau-ci-mutations-'))
function replaceOnce(source: string, before: string, after: string) {
  if (source.split(before).length !== 2) throw new Error(`Mutation anchor must occur exactly once: ${before}`)
  return source.replace(before, after)
}
function relocate(source: string, original: string) {
  // Resolve static imports from their original owner, including workspace SDKs.
  return source.replace(/\bfrom (['"])([^'"]+)\1/g, (whole, _quote, specifier: string) => {
    if (specifier.startsWith('node:') || specifier.startsWith('bun:') || specifier === 'bun') return whole
    return `from ${JSON.stringify(Bun.resolveSync(specifier, dirname(original)))}`
  })
}
async function proof(options: {
  name: string
  source: string
  test: string
  match: string
  mutate: (source: string) => string
}) {
  const original = resolve(root, options.source)
  const source = relocate(readFileSync(original, 'utf8'), original)
  const target = join(scratch, 'subject.ts')
  const testPath = join(scratch, 'proof.test.ts')
  const originalTest = resolve(root, options.test)
  const testSource = relocate(readFileSync(originalTest, 'utf8'), originalTest).replace(
    JSON.stringify(original),
    JSON.stringify(target)
  )
  if (!testSource.includes(JSON.stringify(target)))
    throw new Error('Mutation test did not import the temporary subject')
  await Bun.write(testPath, testSource)
  for (const mutated of [false, true]) {
    await Bun.write(target, mutated ? options.mutate(source) : source)
    const child = Bun.spawn([process.execPath, 'test', testPath, '--test-name-pattern', options.match], {
      cwd: resolve(root, '.github'),
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    const output = stdout + stderr
    if (!mutated) assertTestCompletion(output, code, child.signalCode, 1)
    else if (code !== 1 || child.signalCode || !output.includes(`(fail)`) || !output.includes(options.match)) {
      throw new Error(`${options.name}: mutation did not produce its named assertion failure\n${output}`)
    }
  }
  console.log(`PASS mutation red / baseline green: ${options.name}`)
}

try {
  await proof({
    name: 'missing log paths cannot trust a lexical symlink prefix',
    source: 'apps/core/src/services/deploy/local-deployment-log-path.ts',
    test: 'apps/core/src/services/deploy/local-deployment-log-path.test.ts',
    match: 'missing nested paths resolve their physical ancestor',
    mutate: (source) =>
      replaceOnce(source, 'r=$(realpath -m -- "$p" 2>/dev/null || readlink -f -- "$p" 2>/dev/null || true)', 'r="$p"'),
  })
  await proof({
    name: 'schema cache cannot trust a stale DDL fingerprint',
    source: 'apps/core/src/test-utils/schema-cache.ts',
    test: '.github/test-schema-cache.test.ts',
    match: 'schema reuse requires both identical inputs',
    mutate: (source) => replaceOnce(source, 'stored.fingerprint === hash(current)', 'true'),
  })
  const state = {
    source: 'apps/core/src/services/work-streams/ci-notification-state.ts',
    test: '.github/ci-notification-state.test.ts',
  }
  await proof({
    ...state,
    name: 'workflow partitions cannot collapse to a global slot',
    match: 'A then B then replay A',
    mutate: (source) =>
      replaceOnce(
        source,
        'const key = `${input.repository.toLowerCase()}#${input.workflowId}`',
        "const key = 'acme/repo#1'"
      ),
  })
  await proof({
    ...state,
    name: 'attempt 9 to 10 cannot use lexicographic ordering',
    match: 'attempts compare numerically',
    mutate: (source) =>
      replaceOnce(
        source,
        'BigInt(input.runAttempt) < BigInt(previous.runAttempt)',
        'input.runAttempt < previous.runAttempt'
      ),
  })
  await proof({
    ...state,
    name: 'capacity cannot evict a replay tombstone',
    match: 'capacity is bounded',
    mutate: (source) =>
      replaceOnce(
        source,
        "return { accepted: false, reason: 'workflow state capacity reached' }",
        'delete workflows[Object.keys(workflows)[0]!]'
      ),
  })
  await proof({
    name: 'exit cannot race the final readiness capture',
    source: 'apps/core/src/services/amtp/node-conformance-process.ts',
    test: 'apps/core/src/services/amtp/node-conformance-process.test.ts',
    match: 'reads the final capture after exit races',
    mutate: (source) =>
      replaceOnce(
        source,
        'if (exitedBeforeRead)',
        'if (child.proc.exitCode !== null || child.proc.signalCode !== null)'
      ),
  })
  await proof({
    name: 'Darwin must not inspect protected unrelated sessions',
    source: 'packages/sandbox-server/src/services/process-session.ts',
    test: 'packages/sandbox-server/src/services/process-session.test.ts',
    match: 'does not inspect protected processes outside the owned session',
    mutate: (source) =>
      replaceOnce(source, 'if ((await native.getSessionId(pid)) !== sid) continue', '// mutation: inspect every PID'),
  })
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
