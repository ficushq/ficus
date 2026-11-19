import { useQuery } from '@tanstack/react-query'
import { queries } from '../../queryOptions'

/** A narrow person-authorized selection list; Core revalidates the exact account again before deriving. */
export function useVoiceAccounts() {
  const query = useQuery(queries.publicVoices.githubAccounts())
  return { accounts: query.data ?? [], isPending: query.isPending, error: query.error }
}
