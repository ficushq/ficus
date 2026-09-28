import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { Command } from 'commander'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { output, outputError } from '../output'
import { registerInstallCommands } from './install'

// `ficus install` fetches the manifest, then pipes the published installer into
// `sh`. The fake installer served here records the auth variables it was
// handed, so the test sees exactly what the real install.sh would read.
let dir: string
let envLog: string
let server: ReturnType<typeof Bun.serve>
const saved: Record<string, string | undefined> = {}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      if (path === '/manifest.json')
        return Response.json({ version: 'fixture', commit: 'not-this-build', buildDate: '2026-09-26' })
      if (path === '/install.sh')
        return new Response(
          `#!/bin/sh\nprintf 'FICUS_INSTALL_AUTH=%s TAU_INSTALL_AUTH=%s\\n' "\${FICUS_INSTALL_AUTH-unset}" "\${TAU_INSTALL_AUTH-unset}" >"\${INSTALL_ENV_LOG}"\n`
        )
      return new Response('not found', { status: 404 })
    },
  })
})
afterAll(() => server.stop(true))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ficus-install-test-'))
  envLog = join(dir, 'env.log')
  for (const key of ['FICUS_INSTALL_AUTH', 'TAU_INSTALL_AUTH', 'INSTALL_ENV_LOG']) saved[key] = process.env[key]
  delete process.env.FICUS_INSTALL_AUTH
  delete process.env.TAU_INSTALL_AUTH
  process.env.INSTALL_ENV_LOG = envLog
  ;(output as ReturnType<typeof mock>).mockClear()
  ;(outputError as ReturnType<typeof mock>).mockClear()
})
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(dir, { recursive: true, force: true })
})

async function run(...flags: string[]) {
  const program = new Command()
  program.exitOverride()
  registerInstallCommands(program)
  const base = `http://127.0.0.1:${server.port}`
  await program.parseAsync(
    ['install', '--url', `${base}/install.sh`, '--manifest-url', `${base}/manifest.json`, ...flags],
    { from: 'user' }
  )
  expect(outputError).not.toHaveBeenCalled()
  return readFileSync(envLog, 'utf8').trim()
}

describe('ficus install', () => {
  it('--no-auth hands the installer FICUS_INSTALL_AUTH=0, and only that name', async () => {
    expect(await run('--no-auth')).toBe('FICUS_INSTALL_AUTH=0 TAU_INSTALL_AUTH=unset')
  })

  it('--auth hands the installer FICUS_INSTALL_AUTH=1', async () => {
    expect(await run('--auth')).toBe('FICUS_INSTALL_AUTH=1 TAU_INSTALL_AUTH=unset')
  })

  it('without either flag leaves the installer to decide', async () => {
    expect(await run()).toBe('FICUS_INSTALL_AUTH=unset TAU_INSTALL_AUTH=unset')
  })

  it('reports in Ficus terms', async () => {
    await run('--no-auth')
    const messages = (output as ReturnType<typeof mock>).mock.calls.map((call) => String(call[1]))
    expect(messages.join('\n')).toContain('Current Ficus CLI:')
    expect(messages.join('\n')).toContain('Ficus CLI install completed.')
    expect(messages.join('\n')).not.toContain('Tau')
  })
})
