import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BigbrainClient } from './client'
import { BigbrainBindings } from './local-bindings'

const checkout = process.env.FICUS_BIGBRAIN_UPSTREAM_CHECKOUT
const pin = 'cb61ea00bf9b85cb4cea1c8717cedfb0a40896ed'
/** Opt-in: use a separately prepared, pinned checkout with dependencies; never installs software. */
test.skipIf(!checkout)(
  'pinned upstream stdio reads, pages, searches and attributes a synthetic contribution',
  async () => {
    const revision = Bun.spawnSync(['git', '-C', checkout!, 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'pipe' })
    expect(revision.stdout.toString().trim()).toBe(pin)
    const root = await realpath(await mkdtemp(join(tmpdir(), 'ficus-bigbrain-upstream-')))
    const previousEnv = { ...process.env }
    try {
      const home = join(root, 'home')
      const ficusHome = join(root, 'ficus')
      const vault = join(root, 'vault')
      for (const path of [home, ficusHome, vault, join(vault, 'memory')]) await mkdir(path, { mode: 0o700 })
      await writeFile(
        join(vault, 'vault.yaml'),
        'name: Synthetic Ficus smoke\nintegrations: {}\nsecurity:\n  firewall: false\n'
      )
      await writeFile(
        join(vault, 'memory/MEMORY.md'),
        '# Synthetic working set\n\nLocal evidence for integration validation.\n'
      )
      const env = {
        HOME: home,
        PATH: process.env.PATH!,
        BIGBRAIN_VAULT: vault,
        BIGBRAIN_READ_LOG: join(root, 'reads.jsonl'),
        BIGBRAIN_ARRIVALS: join(root, 'arrivals'),
        BIGBRAIN_VAULT_POINTER: join(root, 'pointer'),
        BIGBRAIN_SHARED_CONNECTIONS: join(root, 'shared.json'),
      }
      const preload = join(root, 'deny-network.ts')
      await writeFile(
        preload,
        `import net from 'node:net'; import tls from 'node:tls'; const deny = () => { throw new Error('Synthetic smoke forbids network'); }; globalThis.fetch = deny; net.connect = deny; net.createConnection = deny; tls.connect = deny; const spawn = Bun.spawnSync; Bun.spawnSync = (argv, options) => spawn(argv[0] === process.execPath ? [argv[0], '--preload', import.meta.path, ...argv.slice(1)] : argv, options);`
      )
      const command = [process.execPath, '--no-install', '--preload', preload, join(checkout!, 'bin/cli.ts')]
      async function cli(args: string[]) {
        const child = Bun.spawn([...command, ...args], { env, cwd: root, stdout: 'pipe', stderr: 'pipe' })
        const timeout = setTimeout(() => child.kill(), 10000)
        try {
          const [stdout, stderr, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ])
          if (code !== 0) throw new Error(`Synthetic upstream setup failed (${code}): ${stderr.slice(0, 500)}`)
          return stdout
        } finally {
          clearTimeout(timeout)
          child.kill()
          await child.exited
        }
      }
      const setup = JSON.parse(await cli(['mcp', 'config']))
      const args: string[] = setup.mcpServers.bigbrain.args
      const clientId = args[args.indexOf('--client') + 1]
      expect(clientId).toMatch(/^[a-f0-9]{8}$/)
      const executable = join(root, 'bigbrain')
      await writeFile(
        executable,
        `#!${process.execPath}\nObject.assign(process.env,${JSON.stringify(env)}); const p = Bun.spawn([...${JSON.stringify(command)},...process.argv.slice(2)],{env:process.env,stdin:'inherit',stdout:'inherit',stderr:'inherit'}); process.exit(await p.exited);`,
        { mode: 0o700 }
      )
      await writeFile(
        join(ficusHome, 'bigbrain-bindings.json'),
        JSON.stringify({
          version: 1,
          bindings: [
            {
              id: 'synthetic',
              label: 'Synthetic',
              vaultPath: vault,
              executablePath: executable,
              clientId,
            },
          ],
        }),
        { mode: 0o600 }
      )
      Object.assign(process.env, {
        HOME: home,
        HOME_DIR: ficusHome,
        FICUS_SANDBOX_RUNTIME: 'host',
        FICUS_DESKTOP_MANAGED: '1',
      })
      delete process.env.FICUS_MANAGED
      const bindings = new BigbrainBindings()
      const binding = await bindings.resolve('synthetic')
      const client = new BigbrainClient({ configuration: binding.configuration, clientId, bindings })
      expect(await client.validate()).toHaveLength(4)
      expect(await client.loadMemory()).toContain('Synthetic working set')
      const paged = await client.readNote({ path: 'memory/MEMORY.md', start: 2, chars: 10 })
      expect(paged).toMatchObject({ start: 2, end: 12, truncated: true })
      const receipt = await client.drop({
        title: 'Synthetic integration finding',
        body: 'A deliberate synthetic finding, not a conversation transcript.',
        kind: 'finding',
      })
      expect('path' in receipt).toBe(true)
      if (!('path' in receipt) || typeof receipt.path !== 'string')
        throw new Error('Synthetic intake unexpectedly queued')
      const note = await client.readNote({ path: receipt.path })
      expect(note.markdown).toContain('deliberate synthetic finding')
      expect(note.markdown).toContain('Local MCP configuration')
      expect((await client.searchVault({ query: 'synthetic', n: 5 })).hits.length).toBeGreaterThan(0)
      await cli(['auth', 'revoke', clientId])
      await expect(client.loadMemory()).rejects.toBeDefined()
    } finally {
      process.env = previousEnv
      await rm(root, { recursive: true, force: true })
    }
  },
  30000
)
