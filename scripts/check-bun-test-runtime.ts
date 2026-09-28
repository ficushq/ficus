export interface BunRuntime {
  version: string
  revision: string
  executable: string
}

const BROKEN_BUN_TEST_VERSIONS = new Set(['1.3.14'])

export function validateBunTestRuntime(runtime: BunRuntime): void {
  if (!BROKEN_BUN_TEST_VERSIONS.has(runtime.version)) return

  throw new Error(`Unsupported Bun test runtime.
Executable: ${runtime.executable}
Version/revision: ${runtime.version} (${runtime.revision})
Bun 1.3.14 has broken async top-level-await test preloads (oven-sh/bun#30887 and #30888).
Switch to the Bun version pinned in .bun-version, then re-run:
  bun run test`)
}

export function validateCurrentBunTestRuntime(): void {
  // This injection can only make the guard stricter. It gives integration tests a
  // deterministic bad runtime without allowing callers to bypass real validation.
  const runtime =
    process.env.FICUS_BUN_TEST_FORCE_BAD_RUNTIME === '1'
      ? {
          version: '1.3.14',
          revision: '1.3.14+injected-wiring-test',
          executable: process.execPath,
        }
      : {
          version: Bun.version,
          revision: Bun.revision,
          executable: process.execPath,
        }
  validateBunTestRuntime(runtime)
}

try {
  validateCurrentBunTestRuntime()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
