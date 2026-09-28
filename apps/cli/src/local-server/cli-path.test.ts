import { describe, expect, it } from 'bun:test'
import { checkCliOnPath, cliInstallDir, cliPathHintLines, detectShell, type CliPathDeps } from './cli-path'

const HOME = '/home/fixture'
const INSTALLED = '/home/fixture/.tau/bin/ficus'

/** An identity realpath — the unit tests never touch the real filesystem. */
const identity = (path: string) => path

function deps(overrides: Partial<CliPathDeps> = {}): CliPathDeps {
  return {
    env: { HOME },
    home: HOME,
    which: () => INSTALLED,
    realpath: identity,
    ...overrides,
  }
}

describe('cliInstallDir', () => {
  it('defaults to $HOME/.tau/bin, matching scripts/install.sh', () => {
    expect(cliInstallDir({}, HOME)).toBe('/home/fixture/.tau/bin')
  })

  it('honours FICUS_INSTALL_DIR, matching scripts/install.sh', () => {
    expect(cliInstallDir({ FICUS_INSTALL_DIR: '/opt/ficus/bin' }, HOME)).toBe('/opt/ficus/bin')
  })

  it('expands a tilde in FICUS_INSTALL_DIR against the given home', () => {
    expect(cliInstallDir({ FICUS_INSTALL_DIR: '~/bin' }, HOME)).toBe('/home/fixture/bin')
  })
})

describe('checkCliOnPath', () => {
  it('is on PATH when `ficus` resolves to the installed binary', () => {
    const status = checkCliOnPath(deps())
    expect(status.onPath).toBe(true)
    expect(status.installedBinary).toBe(INSTALLED)
    expect(status.resolvedBinary).toBe(INSTALLED)
  })

  it('is NOT on PATH when nothing on PATH answers to `ficus`', () => {
    const status = checkCliOnPath(deps({ which: () => null }))
    expect(status.onPath).toBe(false)
    expect(status.resolvedBinary).toBeNull()
  })

  it('is NOT on PATH when a DIFFERENT ficus resolves first (stale install, unrelated shim)', () => {
    const status = checkCliOnPath(deps({ which: () => '/usr/local/bin/ficus' }))
    expect(status.onPath).toBe(false)
    expect(status.resolvedBinary).toBe('/usr/local/bin/ficus')
  })

  it('compares by realpath, so a symlinked shim still counts as on PATH', () => {
    const status = checkCliOnPath(
      deps({
        which: () => '/usr/local/bin/ficus',
        realpath: (path) => (path === INSTALLED || path === '/usr/local/bin/ficus' ? INSTALLED : path),
      })
    )
    expect(status.onPath).toBe(true)
  })

  it('respects FICUS_INSTALL_DIR when deciding the installed binary path', () => {
    const status = checkCliOnPath(
      deps({ env: { HOME, FICUS_INSTALL_DIR: '/opt/ficus/bin' }, which: () => '/opt/ficus/bin/ficus' })
    )
    expect(status.installDir).toBe('/opt/ficus/bin')
    expect(status.installedBinary).toBe('/opt/ficus/bin/ficus')
    expect(status.onPath).toBe(true)
  })
})

describe('detectShell', () => {
  it('reads the shell name from $SHELL', () => {
    expect(detectShell({ SHELL: '/bin/zsh' })).toBe('zsh')
    expect(detectShell({ SHELL: '/bin/bash' })).toBe('bash')
    expect(detectShell({ SHELL: '/usr/local/bin/fish' })).toBe('fish')
  })

  it('falls back to "other" for anything else, including no $SHELL at all', () => {
    expect(detectShell({ SHELL: '/bin/tcsh' })).toBe('other')
    expect(detectShell({})).toBe('other')
  })
})

describe('cliPathHintLines', () => {
  const onPathStatus = {
    onPath: true,
    installDir: '/home/fixture/.tau/bin',
    installedBinary: INSTALLED,
    resolvedBinary: INSTALLED,
  }
  const offPathStatus = {
    onPath: false,
    installDir: '/home/fixture/.tau/bin',
    installedBinary: INSTALLED,
    resolvedBinary: null,
  }

  it('says nothing extra when already on PATH', () => {
    expect(cliPathHintLines(onPathStatus, 'zsh')).toEqual([])
    expect(cliPathHintLines(onPathStatus, 'other')).toEqual([])
  })

  it('gives the zsh export command and the ~/.zshrc profile line when not on PATH', () => {
    const lines = cliPathHintLines(offPathStatus, 'zsh').join('\n')
    expect(lines).toContain('ficus is not on PATH yet')
    expect(lines).toContain(INSTALLED)
    expect(lines).toContain('export PATH="/home/fixture/.tau/bin:$PATH"')
    expect(lines).toContain(`echo 'export PATH="/home/fixture/.tau/bin:$PATH"' >> ~/.zshrc`)
    expect(lines).toContain('or open a new terminal')
    expect(lines).not.toContain('.bashrc')
  })

  it('gives the bash export command and the ~/.bashrc profile line when not on PATH', () => {
    const lines = cliPathHintLines(offPathStatus, 'bash').join('\n')
    expect(lines).toContain('export PATH="/home/fixture/.tau/bin:$PATH"')
    expect(lines).toContain(`echo 'export PATH="/home/fixture/.tau/bin:$PATH"' >> ~/.bashrc`)
    expect(lines).not.toContain('.zshrc')
  })

  it('gives the fish equivalent (set -gx / fish_add_path), never the POSIX export syntax, for fish', () => {
    const lines = cliPathHintLines(offPathStatus, 'fish').join('\n')
    expect(lines).toContain('set -gx PATH "/home/fixture/.tau/bin" $PATH')
    expect(lines).toContain('fish_add_path /home/fixture/.tau/bin')
    expect(lines).not.toContain('export PATH=')
    expect(lines).not.toContain('.zshrc')
    expect(lines).not.toContain('.bashrc')
  })

  it('falls back to the plain export command with no profile-file guess for an unrecognized shell', () => {
    const lines = cliPathHintLines(offPathStatus, 'other').join('\n')
    expect(lines).toContain('export PATH="/home/fixture/.tau/bin:$PATH"')
    expect(lines).toContain('or open a new terminal')
    expect(lines).not.toContain('.zshrc')
    expect(lines).not.toContain('.bashrc')
    expect(lines).not.toContain('fish_add_path')
  })

  it('never prints anything password- or link-shaped (no secrets leak through this path)', () => {
    const lines = cliPathHintLines(offPathStatus, 'zsh').join('\n')
    expect(lines).not.toContain('#setup=')
    expect(lines).not.toContain('password')
  })
})
