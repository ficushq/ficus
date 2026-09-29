import { describe, expect, it } from 'bun:test'
import { recordingRunner } from './runner'
import {
  checkSysboxHost,
  defaultSysboxHostDeps,
  meetsSysboxKernel,
  runSysboxBootstrap,
  SYSBOX_DEB_SHA256,
  SYSBOX_DEB_URL,
  sysboxInstallCommands,
  SYSBOX_MIN_KERNEL,
  SYSBOX_VERSION,
} from './sysbox'
import { SetupFailure } from './types'

const MANUAL = 'docs/wiki/sandbox-runtimes.md#installing-sysbox'

const goodHost = {
  platform: 'linux' as NodeJS.Platform,
  arch: 'x64',
  kernelRelease: '6.8.0-40-generic',
  systemdActive: true,
  wsl: false,
  which: (cmd: string) => `/usr/bin/${cmd}`,
}

describe('meetsSysboxKernel', () => {
  it('accepts the documented matrix', () => {
    expect(meetsSysboxKernel('6.8.0-40-generic')).toBe(true)
    expect(meetsSysboxKernel('5.12.0')).toBe(true)
    expect(meetsSysboxKernel('5.12.0-rc2')).toBe(true)
    expect(meetsSysboxKernel('5.11.0-rc2')).toBe(false)
    expect(meetsSysboxKernel('5.11.0-40-generic')).toBe(false)
    expect(meetsSysboxKernel('4.19.0')).toBe(false)
    expect(SYSBOX_MIN_KERNEL).toEqual([5, 12])
  })
  it('is parse-tolerant: garbage does not pass', () => {
    expect(meetsSysboxKernel('')).toBe(false)
    expect(meetsSysboxKernel('unknown')).toBe(false)
    expect(meetsSysboxKernel('v6.1')).toBe(false)
  })
})

describe('checkSysboxHost', () => {
  it('passes a capable linux host', () => {
    expect(checkSysboxHost(goodHost)).toEqual({ ok: true, failures: [] })
  })
  it('rejects a non-linux host naming the platform', () => {
    const r = checkSysboxHost({ ...goodHost, platform: 'darwin' })
    expect(r.ok).toBe(false)
    expect(r.failures.join('\n')).toMatch(/darwin/)
  })
  it('rejects a non-amd64 host (the .deb is amd64-only)', () => {
    const r = checkSysboxHost({ ...goodHost, arch: 'arm64' })
    expect(r.ok).toBe(false)
    expect(r.failures.join('\n')).toMatch(/amd64/)
  })
  it('names a too-old kernel and the minimum', () => {
    const r = checkSysboxHost({ ...goodHost, kernelRelease: '5.11.0-40-generic' })
    expect(r.failures.join('\n')).toMatch(/5\.11\.0-40-generic/)
    expect(r.failures.join('\n')).toMatch(/5\.12/)
  })
  it('tells WSL hosts without systemd the /etc/wsl.conf recipe', () => {
    const r = checkSysboxHost({ ...goodHost, wsl: true, systemdActive: false })
    expect(r.failures.join('\n')).toMatch(/\[boot\]/)
    expect(r.failures.join('\n')).toMatch(/wsl --shutdown/)
  })
  it('tells plain hosts without systemd the requirement', () => {
    const r = checkSysboxHost({ ...goodHost, systemdActive: false })
    expect(r.failures.join('\n')).toMatch(/systemd/)
    expect(r.failures.join('\n')).not.toMatch(/wsl --shutdown/)
  })
  it('names each missing tool', () => {
    const r = checkSysboxHost({ ...goodHost, which: () => null })
    const text = r.failures.join('\n')
    expect(text).toMatch(/docker/)
    expect(text).toMatch(/sudo/)
    expect(text).toMatch(/dpkg/)
  })
  it('ends every failure with the manual pointer', () => {
    const r = checkSysboxHost({
      ...goodHost,
      platform: 'win32',
      arch: 'arm64',
      kernelRelease: '4.0',
      which: () => null,
    })
    expect(r.ok).toBe(false)
    for (const f of r.failures) expect(f.endsWith(`or follow ${MANUAL}`)).toBe(true)
  })
})

describe('sysboxInstallCommands', () => {
  it('pins the documented recipe in reviewable order, verifying the deb digest before install', () => {
    const commands = sysboxInstallCommands()
    expect(commands[0][0]).toBe('wget')
    expect(commands[0]).toContain(SYSBOX_DEB_URL)
    expect(commands.map((c) => c.join(' '))).toEqual([
      `wget -O /tmp/sysbox-ce_${SYSBOX_VERSION}-0.linux_amd64.deb ${SYSBOX_DEB_URL}`,
      `bash -c echo '${SYSBOX_DEB_SHA256}  /tmp/sysbox-ce_${SYSBOX_VERSION}-0.linux_amd64.deb' | sha256sum -c -`,
      'sudo apt-get install -y jq',
      `sudo dpkg -i /tmp/sysbox-ce_${SYSBOX_VERSION}-0.linux_amd64.deb`,
    ])
    expect(SYSBOX_DEB_URL).toBe(
      `https://downloads.nestybox.com/sysbox/releases/v${SYSBOX_VERSION}/sysbox-ce_${SYSBOX_VERSION}-0.linux_amd64.deb`
    )
    // TOFU-pinned digest of the pinned .deb (see SYSBOX_DEB_SHA256).
    expect(SYSBOX_DEB_SHA256).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('defaultSysboxHostDeps', () => {
  it('reads this host via the injected which', () => {
    const deps = defaultSysboxHostDeps((cmd) => (cmd === 'docker' ? '/usr/bin/docker' : null))
    expect(deps.platform).toBe(process.platform)
    expect(deps.arch).toBe(process.arch)
    expect(deps.which('docker')).toBe('/usr/bin/docker')
    expect(deps.which('nope')).toBeNull()
  })
})

function bootstrapDeps(responses: Record<string, { code?: number; stdout?: string; stderr?: string }> = {}) {
  const rec = recordingRunner(responses)
  const lines: string[] = []
  return {
    rec,
    lines,
    deps: {
      runner: rec.runner,
      isTTY: false,
      confirm: async () => true,
      host: goodHost,
      log: (line?: string) => lines.push(line ?? ''),
    },
  }
}

const CONTAINERS = { 'docker ps': { stdout: 'ci-postgres\nci-ficus\n' } }

describe('runSysboxBootstrap', () => {
  it('refuses without a TTY unless --yes, attempting nothing', async () => {
    const { deps, rec } = bootstrapDeps(CONTAINERS)
    await expect(runSysboxBootstrap({ yes: false, dryRun: false }, deps)).rejects.toThrow(/--yes/)
    // Only the read-only container listing ran (it feeds the warning); the
    // plan itself was never executed.
    expect(rec.calls.map((c) => c.command.join(' '))).toEqual(['docker ps -a --format {{.Names}}'])
  })
  it('fails before doing anything when the host cannot run it', async () => {
    const { deps, rec } = bootstrapDeps(CONTAINERS)
    deps.host = { ...goodHost, kernelRelease: '5.4.0' }
    await expect(runSysboxBootstrap({ yes: true, dryRun: false }, deps)).rejects.toBeInstanceOf(SetupFailure)
    await expect(runSysboxBootstrap({ yes: true, dryRun: false }, deps)).rejects.toThrow(/5\.4\.0/)
    expect(rec.calls).toEqual([])
  })
  it('dry-run prints the plan (with the container warning) and changes nothing', async () => {
    const { deps, rec, lines } = bootstrapDeps(CONTAINERS)
    await runSysboxBootstrap({ yes: true, dryRun: true }, deps)
    const text = lines.join('\n')
    expect(text).toMatch(/wget/)
    expect(text).toMatch(/dpkg/)
    expect(text).toMatch(/removes ALL containers/)
    expect(text).toMatch(/ci-postgres, ci-ficus/)
    expect(rec.calls.map((c) => c.command.join(' '))).toEqual(['docker ps -a --format {{.Names}}'])
  })
  it('runs the full sequence and succeeds when sysbox-runc registers', async () => {
    const { deps, rec, lines } = bootstrapDeps({
      ...CONTAINERS,
      'docker info --format': { stdout: '{"sysbox-runc":{"path":"…"}}' },
    })
    await runSysboxBootstrap({ yes: true, dryRun: false }, deps)
    expect(rec.calls.map((c) => c.command.join(' '))).toEqual([
      'docker ps -a --format {{.Names}}',
      'docker rm -f ci-postgres ci-ficus',
      `wget -O /tmp/sysbox-ce_${SYSBOX_VERSION}-0.linux_amd64.deb ${SYSBOX_DEB_URL}`,
      `bash -c echo '${SYSBOX_DEB_SHA256}  /tmp/sysbox-ce_${SYSBOX_VERSION}-0.linux_amd64.deb' | sha256sum -c -`,
      'sudo apt-get install -y jq',
      `sudo dpkg -i /tmp/sysbox-ce_${SYSBOX_VERSION}-0.linux_amd64.deb`,
      'docker info --format {{json .Runtimes}}',
    ])
    expect(lines.join('\n')).toMatch(/sysbox-runc/)
  })
  it('skips docker rm when nothing is running', async () => {
    const { deps, rec } = bootstrapDeps({
      'docker ps': { stdout: '' },
      'docker info --format': { stdout: '{"sysbox-runc":{}}' },
    })
    await runSysboxBootstrap({ yes: true, dryRun: false }, deps)
    expect(rec.calls.some((c) => c.command[1] === 'rm')).toBe(false)
  })
  it('fails with the shiftfs hint when sysbox-runc never registers', async () => {
    const { deps } = bootstrapDeps({ ...CONTAINERS, 'docker info --format': { stdout: '{"runc":{}}' } })
    await expect(runSysboxBootstrap({ yes: true, dryRun: false }, deps)).rejects.toBeInstanceOf(SetupFailure)
    await expect(runSysboxBootstrap({ yes: true, dryRun: false }, deps)).rejects.toThrow(/shiftfs/)
  })
  it('surfaces a failed plan step and stops', async () => {
    const { deps, rec } = bootstrapDeps({
      ...CONTAINERS,
      wget: { code: 8, stderr: 'download failed' },
    })
    await expect(runSysboxBootstrap({ yes: true, dryRun: false }, deps)).rejects.toThrow(/download failed/)
    expect(rec.calls.some((c) => c.command[0] === 'sudo')).toBe(false)
  })
  it('asks a TTY caller for confirmation and aborts on decline', async () => {
    const { deps, rec } = bootstrapDeps(CONTAINERS)
    deps.isTTY = true
    deps.confirm = async () => false
    await runSysboxBootstrap({ yes: false, dryRun: false }, deps)
    expect(rec.calls.map((c) => c.command.join(' '))).toEqual(['docker ps -a --format {{.Names}}'])
  })
})
