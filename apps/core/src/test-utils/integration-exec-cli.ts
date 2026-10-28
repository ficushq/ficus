import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Real CLI command handler against a test-owned loopback Core endpoint; no credential files. */
export function writeIntegrationExecCli(root: string, binary: string): string {
  const dir = join(root, 'cli-bin')
  mkdirSync(dir, { recursive: true })
  const cliModule = new URL('../../../cli/src/commands/integration.ts', import.meta.url).pathname
  const commander = Bun.resolveSync('commander', cliModule)
  writeFileSync(
    join(dir, 'ficus'),
    `#!${process.execPath} --no-install
import { Command } from ${JSON.stringify(commander)}
import { registerIntegrationCommands } from ${JSON.stringify(cliModule)}
const program = new Command()
registerIntegrationCommands(program)
await program.parseAsync(process.argv)
`,
    { mode: 0o755 }
  )
  symlinkSync(binary, join(dir, 'ntn'))
  return dir
}
