import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..')
const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}
const dockerfile = readFileSync(resolve(repoRoot, 'apps/core/docker-sandbox/Dockerfile'), 'utf8')

describe('Docker sandbox image source contract', () => {
  test('builds from repository root with pinned Bun and a baked executor', () => {
    expect(packageJson.scripts['sandbox:build:docker']).toEndWith('-f apps/core/docker-sandbox/Dockerfile .')
    expect(readFileSync(resolve(repoRoot, '.bun-version'), 'utf8').trim()).toBe('1.4.2')
    expect(dockerfile).toContain('ARG BUN_VERSION=1.4.2')
    expect(dockerfile).toContain('packages/k8s-sandbox/src')
    expect(dockerfile).toContain('apps/core/docker-sandbox/command-identity.json')
  })

  // packages/k8s-sandbox depends on @ficus/shared as `workspace:*`; a bare copy of
  // its package.json + src cannot `bun install` outside the monorepo. Both
  // executor images must vendor the member and declare the workspace first —
  // the docker-socket setup path broke silently when the dependency arrived.
  test('both executor images vendor @ficus/shared as a workspace member before installing', () => {
    const k8sDockerfile = readFileSync(resolve(repoRoot, 'packages/k8s-sandbox/Dockerfile'), 'utf8')
    const executorDeps = JSON.parse(readFileSync(resolve(repoRoot, 'packages/k8s-sandbox/package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    expect(executorDeps.dependencies['@ficus/shared']).toBe('workspace:*')
    for (const [name, text] of [
      ['apps/core/docker-sandbox/Dockerfile', dockerfile],
      ['packages/k8s-sandbox/Dockerfile', k8sDockerfile],
    ] as const) {
      // The executor's own install, not the browser service's `bun install --cwd`.
      const install = text.indexOf('bun install --production')
      expect({ name, installs: install > -1 }).toEqual({ name, installs: true })
      for (const line of [
        'COPY packages/shared/package.json /opt/sandbox/packages/shared/package.json',
        'COPY packages/shared/src /opt/sandbox/packages/shared/src',
        'p.workspaces=["packages/shared"]',
      ]) {
        const at = text.indexOf(line)
        expect({ name, line, beforeInstall: at > -1 && at < install }).toEqual({ name, line, beforeInstall: true })
      }
      expect(text).toContain("require('@ficus/shared/advisory-lock')")
    }
  })

  test('declares the negotiated runtime and installs identity/proxy tools', () => {
    for (const label of [
      'io.hiretau.sandbox.managed="true"',
      'io.hiretau.sandbox.runtime-contract="1"',
      'io.hiretau.sandbox.executor-protocol="1"',
      'io.hiretau.sandbox.command-contract="1"',
    ])
      expect(dockerfile).toContain(label)
    expect(dockerfile).toMatch(/\bsocat\b/)
    expect(dockerfile).toMatch(/\bsu-exec\b/)
    expect(dockerfile).not.toContain('NOPASSWD')
  })
})
