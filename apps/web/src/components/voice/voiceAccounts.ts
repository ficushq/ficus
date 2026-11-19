import type { IntegrationConnection } from '../../api/integrations'
import { useQuery } from '@tanstack/react-query'
import { integrationQueries } from '../../queryOptions'
import { useTick } from '../../hooks/useTick'

/** A non-secret UI hint only. Core revalidates the chosen account before using its token. */
export function usableVoiceAccounts(connections: IntegrationConnection[], now = Date.now()) {
  return connections.filter(
    (c) =>
      c.providerKey === 'github' &&
      c.adapterVersion === 1 &&
      c.enabled &&
      c.credentialConfigured &&
      c.authState === 'authenticated' &&
      c.healthState === 'healthy' &&
      Boolean(c.configuration.login) &&
      Boolean(c.validationExpiresAt) &&
      Date.parse(c.validationExpiresAt!) > now
  )
}

/** Account health is a UI hint; the derivation endpoint remains the credential authority. */
export function useVoiceAccounts() {
  const pool = useQuery(integrationQueries.pool('github'))
  const catalog = useQuery(integrationQueries.catalog())
  const now = useTick(15_000)
  const enabled = catalog.data?.integrations.find((item) => item.key === 'github')?.enabled === true
  return {
    accounts: enabled ? usableVoiceAccounts(pool.data ?? [], now) : [],
    isPending: pool.isPending || catalog.isPending,
    error: pool.error ?? catalog.error,
  }
}
