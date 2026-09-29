import { describe, expect, it, test } from 'bun:test'
import { gitIdentityEnv, resolveGitHubIdentityFromMetadata } from './github-identity'

function secretStore(values: Record<string, string | undefined>) {
  return (key: string) => values[key]
}

describe('resolveGitHubIdentityFromMetadata', () => {
  it('uses global fallbacks when no squad override is configured', () => {
    const identity = resolveGitHubIdentityFromMetadata({
      metadata: {},
      getSecret: secretStore({
        GITHUB_TOKEN: 'global-token',
        GIT_USER_NAME: 'Global Bot',
        GIT_USER_EMAIL: 'global@example.com',
      }),
      hostGitUserName: 'Host User',
      hostGitUserEmail: 'host@example.com',
    })

    expect(identity).toEqual({
      gitUserName: 'Global Bot',
      gitUserEmail: 'global@example.com',
    })
  })

  it('ignores retired global and per-squad token references and plaintext token metadata', () => {
    const identity = resolveGitHubIdentityFromMetadata({
      metadata: {
        githubIdentity: {
          githubTokenSecretKey: 'SQUAD_GITHUB_TOKEN',
          githubToken: 'must-not-be-used',
        },
      },
      getSecret: secretStore({
        SQUAD_GITHUB_TOKEN: 'squad-token',
        GITHUB_TOKEN: 'global-token',
      }),
    })

    expect(identity).not.toHaveProperty('githubToken')
  })

  it('gives squad git identity precedence over global and host config', () => {
    const identity = resolveGitHubIdentityFromMetadata({
      metadata: {
        githubIdentity: {
          gitUserName: 'Squad Bot',
          gitUserEmail: 'squad@example.com',
        },
      },
      getSecret: secretStore({
        GIT_USER_NAME: 'Global Bot',
        GIT_USER_EMAIL: 'global@example.com',
      }),
      hostGitUserName: 'Host User',
      hostGitUserEmail: 'host@example.com',
    })

    expect(identity.gitUserName).toBe('Squad Bot')
    expect(identity.gitUserEmail).toBe('squad@example.com')
  })

  it('uses host git identity without accepting ambient credentials', () => {
    const identity = resolveGitHubIdentityFromMetadata({
      metadata: {},
      getSecret: secretStore({}),
      hostGitUserName: 'Host User',
      hostGitUserEmail: 'host@example.com',
    })

    expect(identity).toEqual({
      gitUserName: 'Host User',
      gitUserEmail: 'host@example.com',
    })
  })
})

describe('gitIdentityEnv', () => {
  test("emits git's own author/committer vars, not just ficus's GIT_USER_* names", () => {
    const env = gitIdentityEnv({ gitUserName: 'ficusagent', gitUserEmail: 'agent@users.noreply.github.com' })
    // GIT_USER_* are Ficus's names and git ignores them; only these four are honored by git.
    expect(env).toMatchObject({
      GIT_AUTHOR_NAME: 'ficusagent',
      GIT_AUTHOR_EMAIL: 'agent@users.noreply.github.com',
      GIT_COMMITTER_NAME: 'ficusagent',
      GIT_COMMITTER_EMAIL: 'agent@users.noreply.github.com',
    })
  })

  test("keeps GIT_USER_* so the image's existing translation step still works", () => {
    const env = gitIdentityEnv({ gitUserName: 'ficusagent', gitUserEmail: 'agent@example.com' })
    expect(env.GIT_USER_NAME).toBe('ficusagent')
    expect(env.GIT_USER_EMAIL).toBe('agent@example.com')
  })

  test('omits every variable when the identity is unresolved', () => {
    // Assert on KEYS, not toEqual({}): toEqual ignores undefined-valued properties,
    // so `{ GIT_USER_NAME: undefined }` would satisfy it and a guard regression
    // (emitting the vars unconditionally) would ship green.
    expect(Object.keys(gitIdentityEnv({}))).toEqual([])
  })

  test('emits only the half that resolved', () => {
    expect(Object.keys(gitIdentityEnv({ gitUserName: 'only-name' })).sort()).toEqual([
      'GIT_AUTHOR_NAME',
      'GIT_COMMITTER_NAME',
      'GIT_USER_NAME',
    ])
  })

  test('the emitted vars outrank a repo-local [user] section — the shadowing that caused #1005', async () => {
    // A stale `[user]` in a cloned repo silently reattributed every commit made in it,
    // while the sandbox's *global* identity was correct. Agents clone repos themselves,
    // so there is no per-repo hook to clean one up; only git's own env vars win.
    const dir = `${process.env.TMPDIR ?? '/tmp'}/ficus-git-identity-${Bun.hash(String(Math.random()))}`
    await Bun.$`mkdir -p ${dir}`.quiet()
    try {
      await Bun.$`git init -q .`.cwd(dir).quiet()
      await Bun.$`git config --local user.name Stale`.cwd(dir).quiet()
      await Bun.$`git config --local user.email stale@example.invalid`.cwd(dir).quiet()

      // Clear any ambient git identity: a git hook, `git rebase -x`, some CI
      // runners, or a Docker-runtime Ficus sandbox can already export these, and
      // they outrank the local [user] this probe is trying to demonstrate.
      const hermetic = {
        ...process.env,
        GIT_AUTHOR_NAME: undefined,
        GIT_AUTHOR_EMAIL: undefined,
        GIT_COMMITTER_NAME: undefined,
        GIT_COMMITTER_EMAIL: undefined,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      } as Record<string, string | undefined>

      const shadowed = await Bun.$`git var GIT_AUTHOR_IDENT`.cwd(dir).env(hermetic).quiet()
      expect(shadowed.stdout.toString()).toContain('stale@example.invalid')

      const env = gitIdentityEnv({ gitUserName: 'ficusagent', gitUserEmail: 'agent@users.noreply.github.com' })
      const resolved = await Bun.$`git var GIT_AUTHOR_IDENT`
        .cwd(dir)
        .env({ ...hermetic, ...env })
        .quiet()
      expect(resolved.stdout.toString()).toContain('agent@users.noreply.github.com')
      expect(resolved.stdout.toString()).not.toContain('stale@example.invalid')
    } finally {
      await Bun.$`rm -rf ${dir}`.quiet()
    }
  })
})

test('GitHub defaults beat host config while explicit global and squad overrides win per field', () => {
  const base = {
    githubDefaults: { gitUserName: 'GitHub Name', gitUserEmail: 'github@example.com' },
    hostGitUserName: 'Host',
    hostGitUserEmail: 'host@example.com',
    getSecret: secretStore({}),
  }
  expect(resolveGitHubIdentityFromMetadata(base)).toEqual(base.githubDefaults)
  expect(resolveGitHubIdentityFromMetadata({ ...base, getSecret: secretStore({ GIT_USER_NAME: 'Override' }) })).toEqual(
    { gitUserName: 'Override', gitUserEmail: 'github@example.com' }
  )
  expect(
    resolveGitHubIdentityFromMetadata({ ...base, metadata: { githubIdentity: { gitUserEmail: 'squad@example.com' } } })
  ).toEqual({ gitUserName: 'GitHub Name', gitUserEmail: 'squad@example.com' })
})
