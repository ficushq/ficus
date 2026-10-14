import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { usePermissions } from '../../hooks/usePermissions'
import { queries } from '../../queryOptions'
import { FormSkeleton } from '../loading/Skeleton'
import { AddDecisionProviders } from '../settings/DecisionModelsSection'
import { errorText } from '../settings/decisionUi'

/** Onboarding: connect a decision provider with the same cards as Settings → Decision Providers. */
export function DecisionModelsStep() {
  const { can, isLoading: permissionsLoading } = usePermissions()
  const canWrite = !permissionsLoading && can('provider-auth:write')
  const { data, isLoading, isError, error } = useQuery(queries.decisions.settings())
  const connected = data?.providers.map((provider) => provider.label) ?? []
  return (
    <div className="space-y-6" data-setting-target="decision-models-setup">
      <header>
        <h3 className="text-lg font-semibold text-primary">Quick judgment calls</h3>
        <p className="mt-1 text-sm text-muted">
          A fast decision model makes small calls for Ficus, like checking tool output for instructions aimed at your
          agents, filing screenshots, and routing Assistant requests. Ficus works without one; it just skips those
          calls.
        </p>
      </header>
      {isLoading ? (
        <FormSkeleton label="Loading decision models" sections={1} />
      ) : isError || !data ? (
        <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
          Could not load decision models{error ? `: ${errorText(error)}` : '.'}
        </p>
      ) : (
        <>
          {connected.length > 0 && (
            <p role="status" className="text-sm text-muted">
              Connected: {connected.join(', ')}.
            </p>
          )}
          {canWrite ? (
            <AddDecisionProviders providers={data.providers} openAIServicesKey={data.openAIServicesKey} onboarding />
          ) : (
            connected.length === 0 && (
              <p className="text-sm text-muted">Ask an administrator to connect a decision model.</p>
            )
          )}
          <p className="text-xs text-muted">
            Choose which model answers what, and try questions, in{' '}
            <Link to="/settings?section=decision-providers" className="text-accent-light hover:underline">
              Settings → Decision Providers
            </Link>
            .
          </p>
        </>
      )}
    </div>
  )
}
