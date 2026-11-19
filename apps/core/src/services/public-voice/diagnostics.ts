import { existsSync } from 'node:fs'
import { resolve, join, basename } from 'node:path'

const repositoryRoot = resolve(import.meta.dir, '../../../../..')
const names = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'URIError',
  'EvalError',
  'AggregateError',
  'AbortError',
  'TimeoutError',
  'ZodError',
  'DerivationStreamError',
])

/** Preserve where a programming failure originated, never its potentially private message.
 * Only existing local source locations survive: no provider URLs, function labels,
 * arbitrary stack lines, operational paths or credential-bearing exception text.
 */
export function safeDerivationDiagnostic(error: unknown): { name: string; stack: string } {
  if (!(error instanceof Error)) return { name: 'NonErrorThrown', stack: '' }
  try {
    const name = names.has(error.name) ? error.name : 'Error'
    const stack: string[] = []
    const prefix = `${repositoryRoot}/`
    for (const line of String(error.stack ?? '')
      .slice(0, 32_768)
      .split('\n')
      .slice(1, 65)) {
      // Bundled production code has no source tree. Admit only the exact running
      // module and publish its basename, never an arbitrary file or host path.
      const bundled = line.indexOf(import.meta.path)
      const position =
        bundled >= 0 ? /^:(\d{1,8}):(\d{1,8})(?:\)|$)/.exec(line.slice(bundled + import.meta.path.length)) : null
      if (position && !import.meta.path.includes('/apps/core/src/')) {
        stack.push(`at core/${basename(import.meta.path)}:${position[1]}:${position[2]}`)
        if (stack.length >= 16) break
        continue
      }
      const start = line.indexOf(prefix)
      if (start < 0) continue
      const location = /^(apps\/core\/src\/[A-Za-z0-9_./-]+\.[cm]?[jt]sx?):(\d{1,8}):(\d{1,8})(?:\)|$)/.exec(
        line.slice(start + prefix.length)
      )
      if (!location || location[1]!.includes('/../') || location[1]!.length > 300) continue
      if (!existsSync(join(repositoryRoot, location[1]!))) continue
      stack.push(`at ${location[1]}:${location[2]}:${location[3]}`)
      if (stack.length >= 16) break
    }
    return { name, stack: [...new Set(stack)].join('\n') }
  } catch {
    return { name: 'Error', stack: '' }
  }
}
