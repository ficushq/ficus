import { afterEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { restartResumeNotice } from '@ficus/shared/restart-context'
import { HARNESS_REVISION } from './define'
import { findScenario } from './scenarios'
import { gitRefVariant, importFromVariant, variantContext, workingTreeVariant, type PromptVariant } from './variant'

const carrier = 'packages/shared/src/restart-context.ts'
const restart = { restartId: 'restart-5d1c', restartedAt: '2026-11-18T15:40:02.114Z' }
const temporaryRoots: string[] = []

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'ficus-eval-restart-test-'))
  temporaryRoots.push(root)
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' })
      .toString()
      .trim()
  git('init')
  mkdirSync(join(root, 'config'))
  writeFileSync(join(root, 'config/fixture.txt'), root)
  const commit = () => {
    git('add', '.')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'Restart fixture')
    const sha = git('rev-parse', 'HEAD')
    temporaryRoots.push(join(tmpdir(), 'ficus-agent-evals', sha))
    return sha
  }
  return { root, commit }
}

async function scenarioNotice(variant: PromptVariant, name: string) {
  const notice = findScenario(name)!.messages[0]!
  expect(typeof notice).toBe('function')
  if (typeof notice !== 'function') throw new Error('Expected the production restart notice builder')
  return await notice(variantContext(variant))
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('both restart scenarios use each real ref’s committed carrier, never the working or other ref’s notice', async () => {
  const repo = repository()
  const source = readFileSync(join(workingTreeVariant().root, carrier), 'utf8')
  const path = join(repo.root, carrier)
  mkdirSync(dirname(path), { recursive: true })
  // Keep the real carrier API and runtime dependencies; change only its returned notice.
  const original = source.replace('export function restartResumeNotice(', 'function originalRestartResumeNotice(')
  expect(original).not.toBe(source)
  const withPrefix = (prefix: string) =>
    original +
    `\nexport function restartResumeNotice(restart: RestartContext): string {\n` +
    `  return ${JSON.stringify(prefix)} + originalRestartResumeNotice(restart)\n}\n`
  const oldSource = withPrefix('Old fixture: ')
  const newSource = withPrefix('New fixture: ')
  writeFileSync(path, oldSource)
  const oldRef = repo.commit()
  writeFileSync(path, newSource)
  const newRef = repo.commit()
  writeFileSync(path, withPrefix('Uncommitted fixture: '))

  // Model the prior cache format: it marked extraction ready without this shared carrier.
  const staleRoot = join(tmpdir(), 'ficus-agent-evals', oldRef)
  mkdirSync(join(staleRoot, '.extracted-v5'), { recursive: true })
  const old = gitRefVariant(oldRef, repo.root)
  const newer = gitRefVariant(newRef, repo.root)
  for (const [variant, expectedSource, prefix, forbidden] of [
    [old, oldSource, 'Old fixture: ', 'New fixture: '],
    [newer, newSource, 'New fixture: ', 'Old fixture: '],
  ] as const) {
    expect(existsSync(join(variant.root, carrier))).toBe(true)
    expect(readFileSync(join(variant.root, carrier), 'utf8')).toBe(expectedSource)
    for (const name of ['restart-side-effect', 'restart-idempotent']) {
      const text = await scenarioNotice(variant, name)
      expect(text).toBe(prefix + restartResumeNotice(restart))
      expect(text).not.toBe(restartResumeNotice(restart))
      expect(text).not.toContain(forbidden)
      expect(text).not.toContain('Uncommitted fixture: ')
      expect(await scenarioNotice(variant, name)).toBe(text)
    }
  }
  expect(gitRefVariant(oldRef, repo.root)).toEqual(old)
})

test('a pre-carrier ref fails explicitly instead of inheriting the working tree restart notice', async () => {
  const repo = repository()
  const ref = repo.commit()
  const variant = gitRefVariant(ref, repo.root)
  expect(existsSync(join(variant.root, carrier))).toBe(false)
  for (const name of ['restart-side-effect', 'restart-idempotent']) {
    await expect(scenarioNotice(variant, name)).rejects.toThrow(`Missing ${carrier} in variant ${variant.label}`)
  }
})

test('working restart scenarios still use the working carrier', async () => {
  for (const name of ['restart-side-effect', 'restart-idempotent']) {
    expect(await scenarioNotice(workingTreeVariant(), name)).toBe(restartResumeNotice(restart))
  }
})

test('unrelated missing modules retain the existing working-source fallback', async () => {
  const repo = repository()
  const variant = gitRefVariant(repo.commit(), repo.root)
  const module = await importFromVariant<typeof import('./define')>(
    variant,
    'apps/core/src/services/agent-evals/define.ts'
  )
  expect(module.HARNESS_REVISION).toBe(HARNESS_REVISION)
})
