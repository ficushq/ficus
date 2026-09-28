import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getSecretStore, resetSecretStore } from '../secrets'
import type { Machine } from './queries'
import { buildPushFileCommand, createSshRunner, createSshStreamer, SshTimeoutError } from './ssh'

const SECRET_KEY = 'machine-ssh:ssh-runner-test'

function makeMachine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'ssh-test',
    provider: 'ssh',
    providerRef: null,
    sshHost: '10.0.0.9',
    sshPort: 2222,
    sshUser: 'tau',
    sshKeyId: SECRET_KEY,
    sshPublicKey: 'ssh-ed25519 AAAA test',
    status: 'ready',
    capabilities: {},
    scope: 'shared',
    bootstrapVersion: null,
    lastSeenAt: null,
    createdAt: new Date(),
    ...overrides,
  } as Machine
}

interface FakeCall {
  args: string[]
  options: Record<string, unknown>
  identityPath: string | undefined
  identityExisted: boolean
}

function makeFakeSpawn(behavior: { stdout?: string; stderr?: string; exitCode?: number; neverExits?: boolean }) {
  const calls: FakeCall[] = []
  const kills: Array<number | string | undefined> = []
  const spawn = ((args: string[], options: Record<string, unknown>) => {
    const iIdx = args.indexOf('-i')
    const identityPath = iIdx >= 0 ? args[iIdx + 1] : undefined
    calls.push({
      args,
      options,
      identityPath,
      identityExisted: identityPath ? existsSync(identityPath) : false,
    })
    return {
      stdout: behavior.stdout ?? '',
      stderr: behavior.stderr ?? '',
      exited: behavior.neverExits ? new Promise<number>(() => {}) : Promise.resolve(behavior.exitCode ?? 0),
      kill: (sig?: number | string) => {
        kills.push(sig)
      },
    }
  }) as unknown as typeof Bun.spawn
  return { spawn, calls, kills }
}

describe('ssh runner', () => {
  let priorKey: string | undefined
  let priorHome: string | undefined

  beforeAll(async () => {
    priorHome = process.env.HOME_DIR
    process.env.HOME_DIR = mkdtempSync(join(tmpdir(), 'tau-ssh-test-'))
    priorKey = process.env.FICUS_ENCRYPTION_KEY
    process.env.FICUS_ENCRYPTION_KEY = priorKey ?? '0'.repeat(64)
    resetSecretStore()
    await getSecretStore().initialize()
    await getSecretStore().set(SECRET_KEY, 'FAKE PRIVATE KEY MATERIAL', 'system')
  })

  afterAll(async () => {
    await getSecretStore().delete(SECRET_KEY)
    if (priorKey === undefined) delete process.env.FICUS_ENCRYPTION_KEY
    else process.env.FICUS_ENCRYPTION_KEY = priorKey
    if (priorHome === undefined) delete process.env.HOME_DIR
    else process.env.HOME_DIR = priorHome
    resetSecretStore()
  })

  it('builds the argv with all required options, identity, target, and command', async () => {
    const { spawn, calls } = makeFakeSpawn({ stdout: 'ok\n' })
    const runner = createSshRunner({ spawn })

    const result = await runner.run(makeMachine(), 'echo hi')

    expect(result).toEqual({ exitCode: 0, stdout: 'ok\n', stderr: '' })
    expect(calls.length).toBe(1)
    const { args } = calls[0]
    expect(args[0]).toBe('ssh')
    // Last two args: target then command.
    expect(args[args.length - 2]).toBe('tau@10.0.0.9')
    expect(args[args.length - 1]).toBe('echo hi')

    const joined = args.join(' ')
    expect(joined).toContain('-o StrictHostKeyChecking=accept-new')
    expect(joined).toContain(`-o UserKnownHostsFile=${process.env.HOME_DIR}/machines/known_hosts`)
    expect(joined).toContain('-o BatchMode=yes')
    expect(joined).toContain('-o ServerAliveInterval=15')
    expect(joined).toContain('-o ServerAliveCountMax=4')
    expect(joined).toContain('-o ConnectTimeout=10')
    expect(joined).toContain('-o IdentitiesOnly=yes')
    expect(joined).toContain('-o IdentityAgent=none')
    expect(joined).toContain('-p 2222')
  })

  it('materializes a 0600 identity present during spawn and cleaned up after', async () => {
    const { spawn, calls } = makeFakeSpawn({})
    const runner = createSshRunner({ spawn })

    await runner.run(makeMachine(), 'true')

    const { identityPath, identityExisted } = calls[0]
    expect(identityExisted).toBe(true)
    expect(identityPath).toBeString()
    // Cleaned up after run resolves.
    expect(existsSync(identityPath!)).toBe(false)
  })

  it('pipes stdin into the child', async () => {
    const { spawn, calls } = makeFakeSpawn({})
    const runner = createSshRunner({ spawn })

    await runner.run(makeMachine(), 'cat', { stdin: 'payload' })

    const stdin = calls[0].options.stdin as Uint8Array
    expect(stdin).toBeInstanceOf(Uint8Array)
    expect(new TextDecoder().decode(stdin)).toBe('payload')
  })

  it('propagates a non-zero exit code with stdout/stderr', async () => {
    const { spawn } = makeFakeSpawn({ exitCode: 42, stdout: 'partial', stderr: 'boom' })
    const runner = createSshRunner({ spawn })

    const result = await runner.run(makeMachine(), 'false')

    expect(result).toEqual({ exitCode: 42, stdout: 'partial', stderr: 'boom' })
  })

  it('kills the child and rejects when the overall timeout expires', async () => {
    const { spawn, kills } = makeFakeSpawn({ neverExits: true })
    // Tiny injected default timeout — exercises the caller-independent bound
    // that keeps a black-holed host from hanging status() forever.
    const runner = createSshRunner({ spawn, defaultTimeoutMs: 30 })

    await expect(runner.run(makeMachine(), 'sleep 999')).rejects.toBeInstanceOf(SshTimeoutError)
    expect(kills.length).toBe(1)
  })

  describe('buildPushFileCommand', () => {
    it('quotes the remote path and defaults to install into /dev/stdin', () => {
      expect(buildPushFileCommand('/etc/tau/config.json', '0644')).toBe(
        "install -m 0644 /dev/stdin '/etc/tau/config.json'"
      )
    })

    it('is safe against a path containing a single quote', () => {
      expect(buildPushFileCommand("/tmp/a'b; rm -rf x", '0600')).toBe(
        "install -m 0600 /dev/stdin '/tmp/a'\\''b; rm -rf x'"
      )
    })

    it('rejects a non-octal mode', () => {
      expect(() => buildPushFileCommand('/tmp/x', '0999')).toThrow(/invalid file mode/)
      expect(() => buildPushFileCommand('/tmp/x', 'rwx')).toThrow(/invalid file mode/)
    })
  })

  // -------------------------------------------------------------------------
  // createSshStreamer — host→host pipe with NO whole-payload buffering
  //
  // Exercised against REAL local processes: the injected spawn rewrites the
  // `ssh <opts> <target> <command>` argv into a local `bash -c <command>`, so
  // every assertion below runs the actual stream pump, the actual byte counter,
  // and real exit-status/EPIPE semantics — not a mock of them. That is the
  // point: the fail-closed guarantees this module is responsible for are
  // process/pipe behaviors, and a fake would assert nothing about them.
  // -------------------------------------------------------------------------
  describe('createSshStreamer', () => {
    /** Rewrites the streamer's ssh argv into a local shell so the pipe is real. */
    function localSpawn(): { spawn: typeof Bun.spawn; commands: string[]; argvs: string[][] } {
      const commands: string[] = []
      const argvs: string[][] = []
      const spawn = ((args: string[], options: Record<string, unknown>) => {
        argvs.push(args)
        const command = args[args.length - 1]
        commands.push(command)
        return Bun.spawn(['bash', '-c', command], options as never)
      }) as unknown as typeof Bun.spawn
      return { spawn, commands, argvs }
    }

    const SOURCE = () => makeMachine({ id: 'src', sshHost: '10.0.0.1' })
    const DEST = () => makeMachine({ id: 'dst', sshHost: '10.0.0.2' })

    it('pipes source stdout into destination stdin and reports the streamed byte count', async () => {
      const { spawn, commands, argvs } = localSpawn()
      const streamer = createSshStreamer({ spawn })
      const out = `${process.env.HOME_DIR}/streamed.bin`

      const result = await streamer.stream(
        { machine: SOURCE(), command: 'head -c 200000 /dev/zero' },
        { machine: DEST(), command: `cat > ${out}` }
      )

      expect(result.bytes).toBe(200000)
      expect(result.source.exitCode).toBe(0)
      expect(result.dest.exitCode).toBe(0)
      expect(Bun.file(out).size).toBe(200000)
      // Two independent ssh invocations, each carrying the standard option set
      // and its OWN machine's target (never one machine's key against the other).
      expect(commands).toHaveLength(2)
      expect(argvs[0][argvs[0].length - 2]).toBe('tau@10.0.0.1')
      expect(argvs[1][argvs[1].length - 2]).toBe('tau@10.0.0.2')
      expect(argvs[0].join(' ')).toContain('-o BatchMode=yes')
      expect(argvs[1].join(' ')).toContain('-o IdentitiesOnly=yes')
    })

    it('surfaces a SOURCE failure mid-stream with its exit code and stderr (never masked by a happy destination)', async () => {
      // The transport's single most dangerous shape: the source dies partway,
      // the destination consumes the truncated prefix and exits 0. Only the
      // source's own exit status distinguishes it from a complete transfer.
      const { spawn } = localSpawn()
      const streamer = createSshStreamer({ spawn })

      const result = await streamer.stream(
        { machine: SOURCE(), command: 'head -c 4096 /dev/zero; echo "tar: read error" >&2; exit 3' },
        { machine: DEST(), command: 'cat > /dev/null' }
      )

      expect(result.source.exitCode).toBe(3)
      expect(result.source.stderr).toContain('tar: read error')
      expect(result.dest.exitCode).toBe(0)
      expect(result.bytes).toBe(4096)
    })

    it('surfaces a DESTINATION failure with its exit code and stderr', async () => {
      const { spawn } = localSpawn()
      const streamer = createSshStreamer({ spawn })

      const result = await streamer.stream(
        { machine: SOURCE(), command: 'head -c 64 /dev/zero' },
        { machine: DEST(), command: 'echo "no space left" >&2; exit 9' }
      )

      expect(result.dest.exitCode).toBe(9)
      expect(result.dest.stderr).toContain('no space left')
    })

    it('never buffers the whole payload: the destination consumes while the source is still producing', async () => {
      // The PR's central claim is flat memory, and a size-only test cannot
      // check it: replacing the pump with
      //   `const buf = await new Response(sourceProc.stdout).arrayBuffer()`
      //   + `spawn(dest, { stdin: buf })`
      // moves 64 MiB through core's heap and still passes every size assertion.
      //
      // So this asserts the property that actually distinguishes them: the two
      // ends must be ALIVE AT THE SAME TIME. The source writes ~1 MiB and then
      // BLOCKS until the destination signals (by touching a sentinel on its
      // first read) that it has begun consuming. A streaming pump completes;
      // a buffering one deadlocks — it waits for the source to EOF before the
      // destination is even spawned, so the sentinel can never appear — and
      // trips the timeout.
      //
      // The 64 MiB tail is kept on top of the handshake: 64 MiB through a
      // 64 KiB pipe buffer only completes if backpressure is preserved end to
      // end rather than accumulated.
      const { spawn } = localSpawn()
      const streamer = createSshStreamer({ spawn })
      const handshakeDir = mkdtempSync(join(tmpdir(), 'tau-stream-handshake-'))
      const sentinel = join(handshakeDir, 'consuming')
      const HANDSHAKE_BYTES = 1024 * 1024
      const TAIL_BYTES = 64 * 1024 * 1024

      try {
        const result = await streamer.stream(
          {
            machine: SOURCE(),
            // Produce the handshake chunk, then refuse to produce anything more
            // until the destination proves it is reading.
            command:
              `head -c ${HANDSHAKE_BYTES} /dev/zero; ` +
              `while [ ! -e '${sentinel}' ]; do sleep 0.05; done; ` +
              `head -c ${TAIL_BYTES} /dev/zero`,
          },
          {
            machine: DEST(),
            // Signal on the FIRST read, then drain the rest.
            command: `dd bs=65536 count=1 of=/dev/null 2>/dev/null; touch '${sentinel}'; cat > /dev/null`,
          },
          // Bounded so a buffering implementation cannot wait forever. It does
          // NOT convert the deadlock into a tidy SshTimeoutError, though: a
          // buffering pump blocks BEFORE the timeout timer is armed, so it hangs
          // to bun's own per-test budget (40s below) and fails there. Either way
          // it fails — the property under test holds — but do not read this
          // number as a promise of a clean rejection.
          //
          // Sized for a LOADED machine, not an idle one. Moving 64 MiB through
          // 64 KiB pipes is inherently scheduling-bound, and at 20s a busy CI
          // runner tripped this timeout on correct code — a recurring flake.
          // Bun's per-test budget below remains the real backstop for a
          // buffering regression, so a longer bound here costs nothing.
          { timeoutMs: 35_000 }
        )

        expect(result.bytes).toBe(HANDSHAKE_BYTES + TAIL_BYTES)
        expect(result.source.exitCode).toBe(0)
        expect(result.dest.exitCode).toBe(0)
        expect(existsSync(sentinel)).toBe(true)
      } finally {
        // Without this every run leaves a tau-stream-handshake-* dir in tmp.
        rmSync(handshakeDir, { recursive: true, force: true })
      }
    }, 60_000)

    it('kills the SOURCE child when spawning the destination throws (no orphaned remote tar)', async () => {
      // The destination spawn can fail synchronously (EMFILE, a bad argv, an
      // ssh binary that is not there). The source is ALREADY running by then —
      // a `sudo tar -c` over a multi-GB workspace — and the migration is about
      // to clear its fence and move on. Whatever was spawned must be killed.
      const children: Array<{ exited: Promise<number> }> = []
      let calls = 0
      const spawn = ((args: string[], options: Record<string, unknown>) => {
        calls += 1
        if (calls === 2) throw new Error('spawn failed: EMFILE')
        const child = Bun.spawn(['bash', '-c', args[args.length - 1]], options as never)
        children.push(child)
        return child
      }) as unknown as typeof Bun.spawn

      await expect(
        createSshStreamer({ spawn }).stream(
          { machine: SOURCE(), command: 'sleep 30' },
          { machine: DEST(), command: 'cat > /dev/null' }
        )
      ).rejects.toThrow(/EMFILE/)

      expect(children).toHaveLength(1)
      // Resolves only because the child was killed — an un-killed `sleep 30`
      // would outlive this test's budget.
      expect(await children[0].exited).not.toBe(0)
    }, 10_000)

    it('kills BOTH children and rejects when the overall timeout expires', async () => {
      const { spawn } = localSpawn()
      const streamer = createSshStreamer({ spawn })

      await expect(
        streamer.stream(
          { machine: SOURCE(), command: 'sleep 30' },
          { machine: DEST(), command: 'cat > /dev/null' },
          { timeoutMs: 100 }
        )
      ).rejects.toBeInstanceOf(SshTimeoutError)
    }, 10_000)

    it('materializes BOTH machines’ identities during the stream and cleans both up after', async () => {
      const seen: string[] = []
      const spawn = ((args: string[], options: Record<string, unknown>) => {
        const iIdx = args.indexOf('-i')
        const identityPath = args[iIdx + 1]
        expect(existsSync(identityPath)).toBe(true)
        seen.push(identityPath)
        return Bun.spawn(['bash', '-c', args[args.length - 1]], options as never)
      }) as unknown as typeof Bun.spawn

      await createSshStreamer({ spawn }).stream(
        { machine: SOURCE(), command: 'true' },
        { machine: DEST(), command: 'cat > /dev/null' }
      )

      expect(seen).toHaveLength(2)
      for (const path of seen) expect(existsSync(path)).toBe(false)
    })
  })
})
