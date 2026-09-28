/** CI fixture only: exercise the real updater with an encrypted integration credential.
 * The Actions installation token is not a user OAuth grant. This job tests local
 * install/update, not interactive authorization; no production import API is added.
 */
export function assertLocalSetupFixtureEnvironment(env: Record<string, string | undefined>): void {
  if (
    env.CI !== 'true' ||
    env.GITHUB_ACTIONS !== 'true' ||
    env.DATABASE_URL !== 'postgres://postgres:postgres@localhost:5433/tau_local_setup' ||
    !env.GH_TOKEN ||
    !env.FICUS_PASSWORD ||
    !/^[0-9a-f]{64}$/i.test(env.FICUS_ENCRYPTION_KEY ?? '')
  ) {
    throw new Error('GitHub updater fixture requires the disposable local-setup CI environment')
  }
}

async function seed(): Promise<void> {
  // Validate before importing the DB: never use an inherited development DB.
  assertLocalSetupFixtureEnvironment(process.env)
  const { db, integrationConnections } = await import('../db')
  const { setIntegrationEnabled } = await import('../services/integrations/provider-state')
  const { getSecretStore } = await import('../services/secrets')
  const { serializeOAuthCredential } = await import('../services/integrations/authorization/credential-bundle')
  const { resolveInstanceGitHubConnection } = await import('../services/integrations/github/resolve-connection')
  const id = crypto.randomUUID()
  const revision = crypto.randomUUID()
  const credentialRef = `__integration-ci:github:${id}`
  const expiresAt = new Date(Date.now() + 60 * 60_000) // Beyond the 40-minute CI job budget.
  const store = getSecretStore()
  await store.initialize()
  await store.set(
    credentialRef,
    serializeOAuthCredential({
      version: 1,
      accessToken: process.env.GH_TOKEN!,
      refreshToken: null,
      expiresAt: expiresAt.toISOString(),
      tokenRevision: 1,
    }),
    'local-setup-ci'
  )
  await db.insert(integrationConnections).values({
    id,
    providerKey: 'github',
    adapterVersion: 1,
    clientAuthority: 'local',
    displayName: 'Local setup CI updater',
    configuration: { version: 1, userId: 1, login: 'local-setup-ci' },
    credentialRef,
    materialRevision: revision,
    validatedRevision: revision,
    enabled: true,
    authState: 'authenticated',
    healthState: 'healthy',
    validatedAt: new Date(),
    validationExpiresAt: expiresAt,
    // The Actions installation token cannot run user-OAuth identity validation.
    // Keep this disposable fixture out of that worker for the job's lifetime.
    nextValidationAt: expiresAt,
  })
  await setIntegrationEnabled('github', true, 'local-setup-ci')
  const resolved = await resolveInstanceGitHubConnection(id)
  if (resolved?.credential.accessToken !== process.env.GH_TOKEN) {
    throw new Error('CI updater integration credential did not resolve')
  }
  const response = await fetch('http://localhost:3100/api/updates/settings', {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${process.env.FICUS_PASSWORD}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ githubConnectionId: id }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`Selecting CI updater integration failed (HTTP ${response.status})`)
  const result = (await response.json()) as { settings?: { githubConnectionId?: string } }
  if (result.settings?.githubConnectionId !== id) throw new Error('CI updater did not select the integration')
  console.log('Encrypted GitHub integration fixture selected for the in-app updater')
}

if (import.meta.main) {
  try {
    await seed()
    // The job owns the DB, credential, and native services through teardown.
    process.exit(0)
  } catch {
    // Never print provider responses or errors that might contain the job token.
    console.error('Failed to seed the local-setup CI GitHub integration fixture')
    process.exit(1)
  }
}
