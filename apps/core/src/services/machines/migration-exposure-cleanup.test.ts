import { expect, test } from 'bun:test'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  chmodSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { buildMigrationScanCommand, parseMigrationScanRecords } from './migration-scanner'
import { createMigrationManifest, compareMigrationManifests } from './migration-manifest'
import { boxHomeForUser, boxUnixUser } from './box-paths'
import type { SshRunner } from './ssh'
import type { Machine } from './queries'

function fixture(namespace: 'squad' | 'agent' = 'squad') {
  const root = mkdtempSync(join(tmpdir(), 'migration-retirement-'))
  const source = join(root, 'source'),
    staging = join(root, 'staging'),
    final = join(root, 'final')
  const sandboxId = `${namespace}_${crypto.randomUUID()}`,
    user = boxUnixUser(sandboxId),
    home = boxHomeForUser(user)
  const identity = {
    operationId: crypto.randomUUID(),
    sandboxId,
    source: { machineId: 'source', generation: null, unixUser: user },
    target: { machineId: 'target', generation: null, unixUser: user },
  }
  for (const dir of [source, staging, final]) mkdirSync(dir)
  mkdirSync(join(source, 'workspace/.ficus'), { recursive: true })
  mkdirSync(join(source, '.private/.ficus'), { recursive: true })
  chmodSync(join(source, '.private'), 0o700)
  const run = (command: string, stdin?: string | Uint8Array) => {
    const result = Bun.spawnSync(['bash', '-c', command], {
      stdin: stdin ? Buffer.from(stdin) : undefined,
      timeout: 10_000,
    })
    return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
  }
  const localize = (command: string, dir: string) =>
    command
      .replace(/^sudo /, '')
      .replaceAll(home, dir)
      .replaceAll(user, userInfo().username)
  const runner: SshRunner = {
    async run(_machine, command, opts) {
      expect(command).toContain(home)
      expect(opts?.timeoutMs).toBe(30_000)
      return run(localize(command, source), opts?.stdin)
    },
  }
  const scan = (dir: string) => {
    const result = run(localize(buildMigrationScanCommand(home, user), dir))
    expect(result.exitCode).toBe(0)
    return createMigrationManifest(identity, parseMigrationScanRecords(result.stdout))
  }
  const restore = () => {
    const line = readFileSync(join(import.meta.dir, '../../../../..', 'scripts/machine/box-provision.sh'), 'utf8')
      .split('\n')
      .find((l) => l.includes('tar -x "$(tar_codec_flag)"'))!
    const archive = join(root, 'state.tar.gz')
    expect(run(`tar czf '${archive}' -C '${source}' workspace .private`).exitCode).toBe(0)
    expect(
      run(`SUDO=(); staging='${staging}'; tar_codec_flag() { printf '%s' '-z'; }; ${line} < '${archive}'`).exitCode
    ).toBe(0)
  }
  return { root, source, staging, final, sandboxId, runner, scan, restore, run, machine: {} as Machine }
}

const cleanEnv =
  '# Generated protected integration bindings. Do not edit values here.\nCUSTOM=keep\nunset GH_TOKEN GITHUB_TOKEN\n'

test('production streamed restore preserves a clean generated env under exact migration verification', () => {
  const f = fixture()
  try {
    writeFileSync(join(f.source, 'workspace/.ficus/.env'), cleanEnv)
    writeFileSync(join(f.source, 'workspace/.ficus/env.user'), 'CUSTOM=keep\n')
    const source = f.scan(f.source)
    f.restore()
    expect(compareMigrationManifests(source, f.scan(f.staging))).toEqual({ ok: true })
    expect(readFileSync(join(f.staging, 'workspace/.ficus/.env'), 'utf8')).toBe(cleanEnv)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('sanitation precedes the immutable snapshot; stale plaintext never enters staging and custom loss still fails', async () => {
  const { prepareMigrationSource } = await import('./migration-exposure-cleanup')
  const f = fixture()
  try {
    writeFileSync(join(f.source, 'workspace/.ficus/.env'), 'OLD_TOKEN=synthetic-retired')
    writeFileSync(join(f.source, '.private/.ficus/agent-secrets.env'), 'OLD_TOKEN=synthetic-retired')
    writeFileSync(join(f.source, 'workspace/.ficus/env.user'), 'CUSTOM=keep\n')
    writeFileSync(join(f.source, '.private/custom'), 'user-owned content')
    chmodSync(join(f.source, '.private/custom'), 0o640)
    const deps = {
      generatedEnv: async (id: string) => {
        expect(id).toBe(f.sandboxId.slice(6))
        return Buffer.from(cleanEnv)
      },
    }
    await prepareMigrationSource(f.runner, f.machine, f.sandboxId, deps)
    await prepareMigrationSource(f.runner, f.machine, f.sandboxId, deps)
    const source = f.scan(f.source)
    f.restore()
    expect(compareMigrationManifests(source, f.scan(f.staging))).toEqual({ ok: true })
    expect(existsSync(join(f.staging, '.private/.ficus/agent-secrets.env'))).toBe(false)
    expect(readFileSync(join(f.staging, 'workspace/.ficus/.env'), 'utf8')).toBe(cleanEnv)
    expect(readFileSync(join(f.staging, 'workspace/.ficus/env.user'), 'utf8')).toBe('CUSTOM=keep\n')
    for (const dir of ['workspace', '.private'])
      expect(f.run(`mv '${f.staging}/${dir}' '${f.final}/${dir}'`).exitCode).toBe(0)
    expect(compareMigrationManifests(source, f.scan(f.final))).toEqual({ ok: true })
    chmodSync(join(f.final, '.private/custom'), 0o600)
    expect(compareMigrationManifests(source, f.scan(f.final))).toMatchObject({
      ok: false,
      type: 'target-metadata-mismatch',
    })
    chmodSync(join(f.final, '.private/custom'), 0o640)
    writeFileSync(join(f.final, '.private/custom'), 'USER-owned content')
    expect(compareMigrationManifests(source, f.scan(f.final))).toMatchObject({
      ok: false,
      type: 'target-content-mismatch',
    })
    rmSync(join(f.final, '.private/custom'))
    expect(compareMigrationManifests(source, f.scan(f.final))).toMatchObject({
      ok: false,
      type: 'target-entry-missing',
    })
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('source settings conflicts abort sanitation without following links or changing custom files', async () => {
  const { prepareMigrationSource } = await import('./migration-exposure-cleanup')
  const f = fixture()
  try {
    const external = join(f.root, 'external')
    mkdirSync(external)
    writeFileSync(join(external, '.env'), 'CUSTOM=untouched')
    rmSync(join(f.source, 'workspace/.ficus'), { recursive: true })
    symlinkSync(external, join(f.source, 'workspace/.ficus'))
    await expect(
      prepareMigrationSource(f.runner, f.machine, f.sandboxId, { generatedEnv: async () => Buffer.from(cleanEnv) })
    ).rejects.toThrow('sanitation failed')
    expect(readFileSync(join(external, '.env'), 'utf8')).toBe('CUSTOM=untouched')
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('agent migration removes only retired private credentials without regenerating a squad workspace', async () => {
  const { prepareMigrationSource } = await import('./migration-exposure-cleanup')
  const f = fixture('agent')
  try {
    writeFileSync(join(f.source, '.private/.ficus/agent-secrets.env'), 'OLD_TOKEN=synthetic-retired')
    writeFileSync(join(f.source, '.private/custom'), 'keep private data')
    writeFileSync(join(f.source, 'workspace/.ficus/.env'), 'CUSTOM=not-carried-by-agent-transfer')
    await prepareMigrationSource(f.runner, f.machine, f.sandboxId, {
      generatedEnv: async () => {
        throw new Error('must not resolve squad environment')
      },
    })
    expect(existsSync(join(f.source, '.private/.ficus/agent-secrets.env'))).toBe(false)
    expect(readFileSync(join(f.source, '.private/custom'), 'utf8')).toBe('keep private data')
    expect(readFileSync(join(f.source, 'workspace/.ficus/.env'), 'utf8')).toBe('CUSTOM=not-carried-by-agent-transfer')
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})
