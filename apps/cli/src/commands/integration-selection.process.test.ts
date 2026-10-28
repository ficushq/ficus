import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeExecutionWrappers } from '../../../core/src/services/integrations/execution-wrappers'

const squad = '11111111-1111-4111-8111-111111111111'
const otherSquad = '33333333-3333-4333-8333-333333333333'
const alternate = '22222222-2222-4222-8222-222222222222'
const override = '44444444-4444-4444-8444-444444444444'
const cli = new URL('../index.ts', import.meta.url).pathname
const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`
type Request = { squadId: string; provider: string; connectionId?: string }

/** Actual CLI + wrapper processes, with synthetic loopback authorization and no operator store. */
async function execute(
  command: (paths: { otherWrapper: string }) => string[],
  options: { defaultState?: 'healthy' | 'absent' | 'unhealthy'; revokeAfterFirst?: boolean } = {}
) {
  const root = mkdtempSync(join(tmpdir(), 'exec-selection-'))
  const requests: Request[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const match = /^\/api\/squads\/([^/]+)\/integrations\/([^/]+)\/execute-environment$/.exec(
        new URL(req.url).pathname
      )
      if (!match) return new Response('Unexpected test endpoint', { status: 404 })
      const body = (await req.json()) as { connectionId?: string }
      const request = { squadId: match[1]!, provider: match[2]!, ...body }
      requests.push(request)
      if (
        (!body.connectionId && options.defaultState && options.defaultState !== 'healthy') ||
        (body.connectionId === alternate && options.revokeAfterFirst && requests.length > 1)
      )
        return Response.json({ error: 'Selected connection unavailable' }, { status: 409 })
      const account =
        body.connectionId === alternate ? 'alternate' : body.connectionId === override ? 'override' : 'default'
      return Response.json({
        environment:
          request.provider === 'github'
            ? { GITHUB_USER: account, GH_TOKEN: 'synthetic-github-command' }
            : { LINEAR_API_KEY: 'synthetic-linear-command' },
        scrubVariables: ['GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_USER', 'LINEAR_API_KEY'],
      })
    },
  })
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    const bin = join(root, 'bin'),
      wrappers = join(root, 'wrappers'),
      otherWrappers = join(root, 'other-wrappers')
    mkdirSync(bin)
    writeFileSync(join(bin, 'ficus'), `#!/bin/sh\nexec ${quote(process.execPath)} --no-install ${quote(cli)} "$@"\n`, {
      mode: 0o755,
    })
    // Check selected environment and all-provider scrubbing without printing credential values.
    writeFileSync(
      join(bin, 'gh'),
      '#!/bin/sh\n[ -z "${LINEAR_API_KEY:-}" ] || exit 91\nprintf "account=%s\\n" "$GITHUB_USER"\n',
      { mode: 0o755 }
    )
    writeFileSync(
      join(bin, 'linear-cli'),
      '#!/bin/sh\n[ -z "${GH_TOKEN:-}${GITHUB_USER:-}" ] || exit 92\n[ -n "${LINEAR_API_KEY:-}" ] || exit 93\nprintf "linear-default\\n"\n',
      { mode: 0o755 }
    )
    writeExecutionWrappers(
      wrappers,
      [
        { binary: 'gh', providerKey: 'github' },
        { binary: 'linear-cli', providerKey: 'linear' },
      ],
      squad
    )
    writeExecutionWrappers(otherWrappers, [{ binary: 'gh', providerKey: 'github' }], otherSquad)
    child = Bun.spawn(
      [
        process.execPath,
        '--no-install',
        cli,
        'integration',
        'exec',
        'github',
        '--squad',
        squad,
        '--connection',
        alternate,
        '--',
        ...command({ otherWrapper: join(otherWrappers, 'gh') }),
      ],
      {
        cwd: root,
        env: {
          HOME: root,
          PATH: `${wrappers}:${bin}:/usr/bin:/bin`,
          FICUS_AGENT_CONTEXT: '1',
          FICUS_TOKEN: 'synthetic-agent',
          FICUS_API_URL: `http://127.0.0.1:${server.port}`,
          FICUS_AUTH_STORE: join(root, 'unused-auth.json'),
          LINEAR_API_KEY: 'synthetic-inherited-other-provider',
        },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 8000,
      }
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { stdout, stderr, code, requests }
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGKILL')
      await child.exited
    }
    await server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
}

for (const defaultState of ['healthy', 'absent', 'unhealthy'] as const) {
  for (const nested of [false, true]) {
    test(`explicit alternate survives ${nested ? 'nested' : 'direct'} PATH wrapper with ${defaultState} default`, async () => {
      const result = await execute(() => (nested ? ['/bin/sh', '-c', 'gh pr list'] : ['gh', 'pr', 'list']), {
        defaultState,
      })
      expect(result.stderr).toBe('')
      expect(result.code).toBe(0)
      expect(result.stdout).toBe('account=alternate\n')
      expect(result.requests).toEqual(
        Array.from({ length: 2 }, () => ({ squadId: squad, provider: 'github', connectionId: alternate }))
      )
    })
  }
}

test('an explicit inner selection overrides outer selection and survives its wrapper', async () => {
  const result = await execute(() => [
    'ficus',
    'integration',
    'exec',
    'github',
    '--squad',
    squad,
    '--connection',
    override,
    '--',
    'gh',
  ])
  expect(result.code).toBe(0)
  expect(result.stdout).toBe('account=override\n')
  expect(result.requests.map((r) => r.connectionId)).toEqual([alternate, override, override])
})

test('selection never crosses a squad boundary', async () => {
  const result = await execute(({ otherWrapper }) => [
    'ficus',
    'integration',
    'exec',
    'github',
    '--squad',
    otherSquad,
    '--',
    otherWrapper,
  ])
  expect(result.code).toBe(0)
  expect(result.stdout).toBe('account=default\n')
  expect(result.requests).toEqual([
    { squadId: squad, provider: 'github', connectionId: alternate },
    { squadId: otherSquad, provider: 'github' },
    { squadId: otherSquad, provider: 'github' },
  ])
})

test('selection never crosses a provider boundary and credentials are scrubbed again', async () => {
  const result = await execute(() => ['ficus', 'integration', 'exec', 'linear', '--squad', squad, '--', 'linear-cli'])
  expect(result.code).toBe(0)
  expect(result.stdout).toBe('linear-default\n')
  expect(result.requests).toEqual([
    { squadId: squad, provider: 'github', connectionId: alternate },
    { squadId: squad, provider: 'linear' },
    { squadId: squad, provider: 'linear' },
  ])
})

test('revocation between outer exec and nested wrapper refuses instead of falling back to default', async () => {
  const result = await execute(() => ['/bin/sh', '-c', 'gh'], { revokeAfterFirst: true })
  expect(result.code).not.toBe(0)
  expect(result.stdout).toBe('')
  expect(result.requests.map((r) => r.connectionId)).toEqual([alternate, alternate])
})
