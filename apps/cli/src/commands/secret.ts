import { Command } from 'commander'
import { apiGet, apiPut, apiDelete } from '../client'
import { output, outputTable, outputError, isJsonMode } from '../output'

type SecretValidation =
  | { status: 'valid'; login: string; tokenType: 'classic' | 'fine-grained'; scopes?: string[]; warnings: string[] }
  | { status: 'invalid'; message: string }
  | { status: 'unverified'; message: string }

interface SetSecretResult {
  key: string
  updated: boolean
  validation?: SecretValidation
}

function formatSecretValidation(validation?: SecretValidation): string {
  if (!validation) return ''
  if (validation.status === 'unverified') return `Saved without validation — ${validation.message}`
  if (validation.status === 'invalid') return validation.message
  const identity =
    validation.tokenType === 'classic'
      ? `Validated as @${validation.login} (classic PAT, scopes: ${validation.scopes?.join(', ') || 'none'})`
      : `Validated as @${validation.login} (fine-grained token)`
  return [identity, ...validation.warnings].join('. ')
}

export function registerSecretCommands(program: Command) {
  const secret = program.command('secret').description('Manage secrets')

  // ficus secret list
  secret
    .command('list')
    .description('List all secrets (names only, no values)')
    .action(async () => {
      try {
        const secrets = await apiGet<any[]>('/api/secrets')
        if (isJsonMode()) {
          output(secrets)
        } else {
          if (secrets.length === 0) {
            console.log('No secrets configured')
            return
          }
          outputTable(secrets, ['key', 'isSet', 'source', 'updatedAt'])
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus secret get <key>
  secret
    .command('get <key>')
    .description('Get a secret value')
    .action(async (key) => {
      try {
        const result = await apiGet<{ key: string; value: string }>(`/api/secrets/${encodeURIComponent(key)}`)
        if (isJsonMode()) {
          output(result)
        } else {
          console.log(result.value)
        }
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus secret set <key> <value>
  secret
    .command('set <key> <value>')
    .description('Set a secret value')
    .option('-f, --force', 'Save even when validation raises a warning (e.g. missing scopes)')
    .action(async (key, value, options: { force?: boolean }) => {
      try {
        const result = await apiPut<SetSecretResult>(`/api/secrets/${encodeURIComponent(key)}`, {
          value,
          ...(options.force ? { force: true } : {}),
        })
        const validationSuffix = formatSecretValidation(result.validation)
        output(result, `Set secret "${key}"${validationSuffix ? `. ${validationSuffix}` : ''}`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus secret delete <key>
  secret
    .command('delete <key>')
    .alias('rm')
    .description('Delete a secret')
    .action(async (key) => {
      try {
        await apiDelete(`/api/secrets/${encodeURIComponent(key)}`)
        output({ key, deleted: true }, `Deleted secret "${key}"`)
      } catch (error) {
        outputError(error as Error)
      }
    })
}
