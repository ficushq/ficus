import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const squad = '11111111-2222-4333-8444-555555555555'
const other = '66666666-7777-4888-8999-aaaaaaaaaaaa'
const cli = new URL('../index.ts', import.meta.url).pathname

async function execute(options: { context?: string; explicit?: string; forbidden?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), 'integration-squad-context-'))
  const requests: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      requests.push(path)
      expect(req.headers.get('authorization')).toBe('Bearer synthetic-agent')
      expect(await req.json()).toEqual({})
      if (options.forbidden || path !== `/api/squads/${squad}/integrations/vercel/execute-environment`)
        return Response.json({ error: 'Forbidden' }, { status: 403 })
      return Response.json({
        environment: { VERCEL_TOKEN: 'synthetic-command-token' },
        scrubVariables: ['VERCEL_TOKEN'],
        selection: null,
      })
    },
  })
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    const bin = join(root, 'bin')
    mkdirSync(bin)
    writeFileSync(
      join(bin, 'npm'),
      '#!/bin/sh\n[ "$VERCEL_TOKEN" = synthetic-command-token ] || exit 73\n[ "$*" = "run deploy" ] || exit 74\ntouch command-ran\nprintf "deployed-fixture\\n"\n',
      { mode: 0o755 }
    )
    child = Bun.spawn(
      [
        process.execPath,
        '--no-install',
        cli,
        'integration',
        'exec',
        'vercel',
        ...(options.explicit ? ['--squad', options.explicit] : []),
        '--',
        'npm',
        'run',
        'deploy',
      ],
      {
        cwd: root,
        env: {
          HOME: root,
          PATH: `${bin}:/usr/bin:/bin`,
          FICUS_AGENT_CONTEXT: '1',
          FICUS_TOKEN: 'synthetic-agent',
          FICUS_API_URL: `http://127.0.0.1:${server.port}`,
          FICUS_AUTH_STORE: join(root, 'unused-auth.json'),
          ...(options.context ? { FICUS_SQUAD_ID: options.context } : {}),
        },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 5000,
      }
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { stdout, stderr, code, requests, ran: existsSync(join(root, 'command-ran')) }
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGKILL')
      await child.exited
    }
    await server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
}

test('documented deploy script uses the current squad context with per-command credentials', async () => {
  expect(await execute({ context: squad })).toMatchObject({
    code: 0,
    ran: true,
    stdout: 'deployed-fixture\n',
    requests: [`/api/squads/${squad}/integrations/vercel/execute-environment`],
  })
})
test('explicit --squad overrides the inherited selector', async () => {
  expect(await execute({ context: other, explicit: squad })).toMatchObject({
    code: 0,
    ran: true,
    requests: [`/api/squads/${squad}/integrations/vercel/execute-environment`],
  })
})
test('without either squad selector exec refuses before API or command execution', async () => {
  const result = await execute({})
  expect(result.code).not.toBe(0)
  expect(result).toMatchObject({ ran: false, requests: [] })
})
test('inherited squad selector grants no authority: Core denial never executes a script', async () => {
  const result = await execute({ context: squad, forbidden: true })
  expect(result.code).not.toBe(0)
  expect(result).toMatchObject({
    ran: false,
    requests: [`/api/squads/${squad}/integrations/vercel/execute-environment`],
  })
})
