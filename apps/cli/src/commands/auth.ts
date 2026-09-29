import { Command } from 'commander'
import { loadAuthStore, saveAuthStore, redactBackend } from '../auth-store'
import { apiGet } from '../client'
import { output, outputTable } from '../output'
import { getExplicitEnv } from '../env'
import { config, resolveAuth, type ResolvedAuth } from '../config'
import { hostname } from 'os'
import { loginWithDeviceAuthorization, revokeDeviceAuthorization } from '../device-login'

function requireValidLabel(label: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(label)) {
    throw new Error('Label may only contain letters, numbers, dots, underscores, and dashes')
  }
}

function summarizeIntrospection(result: {
  identity?: { type?: string }
  roles?: Array<{ slug?: string }>
  permissions?: string[]
}): string {
  const identity = result.identity?.type ?? 'unknown'
  const roles = result.roles?.map((role) => role.slug).filter(Boolean) ?? []
  const roleSummary = roles.length > 0 ? roles.join(', ') : 'none'
  return `Identity ${identity}; roles: ${roleSummary}; permissions: ${result.permissions?.length ?? 0}`
}

export function registerAuthCommands(program: Command): void {
  const auth = program.command('auth').description('Manage Ficus CLI authentication backends')

  auth
    .command('login [label]')
    .description('Add or update a labeled Ficus backend')
    .option('--label <label>', 'Backend label (alternative to positional label)')
    .option('--api-url <url>', 'Ficus Core base URL')
    .option(
      '--password <password>',
      'Ficus password/bearer token (prefer FICUS_PASSWORD or prompt to avoid shell history)'
    )
    .option('--no-switch', 'Do not set this backend as active')
    .action(async (positionalLabel, options) => {
      try {
        const apiUrl = options.apiUrl || getExplicitEnv('FICUS_API_URL') || config.apiUrl
        const parsedUrl = new URL(apiUrl)
        const defaultLabel = parsedUrl.port ? `${parsedUrl.hostname}-${parsedUrl.port}` : parsedUrl.hostname
        const label = options.label || positionalLabel || defaultLabel || 'local'
        requireValidLabel(label)

        const explicitPassword = options.password || getExplicitEnv('FICUS_PASSWORD')
        let password: string
        let deviceId: string | undefined
        let account: string | undefined
        if (explicitPassword) {
          password = explicitPassword
        } else {
          const controller = new AbortController()
          const cancel = () => controller.abort()
          process.once('SIGINT', cancel)
          try {
            const result = await loginWithDeviceAuthorization({
              apiUrl,
              name: `Ficus CLI on ${hostname()}`,
              signal: controller.signal,
              onVerification: (verificationUri, opened) => {
                output(
                  { verificationUri, browserOpened: opened },
                  `${opened ? 'Approve the login in your browser' : 'Open this URL to approve the login'}:\n${verificationUri}`
                )
              },
            })
            password = result.token
            deviceId = result.deviceId
            account = result.user.displayName || result.user.email
          } finally {
            process.off('SIGINT', cancel)
          }
        }

        const store = loadAuthStore()
        store.backends[label] = { apiUrl, password, ...(deviceId ? { deviceId } : {}) }
        if (options.switch !== false) store.active = label
        saveAuthStore(store)
        output(
          { label, apiUrl, active: store.active === label, password: '<redacted>', account },
          `Logged in Ficus backend '${label}'${account ? ` as ${account}` : ''}${store.active === label ? ' and set it active' : ''}.`
        )
      } catch (error) {
        console.error(`Error: ${(error as Error).message}`)
        process.exit(1)
      }
    })

  auth
    .command('switch <label>')
    .description('Set the active Ficus backend')
    .action((label) => {
      try {
        const store = loadAuthStore()
        if (!store.backends[label]) throw new Error(`Unknown Ficus backend '${label}'`)
        store.active = label
        saveAuthStore(store)
        output({ active: label }, `Switched active Ficus backend to '${label}'.`)
      } catch (error) {
        console.error(`Error: ${(error as Error).message}`)
        process.exit(1)
      }
    })

  auth
    .command('logout [label]')
    .description('Remove a Ficus backend (defaults to active backend)')
    .option('--local-only', 'Remove local credentials without revoking the paired device')
    .action(async (label, options) => {
      try {
        const store = loadAuthStore()
        const target = label || store.active
        if (!target) throw new Error('No backend label provided and no active backend is set')
        const backend = store.backends[target]
        if (!backend) throw new Error(`Unknown Ficus backend '${target}'`)
        if (backend.deviceId && !options.localOnly) {
          try {
            await revokeDeviceAuthorization({
              apiUrl: backend.apiUrl,
              password: backend.password,
              deviceId: backend.deviceId,
            })
          } catch (error) {
            // Without this hint an unreachable server leaves the user unable to remove local
            // credentials at all, with nothing pointing at the escape hatch.
            throw new Error(
              `${(error as Error).message}. Re-run with --local-only to remove the local credentials without revoking the paired device.`
            )
          }
        }
        delete store.backends[target]
        if (store.active === target) {
          const [next] = Object.keys(store.backends)
          store.active = next
        }
        saveAuthStore(store)
        output({ removed: target, active: store.active }, `Logged out Ficus backend '${target}'.`)
      } catch (error) {
        console.error(`Error: ${(error as Error).message}`)
        process.exit(1)
      }
    })

  auth
    .command('list')
    .description('List configured Ficus backends')
    .action(() => {
      try {
        const store = loadAuthStore()
        const rows = Object.entries(store.backends).map(([label, backend]) =>
          redactBackend(label, backend, store.active)
        )
        outputTable(rows, ['label', 'apiUrl', 'active', 'password'])
      } catch (error) {
        console.error(`Error: ${(error as Error).message}`)
        process.exit(1)
      }
    })

  auth
    .command('introspect')
    .description('Show the authenticated identity, effective roles, and permissions')
    .option('--squad <squadId>', 'Resolve squad-scoped roles/permissions for a squad')
    .action(async (options) => {
      try {
        const query = options.squad ? `?squadId=${encodeURIComponent(options.squad)}` : ''
        const result = await apiGet<any>(`/api/auth/introspect${query}`)
        output(result, summarizeIntrospection(result))
      } catch (error) {
        console.error(`Error: ${(error as Error).message}`)
        process.exit(1)
      }
    })

  auth
    .command('status')
    .description('Show how ficus is authenticating (env token, stored backend, …) and against which API')
    .action(() => {
      try {
        const resolved = resolveAuth()
        const store = loadAuthStore()
        const backend =
          resolved.label && store.backends[resolved.label]
            ? redactBackend(resolved.label, store.backends[resolved.label], store.active)
            : null
        output({ ...resolved, backend }, describeAuth(resolved))
      } catch (error) {
        console.error(`Error: ${(error as Error).message}`)
        process.exit(1)
      }
    })
}

/** One-line human summary of the effective credential for `ficus auth status`. */
export function describeAuth(resolved: ResolvedAuth): string {
  switch (resolved.source) {
    case 'webhook-context':
      if (resolved.missing?.length)
        return `Webhook script, but incomplete: ${resolved.missing.join(' and ')} not set; no saved login fallback.`
      return `Webhook script: authenticated with its injected credential against ${resolved.apiUrl}.`
    case 'agent-context':
      if (resolved.missing?.length)
        return `Agent shell, but incomplete: ${resolved.missing.join(' and ')} not set, so ficus cannot act as this agent (it will not fall back to a human login).`
      return `Agent shell: authenticated as the injected agent identity${resolved.agentId ? ` (${resolved.agentId})` : ''} against ${resolved.apiUrl}.`
    case 'selected-backend':
    case 'auth-store':
      return `Active Ficus backend: ${resolved.label} (${resolved.apiUrl})`
    case 'env-token':
      return `Authenticated via agent token (FICUS_TOKEN) against ${resolved.apiUrl} — no stored backend needed.`
    case 'env-password':
      return `Authenticated via FICUS_PASSWORD from the environment against ${resolved.apiUrl}.`
    case 'dotenv':
      return `Authenticated via FICUS_PASSWORD from .env against ${resolved.apiUrl}.`
    case 'secret-file':
      return `Authenticated via the mounted sandbox password secret against ${resolved.apiUrl}.`
    case 'none':
      return 'No active Ficus backend configured. Run ficus auth login <label> --api-url <url>.'
  }
}
