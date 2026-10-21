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

  test('owner-link without --out, or onto an existing path, refuses before asking the server', async () => {
    await run(['owner-link', VAULT, '--generation', '3'])
    const existing = join(dir, 'existing')
    await writeFile(existing, 'keep me')
    await run(['owner-link', VAULT, '--generation', '3', '--out', existing])
    expect(apiPost).not.toHaveBeenCalled()
    expect(await readFile(existing, 'utf8')).toBe('keep me')
    expect(allOutput()).toContain('--out')
  })

  test('owner-link writes the link to a new 0600 file; neither text nor --json output contains it', async () => {
    ;(apiPost as AnyMock).mockResolvedValue({ inviteUrl: SECRET, expiresAt: '2026-10-20T01:00:00.000Z' })
    const text = join(dir, 'link.txt')
    await run(['owner-link', VAULT, '--generation', '3', '--out', text])
    const second = join(dir, 'link-2.txt')
    await run(['owner-link', VAULT, '--generation', '3', '--out', second])
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

  test('invite needs a name and never falls back to an owner link', async () => {
    await run(['invite', VAULT, '--generation', '3', '--out', join(dir, 'x')])
    expect(apiPost).not.toHaveBeenCalled()
    expect(allOutput()).toContain('owner-link')
    await run(['invite', VAULT, '--name', 'Grace', '--access', 'owner', '--generation', '3', '--out', join(dir, 'y')])
    expect(apiPost).not.toHaveBeenCalled()
    expect(allOutput()).toContain('--access must be read or write')
  })

  test('a member invite link goes only to a new 0600 file; output shows the path, ID and expiry', async () => {
    const MEMBER = `https://bb-${'2'.repeat(32)}.vaults.example.com/invite#${'M'.repeat(43)}`
    ;(apiPost as AnyMock).mockResolvedValue({
      inviteId: 'c'.repeat(24),
      inviteUrl: MEMBER,
      displayName: 'Grace',
      access: 'write',
      expiresAt: '2026-10-21T00:00:00.000Z',
    })
    const existing = join(dir, 'existing')
    await writeFile(existing, 'keep me')
    await run(['invite', VAULT, '--name', 'Grace', '--generation', '3', '--out', existing])
    expect(apiPost).not.toHaveBeenCalled()
    const file = join(dir, 'member.txt')
    await run(['invite', VAULT, '--name', 'Grace', '--access', 'write', '--generation', '3', '--out', file])
    expect(apiPost).toHaveBeenCalledWith(`/api/integrations/providers/bigbrain/shared-vaults/${VAULT}/invites`, {
      requestId: expect.any(String),
      expectedGeneration: 3,
      displayName: 'Grace',
      access: 'write',
    })
    expect(await readFile(file, 'utf8')).toBe(`${MEMBER}\n`)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(allOutput()).not.toContain('M'.repeat(43))
    expect((output as AnyMock).mock.calls.at(-1)![0]).toEqual({
      written: file,
      inviteId: 'c'.repeat(24),
      access: 'write',
      expiresAt: '2026-10-21T00:00:00.000Z',
    })
  })

  test('members, cancel-invite, set-access and remove-member route by validated IDs and fence', async () => {
    ;(apiGet as AnyMock).mockResolvedValue({
      members: [
        { handle: 'grace', displayName: 'Grace', access: 'read', status: 'active', system: null, editable: true },
      ],
      invites: [],
      membersTruncated: false,
      invitesTruncated: false,
    })
    await run(['members', VAULT])
    expect(apiGet).toHaveBeenCalledWith(`/api/integrations/providers/bigbrain/shared-vaults/${VAULT}/members`)
    await run(['cancel-invite', VAULT, 'c'.repeat(24), '--generation', '3'])
    await run(['set-access', VAULT, 'grace', '--access', 'write', '--generation', '3'])
    await run(['remove-member', VAULT, 'grace', '--generation', '3'])
    const base = `/api/integrations/providers/bigbrain/shared-vaults/${VAULT}`
    expect((apiPost as AnyMock).mock.calls).toEqual([
      [`${base}/invites/${'c'.repeat(24)}/cancel`, { requestId: expect.any(String), expectedGeneration: 3 }],
      [`${base}/members/grace/access`, { requestId: expect.any(String), expectedGeneration: 3, access: 'write' }],
      [`${base}/members/grace/remove`, { requestId: expect.any(String), expectedGeneration: 3 }],
    ])
    ;(apiPost as AnyMock).mockClear()
    await run(['remove-member', VAULT, '../owner', '--generation', '3'])
    await run(['set-access', VAULT, 'grace', '--access', 'admin', '--generation', '3'])
    await run(['cancel-invite', VAULT, 'nope', '--generation', '3'])
    expect(apiPost).not.toHaveBeenCalled()
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
    await run(['owner-link', VAULT, '--generation', '3', '--out', join(dir, 'never')])
    expect(allOutput()).toContain('owner_unavailable')
    await expect(stat(join(dir, 'never'))).rejects.toThrow()
  })
})
