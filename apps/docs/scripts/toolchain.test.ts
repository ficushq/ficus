import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

// The checker loads astro2tsx -> wasm-runtime, whose @emnapi/runtime peer
// must be supplied explicitly because bunfig.toml disables automatic peers.
// Astro catches checker import errors as "missing dependencies" and may exit 0
// without running diagnostics. Exercise Node (the Astro CLI runtime), not Bun's
// module loader, so a missing transitive peer cannot silently skip typechecking.
test('the Astro checker and TypeScript load under Node with the installed docs dependencies', () => {
  const result = spawnSync(
    'node',
    ['--input-type=module', '-e', "await import('@astrojs/check'); await import('typescript')"],
    {
      cwd: resolve(import.meta.dir, '..'),
      encoding: 'utf8',
      timeout: 5000,
    }
  )
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
})
