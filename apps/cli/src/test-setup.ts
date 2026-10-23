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

mock.module('./client', () => ({
  apiGet: mock(() => Promise.resolve({})),
  apiPost: mock(() => Promise.resolve({})),
  apiPatch: mock(() => Promise.resolve({})),
  apiPut: mock(() => Promise.resolve({})),
  apiDelete: mock(() => Promise.resolve({})),
  apiGetRaw: mock(() => Promise.resolve(new Response(''))),
  apiFetch: mock(() => Promise.resolve(new Response(''))),
  apiPostForm: mock(() => Promise.resolve({})),
  apiPostSSE: mock(() => Promise.resolve()),
}))
