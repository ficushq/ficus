import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Every model call must land in the inference cost ledger (docs/wiki/inference-usage.md). Calls made through
 * AgentSession.create, decide() or completeLight/completeWithTier record themselves. A file that reaches a
 * provider directly must call recordInferenceUsage itself, and is listed here after that was checked.
 */
const ALLOWED: Record<string, string> = {
  'routes/transcribe.ts': 'records `transcription` (audio seconds) after each Whisper call',
  'routes/tts.ts': 'records `tts` (characters) per synthesis; the rewrite runs in AgentSession (`tts-reformat`)',
  'services/memory/indexer/EmbeddingService.ts': 'records `embedding:index` / `embedding:search` per embeddings call',
  'services/model-tiers/light-completion-runtime.ts':
    'records `lite:<purpose>` per candidate (recordLightCompletionUsage), API and Claude Code alike',
  'services/agent/claude-code/bridge.ts':
    'the agent-session stream for Claude Code: its assistant messages are recorded by the session hook',
  'services/agent/claude-code/one-shot.ts':
    'reports the result usage through onUsage; light-completion-runtime records it as `lite:<purpose>`',
  'services/agent/claude-code/anthropic.ts':
    'the Anthropic provider streamSimple used by agent sessions: recorded by the session hook',
  'services/agent/openai-compatible-runtime.ts':
    'the OpenAI-compatible provider streamSimple used by agent sessions: recorded by the session hook',
  'services/reply-suggestions/live-eval.ts':
    'dev script for live evals, run by hand and never by CI or the product: not recorded on purpose',
}

const SDK_MODULES = ['@anthropic-ai/claude-agent-sdk', 'openai', '@google-cloud/text-to-speech', '@google-cloud/speech']

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

/** The direct provider entry points a source file uses, by name. */
function providerEntryPoints(source: string): string[] {
  const code = withoutComments(source)
  const found = new Set<string>()
  for (const match of code.matchAll(/import\s+(type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
    const [, typeOnly, bindings, module] = match
    if (typeOnly) continue
    if (SDK_MODULES.includes(module!)) found.add(module!)
    if (module!.startsWith('@earendil-works/pi-ai')) {
      for (const name of ['completeSimple', 'streamSimple'])
        if (new RegExp(`(^|[{,\\s])${name}([\\s,}]|$)`).test(bindings!)) found.add(`${name} from ${module}`)
    }
  }
  for (const match of code.matchAll(/(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/g))
    if (SDK_MODULES.includes(match[1]!)) found.add(match[1]!)
  if (/\bnew\s+OpenAI\s*\(/.test(code)) found.add('new OpenAI()')
  for (const name of ['completeSimple', 'streamSimple'])
    if (new RegExp(`\\.${name}\\s*\\(`).test(code)) found.add(`.${name}()`)
  return [...found].sort()
}

/** Files that use an entry point but are not allowed to, with what they use. */
function unrecordedProviderCalls(
  files: Record<string, string>,
  allowed: Record<string, string>
): Array<{ file: string; entryPoints: string[] }> {
  return Object.entries(files)
    .map(([file, source]) => ({ file, entryPoints: providerEntryPoints(source) }))
    .filter(({ file, entryPoints }) => entryPoints.length > 0 && !(file in allowed))
}

const root = join(import.meta.dir, '..', '..')

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

describe('direct provider calls record their cost', () => {
  const files = Object.fromEntries(
    sourceFiles(root).map((path) => [relative(root, path).split('\\').join('/'), readFileSync(path, 'utf8')])
  )

  test('every file that calls a provider directly is allow-listed', () => {
    const offenders = unrecordedProviderCalls(files, ALLOWED).map(
      ({ file, entryPoints }) =>
        `apps/core/src/${file} uses ${entryPoints.join(', ')}. Record each call with recordInferenceUsage ` +
        `(see docs/wiki/inference-usage.md), then add the file to ALLOWED in provider-imports.guard.test.ts ` +
        `with where it records usage.`
    )
    expect(offenders).toEqual([])
  })

  test('every allow-listed file still exists and still calls a provider directly', () => {
    const stale = Object.keys(ALLOWED).filter((file) => !files[file] || providerEntryPoints(files[file]!).length === 0)
    expect(stale).toEqual([])
  })

  test('the matcher flags an unlisted file and ignores an allow-listed one', () => {
    const direct = `import { completeSimple } from '@earendil-works/pi-ai/compat'\nawait completeSimple(model, ctx)\n`
    expect(
      unrecordedProviderCalls({ 'services/new-feature.ts': direct, 'routes/transcribe.ts': direct }, ALLOWED)
    ).toEqual([
      {
        file: 'services/new-feature.ts',
        entryPoints: ['completeSimple from @earendil-works/pi-ai/compat'],
      },
    ])
    // Through a model runtime, too.
    expect(providerEntryPoints('const message = await runtime.completeSimple(model, context)')).toEqual([
      '.completeSimple()',
    ])
    expect(providerEntryPoints(`import OpenAI from 'openai'\nnew OpenAI({ apiKey })`)).toEqual([
      'new OpenAI()',
      'openai',
    ])
    expect(providerEntryPoints(`const { query } = await import('@anthropic-ai/claude-agent-sdk')`)).toEqual([
      '@anthropic-ai/claude-agent-sdk',
    ])
    // Types, comments and unrelated pi-ai imports are not calls.
    expect(
      providerEntryPoints(
        `import type { Options } from '@anthropic-ai/claude-agent-sdk'\n// new OpenAI() is not used\nimport { calculateCost } from '@earendil-works/pi-ai'\n`
      )
    ).toEqual([])
  })
})
