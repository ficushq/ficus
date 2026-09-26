import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'bun:test'
import { Command } from 'commander'
import { invokedCliName, registerSkillCommands } from './skill'

const tempDirs: string[] = []

async function makeTempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'ficus-skill-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function run(args: string[]) {
  const program = new Command()
  program.exitOverride()
  registerSkillCommands(program)
  await program.parseAsync(args, { from: 'user' })
}

describe('skill CLI commands', () => {
  it('installs ficus-memory to shared project skills for pi', async () => {
    const cwd = await makeTempDir()
    const originalCwd = process.cwd()
    process.chdir(cwd)
    try {
      await run(['skill', 'install', 'ficus-memory', '--agent', 'pi'])
    } finally {
      process.chdir(originalCwd)
    }

    const skill = await readFile(join(cwd, '.agents/skills/ficus-memory/SKILL.md'), 'utf8')
    expect(skill).toContain('name: ficus-memory')
    expect(skill).toContain('## Installed Ficus CLI')
    expect(skill).not.toContain('<ficus-cli>')
    expect(skill).not.toContain('FICUS_BIN')
    await expect(stat(join(cwd, '.agents/skills/ficus-memory/install'))).rejects.toThrow()
  })

  it('replaces every <ficus-cli> placeholder with the installed CLI path', async () => {
    const cwd = await makeTempDir()
    const targetDir = join(cwd, 'custom-skills')

    await run(['skill', 'install', 'ficus-memory', '--agent', 'custom', '--target-dir', targetDir])

    const cli = invokedCliName()
    const source = await readFile(join(import.meta.dir, '../../../../external/skills/ficus-memory/SKILL.md'), 'utf8')
    expect(source).toContain('<ficus-cli> memory')
    for (const file of await readdir(join(targetDir, 'ficus-memory'))) {
      const text = await readFile(join(targetDir, 'ficus-memory', file), 'utf8')
      expect({ file, placeholder: text.includes('<ficus-cli>') }).toEqual({ file, placeholder: false })
    }
    const skill = await readFile(join(targetDir, 'ficus-memory/SKILL.md'), 'utf8')
    expect(skill).toContain(`\`${cli} squad list\``)
    expect(skill).toContain(`${cli} memory get /memory/map.md --squad <squad-id>`)
  })

  it('never touches a sibling skill directory, such as an old install under the pre-rename name', async () => {
    const cwd = await makeTempDir()
    const targetDir = join(cwd, 'custom-skills')
    const sibling = join(targetDir, 'tau') // the pre-rename skill dir, left for the user to delete (D7)
    await mkdir(sibling, { recursive: true })
    await writeFile(join(sibling, 'SKILL.md'), 'old skill\n')

    await run(['skill', 'install', 'ficus', '--agent', 'custom', '--target-dir', targetDir])
    await run(['skill', 'install', 'ficus-memory', '--agent', 'custom', '--target-dir', targetDir, '--force'])

    expect(await readFile(join(sibling, 'SKILL.md'), 'utf8')).toBe('old skill\n')
    expect((await readdir(targetDir)).sort()).toEqual(['ficus', 'ficus-memory', 'tau'])
  })

  it('installs ficus-memory to claude project skills because claude does not use shared project skills', async () => {
    const cwd = await makeTempDir()
    const originalCwd = process.cwd()
    process.chdir(cwd)
    try {
      await run(['skill', 'install', 'ficus-memory', '--agent', 'claude-code'])
    } finally {
      process.chdir(originalCwd)
    }

    const skill = await readFile(join(cwd, '.claude/skills/ficus-memory/SKILL.md'), 'utf8')
    expect(skill).toContain('name: ficus-memory')
  })

  it('installs ficus-memory to a custom target directory', async () => {
    const cwd = await makeTempDir()
    const targetDir = join(cwd, 'custom-skills')

    await run(['skill', 'install', 'ficus-memory', '--agent', 'custom', '--target-dir', targetDir])

    const skill = await readFile(join(targetDir, 'ficus-memory/SKILL.md'), 'utf8')
    expect(skill).toContain('name: ficus-memory')
  })

  it('installs the ficus operator skill from external/skills', async () => {
    const cwd = await makeTempDir()
    const targetDir = join(cwd, 'custom-skills')

    await run(['skill', 'install', 'ficus', '--agent', 'custom', '--target-dir', targetDir])

    const skill = await readFile(join(targetDir, 'ficus/SKILL.md'), 'utf8')
    expect(skill).toContain('name: ficus\n')
    expect(skill).toContain('## Installed Ficus CLI')
  })

  it('installs the ficus-reviewer skill from external/skills', async () => {
    const cwd = await makeTempDir()
    const targetDir = join(cwd, 'custom-skills')

    await run(['skill', 'install', 'ficus-reviewer', '--agent', 'custom', '--target-dir', targetDir])

    const skill = await readFile(join(targetDir, 'ficus-reviewer/SKILL.md'), 'utf8')
    expect(skill).toContain('name: ficus-reviewer\n')
    expect(skill).toContain('Requires the `ficus` skill.')
    expect(skill).toContain('## Installed Ficus CLI')
    expect(skill).not.toContain('<ficus-cli>')
  })

  it('rejects skills that are not bundled, including the pre-rename names', async () => {
    await expect(run(['skill', 'install', 'nope', '--agent', 'pi'])).rejects.toThrow(
      /unsupported skill: nope\. Supported skills: ficus-memory, ficus, ficus-reviewer/
    )
    await expect(run(['skill', 'install', 'tau-memory', '--agent', 'pi'])).rejects.toThrow(/unsupported skill/)
  })

  it('requires a target directory for custom agents', async () => {
    await expect(run(['skill', 'install', 'ficus-memory', '--agent', 'custom'])).rejects.toThrow(
      /custom agent requires --target-dir/
    )
  })

  it('refuses to overwrite an existing skill unless force is set', async () => {
    const cwd = await makeTempDir()
    const originalCwd = process.cwd()
    process.chdir(cwd)
    try {
      await run(['skill', 'install', 'ficus-memory', '--agent', 'codex'])
      await expect(run(['skill', 'install', 'ficus-memory', '--agent', 'codex'])).rejects.toThrow(/already exists/)
      await run(['skill', 'install', 'ficus-memory', '--agent', 'codex', '--force'])
    } finally {
      process.chdir(originalCwd)
    }
  })
})

describe('invokedCliName', () => {
  const noPath = { PATH: '' }

  it('returns ficus for a binary named ficus', () => {
    expect(invokedCliName({ env: { ...noPath, _: '/usr/local/bin/ficus' }, argv: ['/$bunfs/root/ficus'] })).toBe(
      'ficus'
    )
  })

  it('returns ficus for the built ficus.js invoked through PATH, when ficus is on PATH too', async () => {
    const bin = await makeTempDir()
    await writeFile(join(bin, 'ficus'), '#!/bin/sh\n', { mode: 0o755 })
    expect(invokedCliName({ env: { PATH: bin, _: join(bin, 'ficus.js') }, argv: ['bun', join(bin, 'ficus.js')] })).toBe(
      'ficus'
    )
    // Without a `ficus` on PATH the skill gets the script's own path instead.
    expect(invokedCliName({ env: { ...noPath, _: '/opt/cli/ficus.js' }, argv: ['bun', '/opt/cli/ficus.js'] })).toBe(
      '/opt/cli/ficus.js'
    )
  })

  it('returns the absolute script path when run as a file, so the skill works off PATH', () => {
    expect(
      invokedCliName({ env: { ...noPath, _: '/usr/bin/bun' }, argv: ['bun', '/repo/apps/cli/dist/ficus.js'] })
    ).toBe('/repo/apps/cli/dist/ficus.js')
  })

  it('has no pre-rename branch: a binary named tau is treated like any other path', () => {
    const oldBinary = join('/home/u/.tau/bin', 'tau')
    expect(invokedCliName({ env: { ...noPath, _: oldBinary }, argv: [join('/$bunfs/root', 'tau')] })).toBe(oldBinary)
  })

  it('falls back to ficus when nothing else identifies the CLI', () => {
    expect(invokedCliName({ env: noPath, argv: ['/$bunfs/root/ficus'] })).toBe('ficus')
  })
})
