import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// The CLI's entry point, as shipped: the bundle `bun run build` writes to
// dist/ficus.js, and the dev launcher bin/ficus. Both must present themselves
// as `ficus`, and nothing may be named after the pre-rename binary.
const cliRoot = join(import.meta.dir, '..')
const scratch = mkdtempSync(join(tmpdir(), 'ficus-cli-entry-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function helpOf(command: string[]): string {
  const result = Bun.spawnSync(command, { cwd: cliRoot, stdout: 'pipe', stderr: 'pipe' })
  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toEqual({ exitCode: 0, stderr: '' })
  return result.stdout.toString()
}

describe('the ficus CLI entry point', () => {
  test('the package build writes dist/ficus.js', () => {
    const build = (JSON.parse(readFileSync(join(cliRoot, 'package.json'), 'utf8')) as { scripts: { build: string } })
      .scripts.build
    expect(build).toContain('--outfile=dist/ficus.js')
    expect(build).toContain('chmod +x dist/ficus.js')
    expect(build).not.toMatch(/\btau\.js\b/)
  })

  test('the built bundle prints `Usage: ficus`', () => {
    const outfile = join(scratch, 'ficus.js')
    const built = Bun.spawnSync(['bun', 'build', 'src/index.ts', `--outfile=${outfile}`, '--target=bun'], {
      cwd: cliRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(built.exitCode).toBe(0)
    const help = helpOf(['bun', outfile, '--help'])
    expect(help.startsWith('Usage: ficus ')).toBe(true)
    expect(help).toContain('Ficus CLI')
  })

  test('the dev launcher is bin/ficus, and it prints `Usage: ficus`', () => {
    expect(existsSync(join(cliRoot, 'bin', 'ficus'))).toBe(true)
    expect(existsSync(join(cliRoot, 'bin', 'tau'))).toBe(false)
    expect(helpOf([join(cliRoot, 'bin', 'ficus'), '--help']).startsWith('Usage: ficus ')).toBe(true)
  })
})
