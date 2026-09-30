import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { verifyAgentSessionDataflow, verifySanitizerTypeAndExports } from './pi-agent-session-dataflow'

const root = resolve(import.meta.dir, '..')
const overlayRoot = resolve(root, 'patches/pi-coding-agent-0.99.1-source')
const expectedSources = [
  'packages/coding-agent/src/core/agent-session.ts',
  'packages/coding-agent/src/core/extensions/loader.ts',
  'packages/coding-agent/src/core/index.ts',
  'packages/coding-agent/src/core/sdk.ts',
  'packages/coding-agent/src/core/tools/read.ts',
  'packages/coding-agent/src/index.ts',
]
const expectedBuildOutputs = [
  'dist/core/agent-session.d.ts',
  'dist/core/agent-session.d.ts.map',
  'dist/core/agent-session.js',
  'dist/core/agent-session.js.map',
  'dist/core/extensions/loader.d.ts.map',
  'dist/core/extensions/loader.js',
  'dist/core/extensions/loader.js.map',
  'dist/core/index.d.ts',
  'dist/core/index.d.ts.map',
  'dist/core/index.js',
  'dist/core/index.js.map',
  'dist/core/sdk.d.ts',
  'dist/core/sdk.d.ts.map',
  'dist/core/sdk.js',
  'dist/core/sdk.js.map',
  'dist/core/tools/read.d.ts',
  'dist/core/tools/read.d.ts.map',
  'dist/core/tools/read.js',
  'dist/core/tools/read.js.map',
  'dist/index.d.ts',
  'dist/index.d.ts.map',
  'dist/index.js',
  'dist/index.js.map',
]
// The overlays leave these build outputs byte-identical to the published package,
// so they stay in the regeneration allowlist but never appear in the patch.
const unchangedBuildOutputs = new Set(['dist/core/sdk.d.ts', 'dist/core/extensions/loader.d.ts.map'])
const expectedPatchOutputs = expectedBuildOutputs.filter((file) => !unchangedBuildOutputs.has(file))

function verifyPatchHeaders(patch: string): void {
  if (/\/home\/|\.bun\/install\/cache/.test(patch)) throw new Error('patch contains a host-specific path')
  if (/^(deleted|new) file mode /m.test(patch)) throw new Error('patch changes file existence')
  const sections = patch.split(/^diff --git /m).slice(1)
  const paths = sections.map((section) => section.slice(0, section.indexOf('\n')).split(' ')[0]!.replace(/^a\//, ''))
  if (JSON.stringify(paths.sort()) !== JSON.stringify([...expectedPatchOutputs].sort()))
    throw new Error('patch output allowlist mismatch')
  for (const section of sections) {
    const [header, ...lines] = section.split('\n')
    const [from, to] = header!.split(' ')
    const path = from!.replace(/^a\//, '')
    if (/\\|^\/|\.\.\//.test(path) || to === '/dev/null') throw new Error('diff header contains an excluded path')
    if (from !== `a/${path}` || to !== `b/${path}`) throw new Error('diff header is not normalized')
    if (!lines.includes(`--- a/${path}`) || !lines.includes(`+++ b/${path}`))
      throw new Error('file headers are not normalized')
  }
}

function replaceRequired(source: string, from: string, to: string): string {
  if (!source.includes(from)) throw new Error(`mutation source missing: ${from}`)
  return source.replace(from, to)
}

describe('Pi patch no-drift CI gate', () => {
  const source = readFileSync(resolve(overlayRoot, expectedSources[0]!), 'utf8')

  test('uses only reviewed source overlays and emits an exact portable output allowlist', () => {
    const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')
    const script = readFileSync(resolve(root, 'scripts/regenerate-pi-coding-agent-patch.sh'), 'utf8')
    const patch = readFileSync(resolve(root, 'patches/@earendil-works%2Fpi-coding-agent@0.99.1.patch'), 'utf8')
    expect(
      workflow
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.includes('scripts/regenerate-pi-coding-agent-patch.sh'))
    ).toEqual(['PI_MONO_DIR="$RUNNER_TEMP/pi-mono" bash scripts/regenerate-pi-coding-agent-patch.sh'])
    expect(workflow).toContain('uses: actions/setup-node@v4')
    expect(workflow).toContain('node-version: 24')
    expect(workflow).toContain('bun test ./ci-pi-patch-gate.test.ts')
    for (const file of expectedSources) expect(script).toContain(file)
    for (const file of expectedBuildOutputs) expect(script).toContain(file)
    expect(script).toContain('cmp "$GENERATED_PATCH_A" "$GENERATED_PATCH_B"')
    expect(script).toContain('git -C "$candidate" diff --binary --no-ext-diff --src-prefix=a/ --dst-prefix=b/')
    expect(script).not.toContain('BASELINE_')
    expect(script).not.toContain('bun patch')
    expect(script).toContain('bun install --frozen-lockfile --ignore-scripts --linker hoisted')
    expect(script).toContain('cp "$SOURCE_ROOT/bun.lock" "$dir/bun.lock"')
    expect(script).toContain('Pristine source build does not reproduce published output')
    expect(script).not.toContain('rsync --delete')
    expect(script).toContain('Pi patch regeneration requires Node.js >=22.19')
    const writeGuard = script.indexOf('if [[ "$WRITE_MODE" -eq 1 ]]')
    const guardedCopy = script.indexOf('cp "$GENERATED_PATCH_A" "$PATCH_ARTIFACT"')
    const guardEnd = script.indexOf('fi', writeGuard)
    expect(writeGuard).toBeGreaterThan(-1)
    expect(guardedCopy).toBeGreaterThan(writeGuard)
    expect(guardedCopy).toBeLessThan(guardEnd)
    expect(script.indexOf('exit 1', guardEnd)).toBeGreaterThan(guardEnd)
    verifyPatchHeaders(patch)
  })

  test('preserves existing public runtime APIs while adding sanitizer exports', () => {
    const sdk = readFileSync(resolve(overlayRoot, 'packages/coding-agent/src/core/sdk.ts'), 'utf8')
    const index = readFileSync(resolve(overlayRoot, 'packages/coding-agent/src/index.ts'), 'utf8')
    expect(sdk).toContain('export * from "./agent-session-runtime.ts";')
    for (const runtimeExport of [
      'resolveCliModel,',
      'resolveModelScopeWithDiagnostics,',
      'DefaultPackageManager',
      'DefaultResourceLoader,',
      'loadProjectContextFiles }',
      'AgentSessionRuntime,',
      'createAgentSessionRuntime,',
      'main }',
      'InteractiveMode,',
      'RpcClient,',
      'runPrintMode,',
      'runRpcMode,',
    ]) {
      expect(index).toContain(runtimeExport)
    }
  })

  test('proves exact sanitizer, listener, and persistence dataflow in reviewed source', () => {
    verifyAgentSessionDataflow(source, 'agent-session.ts')
    verifySanitizerTypeAndExports(source, [
      readFileSync(resolve(overlayRoot, 'packages/coding-agent/src/core/index.ts'), 'utf8'),
      readFileSync(resolve(overlayRoot, 'packages/coding-agent/src/index.ts'), 'utf8'),
    ])
    const script = readFileSync(resolve(root, 'scripts/regenerate-pi-coding-agent-patch.sh'), 'utf8')
    expect(script).toContain('pi-agent-session-dataflow-cli.ts')
    expect(script).toContain('dist/core/agent-session.js')
  })

  test.each([
    [
      'discard sanitizer return',
      'event = this._eventSanitizer ? await this._eventSanitizer(event) : event;',
      'this._eventSanitizer ? await this._eventSanitizer(event) : event;',
    ],
    ['sanitize wrong value', 'await this._eventSanitizer(event)', 'await this._eventSanitizer(unsafeEvent)'],
    [
      'persist unsafe input',
      'this.sessionManager.appendMessage(event.message)',
      'this.sessionManager.appendMessage(unsafeEvent.message)',
    ],
    ['report unsafe input', 'message: event.message', 'message: unsafeEvent.message'],
    ['emit unsafe input', 'this._emit(event.type', 'this._emit(unsafeEvent.type'],
    [
      'emit arbitrary event expression',
      'this._emit(event.type === "agent_end" ? { ...event, willRetry: this._willRetryAfterAgentEnd(event) } : event);',
      'this._emit({ event });',
    ],
    [
      'insert unsafe listener sink before extension',
      '// Emit to extensions first',
      'this._emit(unsafeEvent);\n\t\t// Emit to extensions first',
    ],
    [
      'insert extra unsafe extension sink',
      '// Emit to extensions first',
      'await this._emitExtensionEvent(unsafeEvent);\n\t\t// Emit to extensions first',
    ],
    [
      'insert element-access unsafe listener sink',
      '// Emit to extensions first',
      'this["_emit"](unsafeEvent);\n\t\t// Emit to extensions first',
    ],
    [
      'insert call-based unsafe listener sink',
      '// Emit to extensions first',
      'this._emit.call(this, unsafeEvent);\n\t\t// Emit to extensions first',
    ],
    [
      'insert bind-based unsafe listener sink',
      '// Emit to extensions first',
      '(this._emit.bind(this))(unsafeEvent);\n\t\t// Emit to extensions first',
    ],
    [
      'insert aliased unsafe listener sink',
      '// Emit to extensions first',
      'const emitAlias = this._emit;\n\t\temitAlias(unsafeEvent);\n\t\t// Emit to extensions first',
    ],
    [
      'insert comma-callee unsafe listener sink',
      '// Emit to extensions first',
      '(0, this._emit)(unsafeEvent);\n\t\t// Emit to extensions first',
    ],
    [
      'insert aliased unsafe persistence sink',
      '// Emit to extensions first',
      'const appendAlias = this.sessionManager.appendMessage;\n\t\tappendAlias(unsafeEvent.message);\n\t\t// Emit to extensions first',
    ],
    [
      'insert arbitrary unsafe network sink',
      '// Emit to extensions first',
      'fetch("https://canary.invalid", { body: JSON.stringify(unsafeEvent) });\n\t\t// Emit to extensions first',
    ],
    [
      'insert aliased pre-guard listener sink for stale event',
      'await this._emitExtensionEvent(event);',
      'await this._emitExtensionEvent(event);\n\t\tconst emitAlias = this._emit;\n\t\temitAlias(event);',
    ],
    [
      'insert Reflect.apply unsafe persistence sink',
      '// Emit to extensions first',
      'Reflect.apply(this.sessionManager.appendMessage, this.sessionManager, [unsafeEvent.message]);\n\t\t// Emit to extensions first',
    ],
    [
      'insert apply-based unsafe persistence sink',
      '// Emit to extensions first',
      'this.sessionManager.appendMessage.apply(this.sessionManager, [unsafeEvent.message]);\n\t\t// Emit to extensions first',
    ],
    [
      'insert parenthesized unsafe custom persistence sink',
      '// Emit to extensions first',
      '(this.sessionManager.appendCustomMessageEntry)(unsafeEvent.message.customType, unsafeEvent.message.content, unsafeEvent.message.display, unsafeEvent.message.details);\n\t\t// Emit to extensions first',
    ],
    [
      'insert unsafe persistence sink before extension',
      '// Emit to extensions first',
      'this.sessionManager.appendMessage(unsafeEvent.message);\n\t\t// Emit to extensions first',
    ],
    [
      'insert extra unsafe listener sink',
      '// Notify all listeners',
      'this._emit(unsafeEvent);\n\t\t// Notify all listeners',
    ],
    [
      'insert extra unsafe persistence sink',
      '// Handle session persistence',
      'this.sessionManager.appendMessage(unsafeEvent.message);\n\t\t// Handle session persistence',
    ],
    [
      'insert nested decoy',
      '// Notify all listeners',
      'if (event.type === "message_end") await this._eventSanitizer(event);\n\t\t// Notify all listeners',
    ],
  ])('rejects mutation: %s', (_name, from, to) => {
    expect(() => verifyAgentSessionDataflow(replaceRequired(source, from, to), 'mutated.ts')).toThrow()
  })

  test('rejects unreachable custom or regular persistence branches', () => {
    expect(() =>
      verifyAgentSessionDataflow(
        replaceRequired(source, 'if (event.message.role === "custom") {', 'if (false) {'),
        'mutated.ts'
      )
    ).toThrow()
    expect(() =>
      verifyAgentSessionDataflow(replaceRequired(source, 'event.message.role === "user" ||', 'false ||'), 'mutated.ts')
    ).toThrow()
  })

  test('rejects sanitizer setter and backing fields not tied to the exact alias', () => {
    const setter = replaceRequired(
      source,
      'setEventSanitizer(sanitizer: AgentSessionEventSanitizer | undefined)',
      'setEventSanitizer(sanitizer: unknown)'
    )
    expect(() => verifyAgentSessionDataflow(setter, 'mutated.ts')).toThrow()
    const backing = replaceRequired(
      source,
      'private _eventSanitizer?: AgentSessionEventSanitizer;',
      'private _eventSanitizer?: (event: AgentEvent) => AgentEvent | Promise<AgentEvent>;'
    )
    expect(() => verifyAgentSessionDataflow(backing, 'mutated.ts')).toThrow()
  })

  test('rejects sanitizer return unions with any extra member', () => {
    const mutated = replaceRequired(
      source,
      'AgentEvent | Promise<AgentEvent>;',
      'AgentEvent | Promise<AgentEvent> | any;'
    )
    expect(() =>
      verifySanitizerTypeAndExports(mutated, [
        readFileSync(resolve(overlayRoot, 'packages/coding-agent/src/core/index.ts'), 'utf8'),
        readFileSync(resolve(overlayRoot, 'packages/coding-agent/src/index.ts'), 'utf8'),
      ])
    ).toThrow()
  })

  test('rejects extra properties on the persisted ownership event', () => {
    const padded = replaceRequired(
      source,
      'sessionFile: this.sessionManager.getSessionFile(),',
      'sessionFile: this.sessionManager.getSessionFile(),\n\t\t\t\traw: event,'
    )
    expect(() => verifyAgentSessionDataflow(padded, 'mutated.ts')).toThrow()
  })

  test('rejects moving post-extension sanitization after listener emission', () => {
    const sanitizer =
      '\t\tif (event.type === "message_end") {\n\t\t\tevent = this._eventSanitizer ? await this._eventSanitizer(event) : event;\n\t\t}\n'
    const without = replaceRequired(source, sanitizer, '')
    const moved = replaceRequired(
      without,
      '\t\t// Handle session persistence',
      `${sanitizer}\t\t// Handle session persistence`
    )
    expect(() => verifyAgentSessionDataflow(moved, 'mutated.ts')).toThrow()
  })
})
