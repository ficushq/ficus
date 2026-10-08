import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  DECISION_PROVIDER_KIND_INFO,
  DECISION_PROVIDER_KINDS,
  type DecisionProviderKind,
  type DecisionProviderView,
} from '@ficus/shared'
import { deleteDecisionProvider, updateDecisionProvider, type DecisionProviderPatch } from '../../api/decisions'
import { usePermissions } from '../../hooks/usePermissions'
import { queries } from '../../queryOptions'
import { Badge } from '../Badge'
import { ConfirmButton } from '../ConfirmButton'
import { Modal } from '../Modal'
import { SkeletonLine } from '../loading/Skeleton'
import { DECISION_INPUT_CLASS, DecisionField } from './DecisionField'
import { DecisionProviderSetup } from './DecisionProviderSetup'
import { DecisionRoutingEditor } from './DecisionRoutingEditor'
import { DecisionTryPanel } from './DecisionTryPanel'
import { ProviderDirectoryCard } from './ProviderDirectoryCard'
import { DECISION_KIND_FIELDS, DECISION_KIND_LOGOS, errorText, invalidateDecisions } from './decisionUi'

/**
 * Decision models, apart from the agent model providers above them: fast models that answer
 * yes/no and multiple-choice questions for the GitHub firewall, workflow decision steps and
 * event rule conditions. They never write text, so they never run agents.
 */
export function DecisionModelsSection() {
  const { can, isLoading: permissionsLoading } = usePermissions()
  const canWrite = !permissionsLoading && can('provider-auth:write')
  const { data, isLoading, isError, error } = useQuery(queries.decisions.settings())

  return (
    <section aria-labelledby="decision-models-heading" className="space-y-8 border-t border-th-border pt-8">
      <header>
        <h3
          id="decision-models-heading"
          data-setting-target="decision-models"
          className="text-lg font-semibold text-primary"
        >
          Decision models
        </h3>
        <p className="mt-1 text-sm text-muted">
          Fast models that answer quick yes/no and multiple-choice questions, never writing text. Ficus uses them for
          the GitHub firewall, workflow decision steps and event rule conditions. They are separate from the agent
          models above.
        </p>
      </header>
      {isLoading ? (
        <div className="space-y-3" aria-label="Loading decision models">
          <SkeletonLine className="h-4 w-1/3" />
          <SkeletonLine className="h-16 w-full" />
        </div>
      ) : isError || !data ? (
        <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
          Could not load decision models{error ? `: ${errorText(error)}` : '.'}
        </p>
      ) : (
        <>
          {data.providers.length > 0 && <DecisionProviderList providers={data.providers} canWrite={canWrite} />}
          {canWrite && <AddDecisionProviders providers={data.providers} openAIServicesKey={data.openAIServicesKey} />}
          {data.providers.length === 0 && !canWrite && <p className="text-sm text-muted">No decision models yet.</p>}
          {data.providers.length > 0 && (
            <DecisionRoutingEditor providers={data.providers} routing={data.routing} canWrite={canWrite} />
          )}
          {data.providers.length > 0 && canWrite && <DecisionTryPanel providers={data.providers} />}
        </>
      )}
    </section>
  )
}

function AddDecisionProviders({
  providers,
  openAIServicesKey,
}: {
  providers: DecisionProviderView[]
  openAIServicesKey: boolean
}) {
  const [open, setOpen] = useState<DecisionProviderKind | null>(null)
  return (
    <section aria-labelledby="add-decision-model-heading" className="space-y-3">
      <div>
        <h4
          id="add-decision-model-heading"
          data-setting-target="add-decision-model"
          className="text-sm font-medium text-secondary"
        >
          Add a decision model
        </h4>
        {providers.length === 0 && (
          <p className="mt-0.5 text-xs text-muted">
            None yet. The first one you add answers every purpose until you set an order.
          </p>
        )}
      </div>
      <div className="grid items-stretch gap-4 md:grid-cols-2">
        {DECISION_PROVIDER_KINDS.map((kind) => {
          const info = DECISION_PROVIDER_KIND_INFO[kind]
          const count = providers.filter((provider) => provider.kind === kind).length
          return (
            <ProviderDirectoryCard
              key={kind}
              providerId={`decision-${kind}`}
              logo={DECISION_KIND_LOGOS[kind]}
              name={info.label}
              description={info.description}
              status={
                count
                  ? 'Connected'
                  : kind === 'openai' && !openAIServicesKey
                    ? 'Needs the OpenAI API services key'
                    : 'Not configured'
              }
              action={count ? 'Add another' : 'Set up'}
              expanded={open === kind}
              onExpandedChange={(expanded) => setOpen(expanded ? kind : null)}
            >
              <DecisionProviderSetup
                kind={kind}
                openAIServicesKey={openAIServicesKey}
                onDone={() => setOpen(null)}
                onCancel={() => setOpen(null)}
              />
            </ProviderDirectoryCard>
          )
        })}
      </div>
    </section>
  )
}

export function DecisionProviderList({
  providers,
  canWrite,
}: {
  providers: DecisionProviderView[]
  canWrite: boolean
}) {
  const queryClient = useQueryClient()
  // The last provider opened stays rendered while the dialog animates closed.
  const [editing, setEditing] = useState<{ provider: DecisionProviderView; open: boolean } | null>(null)
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => updateDecisionProvider(id, { enabled }),
    onSettled: () => invalidateDecisions(queryClient),
  })
  const remove = useMutation({
    mutationFn: (id: string) => deleteDecisionProvider(id),
    onSettled: () => invalidateDecisions(queryClient),
  })
  const failure = toggle.error ?? remove.error

  return (
    <section aria-labelledby="decision-providers-heading" className="space-y-3">
      <h4 id="decision-providers-heading" className="text-sm font-medium text-secondary">
        Added <span className="ml-1 text-muted">{providers.length}</span>
      </h4>
      <ul className="divide-y divide-th-border border-y border-th-border">
        {providers.map((provider) => {
          const Logo = DECISION_KIND_LOGOS[provider.kind]
          const detail = provider.kind === 'systemone' ? provider.baseUrl : undefined
          return (
            <li
              key={provider.id}
              className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"
              aria-label={provider.label}
            >
              <div className="flex min-w-0 items-center gap-3">
                <div
                  aria-hidden="true"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-panel-border bg-surface-secondary text-primary"
                >
                  <Logo className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="truncate text-sm font-medium text-primary">{provider.label}</span>
                    {provider.label !== DECISION_PROVIDER_KIND_INFO[provider.kind].label && (
                      <Badge>{DECISION_PROVIDER_KIND_INFO[provider.kind].label}</Badge>
                    )}
                    {!provider.enabled && <Badge color="attention">Off</Badge>}
                  </div>
                  <p className="truncate font-mono text-xs text-muted">
                    {provider.model}
                    {detail ? ` · ${detail}` : ''}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-3 pl-12 sm:pl-0">
                <label className="flex items-center gap-2 text-sm text-secondary">
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={`Use ${provider.label}`}
                    checked={provider.enabled}
                    disabled={!canWrite || toggle.isPending}
                    onChange={(event) => toggle.mutate({ id: provider.id, enabled: event.target.checked })}
                    className="h-4 w-4 accent-current"
                  />
                  <span>On</span>
                </label>
                {canWrite && (
                  <>
                    <button
                      type="button"
                      aria-label={`Edit ${provider.label}`}
                      onClick={() => setEditing({ provider, open: true })}
                      className="ficus-button ficus-button-secondary rounded-md px-2.5 py-1 text-xs font-medium"
                    >
                      Edit
                    </button>
                    <ConfirmButton
                      label="Remove"
                      confirmLabel="Remove?"
                      ariaLabel={`Remove ${provider.label}`}
                      disabled={remove.isPending}
                      onConfirm={() => remove.mutate(provider.id)}
                      className="rounded-md px-2.5 py-1 text-xs font-medium"
                    />
                  </>
                )}
              </div>
            </li>
          )
        })}
      </ul>
      {failure && (
        <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
          {errorText(failure)}
        </p>
      )}
      {editing && (
        <EditDecisionProvider
          provider={editing.provider}
          isOpen={editing.open}
          onClose={() => setEditing({ ...editing, open: false })}
        />
      )}
    </section>
  )
}

export function EditDecisionProvider({
  provider,
  isOpen,
  onClose,
}: {
  provider: DecisionProviderView
  isOpen: boolean
  onClose: () => void
}) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Edit ${provider.label}`} closeOnEscape>
      <EditDecisionProviderForm key={provider.id} provider={provider} onClose={onClose} />
    </Modal>
  )
}

function EditDecisionProviderForm({ provider, onClose }: { provider: DecisionProviderView; onClose: () => void }) {
  const queryClient = useQueryClient()
  const info = DECISION_PROVIDER_KIND_INFO[provider.kind]
  const fields = DECISION_KIND_FIELDS[provider.kind]
  const [label, setLabel] = useState(provider.label)
  const [model, setModel] = useState(provider.model)
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? '')
  const [accountId, setAccountId] = useState(provider.accountId ?? '')
  const [apiKey, setApiKey] = useState('')
  const save = useMutation({
    mutationFn: (patch: DecisionProviderPatch) => updateDecisionProvider(provider.id, patch),
    onSuccess: async () => {
      await invalidateDecisions(queryClient)
      onClose()
    },
  })
  const keyName = provider.kind === 'cloudflare' ? 'API token' : 'API key'

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (save.isPending) return
        save.mutate({
          label: label.trim(),
          model: model.trim(),
          ...(fields.baseUrl ? { baseUrl: baseUrl.trim() } : {}),
          ...(fields.accountId ? { accountId: accountId.trim() } : {}),
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        })
      }}
    >
      <DecisionField label="Name">
        {(id) => (
          <input
            id={id}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            className={DECISION_INPUT_CLASS}
          />
        )}
      </DecisionField>
      <DecisionField label="Model">
        {(id) => (
          <>
            <input
              id={id}
              list={`${id}-models`}
              value={model}
              onChange={(event) => setModel(event.target.value)}
              autoComplete="off"
              className={DECISION_INPUT_CLASS}
            />
            <datalist id={`${id}-models`}>
              {info.models.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </>
        )}
      </DecisionField>
      {fields.baseUrl && (
        <DecisionField label="Server URL">
          {(id) => (
            <input
              id={id}
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              autoComplete="off"
              className={DECISION_INPUT_CLASS}
            />
          )}
        </DecisionField>
      )}
      {fields.accountId && (
        <DecisionField label="Account ID">
          {(id) => (
            <input
              id={id}
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
              autoComplete="off"
              className={DECISION_INPUT_CLASS}
            />
          )}
        </DecisionField>
      )}
      {fields.apiKey !== 'none' && (
        <DecisionField
          label={`Replace ${keyName}`}
          hint={provider.hasApiKey ? 'Leave blank to keep the saved one.' : `No ${keyName} saved yet.`}
        >
          {(id) => (
            <input
              id={id}
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              autoComplete="off"
              className={DECISION_INPUT_CLASS}
            />
          )}
        </DecisionField>
      )}
      {provider.kind === 'openai' && (
        <p className="text-xs text-muted">Uses the OpenAI API services key from Integrations.</p>
      )}
      <p className="text-xs text-muted">Changes are not tested; use Try a decision to check them.</p>
      {save.isError && (
        <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
          {errorText(save.error)}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-3">
        <button
          type="button"
          onClick={onClose}
          className="ficus-button ficus-button-secondary rounded-lg px-4 py-2 text-sm font-medium"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={save.isPending || !model.trim()}
          className="ficus-button ficus-button-primary rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  )
}
