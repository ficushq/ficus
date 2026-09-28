import { describe, expect, it } from 'bun:test'
import { buildSandboxChildEnv } from './env'

describe('buildSandboxChildEnv', () => {
  it('drops SSH_AUTH_SOCK regardless of value (host or in-sandbox)', () => {
    const env = buildSandboxChildEnv({
      SSH_AUTH_SOCK: '/Users/noah/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock',
      SSH_AGENT_PID: '1234',
    })
    expect(env.SSH_AUTH_SOCK).toBeUndefined()
    expect(env.SSH_AGENT_PID).toBeUndefined()
  })

  it('forwards exact-match allowlisted keys', () => {
    const env = buildSandboxChildEnv({
      HOME: '/root',
      USER: 'root',
      LANG: 'C.UTF-8',
      APP_URL: 'https://tau.example',
      GITHUB_TOKEN: 'ghs_xxx',
      GH_TOKEN: 'ghs_xxx',
      GIT_USER_NAME: 'Ficus Bot',
      GIT_USER_EMAIL: 'bot@tau',
      SSL_CERT_FILE: '/etc/ssl/cert.pem',
    })
    expect(env.HOME).toBe('/root')
    expect(env.USER).toBe('root')
    expect(env.LANG).toBe('C.UTF-8')
    expect(env.APP_URL).toBe('https://tau.example')
    expect(env.GITHUB_TOKEN).toBe('ghs_xxx')
    expect(env.GH_TOKEN).toBe('ghs_xxx')
    expect(env.GIT_USER_NAME).toBe('Ficus Bot')
    expect(env.GIT_USER_EMAIL).toBe('bot@tau')
    expect(env.SSL_CERT_FILE).toBe('/etc/ssl/cert.pem')
  })

  it('forwards prefix-matched keys (FICUS_, TAU_, NIX_, DEVBOX_, XDG_, LC_)', () => {
    const env = buildSandboxChildEnv({
      FICUS_SANDBOX_ID: 'sb1',
      FICUS_API_URL: 'http://tau-api:3000',
      FICUS_PASSWORD: 's3cret',
      NIX_PROFILES: '/nix/var/nix/profiles/default /root/.nix-profile',
      DEVBOX_SHELL_ENABLED: '1',
      XDG_CONFIG_HOME: '/root/.config',
      LC_CTYPE: 'C.UTF-8',
    })
    expect(env.FICUS_SANDBOX_ID).toBe('sb1')
    expect(env.FICUS_API_URL).toBe('http://tau-api:3000')
    expect(env.FICUS_PASSWORD).toBe('s3cret')
    expect(env.NIX_PROFILES).toContain('/nix')
    expect(env.DEVBOX_SHELL_ENABLED).toBe('1')
    expect(env.XDG_CONFIG_HOME).toBe('/root/.config')
    expect(env.LC_CTYPE).toBe('C.UTF-8')
  })

  it('keeps both FICUS_ and TAU_ spellings for one release', () => {
    const env = buildSandboxChildEnv({ FICUS_BOX_HOME: '/h', TAU_BOX_HOME: '/h' })
    expect(env.FICUS_BOX_HOME).toBe('/h')
    expect(env.TAU_BOX_HOME).toBe('/h')
  })

  it('emits a TAU_ alias for every FICUS_ key, overrides included (dual-emit, one release)', () => {
    const env = buildSandboxChildEnv(
      { FICUS_API_URL: 'http://tau-api:3000', FICUS_SANDBOX_ID: 'sb1' },
      { FICUS_TOKEN: 'agent-token', FICUS_API_URL: 'http://override:3000' }
    )
    expect(env.TAU_TOKEN).toBe('agent-token')
    expect(env.FICUS_API_URL).toBe('http://override:3000')
    expect(env.TAU_API_URL).toBe('http://override:3000')
    expect(env.TAU_SANDBOX_ID).toBe('sb1')
  })

  it('excludes KUBERNETES_* and other non-allowlisted keys', () => {
    const env = buildSandboxChildEnv({
      KUBERNETES_SERVICE_HOST: '10.0.0.1',
      KUBERNETES_PORT: 'tcp://10.0.0.1:443',
      TAU_API_PORT_3000_TCP_ADDR: '10.0.0.2',
      EXECUTOR_PORT: '50051',
      WORKSPACE_PATH: '/workspace',
      EDITOR: 'vim',
      NODE_ENV: 'production',
      DOCKER_HOST: 'tcp://docker:2375',
      RANDOM_HOST_VAR: 'leak',
    })
    expect(env.KUBERNETES_SERVICE_HOST).toBeUndefined()
    expect(env.KUBERNETES_PORT).toBeUndefined()
    expect(env.TAU_API_PORT_3000_TCP_ADDR).toBeUndefined()
    expect(env.EXECUTOR_PORT).toBeUndefined()
    expect(env.WORKSPACE_PATH).toBeUndefined()
    expect(env.EDITOR).toBeUndefined()
    expect(env.NODE_ENV).toBeUndefined()
    expect(env.DOCKER_HOST).toBeUndefined()
    expect(env.RANDOM_HOST_VAR).toBeUndefined()
  })

  it('injects sandbox defaults when keys are missing', () => {
    const env = buildSandboxChildEnv({})
    expect(env.HOME).toBe('/root')
    expect(env.PATH).toContain('/root/.nix-profile/bin')
    expect(env.PATH).toContain('/usr/bin')
    expect(env.SHELL).toBe('/bin/bash')
    expect(env.TERM).toBe('xterm-256color')
  })

  it('respects existing values over defaults', () => {
    const env = buildSandboxChildEnv({
      HOME: '/home/agent',
      PATH: '/custom/bin',
      SHELL: '/bin/zsh',
      TERM: 'tmux-256color',
    })
    expect(env.HOME).toBe('/home/agent')
    expect(env.PATH).toBe('/custom/bin')
    expect(env.SHELL).toBe('/bin/zsh')
    expect(env.TERM).toBe('tmux-256color')
  })

  it('applies caller overrides last while still blocking SSH agent variables', () => {
    const env = buildSandboxChildEnv(
      { HOME: '/root', SSH_AUTH_SOCK: '/host/agent.sock' },
      { CUSTOM_VAR: 'hello', HOME: '/override', SSH_AUTH_SOCK: '/tmp/agent.sock', SSH_AGENT_PID: '1234' }
    )
    expect(env.HOME).toBe('/override')
    expect(env.CUSTOM_VAR).toBe('hello')
    expect(env.SSH_AUTH_SOCK).toBeUndefined()
    expect(env.SSH_AGENT_PID).toBeUndefined()
  })

  it('skips undefined values', () => {
    const env = buildSandboxChildEnv({ HOME: undefined, LANG: 'C' })
    expect(env.HOME).toBe('/root') // default kicks in
    expect(env.LANG).toBe('C')
  })
})

describe("git's own identity variables reach the agent's git", () => {
  // Regression guard for #1005/#1007. Core resolves the identity and injects it
  // into the pod/box env, but THIS allowlist gates every agent bash and PTY
  // child (bash.ts:115, shell.ts:81), and Core deliberately forwards no
  // per-command env overrides. So a name missing here is stripped before `git`
  // runs, and the identity fix silently becomes a no-op on k8s and VM while
  // still appearing to work on Docker (which inherits container env directly).
  const identity = {
    GIT_AUTHOR_NAME: 'tauagent',
    GIT_AUTHOR_EMAIL: 'agent@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'tauagent',
    GIT_COMMITTER_EMAIL: 'agent@users.noreply.github.com',
  }

  it.each(Object.keys(identity))('forwards %s', (key) => {
    expect(buildSandboxChildEnv(identity)[key]).toBe(identity[key as keyof typeof identity])
  })

  it('forwards the whole set, so a partial allowlist cannot half-fix attribution', () => {
    // A half-resolved identity is the exact #1005 failure mode: the stale local
    // [user] email keeps winning, which is the field CLA checks match on.
    expect(buildSandboxChildEnv(identity)).toMatchObject(identity)
  })

  it('still forwards the legacy GIT_USER_* pair the image translates', () => {
    const env = buildSandboxChildEnv({ GIT_USER_NAME: 'tauagent', GIT_USER_EMAIL: 'agent@tau' })
    expect(env.GIT_USER_NAME).toBe('tauagent')
    expect(env.GIT_USER_EMAIL).toBe('agent@tau')
  })
})

describe('build parallelism defaults from FICUS_BOX_CPUS', () => {
  it('derives CARGO_BUILD_JOBS / MAKEFLAGS / GOMAXPROCS / CMAKE_BUILD_PARALLEL_LEVEL from FICUS_BOX_CPUS', () => {
    const env = buildSandboxChildEnv({ FICUS_BOX_CPUS: '2' })
    expect(env.CARGO_BUILD_JOBS).toBe('2')
    expect(env.MAKEFLAGS).toBe('-j2')
    expect(env.GOMAXPROCS).toBe('2')
    expect(env.CMAKE_BUILD_PARALLEL_LEVEL).toBe('2')
  })

  it('never overrides an explicit value from the source env or the caller', () => {
    const env = buildSandboxChildEnv({ FICUS_BOX_CPUS: '2', MAKEFLAGS: '-j8' }, { GOMAXPROCS: '1' })
    expect(env.MAKEFLAGS).toBe('-j8')
    expect(env.GOMAXPROCS).toBe('1')
    expect(env.CARGO_BUILD_JOBS).toBe('2')
  })

  it('sets nothing when FICUS_BOX_CPUS is absent or malformed', () => {
    expect(buildSandboxChildEnv({}).CARGO_BUILD_JOBS).toBeUndefined()
    expect(buildSandboxChildEnv({ FICUS_BOX_CPUS: '0' }).CARGO_BUILD_JOBS).toBeUndefined()
    expect(buildSandboxChildEnv({ FICUS_BOX_CPUS: 'lots' }).MAKEFLAGS).toBeUndefined()
  })
})
