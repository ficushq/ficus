import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const script = join(import.meta.dir, 'devbox-routing.sh')
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setup(): { root: string; work: string; project: string; devbox: string; log: string; bin: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'devbox-routing-')))
  dirs.push(root)
  const work = join(root, 'work')
  const project = join(work, 'project', 'nested')
  const devbox = join(root, 'box-devbox')
  const bin = join(root, 'bin')
  const log = join(root, 'calls')
  mkdirSync(project, { recursive: true })
  mkdirSync(devbox)
  mkdirSync(bin)
  writeFileSync(join(devbox, 'devbox.json'), '{"packages":[]}')
  writeFileSync(join(work, 'project', 'devbox.json'), '{"packages":[]}')
  writeFileSync(
    join(bin, 'devbox'),
    '#!/usr/bin/env bash\nprintf "%s|%s\\n" "$PWD" "$*" >> "$DEVBOX_ROUTING_LOG"\nif [ "$1" = shellenv ]; then echo "export ROUTED_SHELLENV=ready"; fi\nexit "${DEVBOX_EXIT:-0}"\n'
  )
  chmodSync(join(bin, 'devbox'), 0o755)
  return { root, work, project, devbox, log, bin }
}

type Fixture = ReturnType<typeof setup>

function run(directory: string, fixture: Fixture, command: string): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(['bash', '--noprofile', '--norc', '-c', `source '${script}'; ${command}`], {
    cwd: directory,
    env: {
      ...process.env,
      PATH: `${fixture.bin}:${process.env.PATH}`,
      FICUS_BOX_HOME: fixture.root,
      FICUS_DEVBOX_DIR: fixture.devbox,
      DEVBOX_ROUTING_LOG: fixture.log,
    },
  })
}

describe('VM devbox add routing', () => {
  test('routes bare adds to box devbox but keeps project devbox precedence', () => {
    const fixture = setup()
    expect(run(fixture.work, fixture, 'devbox add cowsay').exitCode).toBe(0)
    expect(run(fixture.project, fixture, 'devbox add jq').exitCode).toBe(0)

    expect(readFileSync(fixture.log, 'utf8').trim().split('\n')).toEqual([
      `${fixture.devbox}|add cowsay`,
      `${fixture.devbox}|shellenv --init-hook`,
      `${fixture.project}|add jq`,
    ])
  })

  test('leaves non-add commands in the caller directory', () => {
    const fixture = setup()
    expect(run(fixture.work, fixture, 'devbox shellenv').exitCode).toBe(0)
    expect(readFileSync(fixture.log, 'utf8').trim()).toBe(`${fixture.work}|shellenv`)
  })

  test('only marks successful routed mutations dirty and refreshes the current shell', () => {
    const fixture = setup()
    const success = run(fixture.work, fixture, 'devbox add cowsay; printf "$ROUTED_SHELLENV"')
    expect(success.exitCode).toBe(0)
    expect(success.stdout?.toString()).toBe('ready')
    const markers = () => readdirSync(fixture.devbox).filter((name) => name.startsWith('.shellenv-dirty.'))
    expect(markers()).toHaveLength(1)

    rmSync(join(fixture.devbox, markers()[0]))
    const failure = run(fixture.work, fixture, 'DEVBOX_EXIT=1 devbox add bad')
    expect(failure.exitCode).toBe(1)
    expect(markers()).toHaveLength(0)
  })
})
