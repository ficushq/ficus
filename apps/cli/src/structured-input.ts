import { createReadStream } from 'node:fs'
import { Command, InvalidArgumentError } from 'commander'
import { isScalar, parseDocument, visit } from 'yaml'
import { workflowSourceSchema } from '@ficus/shared'

const MAX_INPUT_BYTES = 1024 * 1024
export interface StructuredInputOptions {
  content?: string
  file?: string
  stdin?: boolean
}
interface FlowInputOptions {
  workflow?: string
  flow?: string
  flowContent?: string
  flowStdin?: boolean
}
type Source = { label: string; value: string | boolean | undefined }

/** Explicit flags only: never guess whether a shell string is a filename or a document. */
export function addStructuredInputOptions(command: Command, flow = false): Command {
  command.allowExcessArguments(false)
  const flags = flow
    ? [
        ['--flow-content <text>', 'Inline JSON or YAML flow definition/source'],
        ['--flow-stdin', 'Read a flow definition/source from piped stdin or a heredoc'],
        ['--flow <file>', 'Read a saved JSON/YAML flow definition/source'],
      ]
    : [
        ['--content <text>', 'Inline JSON or YAML object'],
        ['--stdin', 'Read a JSON/YAML object from piped stdin or a heredoc'],
        ['--file <file>', 'Read a saved JSON/YAML object'],
      ]
  for (const [flag, description] of flags) command.option(flag!, description!)
  const sourceFlags = flags.map(([flag]) => flag!.split(' ')[0]!.slice(2))
  if (flow) sourceFlags.push('workflow')
  for (const flag of sourceFlags) {
    let seen = false
    command.on(`option:${flag}`, () => {
      if (seen) throw new InvalidArgumentError('Specify each input source only once')
      seen = true
    })
  }
  return command.addHelpText(
    'after',
    `\n${flow ? 'Choose at most one workflow source; omit to inherit or leave an update unchanged.' : 'Choose exactly one input source.'} Maximum 1 MiB. Prefer inline content for short payloads, stdin for longer payloads; files remain available for saved definitions. --json controls output only.`
  )
}
function selectSource(sources: Source[], required: boolean): Source | undefined {
  const selected = sources.filter((source) => source.value !== undefined && source.value !== false)
  if (selected.length > 1 || (required && selected.length === 0))
    throw new Error(`Choose exactly one input source: ${sources.map((source) => source.label).join(', ')}`)
  return selected[0]
}
async function readBounded(stream: AsyncIterable<Uint8Array | string>, label: string): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk)
      size += bytes.length
      if (size > MAX_INPUT_BYTES) throw new Error('limit')
      chunks.push(bytes)
    }
  } catch {
    // Parser and I/O errors may include source text, filenames, or secrets.
    if (size > MAX_INPUT_BYTES) throw new Error('Structured input exceeds the 1 MiB limit')
    throw new Error(`Unable to read ${label} for structured input`)
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  } catch {
    throw new Error('Structured input must be valid UTF-8')
  }
}
function parseObject(content: string): Record<string, unknown> {
  if (Buffer.byteLength(content, 'utf8') > MAX_INPUT_BYTES) throw new Error('Structured input exceeds the 1 MiB limit')
  if (!content.trim()) throw new Error('Structured input is empty; provide a JSON or YAML object')
  let value: unknown
  try {
    const document = parseDocument(content, { uniqueKeys: true, prettyErrors: false, strict: true })
    if (document.errors.length || document.warnings.length) throw new Error('invalid document')
    visit(document, {
      Pair(_key, pair) {
        if (!isScalar(pair.key) || typeof pair.key.value !== 'string') throw new Error('non-string key')
      },
    })
    value = document.toJS({ maxAliasCount: 100 })
    // Zod expects an acyclic JSON tree. Bound depth and expanded nodes before it recurses.
    const ancestors = new Set<object>()
    let nodes = 0
    function checkTree(node: unknown, depth: number) {
      if (++nodes > 100_000 || depth > 100) throw new Error('complexity limit')
      if (node === null || typeof node !== 'object') return
      if (ancestors.has(node)) throw new Error('cyclic alias')
      ancestors.add(node)
      for (const child of Object.values(node)) checkTree(child, depth + 1)
      ancestors.delete(node)
    }
    checkTree(value, 0)
  } catch {
    throw new Error(
      'Invalid JSON/YAML input: use one document with unique string keys, supported tags, and bounded non-cyclic aliases/nesting'
    )
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Structured input must be a JSON or YAML object')
  return value as Record<string, unknown>
}
export async function readStructuredInput(
  options: StructuredInputOptions,
  positionalFile?: string
): Promise<Record<string, unknown>> {
  const source = selectSource(
    [
      { label: '--content', value: options.content },
      { label: '--stdin', value: options.stdin },
      { label: '--file', value: options.file },
      { label: 'positional file', value: positionalFile },
    ],
    true
  )!
  if (source.label === '--content') return parseObject(source.value as string)
  if (source.label === '--stdin') {
    if (process.stdin.isTTY) throw new Error('Stdin is interactive; use a pipe or heredoc with the stdin flag')
    return parseObject(await readBounded(process.stdin, 'stdin'))
  }
  return parseObject(await readBounded(createReadStream(source.value as string), 'file'))
}
// Only fixed schema field names are safe to print. Participant/step IDs and unknown keys are caller data.
const safeFields = new Set(
  'action expectedVersion attemptId outcome evidence feedback resume targetStepId resumeAt operations op reason active participant task kind id definition customizations schemaVersion name description scope squadId participants steps entry routing limits completion mode agentTypeId instructions output outcomes'.split(
    ' '
  )
)
export function validateStructuredInput<T>(
  schema: {
    safeParse(
      value: unknown
    ): { success: true; data: T } | { success: false; error: { issues: { code: string; path: (string | number)[] }[] } }
  },
  value: unknown
): T {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  const issues = result.error.issues.slice(0, 5).map((issue) => {
    const path =
      issue.path
        .slice(0, 8)
        .map((part) => (typeof part === 'number' ? '[index]' : safeFields.has(part) ? part : '[key]'))
        .join('.') || 'root'
    return `${path}: ${issue.code}`
  })
  throw new Error(`Invalid workflow input (${issues.join('; ')}). Check the command schema and supported fields.`)
}
/** Creation accepts either a raw definition or a source; omission preserves inherited defaults. */
export async function readWorkflowSource(options: FlowInputOptions) {
  const selected = selectSource(
    [
      { label: '--workflow', value: options.workflow },
      { label: '--flow-content', value: options.flowContent },
      { label: '--flow-stdin', value: options.flowStdin },
      { label: '--flow', value: options.flow },
    ],
    false
  )
  if (!selected) return undefined
  if (selected.label === '--workflow')
    return validateStructuredInput(workflowSourceSchema, { kind: 'preset', id: options.workflow })
  const raw = await readStructuredInput({ content: options.flowContent, stdin: options.flowStdin, file: options.flow })
  return validateStructuredInput(
    workflowSourceSchema,
    Object.hasOwn(raw, 'kind') ? raw : { kind: 'inline', definition: raw }
  )
}
