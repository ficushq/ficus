import { useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import type { Squad } from '@ficus/shared'
import { createSquad } from '../../api/squads'
import { sendChatMessage } from '../../api/chat'
import { onboardingQueryKeys, queryKeys } from '../../queryKeys'
import { queries } from '../../queryOptions'
import { composeKickoff } from './kickoff'
import type { ItemRowProps } from './OnboardingPage'
import { STATE_BADGE_CLASS, STATE_LABEL } from './onboardingItemPresentation'
import { CreateHostWorkspaceField } from '../squads/CreateHostWorkspaceField'
import { createHostWorkspacePathError } from '../squads/createHostWorkspacePath'

/**
 * The kickoff message is sent directly to the squad's MANAGER agent via
 * `agentId` (spec §4: "sends the squad's manager a first chat message") —
 * deliberately NOT `scope: { type: 'consultant', id: squadId }`.
 *
 * 'consultant' IS the only chatScopeTypeSchema value (packages/shared/src/schemas.ts)
 * that pairs with a squad id, and it IS what the web app's own squad-scoped
 * composer (SquadAgentThreads.tsx's "start a new task" flow) sends — but core's
 * chat route (apps/core/src/routes/chat.ts:76-84) spawns a FRESH,
 * non-persistent consultant agent on every single call ("Always create a
 * fresh consultant scoped to the squad (new conversation each time)"). The
 * manager never sees that message, and every retry would spawn yet another
 * stray agent. Do not "simplify" this back to scope-based sending.
 *
 * `Squad.create()` (apps/core/src/entities/Squad.ts:248-256) always creates
 * the manager agent and sets `managerAgentId` synchronously before
 * returning, and `Squad.toJson()` includes it — so it's always available on
 * the API response for a squad we just created or one we listed.
 */
export function pickMostRecentlyCreated(squads: Squad[]): Squad | undefined {
  if (squads.length === 0) return undefined
  return [...squads].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]
}

function parseRepos(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/**
 * The `first_squad` onboarding row (design §4 / plan Task 3): wraps the
 * existing squad-creation API with one onboarding-only field (repo URLs),
 * then sends the squad a first chat MESSAGE (never the `context` field) via
 * the existing chat-send API, scoped to the squad the same way the app's own
 * squad composer does.
 *
 * Send-failure keeps the created squad standing (design's error-handling
 * contract: creation is not rolled back over a failed hello) and offers an
 * inline retry. If a squad already exists (created here or elsewhere), this
 * renders the same composer as a non-tracked "send your squad its first
 * task" CTA instead of a create form.
 */
export function FirstSquadStep({ meta, item, embedded, onSquadCreated }: ItemRowProps) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [purpose, setPurpose] = useState('')
  const [squadPresetId, setSquadPresetId] = useState('engineering')
  const [repos, setRepos] = useState('')
  const [hostWorkspacePath, setHostWorkspacePath] = useState('')
  const [createdSquad, setCreatedSquad] = useState<Squad | null>(null)

  // Only needed for the "already exists" CTA, and only until we've created
  // one ourselves this session (createdSquad then takes over as the target).
  const existingSquads = useQuery({
    ...queries.squads.list(),
    enabled: item.state === 'done' && !createdSquad,
  })
  const createOptions = useQuery({
    ...queries.squads.createOptions(),
    enabled: item.state !== 'done' && !createdSquad,
  })
  const squadPresets = useQuery({
    ...queries.squadPresets.list(),
    enabled: item.state !== 'done' && !createdSquad,
  })
  const selectedType = squadPresets.data?.find((type) => type.id === squadPresetId && !type.disabled)

  function handleTypeChange(typeId: string) {
    setSquadPresetId(typeId)
    const type = squadPresets.data?.find((candidate) => candidate.id === typeId)
    if (!purpose.trim() && type?.purpose) setPurpose(type.purpose)
  }

  // Deliberately the most recently created squad, not array order (the API's
  // default order is `order` column then createdAt — not chronological) —
  // and only from the default (non-archived) list GET /squads already
  // returns (Squad.list()'s default filters exclude archivedAt IS NOT NULL
  // rows; apps/core/src/entities/Squad.ts's buildListConditions).
  const existingSquad = useMemo(() => pickMostRecentlyCreated(existingSquads.data ?? []), [existingSquads.data])

  const kickoffMutation = useMutation({
    mutationFn: (input: { agentId: string; repos: string[] }) =>
      sendChatMessage({ message: composeKickoff(input.repos), agentId: input.agentId }, { onEvent: () => {} }),
  })

  const createMutation = useMutation({
    mutationFn: () =>
      createSquad({
        name,
        purpose,
        squadPresetId: selectedType?.id,
        defaultAgents: selectedType?.defaultAgents,
        metadata: {
          workflow: selectedType?.workflows?.default ?? { kind: 'preset', id: 'solo', customizations: [] },
        },
        hostWorkspacePath: hostWorkspacePath.trim() || undefined,
      }),
    onSuccess: (squad) => {
      setCreatedSquad(squad)
      onSquadCreated?.(squad)
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.all })
      // The squad now exists, so `first_squad` reads `done` regardless of
      // how the kickoff message below turns out — invalidate right away.
      queryClient.invalidateQueries({ queryKey: onboardingQueryKeys.all })
      // managerAgentId is always set by the time Squad.create() returns (see
      // the module doc comment above) — the `if` is defensive against the
      // nullable API type, not an expected runtime path.
      if (squad.managerAgentId) {
        kickoffMutation.mutate({ agentId: squad.managerAgentId, repos: parseRepos(repos) })
      }
    },
  })

  function handleCreateSubmit(e: FormEvent) {
    e.preventDefault()
    if (
      !name.trim() ||
      createMutation.isPending ||
      squadPresets.isLoading ||
      createHostWorkspacePathError(hostWorkspacePath.trim())
    )
      return
    createMutation.mutate()
  }

  function handleSendSubmit(e: FormEvent) {
    e.preventDefault()
    const targetAgentId = createdSquad?.managerAgentId ?? existingSquad?.managerAgentId
    if (!targetAgentId || kickoffMutation.isPending) return
    kickoffMutation.mutate({ agentId: targetAgentId, repos: parseRepos(repos) })
  }

  function handleRetry() {
    const targetAgentId = createdSquad?.managerAgentId ?? existingSquad?.managerAgentId
    if (!targetAgentId) return
    kickoffMutation.mutate({ agentId: targetAgentId, repos: parseRepos(repos) })
  }

  return (
    <div className={clsx(!embedded && 'px-4 py-4')}>
      {!embedded && (
        <>
          <div className="flex items-center gap-2">
            <p className="font-medium text-primary">{meta.title}</p>
            <span className={clsx('text-xs px-1.5 py-0.5 rounded', STATE_BADGE_CLASS[item.state])}>
              {STATE_LABEL[item.state]}
            </span>
          </div>
          <p className="text-sm text-muted mt-0.5">{meta.why}</p>
        </>
      )}

      {createdSquad ? (
        <div className="mt-3 space-y-1">
          <p className="text-sm text-secondary">Squad &ldquo;{createdSquad.name}&rdquo; created.</p>
          <KickoffFeedback
            isPending={kickoffMutation.isPending}
            isError={kickoffMutation.isError}
            isSuccess={kickoffMutation.isSuccess}
            onRetry={handleRetry}
          />
        </div>
      ) : item.state === 'done' ? (
        existingSquad?.managerAgentId ? (
          <form onSubmit={handleSendSubmit} className="mt-3 space-y-3">
            <p className="text-sm text-secondary">
              Your squad is set up — send your squad its first task to get it moving.
            </p>
            <ReposField value={repos} onChange={setRepos} idPrefix="first-squad-send" />
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={kickoffMutation.isPending}
                className="ficus-button ficus-button-primary px-4 py-2 text-sm font-medium rounded-md disabled:opacity-50"
              >
                {kickoffMutation.isPending ? 'Sending…' : 'Send'}
              </button>
            </div>
            <KickoffFeedback
              isPending={false}
              isError={kickoffMutation.isError}
              isSuccess={kickoffMutation.isSuccess}
              onRetry={handleRetry}
            />
          </form>
        ) : null
      ) : (
        <form onSubmit={handleCreateSubmit} className="mt-3 space-y-3">
          <div>
            <label htmlFor="first-squad-name" className="block text-sm font-medium text-primary mb-1">
              Squad name
            </label>
            <input
              id="first-squad-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Frontend Team"
              className="ficus-field w-full px-3 py-2 border border-th-border bg-surface text-primary rounded-md  focus:ring-2 focus:ring-accent"
            />
          </div>
          <div>
            <label htmlFor="first-squad-purpose" className="block text-sm font-medium text-primary mb-1">
              Purpose (optional)
            </label>
            <textarea
              id="first-squad-purpose"
              aria-describedby="first-squad-purpose-help"
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              placeholder="Software development for the company"
              rows={2}
              className="ficus-field w-full px-3 py-2 border border-th-border bg-surface text-primary rounded-md  focus:ring-2 focus:ring-accent"
            />
            <p id="first-squad-purpose-help" className="mt-1 text-xs text-muted">
              Strongly encouraged: describe what this squad is responsible for. The assistant and other agents use its
              purpose to help route work to the right squad.
            </p>
          </div>
          <div>
            <label htmlFor="first-squad-preset" className="block text-sm font-medium text-primary mb-1">
              Preset
            </label>
            <select
              id="first-squad-preset"
              value={selectedType?.id ?? ''}
              onChange={(e) => handleTypeChange(e.target.value)}
              disabled={squadPresets.isLoading}
              aria-busy={squadPresets.isLoading || undefined}
              aria-describedby="first-squad-preset-help"
              className="ficus-field w-full sm:max-w-sm px-3 py-2 border border-th-border bg-surface text-primary rounded-md focus:ring-2 focus:ring-accent"
            >
              <option value="">No preset</option>
              {squadPresets.data
                ?.filter((type) => !type.disabled)
                .map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name}
                  </option>
                ))}
            </select>
            <p id="first-squad-preset-help" className="mt-1 text-xs text-muted">
              {selectedType?.description ??
                'Start with Solo, or choose a preset for ready-made workflows and squad settings.'}
            </p>
            {squadPresets.isError && (
              <p role="alert" className="mt-1 text-xs text-muted">
                Could not load presets.{' '}
                <button type="button" onClick={() => squadPresets.refetch()} className="ficus-button ficus-button-link">
                  Retry
                </button>
              </p>
            )}
          </div>
          {createOptions.data?.runtime === 'host' && createOptions.data.defaultHostWorkspaceRoot && (
            <CreateHostWorkspaceField
              id="first-squad-host-workspace-path"
              value={hostWorkspacePath}
              onChange={setHostWorkspacePath}
              defaultRoot={createOptions.data.defaultHostWorkspaceRoot}
            />
          )}
          <ReposField value={repos} onChange={setRepos} idPrefix="first-squad-create" />
          {createMutation.isError && (
            <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
              {createMutation.error instanceof Error ? createMutation.error.message : 'Failed to create the squad.'}
            </p>
          )}
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={
                createMutation.isPending ||
                squadPresets.isLoading ||
                !name.trim() ||
                createHostWorkspacePathError(hostWorkspacePath.trim()) !== null
              }
              className="ficus-button ficus-button-primary px-4 py-2 text-sm font-medium rounded-md disabled:opacity-50"
            >
              {createMutation.isPending ? 'Creating…' : 'Create squad & send kickoff'}
            </button>
          </div>
        </form>
      )}
    </div>
  )
}

function ReposField({
  value,
  onChange,
  idPrefix,
}: {
  value: string
  onChange: (value: string) => void
  idPrefix: string
}) {
  const id = `${idPrefix}-repos`
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-primary mb-1">
        Repositories (optional)
      </label>
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={'One URL per line, e.g.\nhttps://github.com/acme/api'}
        rows={3}
        className="ficus-field w-full px-3 py-2 border border-th-border bg-surface text-primary rounded-md  focus:ring-2 focus:ring-accent"
      />
      <p className="text-xs text-muted mt-1">
        Cloned into the workspace on kickoff — leave blank and your squad will just introduce itself.
      </p>
    </div>
  )
}

function KickoffFeedback({
  isPending,
  isError,
  isSuccess,
  onRetry,
}: {
  isPending: boolean
  isError: boolean
  isSuccess: boolean
  onRetry: () => void
}) {
  if (isPending) return <p className="text-sm text-muted mt-2">Sending your squad its first task…</p>
  if (isError) {
    return (
      <div role="alert" className="mt-2 flex items-center gap-2">
        <p className="text-sm text-status-danger-600 dark:text-status-danger-400">
          Failed to send the kickoff message.
        </p>
        <button type="button" onClick={onRetry} className="ficus-button ficus-button-link text-sm">
          Retry
        </button>
      </div>
    )
  }
  if (isSuccess) {
    return (
      <p className="text-sm text-status-success-700 dark:text-status-success-300 mt-2">
        Sent — your squad is getting started.
      </p>
    )
  }
  return null
}
