import { afterEach, expect, test } from 'bun:test'
import { expectCleanExit, expectFailedExit } from '../../../test-utils/captured-process'
import {
  createFakeNpmSetupSandbox,
  INSTALLED_BINARY,
  ORIGINAL_BINARY,
  sha512Base64,
  type FakeNpmSetupSandbox,
} from '../../../test-utils/fake-npm-setup-sandbox'
import { notionCliSetupScript, notionPlugin } from './plugin'

let sandbox: FakeNpmSetupSandbox | undefined
afterEach(() => sandbox?.dispose())

test('shipped ntn setup step rejects a tampered archive before installing and cleans temporary files', async () => {
  sandbox = createFakeNpmSetupSandbox('ntn', 'tampered ntn archive')
  const [step] = notionPlugin.sandbox.setupSteps

  // A trailing command proves the step stops itself: it must not depend on the
  // caller's shell options or on being the last line of setup.sh.
  const outcome = await sandbox.run(`${step.script}\necho survived > '${sandbox.path('after')}'`)

  // The step's own failure is contained, so the caller's next line still runs;
  // effective-toolchain.ts turns that failure into a non-zero setup.sh.
  expectCleanExit(outcome)
  expect(outcome.stderr).not.toContain('npm install')
  expect(sandbox.installs()).toEqual([])
  expect(sandbox.installedBinary()).toBe(ORIGINAL_BINARY)
  expect(sandbox.leftovers()).toEqual({ temp: [], work: [] })
  expect(sandbox.exists('after')).toBe(true)
})

test('shipped ntn setup step exits non-zero on a tampered archive', async () => {
  sandbox = createFakeNpmSetupSandbox('ntn', 'tampered ntn archive')
  expectFailedExit(await sandbox.run(notionPlugin.sandbox.setupSteps[0].script))
  expect(sandbox.installs()).toEqual([])
})

test('ntn setup step installs an archive whose digest matches and cleans temporary files', async () => {
  const archive = 'genuine ntn archive'
  sandbox = createFakeNpmSetupSandbox('ntn', archive)

  expectCleanExit(await sandbox.run(notionCliSetupScript('9.9.9', sha512Base64(archive))))

  expect(sandbox.installs()).toHaveLength(1)
  expect(sandbox.installs()[0]).toMatch(
    /^install --global --prefix .*\/project\/npm --no-audit --no-fund \.\/fixture\.tgz$/
  )
  expect(sandbox.installedBinary()).toBe(INSTALLED_BINARY)
  expect(sandbox.leftovers()).toEqual({ temp: [], work: [] })
})

test('ntn setup step installs over the copy an interrupted install left behind', async () => {
  const archive = 'genuine ntn archive'
  sandbox = createFakeNpmSetupSandbox('ntn', archive)
  // npm renames the installed package aside before replacing it. Killed at that
  // point, it leaves the renamed copy, and the bundled npm then refuses every
  // later install of the package.
  sandbox.plantInterruptedInstall('ntn')

  expectCleanExit(await sandbox.run(notionCliSetupScript('9.9.9', sha512Base64(archive))))

  expect(sandbox.installedBinary()).toBe(INSTALLED_BINARY)
  expect(sandbox.globalModules()).toEqual(['ntn'])
})
