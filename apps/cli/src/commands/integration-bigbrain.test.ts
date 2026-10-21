import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { apiDelete, apiGet, apiPatch, apiPost } from '../client'
import { output, outputError } from '../output'
import { registerBigbrainVaultCommands, writeSecretFileExclusive } from './integration-bigbrain'

type AnyMock = ReturnType<typeof mock>
const VAULT = '22222222-2222-4222-8222-222222222222'
const SECRET = `https://bb-${'2'.repeat(32)}.vaults.example.com/invite#${'S'.repeat(43)}`
const vaultView = {
  vaultId: VAULT,
  displayName: 'Research',
  state: 'ready',
  readAccess: 'active',
  desiredGeneration: 3,
}

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bigbrain-cli-'))
  ;(output as AnyMock).mockClear()
  ;(outputError as AnyMock).mockClear()
  for (const fn of [apiGet, apiPost, apiPatch, apiDelete] as AnyMock[]) {
    fn.mockClear()
    fn.mockResolvedValue(vaultView)
  }
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function run(args: string[]): Promise<void> {
  const program = new Command().exitOverride()
  const integration = program.command('integration')
  registerBigbrainVaultCommands(integration)
  await program.parseAsync(['integration', 'bigbrain', 'vault', ...args], { from: 'user' })
}
/** Everything the command handed to output/outputError: data (what --json prints) and text. */
const allOutput = () =>
  JSON.stringify([
    (output as AnyMock).mock.calls,
    (outputError as AnyMock).mock.calls.map(([e]) => (e as Error).message),
  ])

describe('integration bigbrain vault', () => {
  test('list shows when the last server backup left a vault out', async () => {
    ;(apiGet as AnyMock).mockResolvedValue({
      vaults: [
        {
          vaultId: VAULT,
          displayName: 'Research',
          state: 'ready',
          readAccess: 'active',
          desiredGeneration: 3,
          backup: 'excluded',
        },
      ],
    })
    await run(['list'])
    expect((output as AnyMock).mock.calls.at(-1)![0]).toEqual([
      {
        vaultId: VAULT,
        displayName: 'Research',
        state: 'ready',
        readAccess: 'active',
        generation: 3,
        backup: 'excluded',
      },
    ])
  })

  test('create sends only a fresh request ID and the name: the owner in BigBrain is always ficus', async () => {
    await run(['create', '--name', 'Research'])
    expect(apiPost).toHaveBeenCalledWith('/api/integrations/providers/bigbrain/shared-vaults', {
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      displayName: 'Research',
    })
  })

  test('mutations route only by full vault UUID and carry the expected generation', async () => {
    await run(['rename', 'Research', '--name', 'X', '--generation', '3'])
    await run(['retry', VAULT.slice(0, 8), '--generation', '3'])
    expect(apiPatch).not.toHaveBeenCalled()
    expect(apiPost).not.toHaveBeenCalled()
    await run(['revoke-read', VAULT, '--generation', '3'])
    expect(apiPost).toHaveBeenCalledWith(`/api/integrations/providers/bigbrain/shared-vaults/${VAULT}/read-access`, {
      requestId: expect.any(String),
      expectedGeneration: 3,
      action: 'revoke',
    })
  })

  test('delete requires the exact name and generation and sends the full confirmation', async () => {
    await run(['delete', VAULT, '--name', 'Research', '--generation', '3'])
    expect(apiDelete).toHaveBeenCalledWith(`/api/integrations/providers/bigbrain/shared-vaults/${VAULT}`, {
      requestId: expect.any(String),
      expectedGeneration: 3,
      confirmedVaultId: VAULT,
      confirmedName: 'Research',
    })
    ;(apiDelete as AnyMock).mockClear()
    await run(['delete', VAULT, '--name', 'Research', '--generation', 'latest'])
    expect(apiDelete).not.toHaveBeenCalled()
  })

  test('invite without --out, or onto an existing path, refuses before asking the server', async () => {
    await run(['invite', VAULT, '--generation', '3'])
    const existing = join(dir, 'existing')
    await writeFile(existing, 'keep me')
    await run(['invite', VAULT, '--generation', '3', '--out', existing])
    expect(apiPost).not.toHaveBeenCalled()
    expect(await readFile(existing, 'utf8')).toBe('keep me')
    expect(allOutput()).toContain('--out')
  })

  test('invite writes the link to a new 0600 file; neither text nor --json output contains it', async () => {
    ;(apiPost as AnyMock).mockResolvedValue({ inviteUrl: SECRET, expiresAt: '2026-10-20T01:00:00.000Z' })
    const text = join(dir, 'link.txt')
    await run(['invite', VAULT, '--generation', '3', '--out', text])
    const second = join(dir, 'link-2.txt')
    await run(['invite', VAULT, '--generation', '3', '--out', second])
    for (const file of [text, second]) {
      expect(await readFile(file, 'utf8')).toBe(`${SECRET}\n`)
      expect((await stat(file)).mode & 0o777).toBe(0o600)
    }
    expect(allOutput()).toContain(text)
    expect(allOutput()).toContain('expires')
    expect(allOutput()).not.toContain('invite#')
    expect(allOutput()).not.toContain('S'.repeat(43))
    // The structured data (printed by --json) is the path and expiry only.
    expect((output as AnyMock).mock.calls.at(-1)![0]).toEqual({
      written: second,
      expiresAt: '2026-10-20T01:00:00.000Z',
    })
  })

  test('the secret writer never follows a symlink or replaces a file that appears meanwhile', async () => {
    const target = join(dir, 'elsewhere')
    const link = join(dir, 'link')
    await symlink(target, link)
    await expect(writeSecretFileExclusive(link, SECRET)).rejects.toThrow('Refusing to overwrite')
    await expect(writeSecretFileExclusive(join(dir, 'missing-dir', 'x'), SECRET)).rejects.toThrow('must exist')
    const fresh = join(dir, 'fresh')
    expect(await writeSecretFileExclusive(fresh, SECRET)).toBe(fresh)
    await expect(writeSecretFileExclusive(fresh, 'second')).rejects.toThrow('Refusing to overwrite')
    expect(await readFile(fresh, 'utf8')).toBe(SECRET)
  })

  test('a server refusal is reported without echoing any response body', async () => {
    ;(apiPost as AnyMock).mockRejectedValue(new Error('owner_unavailable'))
    await run(['invite', VAULT, '--generation', '3', '--out', join(dir, 'never')])
    expect(allOutput()).toContain('owner_unavailable')
    await expect(stat(join(dir, 'never'))).rejects.toThrow()
  })
})
