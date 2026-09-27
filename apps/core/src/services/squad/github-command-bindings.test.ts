import { afterEach, describe, expect, it } from 'bun:test'
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { githubCommandBindings } from './env'

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGkq tau-commit-signing-octo'
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Source the bindings in bash, then run `git` against a fake that prints its argv and signing env. */
function runGit(bindings: string, env: Record<string, string>): string[] {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tau-git-bindings-')))
  dirs.push(dir)
  writeFileSync(
    join(dir, 'git'),
    '#!/bin/sh\nprintf "SQUAD=%s\\n" "${FICUS_GIT_SIGNING_SQUAD:-}"\nfor a in "$@"; do printf "%s\\n" "$a"; done\n'
  )
  chmodSync(join(dir, 'git'), 0o755)
  writeFileSync(join(dir, 'env.sh'), bindings)
  const result = Bun.spawnSync(['bash', '-c', `. ${join(dir, 'env.sh')}; git commit -m hi`], {
    env: { PATH: `${dir}:/usr/bin:/bin`, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(result.stderr.toString()).toBe('')
  expect(result.exitCode).toBe(0)
  return result.stdout.toString().trimEnd().split('\n')
}

/** Source the bindings in bash with only a fake `ficus` on PATH (it prints its argv), then run `cmd`. */
function runWithFicus(bindings: string, cmd: string): string[] {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ficus-gh-bindings-')))
  dirs.push(dir)
  writeFileSync(
    join(dir, 'ficus'),
    '#!/bin/sh\nprintf "ficus"; for a in "$@"; do printf " %s" "$a"; done; printf "\\n"\n'
  )
  chmodSync(join(dir, 'ficus'), 0o755)
  writeFileSync(join(dir, 'env.sh'), bindings)
  const result = Bun.spawnSync(['bash', '-c', `. ${join(dir, 'env.sh')}; ${cmd}`], {
    env: { PATH: `${dir}:/usr/bin:/bin` },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(result.stderr.toString()).toBe('')
  expect(result.exitCode).toBe(0)
  return result.stdout.toString().trimEnd().split('\n')
}

describe('githubCommandBindings', () => {
  it('gh and the git credential helper run through the ficus CLI', () => {
    expect(runWithFicus(githubCommandBindings('squad-1'), 'gh pr list --limit 1')).toEqual([
      'ficus integration exec github --squad squad-1 -- gh pr list --limit 1',
    ])
    const bindings = githubCommandBindings('squad-1', KEY)
    expect(bindings).toContain('command ficus integration exec github --squad')
    expect(bindings).toContain('-c gpg.ssh.program=ficus')
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
