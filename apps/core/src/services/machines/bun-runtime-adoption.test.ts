import { describe, expect, test } from 'bun:test'
import * as adoption from './bun-runtime-adoption'
import type { Machine, MachineBox } from './queries'
import type { SshRunner } from './ssh'

describe('release Bun runtime identity', () => {
  test('uses the effective standalone script pin, not a checkout-relative runtime read', () => {
    expect(typeof adoption.bunVersionFromBootstrap).toBe('function')
    expect(adoption.bunVersionFromBootstrap('#!/bin/bash\nBUN_VERSION="1.4.2"\n')).toBe('1.4.2')
    expect(() => adoption.bunVersionFromBootstrap('BUN_VERSION="latest"')).toThrow('Bun pin')
    expect(() => adoption.bunVersionFromBootstrap('')).toThrow('Bun pin')
  })
})

describe('non-waking runtime adoption proof', () => {
  test('requires the fixed idle proof and rejects SSH failure, unknown output and running executors', async () => {
    expect(typeof adoption.probeBoxBunAdoption).toBe('function')
    const machine = { id: 'fixture' } as any
    const box = { sandboxId: 'agent_fixture', unixUser: 'box_fixture' } as any
    for (const [exitCode, stdout, expected] of [
      [0, 'FICUS_BUN_ADOPTION=idle\n', true],
      [1, 'FICUS_BUN_ADOPTION=idle\n', false],
      [0, '', false],
      [0, 'FICUS_BUN_ADOPTION=blocked\n', false],
    ] as const) {
      const runner = { run: async () => ({ exitCode, stdout, stderr: '' }) }
      expect(await adoption.probeBoxBunAdoption(machine, box, '1.4.2', runner)).toBe(expected)
    }
  })
})

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('the actual host probe shell accepts only inactive units, current Bun and no unresolved records', () => {
  const root = mkdtempSync(join(tmpdir(), 'bun-idle-probe-'))
  try {
    const home = join(root, 'home')
    const bin = join(root, 'bin')
    mkdirSync(home)
    mkdirSync(bin)
    const executable = (name: string, script: string) =>
      writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
    executable('id', 'echo 1000')
    executable('sudo', '[ "$1" = -u ] && shift 2; case "$1" in systemctl|bash|env) exec "$@" ;; *) exit 99 ;; esac')
    executable(
      'systemctl',
      'while [ "${1#--}" != "$1" ]; do shift; done; [ "$1" = show ] && { echo 0; exit 0; }; for unit; do :; done; case "$unit" in *.socket) echo "${SOCKET_STATE:-active}" ;; *proxy.service) echo "${PROXY_STATE:-inactive}" ;; *.service) echo "${SERVER_STATE:-inactive}" ;; *) exit 98 ;; esac'
    )
    executable('bun', 'echo "${DISK_BUN:-1.4.2}"')
    const scriptFor = (sandboxId: string) =>
      adoption
        .buildBunAdoptionProbe({ sandboxId, unixUser: 'box_fixture' }, '1.4.2')
        .replaceAll('/home/box_fixture', home)
        .replaceAll('/opt/ficus/bin/bun', join(bin, 'bun'))
    const probe = (env: NodeJS.ProcessEnv = {}, sandboxId = 'agent_fixture') => {
      const result = Bun.spawnSync(['bash', '-c', scriptFor(sandboxId)], {
        env: { PATH: `${bin}:/usr/bin:/bin`, ...env },
      })
      expect(result.exitCode).toBe(0)
      return result.stdout.toString().trim()
    }
    for (const sandboxId of ['agent_fixture', 'squad_fixture']) {
      expect(probe({}, sandboxId)).toBe('FICUS_BUN_ADOPTION=idle')
      for (const env of [
        { SERVER_STATE: 'active' },
        { SERVER_STATE: 'activating' },
        { SERVER_STATE: 'failed' },
        { PROXY_STATE: 'active' },
        { SOCKET_STATE: 'inactive' },
        { DISK_BUN: '1.2.23' },
      ])
        expect(probe(env, sandboxId)).toBe('FICUS_BUN_ADOPTION=blocked')
    }
    const registry = join(home, '.ficus/runtime/bash-invocations')
    for (const directory of ['', 'active', 'quarantine']) {
      const target = join(registry, directory)
      mkdirSync(target, { recursive: true })
      const record = join(target, 'uncertain.json')
      writeFileSync(record, '{"state":"quarantined"}')
      expect(probe()).toBe('FICUS_BUN_ADOPTION=blocked')
      rmSync(record)
      expect(probe()).toBe('FICUS_BUN_ADOPTION=idle')
    }
    writeFileSync(join(registry, 'quarantine/legacy-no-extension'), 'unclassified')
    expect(probe()).toBe('FICUS_BUN_ADOPTION=blocked')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('idle runtime claim closes activation through the callback and restores it on success/failure', async () => {
  expect(typeof adoption.withIdleBunRuntimeClaim).toBe('function')
  const calls: string[] = []
  const machine = { id: 'fixture' } as any
  const box = { sandboxId: 'agent_fixture', unixUser: 'box_fixture' } as any
  const runner = {
    run: async (_machine: unknown, command: string) => {
      calls.push(command)
      return {
        exitCode: 0,
        stdout: command.includes('FICUS_BUN_RECOVERY=') ? 'FICUS_BUN_RECOVERY=none\n' : 'FICUS_BUN_ADOPTION=claimed\n',
        stderr: '',
      }
    },
  }
  const result = await adoption.withIdleBunRuntimeClaim(
    machine,
    box,
    '1.4.2',
    async () => {
      expect(calls).toHaveLength(2)
      expect(calls[0]).toContain('flock -x')
      expect(calls[1]).toContain('stop ficus-box-box_fixture.socket')
      return 'adopted'
    },
    runner
  )
  expect(result).toEqual({ adopted: true, value: 'adopted' })
  expect(calls.at(-1)).toContain('start ficus-box-box_fixture.socket')
  const failure = new Error('provision failed')
  await expect(
    adoption.withIdleBunRuntimeClaim(
      machine,
      box,
      '1.4.2',
      async () => {
        throw failure
      },
      runner
    )
  ).rejects.toBe(failure)
  expect(calls.at(-1)).toContain('start ficus-box-box_fixture.socket')
  let ran = false
  expect(
    await adoption.withIdleBunRuntimeClaim(
      machine,
      box,
      '1.4.2',
      async () => {
        ran = true
      },
      {
        run: async () => ({ exitCode: 74, stdout: '', stderr: '' }),
      }
    )
  ).toEqual({ adopted: false })
  expect(ran).toBe(false)
})

test('normal provision can keep the claimed activation socket closed until env publication', async () => {
  const { readFile } = await import('node:fs/promises')
  const script = await readFile(new URL('../../../../../scripts/machine/box-provision.sh', import.meta.url), 'utf8')
  const body = script.match(/^provision_box\(\) \{[\s\S]*?^\}/m)![0]
  const program = `
set -eu
${body}
for name in assert_socket_proxyd ensure_user reconcile_unit_mode prepare_box_home ensure_dirs init_shared_nix_cache install_slice_limits ensure_box_port_reservation write_host_env install_unit systemctl; do eval "$name() { :; }"; done
user_home() { echo /owned/fixture; }
box_uid() { echo 1000; }
unit_name() { echo fixture.service; }
socket_name() { echo fixture.socket; }
sysbox() {
  case "$*" in
    'start fixture.socket') echo FORBIDDEN_SOCKET_START >&2; return 90 ;;
    'show -p UnitFileState --value fixture.service') echo disabled ;;
    'show -p UnitFileState --value fixture.socket') echo enabled ;;
    'show -p ActiveState --value fixture.socket') echo inactive ;;
  esac
}
UNIT_MODE=system
SUDO=()
WITH_DOCKER=false
DEFER_SOCKET_START=true
UNIX_USER=fixture
SANDBOX_ID=fixture
PORT=50000
provision_box
`
  const result = Bun.spawnSync(['bash', '-c', program])
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  expect(result.stderr.toString()).not.toContain('FORBIDDEN_SOCKET_START')
})

test('the real claim shell backs off if socket closure overtakes activation or a manager job', async () => {
  const { readFileSync } = await import('node:fs')
  const root = mkdtempSync(join(tmpdir(), 'bun-claim-'))
  try {
    const bin = join(root, 'bin')
    const home = join(root, 'home')
    mkdirSync(bin)
    mkdirSync(home)
    const executable = (name: string, script: string) =>
      writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
    executable('id', 'echo 1000')
    executable('bun', 'echo 1.4.2')
    executable(
      'sudo',
      '[ "$1" = -n ] && shift; [ "$1" = -u ] && shift 2; case "$1" in systemctl|bash|env) exec "$@" ;; *) exit 99 ;; esac'
    )
    executable(
      'systemctl',
      `
while [ "\${1#--}" != "$1" ]; do shift; done
for unit; do :; done
case "$1" in
  stop) echo stop >> "$STATE_ROOT/events"; echo inactive > "$STATE_ROOT/socket"; [ "\${RACE_ON_STOP:-0}" = 1 ] && echo active > "$STATE_ROOT/server"; exit 0 ;;
  start) echo start >> "$STATE_ROOT/events"; echo active > "$STATE_ROOT/socket" ;;
  show) echo "\${UNIT_JOB:-0}" ;;
  is-active) case "$unit" in *.socket) cat "$STATE_ROOT/socket" ;; *proxy.service) echo inactive ;; *.service) cat "$STATE_ROOT/server" ;; *) exit 98 ;; esac ;;
  *) exit 97 ;;
esac`
    )
    const reset = () => {
      writeFileSync(join(root, 'server'), 'inactive\n')
      writeFileSync(join(root, 'socket'), 'active\n')
      writeFileSync(join(root, 'events'), '')
    }
    const machine = { id: 'fixture' } as any
    const box = { sandboxId: 'agent_fixture', unixUser: 'box_fixture' } as any
    let env: Record<string, string> = {}
    const runner = {
      run: async (_machine: unknown, command: string) => {
        const program = command.replaceAll('/home/box_fixture', home).replaceAll('/opt/ficus/bin/bun', join(bin, 'bun'))
        const result = Bun.spawnSync(['bash', '-c', program], {
          env: { PATH: `${bin}:/usr/bin:/bin`, FICUS_HOST_ROOT: root, STATE_ROOT: root, ...env },
        })
        return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
      },
    }
    for (const sandboxId of ['agent_fixture', 'squad_fixture']) {
      box.sandboxId = sandboxId
      env = {}
      reset()
      expect(
        await adoption.withIdleBunRuntimeClaim(
          machine,
          box,
          '1.4.2',
          async () => {
            expect(readFileSync(join(root, 'socket'), 'utf8').trim()).toBe('inactive')
            return 'ready'
          },
          runner
        )
      ).toEqual({ adopted: true, value: 'ready' })
      expect(readFileSync(join(root, 'events'), 'utf8')).toBe('stop\nstart\n')
      expect(readFileSync(join(root, 'socket'), 'utf8').trim()).toBe('active')
      reset()
      env = { RACE_ON_STOP: '1' }
      let ran = false
      expect(
        await adoption.withIdleBunRuntimeClaim(
          machine,
          box,
          '1.4.2',
          async () => {
            ran = true
          },
          runner
        )
      ).toEqual({ adopted: false })
      expect(ran).toBe(false)
      expect(readFileSync(join(root, 'server'), 'utf8').trim()).toBe('active')
      expect(readFileSync(join(root, 'socket'), 'utf8').trim()).toBe('active')
      reset()
      env = { UNIT_JOB: '123 fixture.service' }
      expect(
        await adoption.withIdleBunRuntimeClaim(
          machine,
          box,
          '1.4.2',
          async () => {
            ran = true
          },
          runner
        )
      ).toEqual({ adopted: false })
      expect(readFileSync(join(root, 'events'), 'utf8')).toBe('')
      reset()
      env = {}
      const journal = join(root, 'run/ficus-box-locks/ficus-box-box_fixture.bun-adoption')
      // Simulate a new owner replacing the old token. Old finally MUST NOT
      // reopen its listener, and generation changes must never steal it.
      await expect(
        adoption.withIdleBunRuntimeClaim(
          machine,
          box,
          '1.4.2',
          async () => {
            const lines = readFileSync(journal, 'utf8').trim().split('\n')
            lines[2] = crypto.randomUUID()
            writeFileSync(journal, lines.join('\n') + '\n')
          },
          runner
        )
      ).rejects.toThrow('owned box runtime activation listener')
      expect(readFileSync(join(root, 'socket'), 'utf8').trim()).toBe('inactive')
      expect(
        await adoption.recoverBoxBunRuntimeClaim(
          machine,
          { ...box, reconcilableSpecHash: 'lifecycle:other:spec' },
          runner
        )
      ).toBe(false)
      expect(readFileSync(join(root, 'socket'), 'utf8').trim()).toBe('inactive')
      let replaced = false
      const overtakingRunner = {
        run: async (m: unknown, command: string) => {
          const result = await runner.run(m, command)
          if (!replaced && result.stdout.startsWith('FICUS_BUN_RECOVERY=') && !result.stdout.includes('=none')) {
            replaced = true
            const lines = readFileSync(journal, 'utf8').trim().split('\n')
            lines[2] = crypto.randomUUID()
            writeFileSync(journal, lines.join('\n') + '\n')
          }
          return result
        },
      }
      expect(await adoption.recoverBoxBunRuntimeClaim(machine, box, overtakingRunner)).toBe(false)
      expect(readFileSync(join(root, 'socket'), 'utf8').trim()).toBe('inactive')
      expect(await adoption.recoverBoxBunRuntimeClaim(machine, box, runner)).toBe(true)
      expect(readFileSync(join(root, 'socket'), 'utf8').trim()).toBe('active')
      writeFileSync(journal, 'malformed-unknown-owner\n')
      expect(await adoption.recoverBoxBunRuntimeClaim(machine, box, runner)).toBe(false)
      rmSync(journal)
      reset()
      box.reconcilableSpecHash = 'lifecycle:original:base:bun:1_2_23'
      const desired = 'lifecycle:original:base:bun:1_4_2'
      await expect(
        adoption.withIdleBunRuntimeClaim(
          machine,
          box,
          '1.4.2',
          async () => {
            const lines = readFileSync(journal, 'utf8').trim().split('\n')
            lines[2] = crypto.randomUUID()
            writeFileSync(journal, lines.join('\n') + '\n')
          },
          runner,
          desired
        )
      ).rejects.toThrow('owned box runtime activation listener')
      const failedReady = {
        ...box,
        reconcilableSpecHash: 'lifecycle:original:base',
        bunRuntimeFailureSpecHash: desired,
        bunRuntimeAdoptingSpecHash: desired,
      }
      for (const invalid of [
        { ...failedReady, reconcilableSpecHash: 'lifecycle:replacement:base' },
        { ...failedReady, bunRuntimeFailureSpecHash: null },
        { ...failedReady, bunRuntimeAdoptingSpecHash: 'lifecycle:replacement:base:bun:1_4_2' },
      ])
        expect(await adoption.recoverBoxBunRuntimeClaim(machine, invalid, runner)).toBe(false)
      expect(await adoption.recoverBoxBunRuntimeClaim(machine, failedReady, runner)).toBe(true)
      expect(readFileSync(join(root, 'socket'), 'utf8').trim()).toBe('active')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('unknown recovery and a still-running host flock defer without running adoption', async () => {
  const machine = { id: 'fixture' } as any
  const box = { sandboxId: 'agent_fixture', unixUser: 'box_fixture' }
  for (const runner of [
    { run: async () => ({ exitCode: 73, stdout: '', stderr: 'owned host work still running' }) },
    { run: async () => ({ exitCode: 1, stdout: '', stderr: 'unknown host state' }) },
    { run: async () => ({ exitCode: 0, stdout: 'unrecognized', stderr: '' }) },
    { run: async () => ({ exitCode: 0, stdout: crypto.randomUUID(), stderr: '' }) },
    {
      run: async () => {
        throw new Error('transport outcome unknown')
      },
    },
  ]) {
    let ran = false
    expect(
      await adoption.withIdleBunRuntimeClaim(
        machine,
        box,
        '1.4.2',
        async () => {
          ran = true
        },
        runner
      )
    ).toEqual({ adopted: false })
    expect(ran).toBe(false)
  }
})

test('a failed listener restoration preserves the operation error as well as unproven cleanup', async () => {
  const primary = new Error('verified version mismatch')
  const machine = { id: 'm' } as Machine
  const box = { sandboxId: 'agent_failed_adoption', unixUser: 'box_test', machineId: 'm' } as MachineBox
  const runner: SshRunner = {
    run: async (_machine, command) =>
      command.includes('FICUS_BUN_RECOVERY=')
        ? { exitCode: 0, stdout: 'FICUS_BUN_RECOVERY=none', stderr: '' }
        : {
            exitCode: command.includes('FICUS_BUN_ADOPTION=claimed') ? 0 : 1,
            stdout: command.includes('FICUS_BUN_ADOPTION=claimed') ? 'FICUS_BUN_ADOPTION=claimed' : '',
            stderr: '',
          },
  }
  try {
    await adoption.withIdleBunRuntimeClaim(
      machine,
      box,
      '1.4.2',
      async () => {
        throw primary
      },
      runner,
      'desired'
    )
    throw new Error('Expected failed adoption')
  } catch (error) {
    expect((error as { operationError: unknown }).operationError).toBe(primary)
    expect((error as { restorationError: unknown }).restorationError).toBeInstanceOf(Error)
  }
})
