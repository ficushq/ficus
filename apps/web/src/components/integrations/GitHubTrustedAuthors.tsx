import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { GitHubAccountIdentity } from '@ficus/shared'
import {
  addGitHubTrustedAuthor,
  githubFeedbackErrorMessage,
  removeGitHubTrustedAuthor,
  resolveGitHubTrustedAuthor,
} from '../../api/githubFeedback'
import { githubFeedbackQueries } from '../../queryOptions'
import { githubFeedbackQueryKeys } from '../../queryKeys'
import { authorLabel, trustOriginLabel } from './githubFeedbackLabels'

/**
 * Squad trusted-author management. Linked Ficus users with squad-update permission are trusted
 * dynamically and listed read-only; humans and bots without Ficus accounts are added by a
 * provider-verified numeric account ID that the server re-checks on add.
 */
export function GitHubTrustedAuthors({ squadId }: { squadId: string }) {
  const client = useQueryClient()
  const list = useQuery(githubFeedbackQueries.trustedAuthors(squadId))
  const [login, setLogin] = useState('')
  const [preview, setPreview] = useState<GitHubAccountIdentity | null>(null)
  const [message, setMessage] = useState<{ tone: 'info' | 'error'; text: string } | null>(null)
  const refresh = () => client.invalidateQueries({ queryKey: githubFeedbackQueryKeys.squad(squadId) })
  const fail = (fallback: string) => (error: unknown) =>
    setMessage({ tone: 'error', text: githubFeedbackErrorMessage(error, fallback) })

  const resolve = useMutation({
    mutationFn: (value: string) => resolveGitHubTrustedAuthor(squadId, value),
    onMutate: () => {
      setMessage(null)
      setPreview(null)
    },
    onSuccess: setPreview,
    onError: fail("Couldn't look up that GitHub account."),
  })
  const add = useMutation({
    mutationFn: (account: GitHubAccountIdentity) => addGitHubTrustedAuthor(squadId, account),
    onMutate: () => setMessage(null),
    onSuccess: async (account) => {
      setPreview(null)
      setLogin('')
      setMessage({
        tone: 'info',
        text: `${authorLabel(account)} is now trusted. Their events already waiting for review are not released automatically.`,
      })
      await refresh()
    },
    onError: async (error) => {
      fail("Couldn't add the trusted author.")(error)
      setPreview(null)
    },
  })
  const remove = useMutation({
    mutationFn: (author: GitHubAccountIdentity) =>
      removeGitHubTrustedAuthor(squadId, author.accountId).then((result) => ({ author, result })),
    onMutate: () => setMessage(null),
    onSuccess: async ({ author, result }) => {
      setMessage({
        tone: 'info',
        text: result.remainingOrigins.length
          ? `Removed ${authorLabel(author)} from this squad’s list. They are still trusted: ${result.remainingOrigins.map(trustOriginLabel).join('; ')}.`
          : `${authorLabel(author)} is no longer trusted in this squad.`,
      })
      await refresh()
    },
    onError: fail("Couldn't remove the trusted author."),
  })

  const canManage = list.data?.canManage ?? false
  const authors = list.data?.authors ?? []
  return (
    <div className="space-y-3" aria-labelledby={`trusted-authors-${squadId}`}>
      <div>
        <h5 id={`trusted-authors-${squadId}`} className="text-sm font-medium text-primary">
          Trusted authors
        </h5>
        <p className="mt-1 text-xs text-muted">
          Ficus users who link their GitHub account and can update this squad are trusted automatically. Add people and
          bots without Ficus accounts here. Being trusted never grants repository access.
        </p>
      </div>
      {list.isPending && (
        <p role="status" className="text-sm text-muted">
          Loading trusted authors…
        </p>
      )}
      {list.isError && (
        <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
          {githubFeedbackErrorMessage(list.error, "Couldn't load trusted authors.")}
        </p>
      )}
      {list.isSuccess && authors.length === 0 && <p className="text-sm text-muted">No trusted authors yet.</p>}
      <ul className="divide-y divide-panel-border">
        {authors.map((author) => {
          const manual = author.origins.some((origin) => origin.kind === 'manual')
          return (
            <li key={author.accountId} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <p className="text-sm text-primary break-words">{authorLabel(author)}</p>
                <p className="text-xs text-muted break-words">
                  ID {author.accountId} · {author.origins.map(trustOriginLabel).join('; ')}
                </p>
              </div>
              {canManage && manual && (
                <button
                  type="button"
                  className="ficus-button ficus-button-secondary shrink-0 px-3 py-1.5 text-sm"
                  aria-label={`Remove ${authorLabel(author)} from trusted authors`}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(author)}
                >
                  Remove
                </button>
              )}
            </li>
          )
        })}
      </ul>
      {canManage ? (
        <div className="space-y-2">
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              if (login.trim()) resolve.mutate(login.trim())
            }}
          >
            <input
              type="text"
              aria-label="GitHub username to trust"
              placeholder="GitHub username"
              autoComplete="off"
              spellCheck={false}
              value={login}
              maxLength={100}
              onChange={(event) => {
                setLogin(event.target.value)
                setPreview(null)
              }}
              className="ficus-field min-w-0 flex-1 rounded-md border border-panel-border bg-surface px-3 py-2 text-sm"
            />
            <button
              type="submit"
              className="ficus-button ficus-button-secondary px-3 py-2 text-sm"
              disabled={!login.trim() || resolve.isPending}
            >
              Look up
            </button>
          </form>
          {preview && (
            <div className="ficus-inset space-y-2 p-3" role="group" aria-label="Confirm trusted author">
              <p className="text-sm text-primary">
                GitHub account {authorLabel(preview)} · {preview.accountType === 'Bot' ? 'Bot' : 'User'} · ID{' '}
                {preview.accountId}
              </p>
              <p className="text-xs text-muted">
                Trust is tied to this account ID, so it keeps working if the username changes.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="ficus-button ficus-button-primary px-3 py-1.5 text-sm"
                  disabled={add.isPending}
                  onClick={() => add.mutate(preview)}
                >
                  Trust {authorLabel(preview)}
                </button>
                <button
                  type="button"
                  className="ficus-button ficus-button-secondary px-3 py-1.5 text-sm"
                  onClick={() => setPreview(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        list.isSuccess && (
          <p className="text-xs text-muted">You need permission to update this squad to change trusted authors.</p>
        )
      )}
      {message && (
        <p
          role={message.tone === 'error' ? 'alert' : 'status'}
          className={`text-sm ${message.tone === 'error' ? 'text-status-danger-600 dark:text-status-danger-400' : 'text-muted'}`}
        >
          {message.text}
        </p>
      )}
    </div>
  )
}
