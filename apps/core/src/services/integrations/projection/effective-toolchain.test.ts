import { afterEach, describe, expect, test } from 'bun:test'
import { expectCleanExit, expectFailedExit } from '../../../test-utils/captured-process'
import {
  createFakeNpmSetupSandbox,
  INSTALLED_BINARY,
  ORIGINAL_BINARY,
  sha512Base64,
  type FakeNpmSetupSandbox,
} from '../../../test-utils/fake-npm-setup-sandbox'
import { notionCliSetupScript, notionPlugin } from '../notion/plugin'
import { projectIntegrationAssignments } from './projector'
import { resolveEffectiveToolchain } from './effective-toolchain'

const connection = {
  id: 'connection',
  providerKey: 'notion',
  adapterVersion: 1,
  configuration: { version: 1, workspaceId: 'workspace', workspaceName: null, workspaceIcon: null, botId: 'bot' },
  credentialRef: 'credential',
  materialRevision: 'revision',
}

test('effective toolchain preserves squad metadata and appends stable plugin contributions', () => {
  const squadConfig = { packages: ['python@3.12', 'nodejs@24.12.0'], setupScript: 'echo squad-owned' }
  const before = JSON.stringify(squadConfig)
  const projection = projectIntegrationAssignments([{ plugin: notionPlugin, connection }])
  const effective = resolveEffectiveToolchain(squadConfig, projection.publicDeclaration)

  expect(JSON.stringify(squadConfig)).toBe(before)
  expect(effective.config.packages).toEqual(['nodejs@24.12.0', 'python@3.12'])
  expect(effective.config.setupScript).toStartWith('echo squad-owned\n')
  expect(effective.config.setupScript).toContain(`(\nset -eu\n${notionPlugin.sandbox.setupSteps[0].script}\n)\n`)
  expect(effective.initHooks).toEqual(notionPlugin.sandbox.initHooks)
  expect(effective.readiness).toEqual(notionPlugin.sandbox.readiness)
})

describe('joined setup.sh', () => {
  let sandbox: FakeNpmSetupSandbox | undefined
  afterEach(() => sandbox?.dispose())

  const declaration = (setupSteps: { id: string; script: string }[]) => ({
    packages: [],
    setupSteps,
    initHooks: [],
    readiness: [],
    skills: [],
    extensions: [],
    protectedBindingNames: [],
  })
  const setupScript = (squadScript: string | undefined, steps: { id: string; script: string }[]) =>
    resolveEffectiveToolchain(
      squadScript === undefined ? undefined : { packages: [], setupScript: squadScript },
      declaration(steps)
    ).config.setupScript!
  const marker = (name: string) => ({ id: name, script: `echo ran > '${sandbox!.path(name)}'` })

  test('a tampered ntn archive fails setup.sh without installing it, while later steps still run', async () => {
    sandbox = createFakeNpmSetupSandbox('ntn', 'tampered ntn archive')
    const script = setupScript(`echo squad > '${sandbox.path('squad')}'`, [
      ...notionPlugin.sandbox.setupSteps,
      marker('later-step'),
    ])

    const outcome = await sandbox.run(script)

    expectFailedExit(outcome)
    expect(outcome.stderr).toContain(`Integration setup step ${notionPlugin.sandbox.setupSteps[0].id} failed`)
    expect(sandbox.installs()).toEqual([])
    expect(sandbox.installedBinary()).toBe(ORIGINAL_BINARY)
    expect(sandbox.exists('squad')).toBe(true)
    expect(sandbox.exists('later-step')).toBe(true)
    expect(sandbox.leftovers()).toEqual({ temp: [], work: [] })
  })

  test('a step that checks and then carries on is still stopped at the failed check', async () => {
    sandbox = createFakeNpmSetupSandbox('tool', 'unused')
    const careless = { id: 'careless', script: `test a = b\necho installed > '${sandbox.path('installed')}'` }

    const outcome = await sandbox.run(setupScript(undefined, [careless, marker('later-step')]))

    expectFailedExit(outcome)
    expect(outcome.stderr).toContain('Integration setup step careless failed')
    expect(sandbox.exists('installed')).toBe(false)
    expect(sandbox.exists('later-step')).toBe(true)
  })

  test('a squad script with set -e stops at the first failed step', async () => {
    sandbox = createFakeNpmSetupSandbox('tool', 'unused')
    const failing = { id: 'failing', script: 'false' }

    const outcome = await sandbox.run(setupScript('set -e', [failing, marker('later-step')]))

    expectFailedExit(outcome)
    expect(sandbox.exists('later-step')).toBe(false)
  })

  test('setup.sh succeeds and installs a genuine archive when every step succeeds', async () => {
    const archive = 'genuine ntn archive'
    sandbox = createFakeNpmSetupSandbox('ntn', archive)
    const genuine = { id: 'notion-cli@9.9.9', script: notionCliSetupScript('9.9.9', sha512Base64(archive)) }

    const outcome = await sandbox.run(setupScript('echo squad-owned', [genuine, marker('later-step')]))

    expectCleanExit(outcome)
    expect(sandbox.installs()).toHaveLength(1)
    expect(sandbox.installedBinary()).toBe(INSTALLED_BINARY)
    expect(sandbox.exists('later-step')).toBe(true)
    expect(sandbox.leftovers()).toEqual({ temp: [], work: [] })
  })

  test('step ids are quoted in the failure message', () => {
    expect(setupScript(undefined, [{ id: "it's", script: 'true' }])).toContain(
      `echo 'Integration setup step it'\\''s failed' >&2`
    )
  })

  test('a squad script without integration steps is left unchanged', () => {
    expect(resolveEffectiveToolchain({ packages: [], setupScript: 'echo only' }, declaration([])).config).toEqual({
      packages: [],
      setupScript: 'echo only',
    })
  })
})
