import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import {
  DERIVATION_SURFACES,
  PUBLIC_SURFACES,
  PUBLIC_SURFACE_LABELS,
  type DerivationFilters,
  type DerivationSurface,
  type PublicVoiceSurfaces,
} from '@ficus/shared'
import { deriveSquadVoice, type VoiceDerivationResult } from '../../api/publicVoices'
import { ApiError } from '../../api/client'

const SURFACE_LABELS: Record<DerivationSurface, string> = {
  'pull-requests': 'Pull requests',
  'issue-comments': 'Issue comments',
  reviews: 'Reviews',
  commits: 'Commits',
}

function splitRepos(text: string): string[] | undefined {
  const repos = text
    .split(/[\s,]+/)
    .map((r) => r.trim())
    .filter(Boolean)
  return repos.length ? repos : undefined
}

/**
 * Draft a voice from a GitHub user's writing through a squad's GitHub
 * connection. The result is a draft: the caller decides where it goes, and a
 * person edits it before saving. Nothing is applied here.
 */
export function DeriveVoiceCard({
  squadId,
  linkedLogin,
  onUseDraft,
  useDraftLabel,
  onSaveAsProfile,
}: {
  squadId: string
  linkedLogin: string | null
  onUseDraft?: (draft: { base: string; surfaces: PublicVoiceSurfaces }) => void
  useDraftLabel?: string
  /** Shown only to people who can manage profiles. */
  onSaveAsProfile?: (draft: { base: string; surfaces: PublicVoiceSurfaces }, login: string) => void
}) {
  const [login, setLogin] = useState(linkedLogin ?? '')
  const [before, setBefore] = useState('')
  const [after, setAfter] = useState('')
  const [repos, setRepos] = useState('')
  const [excludeRepos, setExcludeRepos] = useState('')
  const [surfaces, setSurfaces] = useState<DerivationSurface[]>([...DERIVATION_SURFACES])
  const [includeToolAuthored, setIncludeToolAuthored] = useState(false)

  const filters = (): DerivationFilters => ({
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
    ...(splitRepos(repos) ? { repositories: splitRepos(repos) } : {}),
    ...(splitRepos(excludeRepos) ? { excludeRepositories: splitRepos(excludeRepos) } : {}),
    ...(surfaces.length < DERIVATION_SURFACES.length ? { surfaces } : {}),
    ...(includeToolAuthored ? { excludeToolAuthored: false } : {}),
  })

  const mutation = useMutation({
    mutationFn: () => deriveSquadVoice(squadId, { login: login.trim(), filters: filters() }),
  })

  const result: VoiceDerivationResult | undefined = mutation.data
  const error =
    mutation.error instanceof ApiError ? mutation.error.message : mutation.error ? String(mutation.error) : null

  return (
    <div className="space-y-3 rounded-xl border border-panel-border bg-surface p-4">
      <div>
        <h4 className="text-sm font-medium text-primary">Derive a voice from GitHub</h4>
        <p className="mt-1 text-xs text-muted">
          Samples a GitHub user's pull requests, comments, reviews and commit messages through this squad's GitHub
          connection and drafts a style. Nothing is saved until you edit and save the draft. The draft describes a
          writing style; agents never sign as or claim to be that person.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-xs text-muted">
          GitHub login
          <input
            aria-label="GitHub login"
            className="ficus-field mt-1 w-full rounded-md border border-th-border bg-surface px-2 py-1 text-sm text-primary"
            value={login}
            onChange={(e) => setLogin(e.target.value)}
          />
        </label>
        <label className="text-xs text-muted">
          Only before (for example when Ficus started posting from the account)
          <input
            type="date"
            aria-label="Only before"
            className="ficus-field mt-1 w-full rounded-md border border-th-border bg-surface px-2 py-1 text-sm text-primary"
            value={before}
            onChange={(e) => setBefore(e.target.value)}
          />
        </label>
        <label className="text-xs text-muted">
          Only on or after
          <input
            type="date"
            aria-label="Only on or after"
            className="ficus-field mt-1 w-full rounded-md border border-th-border bg-surface px-2 py-1 text-sm text-primary"
            value={after}
            onChange={(e) => setAfter(e.target.value)}
          />
        </label>
        <label className="text-xs text-muted">
          Only these repositories (owner/name)
          <input
            aria-label="Only these repositories"
            className="ficus-field mt-1 w-full rounded-md border border-th-border bg-surface px-2 py-1 text-sm text-primary"
            value={repos}
            onChange={(e) => setRepos(e.target.value)}
          />
        </label>
        <label className="text-xs text-muted">
          Leave out these repositories
          <input
            aria-label="Leave out these repositories"
            className="ficus-field mt-1 w-full rounded-md border border-th-border bg-surface px-2 py-1 text-sm text-primary"
            value={excludeRepos}
            onChange={(e) => setExcludeRepos(e.target.value)}
          />
        </label>
      </div>
      <div className="flex flex-wrap gap-3 text-xs text-secondary">
        {DERIVATION_SURFACES.map((surface) => (
          <label key={surface} className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={surfaces.includes(surface)}
              onChange={(e) =>
                setSurfaces((current) =>
                  e.target.checked ? [...current, surface] : current.filter((s) => s !== surface)
                )
              }
            />
            {SURFACE_LABELS[surface]}
          </label>
        ))}
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={includeToolAuthored}
            onChange={(e) => setIncludeToolAuthored(e.target.checked)}
          />
          Keep items that look written by an assistant or a bot
        </label>
      </div>
      <button
        className="ficus-button ficus-button-primary rounded-md px-3 py-1.5 text-sm"
        disabled={!login.trim() || surfaces.length === 0 || mutation.isPending}
        onClick={() => mutation.mutate()}
      >
        {mutation.isPending ? 'Deriving… (up to a minute)' : 'Derive'}
      </button>

      {error && <p className="text-xs text-status-danger-500">{error}</p>}

      {result && (
        <div className="space-y-3 text-sm">
          <div className="text-xs text-muted">
            <p>
              Kept {result.sampling.counts.kept} of {result.sampling.counts.collected} items. Left out:{' '}
              {result.sampling.counts.droppedByFilter.date} by date, {result.sampling.counts.droppedByFilter.repository}{' '}
              by repository, {result.sampling.counts.droppedAsToolAuthored} as tool-authored (a heuristic),{' '}
              {result.sampling.counts.droppedAsTemplate} as templates or too short.
            </p>
            {Object.entries(result.sampling.dateRange).map(([surface, range]) => (
              <p key={surface}>
                {SURFACE_LABELS[surface as DerivationSurface] ?? surface}: {range.oldest} to {range.newest}
              </p>
            ))}
            {result.sampling.pagingCapped && <p>Paging stopped at its limit; older items may exist.</p>}
            {result.sampling.unavailableRepositories?.length ? (
              <p>
                Not found or not visible to the squad's GitHub account:{' '}
                {result.sampling.unavailableRepositories.join(', ')}
              </p>
            ) : null}
            {result.sampling.commitRepositoriesNotSampled?.length ? (
              <p>
                Commits are read from eight repositories at most; not read:{' '}
                {result.sampling.commitRepositoriesNotSampled.join(', ')}
              </p>
            ) : null}
          </div>
          <div>
            <h5 className="text-xs font-medium text-primary">Observations</h5>
            <ul className="list-disc pl-5 text-secondary">
              {result.observations.map((o) => (
                <li key={o}>{o}</li>
              ))}
            </ul>
          </div>
          {result.exemplars.length > 0 && (
            <div>
              <h5 className="text-xs font-medium text-primary">Exemplars (public repositories only)</h5>
              <ul className="list-disc pl-5 text-secondary">
                {result.exemplars.map((e) => (
                  <li key={e.text}>
                    “{e.text}” <span className="text-muted">({e.repository})</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <h5 className="text-xs font-medium text-primary">
              Draft ({result.bytes} / {result.maxBytes} bytes)
            </h5>
            <pre className="mt-1 whitespace-pre-wrap rounded-md bg-surface-secondary p-2 text-xs text-primary">
              {result.draft.base}
              {PUBLIC_SURFACES.filter((s) => result.draft.surfaces[s])
                .map((s) => `\n- ${PUBLIC_SURFACE_LABELS[s]}: ${result.draft.surfaces[s]!.text}`)
                .join('')}
            </pre>
          </div>
          <div className="flex flex-wrap gap-2">
            {onUseDraft && (
              <button
                className="ficus-button ficus-button-primary rounded-md px-3 py-1 text-sm"
                onClick={() => onUseDraft(result.draft)}
              >
                {useDraftLabel ?? 'Use this draft'}
              </button>
            )}
            {onSaveAsProfile && (
              <button
                className="ficus-button ficus-button-ghost rounded-md px-3 py-1 text-sm"
                onClick={() => onSaveAsProfile(result.draft, result.login)}
              >
                Save as new profile
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
