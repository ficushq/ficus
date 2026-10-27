import { describe, expect, it } from 'bun:test'
import { createSshAuthFailureSampler, parseSshAuthJournal, type JournalRunner } from './ssh-auth-failures'

const journal = (lines: string[], cursor?: string) =>
  [...lines, ...(cursor ? [`-- cursor: ${cursor}`] : [])].join('\n') + '\n'

describe('parseSshAuthJournal', () => {
  it('counts failed passwords, invalid users and PAM authentication failures, and reads the cursor', () => {
    const out = journal(
      [
        'Failed password for root from 203.0.113.9 port 50122 ssh2',
        'Invalid user admin from 203.0.113.9 port 50124',
        'pam_unix(sshd:auth): authentication failure; logname= uid=0 euid=0 tty=ssh ruser= rhost=203.0.113.9',
        'Accepted publickey for root from 198.51.100.4 port 40022 ssh2: ED25519 SHA256:x',
        'Connection closed by 203.0.113.9 port 50126 [preauth]',
      ],
      's=abc;i=12'
    )
    expect(parseSshAuthJournal(out)).toEqual({ count: 3, cursor: 's=abc;i=12' })
  })

  it('an empty read has no cursor and counts nothing', () => {
    expect(parseSshAuthJournal('')).toEqual({ count: 0 })
  })
})

describe('createSshAuthFailureSampler', () => {
  it('reads ssh.service since the last report interval first, then strictly after the previous cursor', async () => {
    const calls: string[][] = []
    const replies = [
      journal(['Failed password for root from 203.0.113.9 port 1 ssh2'], 'c1'),
      journal(['Invalid user x from 203.0.113.9 port 2', 'Invalid user y from 203.0.113.9 port 3'], 'c2'),
      '',
    ]
    const run: JournalRunner = async (argv) => {
      calls.push(argv)
      return { exitCode: 0, stdout: replies.shift() ?? '' }
    }
    const sampler = createSshAuthFailureSampler({ run, firstWindowSeconds: 300, now: () => 1_800_000_000_000 })
    expect(await sampler.sample()).toBe(1)
    expect(await sampler.sample()).toBe(2)
    // Nothing new: no cursor printed, the next read still continues from c2.
    expect(await sampler.sample()).toBe(0)
    expect(calls[0]).toEqual([
      'journalctl',
      '--unit=ssh',
      '--output=cat',
      '--no-pager',
      '--quiet',
      '--show-cursor',
      `--since=@${1_800_000_000 - 300}`,
    ])
    expect(calls[1]!.at(-1)).toBe('--after-cursor=c1')
    expect(calls[2]!.at(-1)).toBe('--after-cursor=c2')
  })

  it('before any cursor, an empty read moves the start to that read, so nothing is counted twice', async () => {
    const calls: string[][] = []
    let clock = 1_800_000_000_000
    const sampler = createSshAuthFailureSampler({
      run: async (argv) => {
        calls.push(argv)
        return { exitCode: 0, stdout: '' }
      },
      firstWindowSeconds: 300,
      now: () => clock,
    })
    await sampler.sample()
    clock += 300_000
    await sampler.sample()
    expect(calls[1]!.at(-1)).toBe('--since=@1800000000')
  })

  it('an unreadable journal is null (the sample omits the key), and the next read starts where it would have', async () => {
    const calls: string[][] = []
    const results = [
      { exitCode: 0, stdout: journal([], 'c1') },
      { exitCode: 1, stdout: '' },
    ]
    const sampler = createSshAuthFailureSampler({
      run: async (argv) => {
        calls.push(argv)
        const next = results.shift()
        if (!next) throw new Error('spawn failed')
        return next
      },
    })
    expect(await sampler.sample()).toBe(0)
    expect(await sampler.sample()).toBeNull()
    expect(await sampler.sample()).toBeNull()
    expect(calls[2]!.at(-1)).toBe('--after-cursor=c1')
  })
})
