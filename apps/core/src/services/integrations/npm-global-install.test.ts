import { expect, test } from 'bun:test'
import { deploymentCliSetup } from './deployment/cli-install'
import { npmGlobalInstallLines } from './npm-global-install'

test('clears the copy an interrupted install left beside the package, then installs', () => {
  expect(npmGlobalInstallLines('netlify-cli')).toEqual([
    'rm -rf -- "$DEVBOX_PROJECT_ROOT/npm/lib/node_modules"/.netlify-cli-????????',
    'npm install --global --prefix "$DEVBOX_PROJECT_ROOT/npm" --no-audit --no-fund "./$archive"',
  ])
})

test('looks inside the scope directory for a scoped package', () => {
  expect(npmGlobalInstallLines('@scope/tool')[0]).toBe(
    'rm -rf -- "$DEVBOX_PROJECT_ROOT/npm/lib/node_modules/@scope"/.tool-????????'
  )
})

test('refuses a name that would change the shell command', () => {
  for (const name of ['', '../x', 'a b', 'x"; rm -rf /; "', '@scope', 'a/b/c', '*']) {
    expect(() => npmGlobalInstallLines(name)).toThrow('Unsupported npm package name')
  }
})

test('the npm-distributed deployment CLIs install through the same lines', () => {
  for (const [binary, packageName] of [
    ['wrangler', 'wrangler'],
    ['vercel', 'vercel'],
    ['netlify', 'netlify-cli'],
  ] as const) {
    const { script } = deploymentCliSetup(binary)
    for (const line of npmGlobalInstallLines(packageName)) expect(script).toContain(line)
  }
})
