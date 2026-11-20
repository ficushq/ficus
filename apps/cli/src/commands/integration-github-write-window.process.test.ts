import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const squad = '11111111-2222-4333-8444-555555555555'
const windowId = '99999999-8888-4777-8666-555555555555'
const cli = new URL('../index.ts', import.meta.url).pathname

/** Runs `ficus integration exec github -- gh ...` against a fake Core and records what it asked for. */
async function execute(args: string[], options: { exit?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'integration-github-window-'))
  const requests: { path: string; body: unknown }[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      const body = await req.json()
      requests.push({ path, body })
      if (path === `/api/squads/${squad}/integrations/github/execute-environment`)
        return Response.json({
          environment: { GH_TOKEN: 'synthetic-command-token', GITHUB_USER: 'owner' },
          scrubVariables: ['GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_USER'],
          selection: null,
          ...((body as { feedbackWrite?: boolean }).feedbackWrite === false ? {} : { writeWindowId: windowId }),
        })
      if (path === `/api/squads/${squad}/integrations/github/write-windows/${windowId}/close`)
        return Response.json({ closed: true })
      return Response.json({ error: 'Not found' }, { status: 404 })
    },
  })
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    const bin = join(root, 'bin')
    mkdirSync(bin)
    writeFileSync(
      join(bin, 'gh'),
      `#!/bin/sh\n[ "$GH_TOKEN" = synthetic-command-token ] || exit 73\nexit ${options.exit ?? 0}\n`,
      { mode: 0o755 }
    )
    child = Bun.spawn(
      [process.execPath, '--no-install', cli, 'integration', 'exec', 'github', '--squad', squad, '--', 'gh', ...args],
      {
        cwd: root,
        env: {
          HOME: root,
          PATH: `${bin}:/usr/bin:/bin`,
          FICUS_AGENT_CONTEXT: '1',
          FICUS_TOKEN: 'synthetic-agent',
          FICUS_API_URL: `http://127.0.0.1:${server.port}`,
          FICUS_AUTH_STORE: join(root, 'unused-auth.json'),
        },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 10_000,
      }
    )
    const code = await child.exited
    return { code, requests }
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGKILL')
      await child.exited
    }
    await server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
}

test('a gh command that can post a review declares it and closes its write window when it exits', async () => {
  const { code, requests } = await execute(['pr', 'review', '12', '--approve'])
  expect(code).toBe(0)
  expect(requests).toEqual([
    { path: `/api/squads/${squad}/integrations/github/execute-environment`, body: { feedbackWrite: true } },
    { path: `/api/squads/${squad}/integrations/github/write-windows/${windowId}/close`, body: {} },
  ])
})

test('the window is closed even when the command fails', async () => {
  const { code, requests } = await execute(['api', '-X', 'POST', 'repos/acme/app/pulls/1/reviews'], { exit: 3 })
  expect(code).toBe(3)
  expect(requests.map((request) => request.path)).toEqual([
    `/api/squads/${squad}/integrations/github/execute-environment`,
    `/api/squads/${squad}/integrations/github/write-windows/${windowId}/close`,
  ])
})

test('a read-only gh command opens no window', async () => {
  const { code, requests } = await execute(['pr', 'view', '12'])
  expect(code).toBe(0)
  expect(requests).toEqual([
    { path: `/api/squads/${squad}/integrations/github/execute-environment`, body: { feedbackWrite: false } },
  ])
})
