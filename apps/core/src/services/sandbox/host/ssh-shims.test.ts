import { readdirSync } from 'fs'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SSH_FAMILY_TOOLS, ensureSshFamilyShims, renderSshShimScript } from './ssh-shims'

// The rendered scripts must be valid POSIX /bin/sh — CI's shell is dash, the
// strictest of the targets — so syntax-check every render. A wrong \${...}
// escape inside ssh-shims.ts is otherwise a silent runtime bug.
function checkShellSyntax(script: string): void {
  const file = join(tmpdir(), `tau-shim-syntax-${Math.random().toString(36).slice(2)}`)
  writeFileSync(file, script)
  try {
    const result = Bun.spawnSync(['/bin/sh', '-n', file])
    expect(result.exitCode).toBe(0)
  } finally {
    rmSync(file, { force: true })
  }
}

describe('renderSshShimScript (unit)', () => {
  test.each([...SSH_FAMILY_TOOLS])('renders a %s shim with the shared skeleton', (tool) => {
    const script = renderSshShimScript(tool)
    expect(script.startsWith('#!/bin/sh\n')).toBe(true)
    expect(script).toContain('FICUS_SQUAD_SSH_DIR')
    expect(script).toContain('# >>> tau remote hosts >>>')
    expect(script).toContain('# <<< tau remote hosts <<<')
    expect(script).toContain('-ef "$0"') // recursion guard
    expect(script).toContain('exec "$REAL"')
    checkShellSyntax(script)
  })

  test('ssh shim declares ssh value-taking options and the UserKnownHostsFile injection', () => {
    const script = renderSshShimScript('ssh')
    expect(script).toContain('VALOPTS="BbcDEeFIiJLlmOopQRSWw"')
    expect(script).toContain('-o "UserKnownHostsFile=$KH"')
  })

  test('scp shim declares scp value-taking options and the UserKnownHostsFile injection', () => {
    const script = renderSshShimScript('scp')
    expect(script).toContain('VALOPTS="cFiJlPSo"')
    expect(script).toContain('-o "UserKnownHostsFile=$KH"')
  })

  test('rsync shim exports RSYNC_RSH and does no -e/--rsh parsing', () => {
    const script = renderSshShimScript('rsync')
    expect(script).toContain('RSYNC_RSH=')
    // -e/--rsh is deliberately not parsed: rsync gives an explicit -e/--rsh
    // precedence over RSYNC_RSH, so the env var never overrides the user.
    expect(script).not.toContain('VALOPTS')
  })
})

describe('ssh-family shims (functional matrix)', () => {
  // Harness: real /bin/sh + a crafted PATH (shims via ensureSshFamilyShims,
  // then recorder stubs), mirroring how an agent's command reaches the shim.
  // The stub writes one line per argv element plus a RSYNC_RSH line when the
  // env var is set, so assertions are exact argv/env comparisons.
  let t: string
  let prevHome: string | undefined
  const CFG = () => join(t, 'squadssh', 'config')
  const KH = () => join(t, 'squadssh', 'known_hosts')

  const FIXTURE_CONFIG = [
    'Host github-work',
    '  HostName github.com',
    '# >>> tau remote hosts >>>',
    '  Host staging',
    '    HostName 10.1.2.3',
    '    Port 22',
    '    User deploy',
    '    IdentityFile /abs/ficus_remote_staging',
    '    IdentitiesOnly yes',
    '    UserKnownHostsFile /abs/known_hosts',
    '    StrictHostKeyChecking accept-new',
    '# <<< tau remote hosts <<<',
    '',
  ].join('\n')

  function writeStub(tool: string, dir: string): void {
    const stub = join(dir, tool)
    writeFileSync(
      stub,
      '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$RECORDER_OUT"\nenv | grep \'^RSYNC_RSH=\' >> "$RECORDER_OUT" || true\nexit 0\n'
    )
    chmodSync(stub, 0o755)
  }

  interface RunResult {
    lines: string[]
    exitCode: number
    stderr: string
  }

  function run(command: string, opts: { solo?: boolean; path?: string } = {}): RunResult {
    const env: Record<string, string> = {
      PATH: opts.path ?? `${join(t, 'host', 'bin')}:${join(t, 'bin')}:/usr/bin:/bin`,
      HOME: t,
      RECORDER_OUT: join(t, 'out'),
    }
    if (!opts.solo) env.FICUS_SQUAD_SSH_DIR = join(t, 'squadssh')
    const result = Bun.spawnSync(['/bin/sh', '-c', command], {
      env,
      cwd: t,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 15_000,
    })
    const out = existsSync(join(t, 'out')) ? readFileSync(join(t, 'out'), 'utf8') : ''
    rmSync(join(t, 'out'), { force: true })
    return {
      lines: out ? out.split('\n').slice(0, -1) : [],
      exitCode: result.exitCode ?? -1,
      stderr: result.stderr.toString(),
    }
  }

  beforeEach(() => {
    t = mkdtempSync(join(tmpdir(), 'tau-ssh-shims-fn-'))
    prevHome = process.env.HOME_DIR
    process.env.HOME_DIR = t
    ensureSshFamilyShims()
    mkdirSync(join(t, 'bin'), { recursive: true })
    for (const tool of SSH_FAMILY_TOOLS) writeStub(tool, join(t, 'bin'))
    mkdirSync(join(t, 'squadssh'), { recursive: true })
    writeFileSync(CFG(), FIXTURE_CONFIG)
    writeFileSync(KH(), '')
  })
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME_DIR
    else process.env.HOME_DIR = prevHome
    rmSync(t, { recursive: true, force: true })
  })

  const KH_ARGS = () => ['-F', CFG(), '-o', `UserKnownHostsFile=${KH()}`]

  test('1. ssh <managed alias>: prepends -F + pinned known_hosts, argv preserved', () => {
    expect(run('ssh staging true').lines).toEqual([...KH_ARGS(), 'staging', 'true'])
  })

  test('2. ssh <operator destination>: byte-identical pass-through', () => {
    expect(run('ssh github.com true').lines).toEqual(['github.com', 'true'])
  })

  test('3. ssh options + user@alias: prefix-only injection', () => {
    expect(run('ssh -p 2222 deploy@staging true').lines).toEqual([...KH_ARGS(), '-p', '2222', 'deploy@staging', 'true'])
  })

  test('4. ssh with a user -F: never overridden', () => {
    expect(run("ssh -F '~/.ssh/myconf' staging").lines).toEqual(['-F', '~/.ssh/myconf', 'staging'])
  })

  test('5. ssh with an attached -vF<cfg> bundle value: never overridden', () => {
    expect(run('ssh -vF/my/conf staging').lines).toEqual(['-vF/my/conf', 'staging'])
  })

  test('6. ssh <alias> without a squad known_hosts: injects -F only', () => {
    rmSync(KH())
    expect(run('ssh staging').lines).toEqual(['-F', CFG(), 'staging'])
  })

  test('7. ssh with no FICUS_SQUAD_SSH_DIR (solo agent): untouched', () => {
    expect(run('ssh staging true', { solo: true }).lines).toEqual(['staging', 'true'])
  })

  test('8. ssh with an empty managed block: untouched', () => {
    writeFileSync(CFG(), '# >>> tau remote hosts >>>\n# <<< tau remote hosts <<<\n')
    expect(run('ssh staging true').lines).toEqual(['staging', 'true'])
  })

  test('9. scp <alias>:path: prepends -F + pinned known_hosts, argv preserved', () => {
    expect(run('scp file.txt staging:/tmp/').lines).toEqual([...KH_ARGS(), 'file.txt', 'staging:/tmp/'])
  })

  test('10. scp to an operator host: untouched', () => {
    expect(run('scp -r -i key dir other:/x').lines).toEqual(['-r', '-i', 'key', 'dir', 'other:/x'])
  })

  test('11. scp -3 mixed alias+operator: all-or-nothing, untouched', () => {
    expect(run('scp -3 a staging:/x other:/y').lines).toEqual(['-3', 'a', 'staging:/x', 'other:/y'])
  })

  test('12. rsync to <alias>: argv untouched, RSYNC_RSH exported with quoted paths', () => {
    expect(run('rsync -a dir/ staging:/x/').lines).toEqual([
      '-a',
      'dir/',
      'staging:/x/',
      `RSYNC_RSH=ssh -F '${CFG()}' -o UserKnownHostsFile='${KH()}'`,
    ])
  })

  test('13. rsync to an operator host: no RSYNC_RSH, argv untouched', () => {
    expect(run('rsync -a dir/ other:/x/').lines).toEqual(['-a', 'dir/', 'other:/x/'])
  })

  test('14. rsync with a user -e: argv untouched; RSYNC_RSH set but inert (rsync precedence)', () => {
    // rsync gives an explicit -e/--rsh precedence over RSYNC_RSH (verified on
    // rsync 3.2.7), so exporting the env var can never override the user's
    // rsh — the shim deliberately does not parse -e (bundle-aware detection
    // would false-positive on option values like filter rules containing 'e').
    expect(run("rsync -ae 'ssh -p 2' dir/ staging:/x/").lines).toEqual([
      '-ae',
      'ssh -p 2',
      'dir/',
      'staging:/x/',
      `RSYNC_RSH=ssh -F '${CFG()}' -o UserKnownHostsFile='${KH()}'`,
    ])
  })

  test('15. rsync daemon (::) and rsync:// specs: never injected', () => {
    expect(run('rsync -a dir/ staging::mod').lines).toEqual(['-a', 'dir/', 'staging::mod'])
    expect(run('rsync -a dir/ rsync://h/x').lines).toEqual(['-a', 'dir/', 'rsync://h/x'])
  })

  test('16. git regression: the exact GIT_SSH_COMMAND token stream gets no double -F', () => {
    // GIT_SSH_COMMAND = "ssh -F '<cfg>' [-o UserKnownHostsFile='<kh>']"; git
    // execs it through the shell, so 'ssh' resolves to this shim. The shim's
    // "user -F wins" rule must pass it through BYTE-IDENTICALLY.
    expect(run(`ssh -F '${CFG()}' staging git-upload-pack`).lines).toEqual(['-F', CFG(), 'staging', 'git-upload-pack'])
    expect(run(`ssh -F '${CFG()}' -o UserKnownHostsFile='${KH()}' staging git-upload-pack`).lines).toEqual([
      '-F',
      CFG(),
      '-o',
      `UserKnownHostsFile=${KH()}`,
      'staging',
      'git-upload-pack',
    ])
  })

  test('no recursion: shim-only PATH exits 127 with the shim error, never loops', () => {
    const { exitCode, stderr } = run('ssh anyhost true', { path: join(t, 'host', 'bin') })
    expect(exitCode).toBe(127)
    expect(stderr).toContain('ssh: not found (tau host shim)')
  })

  test('aliases outside the managed block (user stanza) are never resolved by the shim', () => {
    // 'github-work' sits in the USER section of the same config — only the
    // marker-delimited block is tau's. A user alias needs an explicit -F.
    expect(run('ssh github-work true').lines).toEqual(['github-work', 'true'])
  })
})

describe('ensureSshFamilyShims', () => {
  let home: string
  let prevHome: string | undefined
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'tau-ssh-shims-'))
    prevHome = process.env.HOME_DIR
    process.env.HOME_DIR = home
  })
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME_DIR
    else process.env.HOME_DIR = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  test('writes ssh, scp and rsync shims executable into <HOME_DIR>/host/bin', () => {
    const written = ensureSshFamilyShims()
    expect(written).toEqual(['ssh', 'scp', 'rsync'].map((t) => join(home, 'host', 'bin', t)))
    for (const tool of ['ssh', 'scp', 'rsync']) {
      const shim = join(home, 'host', 'bin', tool)
      expect(existsSync(shim)).toBe(true)
      expect(statSync(shim).mode & 0o777).toBe(0o755)
      expect(readFileSync(shim, 'utf8')).toBe(renderSshShimScript(tool as (typeof SSH_FAMILY_TOOLS)[number]))
    }
  })

  test('is idempotent: re-running rewrites the same content without failing', () => {
    ensureSshFamilyShims()
    const before = SSH_FAMILY_TOOLS.map((t) => readFileSync(join(home, 'host', 'bin', t), 'utf8'))
    ensureSshFamilyShims()
    const after = SSH_FAMILY_TOOLS.map((t) => readFileSync(join(home, 'host', 'bin', t), 'utf8'))
    expect(after).toEqual(before)
    // Atomic-write scratch files are always cleaned up by the rename.
    expect(readdirSync(join(home, 'host', 'bin')).filter((f) => f.includes('.tmp-'))).toEqual([])
  })
})
