import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir, userInfo } from 'os'
import { join } from 'path'
import { like } from 'drizzle-orm'
import { db, sshTrustKeys, sshTrustTargets } from '../../db'
import { createSshRunner } from '../machines/ssh'
import type { Machine } from '../machines/queries'
import { buildGitSshCommand } from '../memory/sync/GitAdapter'
import { composeManagedConfig, renderManagedBlock } from '../remote-hosts/materialize'
import type { RemoteHost } from '../remote-hosts/queries'
import { getSecretStore, resetSecretStore } from '../secrets'
import { ensureTrustTarget, HostKeyNotTrustedError, listTrustKeys, machineTrustSpec, trustTrustKey } from './index'

/**
 * End to end against a local, synthetic sshd (127.0.0.1, throwaway host and
 * client keys; nothing else is contacted): machine connections and memory git
 * check the host key strictly against person-confirmed keys, adopt the key
 * Core already trusted, and a hostile squad `Host *` stanza cannot disable
 * pinning for a managed remote host over ssh or git.
 */

const SSHD = ['/usr/sbin/sshd', '/usr/local/sbin/sshd'].find((p) => existsSync(p))
const available = !!SSHD && !!Bun.which('ssh') && !!Bun.which('ssh-keygen') && !!Bun.which('git')

const HOSTILE_USER_CONFIG = [
  'Host *',
  '  StrictHostKeyChecking no',
  '  UserKnownHostsFile /dev/null',
  '  GlobalKnownHostsFile /dev/null',
  '',
].join('\n')

function sh(argv: string[], env: Record<string, string> = {}): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync(argv, { env: { ...process.env, ...env }, stdin: 'ignore' })
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() }
}

function publicKeyFields(path: string): { keyType: string; publicKey: string } {
  const [keyType, publicKey] = readFileSync(path, 'utf8').trim().split(/\s+/)
  return { keyType, publicKey }
}

describe.skipIf(!available)('host-key pinning against a local sshd', () => {
  const run = `sshd-pin-${Date.now()}`
  const user = userInfo().username
  let dir: string
  let port: number
  let sshd: ReturnType<typeof Bun.spawn> | undefined
  let served: { keyType: string; publicKey: string }
  let impostor: { keyType: string; publicKey: string }
  let priorHome: string | undefined
  let priorKey: string | undefined
  const secretKey = `machine-ssh:${run}`

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ficus-sshd-pin-'))
    for (const name of ['host', 'impostor', 'client']) {
      expect(sh(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', join(dir, name)]).code).toBe(0)
    }
    served = publicKeyFields(join(dir, 'host.pub'))
    impostor = publicKeyFields(join(dir, 'impostor.pub'))
    writeFileSync(join(dir, 'authorized_keys'), readFileSync(join(dir, 'client.pub')))
    expect(sh(['git', 'init', '-q', '--bare', join(dir, 'repo.git')]).code).toBe(0)

    for (let attempt = 0; attempt < 5 && !sshd; attempt++) {
      port = 20000 + Math.floor(Math.random() * 30000)
      writeFileSync(
        join(dir, 'sshd_config'),
        [
          `Port ${port}`,
          'ListenAddress 127.0.0.1',
          `HostKey ${join(dir, 'host')}`,
          `AuthorizedKeysFile ${join(dir, 'authorized_keys')}`,
          `PidFile ${join(dir, 'sshd.pid')}`,
          'StrictModes no',
          'UsePAM no',
          'PasswordAuthentication no',
          'KbdInteractiveAuthentication no',
          '',
        ].join('\n')
      )
      const proc = Bun.spawn([SSHD!, '-D', '-e', '-f', join(dir, 'sshd_config')], {
        stdout: 'ignore',
        stderr: 'ignore',
      })
      for (let i = 0; i < 50; i++) {
        if (sh(['ssh-keyscan', '-T', '1', '-p', String(port), '127.0.0.1']).out.includes(served.publicKey)) break
        await Bun.sleep(100)
      }
      if (sh(['ssh-keyscan', '-T', '1', '-p', String(port), '127.0.0.1']).out.includes(served.publicKey)) sshd = proc
      else proc.kill()
    }
    if (!sshd) throw new Error('local sshd did not start')

    priorHome = process.env.HOME_DIR
    process.env.HOME_DIR = join(dir, 'home')
    mkdirSync(process.env.HOME_DIR)
    priorKey = process.env.FICUS_ENCRYPTION_KEY
    process.env.FICUS_ENCRYPTION_KEY = priorKey ?? '0'.repeat(64)
    resetSecretStore()
    await getSecretStore().initialize()
    await getSecretStore().set(secretKey, readFileSync(join(dir, 'client'), 'utf8'), 'system')
  })

  afterAll(async () => {
    sshd?.kill()
    await sshd?.exited
    await getSecretStore().delete(secretKey)
    await db.delete(sshTrustTargets).where(like(sshTrustTargets.scope, `machine:${run}%`))
    if (priorKey === undefined) delete process.env.FICUS_ENCRYPTION_KEY
    else process.env.FICUS_ENCRYPTION_KEY = priorKey
    if (priorHome === undefined) delete process.env.HOME_DIR
    else process.env.HOME_DIR = priorHome
    resetSecretStore()
    rmSync(dir, { recursive: true, force: true })
  })

  function machine(name: string): Machine {
    return {
      id: `${run}-${name}`,
      name,
      provider: 'ssh',
      sshHost: '127.0.0.1',
      sshPort: port,
      sshUser: user,
      sshKeyId: secretKey,
    } as Machine
  }

  describe('machines', () => {
    const runner = () => createSshRunner({ defaultTimeoutMs: 20_000 })

    it('an unknown machine is refused and its key held pending; after a person trusts it, ssh connects', async () => {
      const m = machine('fresh')
      await expect(runner().run(m, 'echo ok')).rejects.toBeInstanceOf(HostKeyNotTrustedError)
      const target = await ensureTrustTarget(machineTrustSpec(m))
      const keys = await listTrustKeys(target.id)
      expect(keys.map((k) => [k.status, k.publicKey])).toEqual([['pending', served.publicKey]])

      await trustTrustKey(target.id, keys[0].id, `${run}-person`)
      const result = await runner().run(m, 'echo ok')
      expect(result).toMatchObject({ exitCode: 0, stdout: 'ok\n' })
    }, 60_000)

    it('a machine Core reached under accept-new adopts the key it already recorded, with no prompt', async () => {
      const m = machine('existing')
      await db.insert(sshTrustTargets).values({ ...machineTrustSpec(m), adoptionPending: true })
      mkdirSync(join(process.env.HOME_DIR!, 'machines'), { recursive: true })
      writeFileSync(
        join(process.env.HOME_DIR!, 'machines', 'known_hosts'),
        `[127.0.0.1]:${port} ${served.keyType} ${served.publicKey}\n`
      )

      expect(await runner().run(m, 'echo ok')).toMatchObject({ exitCode: 0, stdout: 'ok\n' })
      const [key] = await listTrustKeys((await ensureTrustTarget(machineTrustSpec(m))).id)
      expect(key).toMatchObject({ status: 'trusted', origin: 'adopted', decidedByUserId: null })
    }, 60_000)

    it('a host presenting a key other than the trusted one is refused by ssh itself', async () => {
      const m = machine('impostor')
      const target = await ensureTrustTarget(machineTrustSpec(m))
      // The person trusted a different key than the one this sshd serves (a MITM from their point of view).
      await db.insert(sshTrustKeys).values({
        targetId: target.id,
        ...impostor,
        fingerprint: 'SHA256:x',
        status: 'trusted',
        origin: 'scan',
        decidedByUserId: `${run}-person`,
      })

      const result = await runner().run(m, 'echo ok')
      expect(result.exitCode).toBe(255)
      expect(result.stderr).toContain('Host key verification failed')
    }, 60_000)
  })

  describe('squad ssh_config with a hostile Host * stanza', () => {
    let sshDir: string
    const remote = () =>
      ({ id: 'r1', name: 'prod', sshHost: '127.0.0.1', sshPort: port, sshUser: user }) as unknown as RemoteHost

    function writeSquadSsh(
      pinnedKey: { keyType: string; publicKey: string },
      order: 'managed-first' | 'user-first',
      userConfig = HOSTILE_USER_CONFIG
    ) {
      sshDir = join(dir, `squad-${order}-${pinnedKey === served ? 'right' : 'wrong'}-${userConfig.length}`)
      mkdirSync(sshDir, { recursive: true })
      writeFileSync(join(sshDir, 'ficus_remote_prod'), readFileSync(join(dir, 'client')), { mode: 0o600 })
      writeFileSync(join(sshDir, 'known_hosts'), `ficus-remote.prod ${pinnedKey.keyType} ${pinnedKey.publicKey}\n`)
      const block = renderManagedBlock([{ host: remote(), mode: 'pinned' }], { absoluteSshDir: sshDir })
      const config = order === 'managed-first' ? composeManagedConfig(userConfig, block) : `${userConfig}${block}\n` // the layout before managed settings moved first
      writeFileSync(join(sshDir, 'config'), config)
      return join(sshDir, 'config')
    }

    const sshProd = (config: string) =>
      sh(['ssh', '-F', config, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'prod', 'echo ok'])
    const gitProd = (config: string) =>
      sh(['git', 'ls-remote', `prod:${join(dir, 'repo.git')}`], {
        GIT_SSH_COMMAND: `ssh -F '${config}' -o BatchMode=yes -o ConnectTimeout=10`,
        GIT_TERMINAL_PROMPT: '0',
      })

    it('the old layout let the hostile stanza accept any key (the gap this closes)', () => {
      const config = writeSquadSsh(impostor, 'user-first')
      expect(sshProd(config).code).toBe(0)
    })

    it('ssh: the managed host still checks strictly against the pinned key', () => {
      const wrong = sshProd(writeSquadSsh(impostor, 'managed-first'))
      expect(wrong.code).toBe(255)
      expect(wrong.err).toContain('Host key verification failed')
      expect(sshProd(writeSquadSsh(served, 'managed-first'))).toMatchObject({ code: 0, out: 'ok\n' })
    }, 60_000)

    it('git: the managed host still checks strictly against the pinned key', () => {
      const wrong = gitProd(writeSquadSsh(impostor, 'managed-first'))
      expect(wrong.code).not.toBe(0)
      expect(wrong.err).toContain('Host key verification failed')
      expect(gitProd(writeSquadSsh(served, 'managed-first')).code).toBe(0)
    }, 60_000)

    it("a squad's own IgnoreUnknown (macOS UseKeychain snippet) keeps working for managed hosts", () => {
      const keychain = `IgnoreUnknown UseKeychain\nUseKeychain yes\n${HOSTILE_USER_CONFIG}`
      expect(sshProd(writeSquadSsh(served, 'managed-first', keychain))).toMatchObject({ code: 0, out: 'ok\n' })
      const wrong = sshProd(writeSquadSsh(impostor, 'managed-first', keychain))
      expect(wrong.code).toBe(255)
      expect(wrong.err).toContain('Host key verification failed')
      // Hosts Ficus does not manage still parse with the squad's own IgnoreUnknown.
      expect(sh(['ssh', '-G', '-F', join(sshDir, 'config'), 'unmanaged.example']).code).toBe(0)
    }, 60_000)

    it('the hostile settings still apply to hosts Ficus does not manage', () => {
      const config = writeSquadSsh(served, 'managed-first')
      const effective = sh(['ssh', '-G', '-F', config, 'unmanaged.example']).out
      expect(effective).toContain('stricthostkeychecking false')
      expect(effective).toContain('userknownhostsfile /dev/null')
      const managed = sh(['ssh', '-G', '-F', config, 'prod']).out
      expect(managed).toContain('stricthostkeychecking true')
      expect(managed).toContain(`userknownhostsfile ${join(sshDir, 'known_hosts')}`)
      expect(managed).toContain('hostkeyalias ficus-remote.prod')
    })
  })

  describe('memory git', () => {
    function pinFile(key: { keyType: string; publicKey: string }): { knownHostsPath: string; alias: string } {
      const knownHostsPath = join(dir, `memory-pin-${key === served ? 'right' : 'wrong'}`)
      writeFileSync(knownHostsPath, `ficus-trust.memory ${key.keyType} ${key.publicKey}\n`, { mode: 0o600 })
      return { knownHostsPath, alias: 'ficus-trust.memory' }
    }

    function gitLsRemote(command: string) {
      return sh(['git', 'ls-remote', `ssh://${user}@127.0.0.1:${port}${join(dir, 'repo.git')}`], {
        GIT_SSH_COMMAND: command,
        GIT_TERMINAL_PROMPT: '0',
      })
    }

    it('connects only with the pinned key, even under a hostile ssh_config', () => {
      const hostile = join(dir, 'hostile_config')
      writeFileSync(hostile, HOSTILE_USER_CONFIG)
      // Command-line options beat every config file; prove it with the hostile file in force.
      const underHostile = (cmd: string) => cmd.replace(/^'ssh'/, `'ssh' -F '${hostile}' -o BatchMode=yes`)

      const wrong = gitLsRemote(underHostile(buildGitSshCommand(join(dir, 'client'), pinFile(impostor))))
      expect(wrong.code).not.toBe(0)
      expect(wrong.err).toContain('Host key verification failed')
      expect(gitLsRemote(underHostile(buildGitSshCommand(join(dir, 'client'), pinFile(served)))).code).toBe(0)
    }, 60_000)
  })
})
