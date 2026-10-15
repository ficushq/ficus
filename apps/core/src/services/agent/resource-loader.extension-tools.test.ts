import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'bun:test'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { ContentSafety } from '../security/content-safety'
import { wrapToolWithOutputRedaction } from '../security/tool-output-redaction'
import { FicusResourceLoader } from './resource-loader'

const dir = mkdtempSync(join(tmpdir(), 'ficus-ext-tools-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A pi extension whose tool echoes whatever it was given, like a file reader would. */
function writeEchoExtension(): string {
  const path = join(dir, `echo-${randomUUID()}.ts`)
  writeFileSync(
    path,
    `export default function (pi) {
  pi.registerTool({
    name: 'ext_echo',
    label: 'ext_echo',
    description: 'echo',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    async execute(_id, params) {
      return { content: [{ type: 'text', text: params.text }], details: { echoed: params.text } }
    },
  })
}
`
  )
  return path
}

type Executable = { execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; details: unknown }> }

describe('FicusResourceLoader extension tools', () => {
  it('redacts the output of tools an extension registers, at load and at runtime', async () => {
    const value = `CANARY_SECRET_${randomUUID()}`
    const safety = ContentSafety.fromSecretEntries([{ key: 'SYNTHETIC_KEY', value }])
    const loader = await FicusResourceLoader.create('system prompt', [], [writeEchoExtension()], (tool) =>
      wrapToolWithOutputRedaction(tool, safety)
    )
    const extension = loader.getExtensions().extensions.find((candidate) => candidate.tools.has('ext_echo'))!

    const loaded = extension.tools.get('ext_echo')!.definition as unknown as Executable
    const result = await loaded.execute('call-1', { text: `got ${value}` })
    expect(JSON.stringify(result)).not.toContain(value)
    expect(result.content[0]!.text).toBe('got [REDACTED_SECRET_ENV:SYNTHETIC_KEY]')

    // A tool registered later (pi's registerTool writes the same map) is wrapped too.
    const late = {
      name: 'ext_late',
      execute: async () => ({ content: [{ type: 'text', text: value }] }),
    } as unknown as ToolDefinition
    extension.tools.set('ext_late', { definition: late, sourceInfo: extension.sourceInfo } as never)
    const lateResult = await (extension.tools.get('ext_late')!.definition as unknown as Executable).execute('call-2')
    expect(lateResult.content[0]!.text).toBe('[REDACTED_SECRET_ENV:SYNTHETIC_KEY]')
  })

  it('leaves extension tools untouched without a wrapper', async () => {
    const loader = await FicusResourceLoader.create('system prompt', [], [writeEchoExtension()])
    const extension = loader.getExtensions().extensions.find((candidate) => candidate.tools.has('ext_echo'))!
    const result = await (extension.tools.get('ext_echo')!.definition as unknown as Executable).execute('call-3', {
      text: 'plain',
    })
    expect(result.content[0]!.text).toBe('plain')
  })
})
