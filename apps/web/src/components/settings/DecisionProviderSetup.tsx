import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { DECISION_PROVIDER_KIND_INFO, type DecisionProviderKind } from '@ficus/shared'
import {
  addDecisionProvider,
  detectDecisionServers,
  type DecisionProviderInput,
  type DetectedDecisionServer,
} from '../../api/decisions'
import { SegmentedControl } from '../SegmentedControl'
import { DECISION_INPUT_CLASS, DecisionField } from './DecisionField'
import { DECISION_KIND_FIELDS, errorText, invalidateDecisions, OPENAI_SERVICES_LINK } from './decisionUi'

/**
 * Set up one decision provider. Core asks it a test question before saving, so a wrong key,
 * account or server shows up here, inline, instead of on the first real decision.
 */
export function DecisionProviderSetup({
  kind,
  openAIServicesKey,
  onDone,
  onCancel,
}: {
  kind: DecisionProviderKind
  openAIServicesKey: boolean
  onDone: () => void
  onCancel: () => void
}) {
  const queryClient = useQueryClient()
  const info = DECISION_PROVIDER_KIND_INFO[kind]
  const fields = DECISION_KIND_FIELDS[kind]
  const [label, setLabel] = useState('')
  const [model, setModel] = useState(info.defaultModel)
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [accountId, setAccountId] = useState('')
  const [servers, setServers] = useState<DetectedDecisionServer[] | null>(null)

  const save = useMutation({
    mutationFn: (input: DecisionProviderInput) => addDecisionProvider(input),
    onSuccess: async () => {
      await invalidateDecisions(queryClient)
      onDone()
    },
  })
  const detect = useMutation({
    mutationFn: detectDecisionServers,
    onSuccess: (found) => {
      setServers(found)
      if (found[0]) pickServer(found[0])
    },
  })
  const pickServer = (server: DetectedDecisionServer) => {
    setBaseUrl(server.baseUrl)
    if (server.models[0]) setModel(server.models[0])
  }

  if (kind === 'openai' && !openAIServicesKey) {
    return (
      <div className="space-y-3 text-sm text-secondary">
        <p>
          OpenAI Decisions uses the OpenAI API services key, the same one the voice assistant and memory search use. It
          has no key of its own. Add that key under Integrations first, then come back here.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Link
            to={OPENAI_SERVICES_LINK}
            className="ficus-button ficus-button-primary rounded-lg px-4 py-2 text-sm font-medium"
          >
            Open Integrations
          </Link>
          <button
            type="button"
            onClick={onCancel}
            className="ficus-button ficus-button-secondary rounded-lg px-4 py-2 text-sm font-medium"
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

  const missing =
    (fields.apiKey === 'required' && !apiKey.trim()) ||
    (fields.baseUrl && !baseUrl.trim()) ||
    (fields.accountId && !accountId.trim()) ||
    !model.trim()
  const detectedModels = [...new Set([...(servers?.flatMap((server) => server.models) ?? []), ...info.models])]

  return (
    <form
      className="min-w-0 space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (missing || save.isPending) return
        save.mutate({
          kind,
          label: label.trim() || undefined,
          model: model.trim(),
          ...(fields.apiKey !== 'none' && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          ...(fields.baseUrl ? { baseUrl: baseUrl.trim() } : {}),
          ...(fields.accountId ? { accountId: accountId.trim() } : {}),
        })
      }}
    >
      {fields.baseUrl && (
        <div className="space-y-2">
          <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <DecisionField label="Server URL" className="min-w-0 space-y-1">
              {(id) => (
                <input
                  id={id}
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder="http://localhost:11434"
                  autoComplete="off"
                  className={DECISION_INPUT_CLASS}
                />
              )}
            </DecisionField>
            <button
              type="button"
              onClick={() => detect.mutate()}
              disabled={detect.isPending}
              className="ficus-button ficus-button-secondary w-fit whitespace-nowrap rounded-lg px-3 py-2 text-sm disabled:opacity-50"
            >
              {detect.isPending ? 'Looking…' : 'Find on this computer'}
            </button>
          </div>
          <p className="text-xs text-muted">
            Where Ollama, vLLM or SGLang serves the model. Ficus calls its{' '}
            <code className="font-mono">/v1/systemone</code> endpoint.
          </p>
          {detect.isError && (
            <p role="alert" className="text-xs text-status-danger-600 dark:text-status-danger-400">
              {errorText(detect.error)}
            </p>
          )}
          {servers && servers.length === 0 && (
            <p role="status" className="text-xs text-muted">
              No decision models answered on this computer&apos;s usual ports (11434, 8000, 30000, 8080).
            </p>
          )}
          {servers && servers.length > 1 && (
            <div role="status" className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <span>Found on:</span>
              {servers.map((server) => (
                <button
                  key={server.baseUrl}
                  type="button"
                  aria-pressed={server.baseUrl === baseUrl}
                  onClick={() => pickServer(server)}
                  className="ficus-button ficus-button-secondary rounded-md px-2 py-1 font-mono text-xs"
                >
                  {server.baseUrl}
                </button>
              ))}
            </div>
          )}
          {servers && servers.length === 1 && (
            <p role="status" className="text-xs text-muted">
              Found {servers[0].models.join(', ')} at {servers[0].baseUrl}.
            </p>
          )}
        </div>
      )}

      {fields.accountId && (
        <DecisionField label="Account ID" hint="Shown on your Cloudflare dashboard's Workers AI page.">
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
          label={kind === 'cloudflare' ? 'API token' : fields.apiKey === 'optional' ? 'API key (optional)' : 'API key'}
          hint={
            kind === 'cloudflare'
              ? 'A token with Workers AI read access.'
              : fields.apiKey === 'optional'
                ? 'Only if the server asks for one.'
                : undefined
          }
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

      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        {fields.freeModel ? (
          <DecisionField label="Model" hint="The model name the server lists.">
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
                  {detectedModels.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
              </>
            )}
          </DecisionField>
        ) : info.models.length > 1 ? (
          <div className="min-w-0 space-y-1">
            <span className="block text-xs font-medium text-secondary">Model</span>
            <SegmentedControl
              ariaLabel="Model"
              value={model}
              onChange={setModel}
              options={info.models.map((name) => ({ value: name, label: name }))}
            />
          </div>
        ) : (
          <div className="min-w-0 space-y-1">
            <span className="block text-xs font-medium text-secondary">Model</span>
            <p className="py-2 font-mono text-sm text-primary">{info.defaultModel}</p>
          </div>
        )}
        <DecisionField label="Name (optional)">
          {(id) => (
            <input
              id={id}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder={info.label}
              autoComplete="off"
              className={DECISION_INPUT_CLASS}
            />
          )}
        </DecisionField>
      </div>

      {save.isError && (
        <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
          {errorText(save.error)}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={missing || save.isPending}
          className="ficus-button ficus-button-primary rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          {save.isPending ? 'Testing…' : 'Test and add'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="ficus-button ficus-button-secondary rounded-lg px-4 py-2 text-sm font-medium"
        >
          Cancel
        </button>
        <span className="text-xs text-muted">Ficus asks it a test question before saving.</span>
      </div>
    </form>
  )
}
