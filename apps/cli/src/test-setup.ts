/**
 * CLI test setup. Preload this before CLI tests so output and client mocks
 * are registered before any command modules are imported.
 */
import { afterEach, mock } from 'bun:test'

const isJsonMode = mock(() => false)
const isQuietMode = mock(() => false)
// mock.restore() restores spies, but does not reset mockReturnValue on module
// mocks. A JSON-mode test otherwise suppresses tables in unrelated files.
afterEach(() => {
  isJsonMode.mockReset().mockReturnValue(false)
  isQuietMode.mockReset().mockReturnValue(false)
})

mock.module('./output', () => ({
  output: mock(() => {}),
  outputTable: mock(() => {}),
  outputError: mock(() => {}),
  isJsonMode,
  isQuietMode,
  setOutputOptions: mock(() => {}),
}))

// Idempotent POSTs delegate to the apiPost mock by default, so command tests can keep
// asserting a create's path and body on apiPost and still inspect the key and budget here.
const apiPostMock = mock((_path: string, _body?: unknown): Promise<unknown> => Promise.resolve({}))
mock.module('./client', () => ({
  apiGet: mock(() => Promise.resolve({})),
  apiPostResponse: mock(() => Promise.resolve(Response.json({}))),
  apiPost: apiPostMock,
  apiPostIdempotent: mock((path: string, body: unknown) => apiPostMock(path, body)),
  IdempotentRequestIncompleteError: class IdempotentRequestIncompleteError extends Error {
    constructor(
      readonly reason: 'timeout' | 'retries',
      readonly idempotencyKey: string,
      readonly timeoutMs: number,
      readonly cause?: unknown
    ) {
      super(
        reason === 'timeout' ? `No answer within ${Math.round(timeoutMs / 1000)} seconds` : 'The request kept failing'
      )
    }
  },
  apiPatch: mock(() => Promise.resolve({})),
  apiPut: mock(() => Promise.resolve({})),
  apiDelete: mock(() => Promise.resolve({})),
  apiGetRaw: mock(() => Promise.resolve(new Response(''))),
  apiFetch: mock(() => Promise.resolve(new Response(''))),
  apiPostForm: mock(() => Promise.resolve({})),
  apiPostSSE: mock(() => Promise.resolve()),
}))
