import { connectedGitHubLogins } from './resolve-connection'

/** Compatibility action scripts receive identities, never a global GitHub credential. */
export async function githubWebhookEnvironment(): Promise<NodeJS.ProcessEnv> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^(?:GH_TOKEN|GITHUB_TOKEN)(?:_|$)/.test(key) &&
        key !== 'GITHUB_WEBHOOK_SECRET' &&
        key !== 'GITHUB_USER' &&
        key !== 'DEPLOY_GITHUB_PAGES_TOKEN'
    )
  )
  return { ...environment, FICUS_GITHUB_LOGINS_JSON: JSON.stringify(await connectedGitHubLogins()) }
}
