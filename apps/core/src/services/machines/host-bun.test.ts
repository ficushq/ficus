import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../../../../..')
const bootstrap = join(root, 'scripts/machine/bootstrap.sh')
const pin = readFileSync(join(root, '.bun-version'), 'utf8').trim()
const roots: string[] = []
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('VM host Bun source contract', () => {
  test('standalone bootstrap pin equals .bun-version', () => {
    const script = readFileSync(bootstrap, 'utf8')
    expect(script.match(/^BUN_VERSION="([^"]+)"$/m)?.[1]).toBe(pin)
    expect(script).not.toContain('repo has no .bun-version')
  })

  test('machine image derives install and marker version from .bun-version, not an overridable ARG', () => {
    const dockerfile = readFileSync(join(root, 'packages/machine-image/Dockerfile'), 'utf8')
    expect(dockerfile).toContain('COPY .bun-version /opt/ficus/bun-version')
    expect(dockerfile).not.toMatch(/^ARG BUN_VERSION/m)
    expect(dockerfile).toContain('BUN_VERSION="$(cat /opt/ficus/bun-version)"')
    expect(dockerfile).toContain('[ "$(/opt/ficus/bin/bun --version)" = "${BUN_VERSION}" ]')
    expect(dockerfile).toContain('"$(cat /opt/ficus/bun-version)" "${NIX_VERSION}"')
  })
})

function fixture(old = '1.2.23', mode = '') {
  const dir = mkdtempSync(join(tmpdir(), 'host-bun-'))
  roots.push(dir)
  const ficus = join(dir, 'opt/ficus')
  mkdirSync(join(ficus, 'bun/bin'), { recursive: true })
  mkdirSync(join(ficus, 'bin'))
  mkdirSync(join(dir, 'commands'))
  mkdirSync(join(dir, 'home'))
  const binary = join(ficus, 'bun/bin/bun')
  writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' '${old}'\n`, { mode: 0o755 })
  symlinkSync(binary, join(ficus, 'bin/bun'))
  writeFileSync(
    join(ficus, 'prebaked'),
    JSON.stringify({ bunVersion: old, nixVersion: 'old-nix', devboxVersion: 'old-devbox' })
  )
  // The network is replaced at the process boundary, not the installer function:
  // the real stage/version/lock/rename code executes against this owned root.
  writeFileSync(
    join(dir, 'commands/curl'),
    `#!/bin/sh
printf 'download\\n' >> "$FIXTURE_ROOT/downloads"
if [ "$FIXTURE_MODE" = download-failed ]; then exit 22; fi
if [ "$FIXTURE_MODE" = interrupted ]; then exit 130; fi
cat <<'INSTALLER'
set -eu
if [ "$FIXTURE_MODE" = profile ]; then mkdir -p "$HOME"; echo installer-profile > "$HOME/.bashrc"; fi
mkdir -p "$BUN_INSTALL/bin"
cat > "$BUN_INSTALL/bin/bun" <<'BINARY'
#!/bin/sh
case "$FIXTURE_MODE:$0" in
  wrong:*) echo 0.0.0;;
  post-invalid:*/bun/bin/bun) echo 0.0.0;;
  *) echo ${pin};;
esac
BINARY
chmod 755 "$BUN_INSTALL/bin/bun"
INSTALLER
`,
    { mode: 0o755 }
  )
  const env = {
    ...process.env,
    FICUS_HOST_ROOT: dir,
    FIXTURE_ROOT: dir,
    HOME: join(dir, 'home'),
    FIXTURE_MODE: mode,
    PATH: `${dir}/commands:${process.env.PATH}`,
  }
  const run = (body = 'install_bun') =>
    Bun.spawnSync(
      [
        'timeout',
        '3',
        'bash',
        '-c',
        'script=$1; shift; source "$script"; SUDO=(); BUN_LOCK_TIMEOUT_SECS=0; ' + body,
        'fixture',
        bootstrap,
      ],
      { env }
    )
  const version = () => Bun.spawnSync([binary, '--version'], { env }).stdout.toString().trim()
  return { dir, ficus, binary, env, run, version }
}

describe('Bun-only host convergence on owned host roots', () => {
  test('prebaked bootstrap converges only Bun, leaving nix/devbox and baked marker alone', () => {
    const f = fixture()
    const marker = readFileSync(join(f.ficus, 'prebaked'), 'utf8')
    const result = f.run(`
require_machine_layout_ready() { :; }
make_dirs() { :; }
install_base_packages() { exit 81; }
install_docker_packages() { exit 82; }
install_nix() { exit 83; }
install_devbox() { exit 84; }
install_browser() { exit 85; }
write_manifest() { :; }
ensure_box_port_reservation() { :; }
verify_browser() { :; }
main`)
    expect(result.exitCode).toBe(0)
    expect(f.version()).toBe(pin)
    expect(readFileSync(join(f.ficus, 'prebaked'), 'utf8')).toBe(marker)
  })

  test('atomic replacement retains old executable inode and rollback binary; repeats do not download', () => {
    const f = fixture()
    const oldInode = statSync(f.binary).ino
    expect(f.run().exitCode).toBe(0)
    expect(f.version()).toBe(pin)
    expect(statSync(f.binary).ino).not.toBe(oldInode)
    expect(
      Bun.spawnSync([`${f.binary}.previous`, '--version'])
        .stdout.toString()
        .trim()
    ).toBe('1.2.23')
    const inode = statSync(f.binary).ino
    expect(f.run().exitCode).toBe(0)
    expect(statSync(f.binary).ino).toBe(inode)
    expect(readFileSync(join(f.dir, 'downloads'), 'utf8')).toBe('download\n')
  })

  for (const mode of ['wrong', 'download-failed', 'post-invalid']) {
    test(`failure ${mode} keeps the previous runnable version and does not claim success`, () => {
      const f = fixture('1.2.23', mode)
      const before = readFileSync(f.binary, 'utf8')
      expect(f.run().exitCode).not.toBe(0)
      expect(readFileSync(f.binary, 'utf8')).toBe(before)
      expect(f.version()).toBe('1.2.23')
    })
  }

  test('link publication failure rolls the executable back and leaves the conflicting path alone', () => {
    const f = fixture()
    rmSync(join(f.ficus, 'bin/bun'))
    mkdirSync(join(f.ficus, 'bin/bun'))
    expect(f.run().exitCode).not.toBe(0)
    expect(f.version()).toBe('1.2.23')
    expect(statSync(join(f.ficus, 'bin/bun')).isDirectory()).toBe(true)
  })

  test('installer profile side effects stay inside the disposable stage, never the real admin HOME', () => {
    const f = fixture('1.2.23', 'profile')
    expect(f.run().exitCode).toBe(0)
    expect(f.version()).toBe(pin)
    expect(existsSync(join(f.dir, 'home/.bashrc'))).toBe(false)
  })

  test('already pinned Bun is not downloaded or backed up', () => {
    const f = fixture(pin)
    expect(f.run().exitCode).toBe(0)
    expect(existsSync(join(f.dir, 'downloads'))).toBe(false)
    expect(existsSync(`${f.binary}.previous`)).toBe(false)
  })

  test('refuses symlinked installation directories without touching their target', () => {
    const f = fixture()
    const target = join(f.dir, 'foreign')
    mkdirSync(target)
    rmSync(join(f.ficus, 'bun'), { recursive: true })
    symlinkSync(target, join(f.ficus, 'bun'))
    expect(f.run().exitCode).not.toBe(0)
    expect(existsSync(join(f.dir, 'downloads'))).toBe(false)
  })

  test('bounded lock refusal neither downloads nor changes an installed executable', () => {
    const f = fixture()
    const result = f.run('exec 8>"$FICUS_ROOT/bun-install.lock"; flock -x 8; install_bun')
    expect(result.exitCode).not.toBe(0)
    expect(f.version()).toBe('1.2.23')
    expect(existsSync(join(f.dir, 'downloads'))).toBe(false)
  })
})

const prebakedBootstrap = `
require_machine_layout_ready() { :; }
make_dirs() { :; }
write_manifest() { echo manifest > "$FIXTURE_ROOT/continued"; }
ensure_box_port_reservation() { :; }
verify_browser() { :; }
main`

describe('prebaked Bun convergence preserves availability on safe failed replacement', () => {
  for (const mode of ['download-failed', 'wrong', 'post-invalid']) {
    test(`${mode} warns and continues with the intact existing runtime`, () => {
      const f = fixture('1.2.23', mode)
      const before = readFileSync(f.binary, 'utf8')
      const result = f.run(prebakedBootstrap)
      expect(result.exitCode).toBe(0)
      expect(result.stderr.toString()).toContain('WARNING')
      expect(readFileSync(f.binary, 'utf8')).toBe(before)
      expect(f.version()).toBe('1.2.23')
      expect(existsSync(join(f.dir, 'continued'))).toBe(true)
    })
  }

  test('lock contention defers the upgrade without withdrawing the working host', () => {
    const f = fixture()
    const result = f.run('exec 8>"$FICUS_ROOT/bun-install.lock"; flock -x 8; ' + prebakedBootstrap)
    expect(result.exitCode).toBe(0)
    expect(result.stderr.toString()).toContain('WARNING')
    expect(f.version()).toBe('1.2.23')
    expect(existsSync(join(f.dir, 'downloads'))).toBe(false)
    expect(existsSync(join(f.dir, 'continued'))).toBe(true)
  })

  test('no usable old binary is still a fatal bootstrap failure', () => {
    const f = fixture('1.2.23', 'download-failed')
    rmSync(f.binary)
    expect(f.run(prebakedBootstrap).exitCode).not.toBe(0)
    expect(existsSync(join(f.dir, 'continued'))).toBe(false)
  })

  test('failed rollback remains fatal even when a broken replacement is executable', () => {
    const f = fixture('1.2.23', 'post-invalid')
    writeFileSync(
      join(f.dir, 'commands/mv'),
      `#!/bin/sh
case "$*" in */restore*) exit 87;; esac
exec /usr/bin/mv "$@"
`,
      { mode: 0o755 }
    )
    const result = f.run(prebakedBootstrap)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain('rollback failed')
    expect(existsSync(`${f.binary}.previous`)).toBe(true)
    expect(existsSync(join(f.dir, 'continued'))).toBe(false)
  })
})

test('a deferred prebaked run reports actual Bun and preserves retry intent in capabilities and manifest', () => {
  const f = fixture('1.2.23', 'download-failed')
  const result = f.run(
    prebakedBootstrap.replace('write_manifest() { echo manifest > "$FIXTURE_ROOT/continued"; }', '') +
      `
detect_docker() { echo none; }
detect_forwarding() { echo yes; }
detect_box_ports() { echo reserved; }
detect_socket_bind() { echo unsupported; }
print_capabilities`
  )
  expect(result.exitCode).toBe(0)
  const caps = JSON.parse(result.stdout.toString().split('FICUS_CAPS_JSON: ')[1]!)
  expect(caps.bunConvergence).toBe('deferred')
  const manifest = JSON.parse(readFileSync(join(f.ficus, 'manifest.json'), 'utf8'))
  expect(manifest.bunVersion).toBe('1.2.23')
  expect(manifest.bunConvergence).toBe('deferred')
})

test('prebaked Bun deferral does not swallow explicit interruption', () => {
  const f = fixture('1.2.23', 'interrupted')
  expect(f.run(prebakedBootstrap).exitCode).toBe(130)
  expect(existsSync(join(f.dir, 'continued'))).toBe(false)
  expect(f.version()).toBe('1.2.23')
})

test('an already pinned symlinked Bun executable is refused without following or changing its target', () => {
  const f = fixture(pin)
  const foreign = join(f.dir, 'foreign-bun')
  writeFileSync(foreign, readFileSync(f.binary), { mode: 0o755 })
  rmSync(f.binary)
  symlinkSync(foreign, f.binary)
  expect(f.run().exitCode).not.toBe(0)
  expect(existsSync(join(f.dir, 'downloads'))).toBe(false)
  expect(readFileSync(foreign, 'utf8')).toContain(pin)
})

test('a non-regular Bun lock is refused without blocking on open', () => {
  const f = fixture()
  expect(Bun.spawnSync(['mkfifo', join(f.ficus, 'bun-install.lock')]).exitCode).toBe(0)
  const result = f.run()
  expect(result.exitCode).toBe(3)
  expect(f.version()).toBe('1.2.23')
  expect(existsSync(join(f.dir, 'downloads'))).toBe(false)
})
