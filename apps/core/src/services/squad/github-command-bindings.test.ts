import { afterEach, describe, expect, it } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { integrationWrapperPreamble } from '@ficus/shared/integration-wrapper-path'
import { writeExecutionWrappers } from '../integrations/execution-wrappers'
import { tmpdir } from 'os'
import { join } from 'path'
import { githubCommandBindings } from './env'

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGkq ficus-commit-signing-octo'
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Source the bindings in bash, then run `git` against a fake that prints its argv and signing env. */
function runGit(bindings: string, env: Record<string, string>): string[] {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ficus-git-bindings-')))
  dirs.push(dir)
  writeFileSync(
    join(dir, 'git'),
    '#!/bin/sh\nprintf "SQUAD=%s\\n" "${FICUS_GIT_SIGNING_SQUAD:-}"\nfor a in "$@"; do printf "%s\\n" "$a"; done\n'
  )
  chmodSync(join(dir, 'git'), 0o755)
  writeFileSync(join(dir, 'env.sh'), bindings)
  const result = Bun.spawnSync(['bash', '-c', `. ${join(dir, 'env.sh')}; git commit -m hi`], {
    env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir, ...env },
    timeout: 3000,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(result.stderr.toString()).toBe('')
  expect(result.exitCode).toBe(0)
  return result.stdout.toString().trimEnd().split('\n')
}

/** Exercise the actual post-activation assets, with provider/CLI transport replaced by synthetic executables. */
function runManagedCommand(cmd: string, agent = true) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ficus-gh-bindings-')))
  dirs.push(dir)
  const wrappers = join(dir, '.ficus', 'integration-bin')
  const real = join(dir, 'real')
  mkdirSync(real)
  writeExecutionWrappers(
    wrappers,
    [{ binary: 'gh', providerKey: 'github' }],
    'squad-1',
    githubCommandBindings('squad-1', KEY)
  )
  writeFileSync(join(dir, '.ficus', '.env'), 'SQUAD_SETTING=preserved\n')
  const calls = join(dir, 'calls')
  writeFileSync(calls, '')
  writeFileSync(
    join(real, 'ficus'),
    '#!/bin/sh\nset -eu\n{ printf "CALL\\n"; printf "%s\\n" "$@"; } >> "$FIXTURE_CALLS"\nwhile [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done\n[ "$#" -gt 0 ] || exit 64\nshift\nexec "$@"\n',
    { mode: 0o755 }
  )
  writeFileSync(
    join(real, 'gh'),
    '#!/bin/sh\nif [ "$1" = auth ] && [ "$2" = git-credential ]; then\n  printf "username=synthetic-user\\npassword=synthetic-gh-token\\n"\nelse\n  printf "gh %s\\n" "$*"\nfi\n',
    { mode: 0o755 }
  )
  // The managed assets carry instructions only, not even the injected test identity.
  for (const file of [join(dir, '.ficus', '.env'), join(wrappers, 'gh'), join(wrappers, '.git-config')]) {
    const asset = readFileSync(file, 'utf8')
    expect(asset).not.toContain('synthetic-agent-identity')
    expect(asset).not.toContain('synthetic-gh-token')
  }
  expect(readFileSync(join(dir, '.ficus', '.env'), 'utf8')).not.toContain('git()')
  expect(readFileSync(join(wrappers, '.git-config'), 'utf8')).not.toContain('gh()')
  const result = Bun.spawnSync(
    ['bash', '--noprofile', '--norc', '-c', '. "$FIXTURE_ENV"\n' + integrationWrapperPreamble(wrappers) + cmd],
    {
      cwd: dir,
      env: {
        PATH: `${real}:/usr/bin:/bin`,
        HOME: dir,
        GH_CONFIG_DIR: dir,
        XDG_CONFIG_HOME: dir,
        FIXTURE_CALLS: calls,
        FIXTURE_ENV: join(dir, '.ficus', '.env'),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        ...(agent ? { FICUS_TOKEN: 'synthetic-agent-identity' } : {}),
      },
      timeout: 3000,
      stdout: 'pipe',
      stderr: 'pipe',
    }
  )
  expect(result.exitCode).toBe(0)
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    realGh: join(real, 'gh'),
    calls: readFileSync(calls, 'utf8')
      .split('CALL\n')
      .slice(1)
      .map((call) => call.trimEnd().split('\n')),
  }
}

describe('githubCommandBindings', () => {
  it('the executable gh wrapper dispatches through ficus after loading .git-config', () => {
    const result = runManagedCommand('gh pr list --limit 1')
    expect(result.stdout).toBe('gh pr list --limit 1\n')
    expect(result.stderr).toBe('')
    expect(result.calls).toEqual([
      ['integration', 'exec', 'github', '--squad', 'squad-1', '--', result.realGh, 'pr', 'list', '--limit', '1'],
    ])
    const bindings = githubCommandBindings('squad-1', KEY)
    expect(bindings).toContain('command ficus integration exec github --squad')
    expect(bindings).toContain('-c gpg.ssh.program=ficus')
  })

  it('real Git invokes its per-command credential helper through ficus and the executable wrapper', () => {
    const result = runManagedCommand("printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill")
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe(
      'protocol=https\nhost=github.com\nusername=synthetic-user\npassword=synthetic-gh-token\n'
    )
    expect(result.calls).toEqual([
      ['integration', 'exec', 'github', '--squad', 'squad-1', '--', 'gh', 'auth', 'git-credential', 'get'],
      ['integration', 'exec', 'github', '--squad', 'squad-1', '--', result.realGh, 'auth', 'git-credential', 'get'],
    ])
  })

  it('human activation does not load Git overrides or acquire Ficus integration credentials', () => {
    const result = runManagedCommand('type -t git; gh pr list --limit 1', false)
    expect(result.stdout).toBe('file\ngh pr list --limit 1\n')
    expect(result.stderr).toBe(
      'Ficus integration credentials are only available to agents; running gh without Ficus credentials.\n'
    )
    expect(result.calls).toEqual([])
  })

  it('without a signing key, git only gets the credential helper', () => {
    const lines = runGit(githubCommandBindings('squad-1'), { FICUS_TOKEN: 'ficus_agent_x' })
    expect(lines[0]).toBe('SQUAD=')
    expect(lines).not.toContain('commit.gpgsign=true')
    expect(lines.slice(-3)).toEqual(['commit', '-m', 'hi'])
  })

  it('signs agent commits through ficus with the squad key, outranking repo config', () => {
    const lines = runGit(githubCommandBindings('squad-1', KEY), { FICUS_TOKEN: 'ficus_agent_x' })
    expect(lines[0]).toBe('SQUAD=squad-1')
    for (const setting of [
      'gpg.format=ssh',
      'commit.gpgsign=true',
      'tag.gpgsign=true',
      `user.signingkey=key::${KEY}`,
      'gpg.ssh.program=ficus',
    ]) {
      const at = lines.indexOf(setting)
      expect(at).toBeGreaterThan(0)
      expect(lines[at - 1]).toBe('-c')
    }
    // The credential helper is still configured, and the user's arguments come last.
    expect(lines.some((line) => line.includes('ficus integration exec github --squad'))).toBe(true)
    expect(lines.slice(-3)).toEqual(['commit', '-m', 'hi'])
  })

  it('does not sign in shells without an agent token (human terminals cannot reach the signer)', () => {
    const lines = runGit(githubCommandBindings('squad-1', KEY), {})
    expect(lines[0]).toBe('SQUAD=')
    expect(lines).not.toContain('commit.gpgsign=true')
    expect(lines.some((line) => line.includes('ficus integration exec github --squad'))).toBe(true)
  })
})
