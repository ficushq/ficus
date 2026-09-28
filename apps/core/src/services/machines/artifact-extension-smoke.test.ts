import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { smokeConfiguredExtensions } from '../../smoke-configured-extensions'
import { expectCleanExit, runCapturedProcess } from '../../test-utils/captured-process'

const CODE_AST_ROOT = resolve(import.meta.dir, '../../../../../config/agent/extensions/code-ast')
const roots: string[] = []
async function scratch(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

async function write(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents)
}

describe('smokeConfiguredExtensions', () => {
  it('declares host-provided imports as optional peers and keeps TypeScript extension-local', async () => {
    const manifest = JSON.parse(await Bun.file(join(CODE_AST_ROOT, 'package.json')).text())

    expect(manifest.dependencies).toEqual({ typescript: '^5.7.0' })
    expect(manifest.peerDependencies).toEqual({
      '@earendil-works/pi-coding-agent': '0.87.1',
      '@earendil-works/pi-tui': '0.87.1',
      '@sinclair/typebox': '^0.34.48',
    })
    expect(manifest.peerDependenciesMeta).toEqual({
      '@earendil-works/pi-coding-agent': { optional: true },
      '@earendil-works/pi-tui': { optional: true },
      '@sinclair/typebox': { optional: true },
    })
  })

  it('loads the configured code-ast extension and verifies its registered tools', async () => {
    const extensionsDir = dirname(CODE_AST_ROOT)

    const result = await smokeConfiguredExtensions({ extensionsDir, cwd: process.cwd() })

    expect(result).toEqual({
      extensions: ['code-ast'],
      tools: {
        'code-ast': ['ast_references', 'ast_rename', 'ast_symbols'],
      },
    })
  })

  describe('isolated bundled artifact', () => {
    let artifactRoot: string
    let coreDir: string
    let extensionsDir: string
    beforeAll(async () => {
      artifactRoot = await scratch('artifact-extension-smoke-isolated-')
      coreDir = join(artifactRoot, 'apps/core')
      extensionsDir = join(artifactRoot, 'config/agent/extensions')
      await mkdir(join(coreDir, 'dist'), { recursive: true })
      await cp(CODE_AST_ROOT, join(extensionsDir, 'code-ast'), { recursive: true })
      // A real artifact vendors extension dependencies. Copy the installed package
      // explicitly: a bare extension can make Bun auto-install from the network,
      // so its timing and success depend on a warm global package cache.
      await cp(
        dirname(Bun.resolveSync('typescript/package.json', import.meta.dir)),
        join(extensionsDir, 'code-ast/node_modules/typescript'),
        { recursive: true, dereference: true }
      )
      await cp(resolve(CODE_AST_ROOT, '../../../agent-types'), join(artifactRoot, 'config/agent-types'), {
        recursive: true,
      })

      // Build is fixture preparation, not part of the extension loader's deadline.
      // Use the same bundler without starting another runtime just to invoke it.
      const built = await Bun.build({
        entrypoints: [resolve(import.meta.dir, '../../smoke-configured-extensions.ts')],
        outdir: join(coreDir, 'dist'),
        target: 'bun',
      })
      expect(built.success, built.logs.map(String).join('\n')).toBe(true)
    })
    it('loads code-ast from an isolated artifact through the bundled host runtime', async () => {
      const smoke = await runCapturedProcess(
        [
          process.execPath,
          '--no-install',
          join(coreDir, 'dist/smoke-configured-extensions.js'),
          extensionsDir,
          coreDir,
        ],
        {
          cwd: coreDir,
          env: { ...process.env, FICUS_ROOT: artifactRoot },
          timeoutMs: 4500,
        }
      )
      expectCleanExit(smoke)
      expect(`${smoke.stdout}\n${smoke.stderr}`).toContain('configured extension smoke: PASS (code-ast)')
    })
  })

  it('names the configured extension and underlying resolution error when a host dependency is missing', async () => {
    const root = await scratch('artifact-extension-smoke-missing-')
    const extensionRoot = join(root, 'config/agent/extensions/broken-host-alias')
    await write(join(root, 'config/agent-types/test.yaml'), 'id: test\nextensions:\n  - broken-host-alias\n')
    await write(
      join(extensionRoot, 'package.json'),
      `${JSON.stringify({ name: 'broken-host-alias', private: true, pi: { extensions: ['./index.ts'] } })}\n`
    )
    await write(join(extensionRoot, 'index.ts'), `import 'missing-host-alias-fixture'\nexport default function () {}\n`)

    await expect(
      smokeConfiguredExtensions({ extensionsDir: join(root, 'config/agent/extensions'), cwd: root })
    ).rejects.toThrow(/configured extension broken-host-alias.*missing-host-alias-fixture/is)
  })

  for (const [label, pi] of [
    ['missing', undefined],
    ['empty', { extensions: [] }],
  ] as const) {
    it(`fails by extension name when pi.extensions is ${label}`, async () => {
      const root = await scratch(`artifact-extension-smoke-${label}-entrypoints-`)
      const extensionName = `${label}-entrypoints`
      await write(join(root, 'config/agent-types/test.yaml'), `id: test\nextensions:\n  - ${extensionName}\n`)
      await write(
        join(root, 'config/agent/extensions', extensionName, 'package.json'),
        `${JSON.stringify({ name: extensionName, private: true, ...(pi === undefined ? {} : { pi }) })}\n`
      )

      await expect(
        smokeConfiguredExtensions({ extensionsDir: join(root, 'config/agent/extensions'), cwd: root })
      ).rejects.toThrow(new RegExp(`configured extension ${extensionName}.*pi\\.extensions`, 'is'))
    })
  }

  for (const [label, extensions] of [
    ['non-array', './index.ts'],
    ['non-string entry', [42]],
  ] as const) {
    it(`fails by extension name when pi.extensions has a ${label}`, async () => {
      const root = await scratch('artifact-extension-smoke-malformed-entrypoints-')
      const extensionName = 'malformed-entrypoints'
      await write(join(root, 'config/agent-types/test.yaml'), `id: test\nextensions:\n  - ${extensionName}\n`)
      await write(
        join(root, 'config/agent/extensions', extensionName, 'package.json'),
        `${JSON.stringify({ name: extensionName, private: true, pi: { extensions } })}\n`
      )

      await expect(
        smokeConfiguredExtensions({ extensionsDir: join(root, 'config/agent/extensions'), cwd: root })
      ).rejects.toThrow(new RegExp(`configured extension ${extensionName}.*pi\\.extensions`, 'is'))
    })
  }

  it('loads only extensions referenced by configured agent types', async () => {
    const root = await scratch('artifact-extension-smoke-configured-')
    await write(join(root, 'config/agent-types/test.yaml'), 'id: test\nextensions:\n  - configured\n')
    for (const name of ['configured', 'unused-broken']) {
      const extensionRoot = join(root, 'config/agent/extensions', name)
      await write(
        join(extensionRoot, 'package.json'),
        `${JSON.stringify({ name, private: true, pi: { extensions: ['./index.ts'] } })}\n`
      )
      await write(
        join(extensionRoot, 'index.ts'),
        name === 'configured'
          ? 'export default function () {}\n'
          : `import 'missing-unused-extension-dependency'\nexport default function () {}\n`
      )
    }

    const result = await smokeConfiguredExtensions({
      extensionsDir: join(root, 'config/agent/extensions'),
      cwd: root,
    })
    expect(result.extensions).toEqual(['configured'])
  })
})
