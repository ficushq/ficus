import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { Command } from 'commander'
import { apiDelete, apiGet, apiPost } from '../client'
import { output, outputError, outputTable } from '../output'
import {
  registerRemoteHostsCommands,
  renderConflicts,
  renderHostKeys,
  renderInstallInstructions,
  type PublicRemoteHost,
} from './remote-hosts'

const HOST = {
  id: 'host-1',
  name: 'build-box',
  description: 'CI build machine',
  sshHost: 'build.example.com',
  sshPort: 22,
  sshUser: 'ci',
  sshPublicKey: 'ssh-ed25519 AAAA... ficus-remote-host',
  createdAt: '2026-07-14T00:00:00.000Z',
  updatedAt: '2026-07-14T00:00:00.000Z',
}

describe('renderInstallInstructions', () => {
  it('renders the public key line, install instructions, and check hint', () => {
    const text = renderInstallInstructions(HOST)
    const lines = text.split('\n')
    expect(lines[0]).toBe('ssh-ed25519 AAAA... ficus-remote-host')
    expect(lines[1]).toBe(
      'Ask the owner of build.example.com to append the line above to ~/.ssh/authorized_keys for user ci.'
    )
    expect(lines[2]).toBe('Then verify with: ficus remote-hosts check build-box.')
  })

  it('trims trailing newlines off the public key so no blank line is inserted', () => {
    const text = renderInstallInstructions({ ...HOST, sshPublicKey: 'ssh-ed25519 AAAA...\n' })
    const lines = text.split('\n')
    expect(lines[0]).toBe('ssh-ed25519 AAAA...')
    expect(lines[1]).toBe(
      'Ask the owner of build.example.com to append the line above to ~/.ssh/authorized_keys for user ci.'
    )
    expect(lines).toHaveLength(3)
  })
})

const PENDING_KEY = {
  id: 'key-new',
  keyType: 'ssh-ed25519',
  fingerprint: 'SHA256:newfingerprint',
  status: 'pending',
  origin: 'scan',
  decisionNote: null,
  decidedByUserId: null,
  decidedAt: null,
  replacesFingerprints: ['SHA256:oldfingerprint'],
}
const TRUSTED_KEY = {
  ...PENDING_KEY,
  id: 'key-old',
  fingerprint: 'SHA256:oldfingerprint',
  status: 'trusted',
  decisionNote: 'trusted by a person',
  decidedByUserId: 'user-1',
  decidedAt: '2026-10-16T00:00:00.000Z',
  replacesFingerprints: [],
}
const CHANGED_HOST: PublicRemoteHost = { ...HOST, hostKeyState: 'changed', hostKeys: [TRUSTED_KEY, PENDING_KEY] }

describe('renderHostKeys', () => {
  it('shows a key change with both fingerprints and how a person acts on it', () => {
    const text = renderHostKeys(CHANGED_HOST)
    expect(text).toContain('HOST KEY CHANGED')
    expect(text).toContain('[trusted] ssh-ed25519 SHA256:oldfingerprint')
    expect(text).toContain('[pending] ssh-ed25519 SHA256:newfingerprint')
    expect(text).toContain('key change: replaces trusted SHA256:oldfingerprint')
    expect(text).toContain('ficus remote-hosts trust-key build-box <fingerprint>')
    expect(text).toContain('agents are refused')
  })

  it('a blocked host with a failed fetch says so and how to fetch again', () => {
    const text = renderHostKeys({ ...HOST, hostKeyState: 'unverified', hostKeys: [], hostKeyCheckError: 'timed out' })
    expect(text).toContain('BLOCKED')
    expect(text).toContain('Last key fetch failed: timed out')
    expect(text).toContain('ficus remote-hosts fetch-key build-box')
  })
})

describe('renderConflicts', () => {
  it('lists both fingerprints, flags wildcard lines and explains resolution', () => {
    const text = renderConflicts([
      {
        id: 'c1',
        sandboxId: 'agent_1',
        host: 'git.example',
        keyType: 'ssh-ed25519',
        boxFingerprint: 'SHA256:box',
        coreFingerprint: 'SHA256:core',
        boxLine: 4,
        wildcard: true,
        status: 'open',
        resolvedByUserId: null,
      },
    ])
    expect(text).toContain('c1 [open] git.example ssh-ed25519 on agent_1 line 4 (wildcard line)')
    expect(text).toContain('box:  SHA256:box')
    expect(text).toContain('Ficus: SHA256:core')
    expect(text).toContain('--keep-box | --use-core')
  })

  it('says when there are none', () => {
    expect(renderConflicts([])).toBe('No known_hosts conflicts on your squad boxes.')
  })
})

describe('ficus remote-hosts commands', () => {
  const originalSquadId = process.env.FICUS_SQUAD_ID

  beforeEach(() => {
    delete process.env.FICUS_SQUAD_ID
    ;(apiGet as ReturnType<typeof mock>).mockClear()
    ;(apiPost as ReturnType<typeof mock>).mockClear()
    ;(apiDelete as ReturnType<typeof mock>).mockClear()
    ;(output as ReturnType<typeof mock>).mockClear()
    ;(outputTable as ReturnType<typeof mock>).mockClear()
    ;(outputError as ReturnType<typeof mock>).mockClear()
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue([HOST])
    ;(apiPost as ReturnType<typeof mock>).mockResolvedValue(HOST)
    ;(apiDelete as ReturnType<typeof mock>).mockResolvedValue(undefined)
  })

  afterEach(() => {
    if (originalSquadId === undefined) delete process.env.FICUS_SQUAD_ID
    else process.env.FICUS_SQUAD_ID = originalSquadId
  })

  async function run(args: string[]): Promise<void> {
    const program = new Command()
    program.exitOverride()
    registerRemoteHostsCommands(program)
    await program.parseAsync(args, { from: 'user' })
  }

  it('list uses the squad surface with FICUS_SQUAD_ID by default', async () => {
    process.env.FICUS_SQUAD_ID = 'squad-1'
    await run(['remote-hosts', 'list'])
    expect(apiGet).toHaveBeenCalledWith('/api/remote-hosts/squad/squad-1')
    expect(outputTable).toHaveBeenCalledWith(
      [HOST],
      ['name', 'sshUser', 'sshHost', 'sshPort', 'hostKeyState', 'description']
    )
  })

  it('list errors with guidance when FICUS_SQUAD_ID is unset and no --squad given', async () => {
    await run(['remote-hosts', 'list'])
    expect(apiGet).not.toHaveBeenCalled()
    expect(outputError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('--squad') }))
  })

  it('list --all hits the global registry', async () => {
    await run(['remote-hosts', 'list', '--all'])
    expect(apiGet).toHaveBeenCalledWith('/api/remote-hosts')
  })

  it('list --squad overrides FICUS_SQUAD_ID', async () => {
    process.env.FICUS_SQUAD_ID = 'squad-1'
    await run(['remote-hosts', 'list', '--squad', 'squad-2'])
    expect(apiGet).toHaveBeenCalledWith('/api/remote-hosts/squad/squad-2')
  })

  it('show resolves the host by name from the squad list and prints the install block', async () => {
    process.env.FICUS_SQUAD_ID = 'squad-1'
    await run(['remote-hosts', 'show', 'build-box'])
    expect(apiGet).toHaveBeenCalledWith('/api/remote-hosts/squad/squad-1')
    expect(output).toHaveBeenCalledWith(
      HOST,
      expect.stringContaining('Then verify with: ficus remote-hosts check build-box.')
    )
  })

  it('add defaults to FICUS_SQUAD_ID and posts the squad add-and-grant surface, then prints the install block', async () => {
    process.env.FICUS_SQUAD_ID = 'squad-1'
    await run(['remote-hosts', 'add', '--name', 'build-box', '--host', 'build.example.com', '--user', 'ci'])
    expect(apiPost).toHaveBeenCalledWith('/api/remote-hosts/squad/squad-1', {
      name: 'build-box',
      sshHost: 'build.example.com',
      sshUser: 'ci',
    })
    expect(output).toHaveBeenCalledWith(HOST, expect.stringContaining('Registered "build-box"'))
    expect(output).toHaveBeenCalledWith(
      HOST,
      expect.stringContaining('Then verify with: ficus remote-hosts check build-box.')
    )
  })

  it('add rejects a non-numeric --port before making any API call', async () => {
    process.env.FICUS_SQUAD_ID = 'squad-1'
    await run([
      'remote-hosts',
      'add',
      '--name',
      'build-box',
      '--host',
      'build.example.com',
      '--user',
      'ci',
      '--port',
      'abc',
    ])
    expect(apiPost).not.toHaveBeenCalled()
    expect(outputError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('Invalid --port "abc"') })
    )
  })

  it('add rejects an out-of-range --port before making any API call', async () => {
    process.env.FICUS_SQUAD_ID = 'squad-1'
    await run([
      'remote-hosts',
      'add',
      '--name',
      'build-box',
      '--host',
      'build.example.com',
      '--user',
      'ci',
      '--port',
      '70000',
    ])
    expect(apiPost).not.toHaveBeenCalled()
    expect(outputError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('Invalid --port "70000"') })
    )
  })

  it('add accepts a valid --port and passes it through as a number', async () => {
    process.env.FICUS_SQUAD_ID = 'squad-1'
    await run([
      'remote-hosts',
      'add',
      '--name',
      'build-box',
      '--host',
      'build.example.com',
      '--user',
      'ci',
      '--port',
      '2222',
    ])
    expect(outputError).not.toHaveBeenCalled()
    expect(apiPost).toHaveBeenCalledWith('/api/remote-hosts/squad/squad-1', {
      name: 'build-box',
      sshHost: 'build.example.com',
      sshUser: 'ci',
      sshPort: 2222,
    })
  })

  it('add --global posts to the global registry without granting a squad', async () => {
    await run(['remote-hosts', 'add', '--name', 'build-box', '--host', 'build.example.com', '--user', 'ci', '--global'])
    expect(apiPost).toHaveBeenCalledWith('/api/remote-hosts', {
      name: 'build-box',
      sshHost: 'build.example.com',
      sshUser: 'ci',
    })
  })

  it('add passes --port and --description through as sshPort/description', async () => {
    process.env.FICUS_SQUAD_ID = 'squad-1'
    await run([
      'remote-hosts',
      'add',
      '--name',
      'build-box',
      '--host',
      'build.example.com',
      '--user',
      'ci',
      '--port',
      '2222',
      '--description',
      'CI box',
    ])
    expect(apiPost).toHaveBeenCalledWith('/api/remote-hosts/squad/squad-1', {
      name: 'build-box',
      sshHost: 'build.example.com',
      sshUser: 'ci',
      sshPort: 2222,
      description: 'CI box',
    })
  })

  it('grant resolves via the global list and posts a grant', async () => {
    await run(['remote-hosts', 'grant', 'build-box', '--squad', 'squad-2'])
    expect(apiGet).toHaveBeenCalledWith('/api/remote-hosts')
    expect(apiPost).toHaveBeenCalledWith('/api/remote-hosts/host-1/grants', { squadId: 'squad-2' })
  })

  it('revoke without --squad uses FICUS_SQUAD_ID on the squad surface', async () => {
    process.env.FICUS_SQUAD_ID = 'squad-1'
    await run(['remote-hosts', 'revoke', 'build-box'])
    expect(apiGet).toHaveBeenCalledWith('/api/remote-hosts/squad/squad-1')
    expect(apiDelete).toHaveBeenCalledWith('/api/remote-hosts/squad/squad-1/host-1')
  })

  it('revoke with --squad uses the global surface for an arbitrary squad', async () => {
    await run(['remote-hosts', 'revoke', 'build-box', '--squad', 'squad-9'])
    expect(apiGet).toHaveBeenCalledWith('/api/remote-hosts')
    expect(apiDelete).toHaveBeenCalledWith('/api/remote-hosts/host-1/grants/squad-9')
  })

  it('revoke surfaces the rotated public key and authorized_keys guidance', async () => {
    process.env.FICUS_SQUAD_ID = 'squad-1'
    ;(apiDelete as ReturnType<typeof mock>).mockResolvedValue({
      revoked: true,
      rotated: true,
      sshPublicKey: 'ssh-ed25519 NEWKEY ficus-remote-host',
      message: 'Append this public key to ~/.ssh/authorized_keys on build.example.com for user ci.',
    })
    await run(['remote-hosts', 'revoke', 'build-box'])
    const humanText = (output as ReturnType<typeof mock>).mock.calls.at(-1)?.[1] as string
    expect(humanText).toContain('ssh-ed25519 NEWKEY ficus-remote-host')
    expect(humanText).toContain('authorized_keys')
  })

  it('revoke warns when rotation failed and the previous key remains valid', async () => {
    process.env.FICUS_SQUAD_ID = 'squad-1'
    ;(apiDelete as ReturnType<typeof mock>).mockResolvedValue({
      revoked: true,
      rotated: false,
      warning: 'Grant revoked, but rotating the host key failed — the previous key remains valid.',
    })
    await run(['remote-hosts', 'revoke', 'build-box'])
    const humanText = (output as ReturnType<typeof mock>).mock.calls.at(-1)?.[1] as string
    expect(humanText).toContain('rotating the host key failed')
  })

  it('revoke reports a friendly error when the name is not found', async () => {
    process.env.FICUS_SQUAD_ID = 'squad-1'
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue([])
    await run(['remote-hosts', 'revoke', 'nope'])
    expect(apiDelete).not.toHaveBeenCalled()
    expect(outputError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Remote host "nope" not found.' }))
  })

  it('remove resolves via the global list then deletes the host', async () => {
    await run(['remote-hosts', 'remove', 'build-box'])
    expect(apiGet).toHaveBeenCalledWith('/api/remote-hosts')
    expect(apiDelete).toHaveBeenCalledWith('/api/remote-hosts/host-1')
  })

  it('remove reports a friendly error when the name is not found', async () => {
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue([])
    await run(['remote-hosts', 'remove', 'nope'])
    expect(apiDelete).not.toHaveBeenCalled()
    expect(outputError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Remote host "nope" not found.' }))
  })

  it('check defaults to the squad surface using FICUS_SQUAD_ID', async () => {
    process.env.FICUS_SQUAD_ID = 'squad-1'
    ;(apiPost as ReturnType<typeof mock>).mockResolvedValue({ reachable: true })
    await run(['remote-hosts', 'check', 'build-box'])
    expect(apiGet).toHaveBeenCalledWith('/api/remote-hosts/squad/squad-1')
    expect(apiPost).toHaveBeenCalledWith('/api/remote-hosts/squad/squad-1/check/host-1')
    expect(output).toHaveBeenCalledWith({ reachable: true }, '"build-box" is reachable.')
  })

  it('check --all resolves via the global list and posts the global probe', async () => {
    ;(apiPost as ReturnType<typeof mock>).mockResolvedValue({ reachable: true })
    await run(['remote-hosts', 'check', 'build-box', '--all'])
    expect(apiGet).toHaveBeenCalledWith('/api/remote-hosts')
    expect(apiPost).toHaveBeenCalledWith('/api/remote-hosts/host-1/check')
    expect(output).toHaveBeenCalledWith({ reachable: true }, '"build-box" is reachable.')
  })

  it('check prints the unreachable message with the error detail', async () => {
    process.env.FICUS_SQUAD_ID = 'squad-1'
    ;(apiPost as ReturnType<typeof mock>).mockResolvedValue({ reachable: false, error: 'Connection refused' })
    await run(['remote-hosts', 'check', 'build-box'])
    expect(output).toHaveBeenCalledWith(
      { reachable: false, error: 'Connection refused' },
      '"build-box" is NOT reachable: Connection refused'
    )
  })

  it('sync posts to the squad sync route using FICUS_SQUAD_ID and explains live-mount', async () => {
    process.env.FICUS_SQUAD_ID = 'squad-1'
    ;(apiPost as ReturnType<typeof mock>).mockResolvedValue({ pushed: false, reason: 'live-mount' })
    await run(['remote-hosts', 'sync'])
    expect(apiPost).toHaveBeenCalledWith('/api/remote-hosts/squad/squad-1/sync')
    expect(output).toHaveBeenCalledWith(
      { pushed: false, reason: 'live-mount' },
      expect.stringContaining('No sync needed')
    )
  })

  it('sync reports success when pushed:true', async () => {
    process.env.FICUS_SQUAD_ID = 'squad-1'
    ;(apiPost as ReturnType<typeof mock>).mockResolvedValue({ pushed: true })
    await run(['remote-hosts', 'sync'])
    expect(apiPost).toHaveBeenCalledWith('/api/remote-hosts/squad/squad-1/sync')
    expect(output).toHaveBeenCalledWith({ pushed: true }, 'Synced ssh config and keys to your box.')
  })

  it('sync explains box-unreachable with a retry hint', async () => {
    process.env.FICUS_SQUAD_ID = 'squad-1'
    ;(apiPost as ReturnType<typeof mock>).mockResolvedValue({ pushed: false, reason: 'box-unreachable' })
    await run(['remote-hosts', 'sync'])
    expect(output).toHaveBeenCalledWith(
      { pushed: false, reason: 'box-unreachable' },
      expect.stringContaining('try `ficus remote-hosts sync` again')
    )
  })
  it('trust-key resolves the fingerprint to the key id and posts to the squad surface', async () => {
    process.env.FICUS_SQUAD_ID = 'squad-1'
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue([CHANGED_HOST])
    ;(apiPost as ReturnType<typeof mock>).mockResolvedValue({ ...CHANGED_HOST, hostKeyState: 'trusted' })
    await run(['remote-hosts', 'trust-key', 'build-box', 'SHA256:newfingerprint'])
    expect(apiPost).toHaveBeenCalledWith('/api/remote-hosts/squad/squad-1/host-keys/host-1/key-new/trust')
  })

  it('reject-key --all uses the global registry', async () => {
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue([CHANGED_HOST])
    ;(apiPost as ReturnType<typeof mock>).mockResolvedValue(CHANGED_HOST)
    await run(['remote-hosts', 'reject-key', 'build-box', 'SHA256:newfingerprint', '--all'])
    expect(apiPost).toHaveBeenCalledWith('/api/remote-hosts/host-1/host-keys/key-new/reject')
  })

  it('trust-key with an unknown fingerprint errors without posting', async () => {
    process.env.FICUS_SQUAD_ID = 'squad-1'
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue([CHANGED_HOST])
    await run(['remote-hosts', 'trust-key', 'build-box', 'SHA256:nope'])
    expect(apiPost).not.toHaveBeenCalled()
    expect(outputError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('No host key') })
    )
  })

  it('fetch-key posts the scan', async () => {
    process.env.FICUS_SQUAD_ID = 'squad-1'
    ;(apiPost as ReturnType<typeof mock>).mockResolvedValue(CHANGED_HOST)
    await run(['remote-hosts', 'fetch-key', 'build-box'])
    expect(apiPost).toHaveBeenCalledWith('/api/remote-hosts/squad/squad-1/host-keys/host-1/scan')
  })

  it('conflicts lists the squad conflicts; resolve-conflict needs exactly one choice', async () => {
    process.env.FICUS_SQUAD_ID = 'squad-1'
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue([])
    await run(['remote-hosts', 'conflicts'])
    expect(apiGet).toHaveBeenCalledWith('/api/remote-hosts/squad/squad-1/known-hosts-conflicts')

    await run(['remote-hosts', 'resolve-conflict', 'c1'])
    expect(apiPost).not.toHaveBeenCalled()
    await run(['remote-hosts', 'resolve-conflict', 'c1', '--use-core'])
    expect(apiPost).toHaveBeenCalledWith('/api/remote-hosts/squad/squad-1/known-hosts-conflicts/c1/use-core')
  })
})
