import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import ts from 'typescript'
import { SandboxClient, SandboxHttpError, type VerifiedWriteRequest } from '../services/sandbox/k8s/http-client'
import { createK8sSandboxedCodingTools } from './k8s-sandbox'
import {
  corpusGoldens,
  decodeUtf8Fatal,
  diffLines,
  identity,
  realEditCorpora,
  type GeneratedCorpus,
} from './test-support/real-edit-corpus'

// This suite spawns a real k8s-sandbox server process and drives it over a
// real HTTP client; bun's thin 5000ms default has flaked under CI scheduling
// jitter even though every case has generous local headroom. Match
// pickup.test.ts's setDefaultTimeout rationale.
setDefaultTimeout(60_000)

const SERVER_ENTRY = join(import.meta.dir, '../../../../packages/k8s-sandbox/src/server.ts')
const EXPECTED_SUFFIX_MAX = 512
const SERVER_TOKEN = 'real-edit-corpus-owned-token'

let root = ''
let serverWorkspace = ''
let serverProcess: ReturnType<typeof Bun.spawn> | undefined
let stderrCapture: Promise<string> | undefined
let client: SandboxClient
let fileSequence = 0

async function captureBounded(stream: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const reader = stream.getReader()
  const chunks: Buffer[] = []
  let retained = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (retained >= limit) continue
    const chunk = Buffer.from(value).subarray(0, limit - retained)
    chunks.push(chunk)
    retained += chunk.byteLength
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function waitForExit(proc: ReturnType<typeof Bun.spawn>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    proc.exited.then(
      () => true,
      () => false
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ])
}

async function stopServer(): Promise<void> {
  if (!serverProcess) return
  serverProcess.kill()
  if (!(await waitForExit(serverProcess, 2_000))) {
    serverProcess.kill('SIGKILL')
    if (!(await waitForExit(serverProcess, 2_000))) throw new Error('owned real-edit server did not exit after SIGKILL')
  }
  serverProcess = undefined
}

// This file spawns a real k8s-sandbox server subprocess and drives real
// verified-edit HTTP traffic against it — too jitter-prone for the shared CI
// runner. It runs only in the dedicated `subprocess-tests` CI job (see
// ci.yml); the main sweep sets FICUS_TEST_SKIP_SUBPROCESS=1 to skip it here.
const describeSubprocess = describe.skipIf(process.env.FICUS_TEST_SKIP_SUBPROCESS === '1')

beforeAll(async () => {
  if (process.env.FICUS_TEST_SKIP_SUBPROCESS === '1') return
  root = mkdtempSync(join(tmpdir(), 'real-edit-corpus-'))
  serverWorkspace = join(root, 'workspace')
  mkdirSync(serverWorkspace)
  const port = 20_000 + Math.floor(Math.random() * 20_000)
  const inheritedRuntimeEnv = Object.fromEntries(
    ['PATH', 'HOME', 'TMPDIR'].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]!]]))
  )
  serverProcess = Bun.spawn(['bun', SERVER_ENTRY], {
    env: {
      ...inheritedRuntimeEnv,
      EXECUTOR_PORT: String(port),
      EXECUTOR_BIND: '127.0.0.1',
      EXECUTOR_AUTH_TOKEN: SERVER_TOKEN,
      FICUS_SANDBOX_ROLE: 'agent',
      WORKSPACE_PATH: serverWorkspace,
    },
    stdout: 'ignore',
    stderr: 'pipe',
  })
  stderrCapture = captureBounded(serverProcess.stderr as ReadableStream<Uint8Array>, 4_096)
  client = new SandboxClient(`127.0.0.1:${port}`, SERVER_TOKEN)
  try {
    await client.waitForReady(15_000)
  } catch (error) {
    let stopFailure: unknown
    try {
      await stopServer()
    } catch (stopError) {
      stopFailure = stopError
    }
    const stderr = stopFailure ? '' : await stderrCapture?.catch(() => '')
    rmSync(root, { recursive: true, force: true })
    root = ''
    if (stopFailure) throw stopFailure
    throw new Error(`real-edit server failed readiness: ${(stderr ?? '').slice(0, 512)}`, { cause: error })
  }
})

afterAll(async () => {
  if (process.env.FICUS_TEST_SKIP_SUBPROCESS === '1') return
  let cleanupFailure: unknown
  try {
    client?.close()
  } catch (error) {
    cleanupFailure = error
  }
  try {
    await stopServer()
  } catch (error) {
    cleanupFailure ??= error
  }
  try {
    if (!cleanupFailure) await stderrCapture?.catch(() => '')
  } finally {
    if (root) rmSync(root, { recursive: true, force: true })
  }
  if (cleanupFailure) throw cleanupFailure
})

function parseDiagnosticCount(value: Buffer): number {
  const source = ts.createSourceFile(
    'generated.ts',
    decodeUtf8Fatal(value),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  return (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length
}

function assertGolden(corpus: GeneratedCorpus, key: keyof typeof corpusGoldens): void {
  const golden = corpusGoldens[key]
  expect(identity(corpus.original)).toEqual(golden.original)
  expect(identity(corpus.intendedResult)).toEqual(golden.intendedResult)
  expect(corpus.original.subarray(-Buffer.byteLength(corpus.exactSuffix)).toString()).toBe(corpus.exactSuffix)
}

function fileIdentity(value: { bytes: number; sha256: string }) {
  return { bytes: value.bytes, sha256: value.sha256 }
}

function nextPath(label: string): string {
  fileSequence += 1
  return join(serverWorkspace, `${String(fileSequence).padStart(2, '0')}-${label}.ts`)
}

function facade(overrides: Partial<Pick<SandboxClient, 'read' | 'stat' | 'writeVerified' | 'write'>> = {}) {
  return {
    read: overrides.read ?? client.read.bind(client),
    stat: overrides.stat ?? client.stat.bind(client),
    writeVerified: overrides.writeVerified ?? client.writeVerified.bind(client),
    write: overrides.write ?? client.write.bind(client),
  }
}

function editTool(clientLike = facade()) {
  const manager = {
    getClientForSandbox: () => clientLike,
    getSandboxStatus: async () => ({ status: 'running' }),
  }
  return createK8sSandboxedCodingTools(serverWorkspace, 'generated-real-edit', manager as any).find(
    (tool) => tool.key === 'edit'
  )!
}

async function executeEdit(path: string, corpus: GeneratedCorpus, clientLike = facade()) {
  return editTool(clientLike).execute('real-edit-corpus', { path, edits: [corpus.edit] } as any)
}

function assertDisk(path: string, expected: Buffer, corpus: GeneratedCorpus): void {
  const disk = readFileSync(path)
  expect(identity(disk)).toEqual(identity(expected))
  expect(disk.equals(expected)).toBe(true)
  expect(disk.subarray(-Buffer.byteLength(corpus.exactSuffix)).toString()).toBe(corpus.exactSuffix)
  expect(disk.includes(Buffer.from(corpus.eofSentinel))).toBe(true)
  expect(disk.includes(Buffer.from(corpus.closingSentinel))).toBe(true)
}

async function captureRejection(promise: Promise<unknown>, forbidden: readonly string[] = []): Promise<Error> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    const result = error as Error
    expect(Buffer.byteLength(result.message, 'utf8')).toBeLessThanOrEqual(EXPECTED_SUFFIX_MAX)
    expect(result.message).not.toContain('Successfully replaced')
    expect(result.message).not.toMatch(/integrity verified|successfully published/i)
    for (const fragment of forbidden.filter(Boolean)) expect(result.message).not.toContain(fragment)
    return result
  }
  throw new Error('expected real edit rejection')
}

async function runSuccess(label: string, corpus: GeneratedCorpus): Promise<string> {
  const path = nextPath(label)
  writeFileSync(path, corpus.original)
  const result = await executeEdit(path, corpus)
  const text = result.content.find((item) => item.type === 'text')?.text ?? ''
  expect(text).toContain('byte integrity verified')
  assertDisk(path, corpus.intendedResult, corpus)
  expect(parseDiagnosticCount(readFileSync(path))).toBe(0)
  return path
}

function braceDelta(value: Buffer): number {
  const text = decodeUtf8Fatal(value)
  return (text.match(/{/g)?.length ?? 0) - (text.match(/}/g)?.length ?? 0)
}

function assertCorruptionShape(corpus: GeneratedCorpus, corrupt: Buffer): void {
  expect(corrupt.includes(Buffer.from(corpus.eofSentinel))).toBe(false)
  expect(corrupt.includes(Buffer.from(corpus.closingSentinel))).toBe(false)
  expect(corrupt.subarray(-Buffer.byteLength(corpus.exactSuffix)).toString()).not.toBe(corpus.exactSuffix)
  expect(parseDiagnosticCount(corrupt)).toBeGreaterThan(0)
}

async function runTransportTamper(label: string, corpus: GeneratedCorpus, corrupt: Buffer): Promise<void> {
  assertCorruptionShape(corpus, corrupt)
  const path = nextPath(label)
  writeFileSync(path, corpus.original)
  let commits = 0
  const wrapped = facade({
    writeVerified: async (request: VerifiedWriteRequest) => {
      commits += 1
      return client.writeVerified({ ...request, content: corrupt.toString('base64') })
    },
  })
  const error = await captureRejection(executeEdit(path, corpus, wrapped), [
    path,
    corpus.edit.oldText,
    corrupt.subarray(0, 64).toString(),
  ])
  expect(commits).toBe(1)
  expect(error).toBeInstanceOf(SandboxHttpError)
  expect((error as SandboxHttpError).status).toBe(500)
  expect((error as SandboxHttpError).code).toBe('pre-publication')
  expect((error as SandboxHttpError).phase).toBe('pre-publication')
  expect(error.message).toContain('Atomic write request identity mismatch')
  expect(error.message).toContain('candidate was not published by this writer')
  assertDisk(path, corpus.original, corpus)
}

const A = realEditCorpora.diffText
const B = realEditCorpora.executor
const C = realEditCorpora.schema
const D = realEditCorpora.providerBase
const E = realEditCorpora.providerSchema
const F = realEditCorpora.staleBase
const G = realEditCorpora.amtpNodeRecurrence
const H = realEditCorpora.queriesPostRestoreRecurrence

describeSubprocess('real sandbox verified edit incident corpus', () => {
  test('diff-text mixed missing call: zero commit, original exact', async () => {
    assertGolden(A, 'diffText')
    const path = nextPath('diff-mixed')
    writeFileSync(path, A.original)
    let commits = 0
    const wrapped = facade({
      writeVerified: async () => {
        commits += 1
        throw new Error('unexpected commit')
      },
    })
    const error = await captureRejection(
      editTool(wrapped).execute('mixed', {
        path,
        edits: [
          A.edit,
          { oldText: 'MISSING-LATER-EDIT', newText: 'must-not-land' },
          { oldText: '// DIFF-TEXT-LATER-CANDIDATE-B', newText: '// LATER-EDIT' },
        ],
      } as any),
      [path, A.edit.oldText, 'must-not-land', '// LATER-EDIT']
    )
    expect(error.message).toContain('Edit integrity check failed before write')
    expect(error.message).toContain('original file was not modified')
    expect(error.message).toMatch(/not found|missing/i)
    expect(commits).toBe(0)
    assertDisk(path, A.original, A)
  })

  test('diff-text unique helper success and real multi-page read', async () => {
    assertGolden(A, 'diffText')
    expect(A.original.byteLength).toBeGreaterThan(1024 * 1024)
    const path = await runSuccess('diff-success', A)
    const disk = readFileSync(path)
    expect(decodeUtf8Fatal(disk).split('\n')[1084]).toBe('  // DIFF-TEXT-LONG-FUNCTION-MARKER')
    for (const contamination of ['diff --git', 'ddiff --git', '"oldText"', 'REQUEST-SERIALIZATION-MUST-NOT-LAND']) {
      expect(disk.includes(Buffer.from(contamination))).toBe(false)
    }
  })

  test('executor unique success', async () => {
    assertGolden(B, 'executor')
    expect(braceDelta(B.original)).toBe(0)
    expect(B.original.includes(Buffer.from(B.closingSentinel))).toBe(true)
    await runSuccess('executor-success', B)
  })

  test('schema unique success', async () => {
    assertGolden(C, 'schema')
    await runSuccess('schema-success', C)
  })

  test('provider base unique same-length success', async () => {
    assertGolden(D, 'providerBase')
    expect(D.original.byteLength).toBe(D.intendedResult.byteLength)
    await runSuccess('provider-success', D)
  })

  test('provider schema intended +5/-1 success', async () => {
    assertGolden(E, 'providerSchema')
    expect(diffLines(E.original, E.intendedResult)).toEqual({ added: 5, removed: 1 })
    await runSuccess('provider-schema-success', E)
  })

  test('concurrent stale-base edit refuses after cooperating restore and leaves exact restored identity', async () => {
    assertGolden(F, 'staleBase')
    const restored = F.corruptions.restored
    expect(identity(restored)).toEqual(corpusGoldens.staleBase.corruptions.restored)
    expect(diffLines(restored, F.original)).toEqual({ added: 38, removed: 12 })
    const path = nextPath('stale-conflict')
    writeFileSync(path, F.original)
    let release!: () => void
    let sawRequest!: (request: VerifiedWriteRequest) => void
    let staleDelegations = 0
    const intercepted = new Promise<VerifiedWriteRequest>((resolve) => {
      sawRequest = resolve
    })
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const wrapped = facade({
      writeVerified: async (request: VerifiedWriteRequest) => {
        staleDelegations += 1
        sawRequest(request)
        await barrier
        return client.writeVerified(request)
      },
    })
    const staleExecution = executeEdit(path, F, wrapped)
    const staleRequest = await intercepted
    let restoreSettled = false
    let restoreFailure: unknown
    try {
      expect(staleRequest.expectedOriginal).toEqual(fileIdentity(corpusGoldens.staleBase.original))
      expect(staleRequest.expectedResult).toEqual(fileIdentity(corpusGoldens.staleBase.intendedResult))
      const response = await client.writeVerified({
        path,
        content: restored.toString('base64'),
        expectedOriginal: fileIdentity(corpusGoldens.staleBase.original),
        expectedResult: fileIdentity(corpusGoldens.staleBase.corruptions.restored),
      })
      expect(response.bytesWritten).toBe(corpusGoldens.staleBase.corruptions.restored.bytes)
      expect(response.sha256).toBe(corpusGoldens.staleBase.corruptions.restored.sha256)
      restoreSettled = true
    } catch (error) {
      restoreFailure = error
    } finally {
      release()
    }
    if (restoreFailure) {
      await staleExecution.then(
        () => undefined,
        () => undefined
      )
      throw restoreFailure
    }
    expect(restoreSettled).toBe(true)
    const error = await captureRejection(staleExecution, [path, F.edit.oldText, F.edit.newText])
    expect(staleDelegations).toBe(1)
    expect(error).toBeInstanceOf(SandboxHttpError)
    expect((error as SandboxHttpError).status).toBe(409)
    expect((error as SandboxHttpError).code).toBe('edit-conflict')
    expect((error as SandboxHttpError).phase).toBe('pre-publication')
    expect(error.message).toContain('candidate was not published by this writer')
    assertDisk(path, restored, F)
    expect(restored.includes(Buffer.from(F.edit.oldText))).toBe(true)
    expect(restored.includes(Buffer.from(F.edit.newText))).toBe(false)
    expect(parseDiagnosticCount(restored)).toBe(0)
    expect(parseDiagnosticCount(F.original)).toBeGreaterThan(0)
  })

  test('diff-text transport contamination rejected by server', async () => {
    assertGolden(A, 'diffText')
    const corrupt = A.corruptions.transportContamination
    expect(identity(corrupt)).toEqual(corpusGoldens.diffText.corruptions.transportContamination)
    expect(corrupt.includes(Buffer.from('ddiff --git'))).toBe(true)
    expect(parseDiagnosticCount(corrupt)).toBeGreaterThan(0)
    await runTransportTamper('diff-transport', A, corrupt)
  })

  test('executor line-1,076 truncation rejected by server', async () => {
    assertGolden(B, 'executor')
    const corrupt = B.corruptions.transportTruncation
    expect(identity(corrupt)).toEqual(corpusGoldens.executor.corruptions.transportTruncation)
    expect(braceDelta(corrupt)).not.toBe(0)
    expect(corrupt.includes(Buffer.from(B.closingSentinel))).toBe(false)
    expect(parseDiagnosticCount(corrupt)).toBeGreaterThan(0)
    await runTransportTamper('executor-truncation', B, corrupt)
  })

  test('schema line-882 partial truncation rejected by server', async () => {
    assertGolden(C, 'schema')
    const corrupt = C.corruptions.transportTruncation
    expect(identity(corrupt)).toEqual(corpusGoldens.schema.corruptions.transportTruncation)
    expect(corrupt.subarray(-"// derivation's o".length).toString()).toBe("// derivation's o")
    expect(parseDiagnosticCount(corrupt)).toBeGreaterThan(0)
    await runTransportTamper('schema-truncation', C, corrupt)
  })

  test('provider base size/EOF shape 1,318 lines and 52,414 bytes rejected by server', async () => {
    assertGolden(D, 'providerBase')
    const corrupt = D.corruptions.providerSizeEofCorrupt
    expect(identity(corrupt)).toEqual(corpusGoldens.providerBase.corruptions.providerSizeEofCorrupt)
    expect(diffLines(D.original, corrupt)).toEqual({ added: 34, removed: 1397 })
    expect(corrupt.includes(Buffer.from(D.eofSentinel))).toBe(false)
    await runTransportTamper('provider-size', D, corrupt)
  })

  test('provider base diff-stat shape +34/-1,398 and 52,414 bytes rejected by server', async () => {
    assertGolden(D, 'providerBase')
    const corrupt = D.corruptions.providerDiffStatCorrupt
    expect(identity(corrupt)).toEqual(corpusGoldens.providerBase.corruptions.providerDiffStatCorrupt)
    expect(diffLines(D.original, corrupt)).toEqual({ added: 34, removed: 1398 })
    expect(corrupt.includes(Buffer.from(D.exactSuffix))).toBe(false)
    await runTransportTamper('provider-diffstat', D, corrupt)
  })

  test('provider schema shape 1,152 lines, 51,526 bytes, and +6/-976 rejected by server', async () => {
    assertGolden(E, 'providerSchema')
    const corrupt = E.corruptions.providerSchemaCorrupt
    expect(identity(corrupt)).toEqual(corpusGoldens.providerSchema.corruptions.providerSchemaCorrupt)
    expect(diffLines(E.original, corrupt)).toEqual({ added: 6, removed: 976 })
    expect(parseDiagnosticCount(corrupt)).toBeGreaterThan(0)
    await runTransportTamper('provider-schema-corrupt', E, corrupt)
  })

  test('AMTP node recurrence unexpected shrink rejected with exact 1,502-line original preserved', async () => {
    assertGolden(G, 'amtpNodeRecurrence')
    const corrupt = G.corruptions.unexpectedShrink
    expect(identity(corrupt)).toEqual(corpusGoldens.amtpNodeRecurrence.corruptions.unexpectedShrink)
    expect(corrupt.includes(Buffer.from(G.exactSuffix))).toBe(false)
    expect(parseDiagnosticCount(corrupt)).toBeGreaterThan(0)
    await runTransportTamper('amtp-shrink', G, corrupt)
  })

  test('queries post-restore 650-line recurrence of unknown cause is rejected with clean scaffold preserved', async () => {
    assertGolden(H, 'queriesPostRestoreRecurrence')
    expect(H.original.equals(F.corruptions.restored)).toBe(true)
    expect(H.edit.oldText).not.toBe(F.edit.oldText)
    const corrupt = H.corruptions.syntheticLost650
    expect(identity(corrupt)).toEqual(corpusGoldens.queriesPostRestoreRecurrence.corruptions.syntheticLost650)
    expect(corrupt.subarray(-Buffer.byteLength(H.exactSuffix)).toString()).not.toBe(H.exactSuffix)
    expect(parseDiagnosticCount(corrupt)).toBeGreaterThan(0)
    await runTransportTamper('queries-unknown-shrink', H, corrupt)
  })

  test('corrupt or short initial Core read fails before verified write', async () => {
    assertGolden(A, 'diffText')
    const path = nextPath('initial-read')
    writeFileSync(path, A.original)
    let writes = 0
    const wrapped = facade({
      read: async () => ({ content: '', totalSize: A.original.byteLength, isBinary: false }),
      writeVerified: async () => {
        writes += 1
        throw new Error('unexpected verified write')
      },
    })
    const error = await captureRejection(executeEdit(path, A, wrapped), [
      path,
      A.edit.oldText,
      A.original.subarray(0, 64).toString(),
    ])
    expect(error.message).toBe(
      `Complete remote file read failed: remote read stopped at 0 of ${A.original.byteLength} bytes`
    )
    expect(error.message).not.toMatch(/published|publication/i)
    expect(writes).toBe(0)
    assertDisk(path, A.original, A)
  })

  test('corrupt Core final readback suppresses success after server response', async () => {
    assertGolden(B, 'executor')
    const path = nextPath('final-readback')
    writeFileSync(path, B.original)
    let committed = false
    let verifiedCommits = 0
    let corruptedReadPages = 0
    const wrapped = facade({
      writeVerified: async (request: VerifiedWriteRequest) => {
        verifiedCommits += 1
        const response = await client.writeVerified(request)
        committed = true
        return response
      },
      read: async (request: { path: string; offset?: number; limit?: number }) => {
        const response = await client.read(request)
        if (!committed || (request.offset ?? 0) !== 0) return response
        corruptedReadPages += 1
        const page = Buffer.from(response.content, 'base64')
        page[0] ^= 1
        return { ...response, content: page.toString('base64') }
      },
    })
    const error = await captureRejection(executeEdit(path, B, wrapped), [
      path,
      B.edit.oldText,
      B.original.subarray(0, 64).toString(),
    ])
    expect(error.message).toContain('final readback identity mismatch')
    expect(error.message).toContain('candidate may have been published')
    expect(error.message).toContain('success was not reported')
    expect(verifiedCommits).toBe(1)
    expect(corruptedReadPages).toBe(1)
    assertDisk(path, B.intendedResult, B)
  })

  test('old executor write-verified 404 fails closed with no legacy write fallback', async () => {
    assertGolden(C, 'schema')
    const path = nextPath('old-executor')
    writeFileSync(path, C.original)
    let verified = 0
    let legacy = 0
    const wrapped = facade({
      writeVerified: async () => {
        verified += 1
        throw new SandboxHttpError(
          "Sandbox executor is outdated. Restart this agent's sandbox from the agent page, or recreate the squad sandbox, then retry; the verified edit was not attempted",
          404
        )
      },
      write: async () => {
        legacy += 1
        throw new Error('legacy write forbidden')
      },
    })
    const error = await captureRejection(executeEdit(path, C, wrapped), [
      path,
      C.edit.oldText,
      C.original.subarray(0, 64).toString(),
    ])
    expect(error).toBeInstanceOf(SandboxHttpError)
    expect((error as SandboxHttpError).status).toBe(404)
    expect(error.message).toBe(
      "Sandbox executor is outdated. Restart this agent's sandbox from the agent page, or recreate the squad sandbox, then retry; the verified edit was not attempted"
    )
    expect(verified).toBe(1)
    expect(legacy).toBe(0)
    assertDisk(path, C.original, C)
  })
})
