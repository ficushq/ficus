import { createHash } from 'node:crypto'
import { posix } from 'node:path'

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, stableValue(entry)])
    )
  return value
}

/** Normalize ordinary shell spacing without rewriting quoted data. Complex
 * multiline/escaped scripts retain their bytes: this is not a shell parser. */
function commandTarget(command: string): string {
  if (/[\n\r\\]/.test(command)) return command
  const parts = command.match(/'[^']*'|"[^"]*"|`[^`]*`|[ \t]+|[^ \t'"`]+|./g) ?? []
  return parts
    .map((part) => (/^[ \t]+$/.test(part) ? ' ' : part))
    .join('')
    .trim()
}

export function recoveryInvocationKey(name: string, params: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify([name, stableValue(params)]))
    .digest('hex')
}

/** Only a confirmed success of the same normalized target may settle its budget.
 * Timeout/verbosity metadata cannot change Bash or file-operation identity. */
export function recoveryOperationKey(name: string, params: unknown): string {
  const input = params && typeof params === 'object' ? (params as Record<string, unknown>) : {}
  let target: unknown = stableValue(params)
  if ((name === 'bash' || name === 'squad_bash') && typeof input.command === 'string')
    target = ['command', commandTarget(input.command)]
  else if (['read', 'edit', 'write'].includes(name) && typeof input.path === 'string')
    target = ['path', posix.normalize(input.path)]
  return recoveryInvocationKey(name, target)
}
