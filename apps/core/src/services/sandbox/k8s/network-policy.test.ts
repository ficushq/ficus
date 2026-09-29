import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'

const repoRoot = join(import.meta.dir, '../../../../../..')

describe('K8s sandbox GitHub SSH egress', () => {
  test('NetworkPolicy permits all ports to the internet while excluding private and special-use ranges', () => {
    const policyPath = join(repoRoot, 'k8s/network-policy.yaml')
    const policy = yaml.load(readFileSync(policyPath, 'utf8')) as any

    const publicInternetRule = policy.spec.egress.find((rule: any) =>
      rule.to?.some((target: any) => target.ipBlock?.cidr === '0.0.0.0/0')
    )

    expect(publicInternetRule).toBeDefined()
    expect(publicInternetRule.ports).toBeUndefined()
    expect(publicInternetRule.to[0].ipBlock.except).toEqual(
      expect.arrayContaining([
        '10.0.0.0/8',
        '100.64.0.0/10',
        '127.0.0.0/8',
        '169.254.0.0/16',
        '172.16.0.0/12',
        '192.168.0.0/16',
      ])
    )
  })

  test('sandbox images configure github.com SSH remotes to use GitHub SSH over port 443', () => {
    const configPath = join(repoRoot, 'packages/k8s-sandbox/sandbox/ssh_config.d/99-github-ssh-over-443.conf')
    const config = readFileSync(configPath, 'utf8')

    expect(config).toContain('Host github.com')
    expect(config).toContain('HostName ssh.github.com')
    expect(config).toContain('Port 443')
    expect(config).toContain('User git')

    // The ssh config is COPYed in the shared `base` stage of the multi-stage
    // Dockerfile, which both the agent and squad targets inherit via FROM base.
    const k8sDockerfile = readFileSync(join(repoRoot, 'packages/k8s-sandbox/Dockerfile'), 'utf8')
    expect(k8sDockerfile).toContain('99-github-ssh-over-443.conf')

    const dockerSandboxConfig = readFileSync(
      join(repoRoot, 'apps/core/docker-sandbox/ssh_config.d/99-github-ssh-over-443.conf'),
      'utf8'
    )
    expect(dockerSandboxConfig).toBe(config)

    const dockerSandboxDockerfile = readFileSync(join(repoRoot, 'apps/core/docker-sandbox/Dockerfile'), 'utf8')
    expect(dockerSandboxDockerfile).toContain('99-github-ssh-over-443.conf')
  })

  test('sandbox image does not bundle ficus cli', () => {
    const dockerfile = readFileSync(join(repoRoot, 'packages/k8s-sandbox/Dockerfile'), 'utf8')

    expect(dockerfile).not.toContain('/opt/tau-cli')
    expect(dockerfile).not.toContain('apps/cli/src')
    expect(dockerfile).not.toContain('bun run build')
  })

  test('Docker sandbox COPY sources exist within its build context', () => {
    const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
    const buildScript = packageJson.scripts['sandbox:build:docker'] as string
    const buildMatch = buildScript.match(/-f\s+(\S+)\s+(\S+)$/)
    expect(buildMatch).not.toBeNull()
    expect(buildMatch![1]).toBe('apps/core/docker-sandbox/Dockerfile')
    expect(buildMatch![2]).toBe('.')

    const buildContext = repoRoot
    const dockerfile = readFileSync(join(repoRoot, buildMatch![1]), 'utf8')
    const copySources = [...dockerfile.matchAll(/^COPY\s+([^\s]+)\s+/gm)].map((match) => match[1])
    const ignorePatterns = readFileSync(join(repoRoot, '.dockerignore'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))

    expect(copySources).toContain('apps/core/docker-sandbox/ssh_config.d/99-github-ssh-over-443.conf')
    for (const source of copySources) {
      expect(existsSync(join(buildContext, source))).toBe(true)
      expect(ignorePatterns.some((pattern) => new Bun.Glob(pattern).match(source))).toBe(false)
    }
  })
})
