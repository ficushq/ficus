import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { IntegrationAuthorizationStart } from '@ficus/shared'
import {
  cancelGitHubIdentityDevice,
  confirmGitHubIdentity,
  pollGitHubIdentityDevice,
  startGitHubIdentityLink,
  unlinkGitHubIdentity,
} from '../../api/githubIdentity'
import { githubFeedbackErrorMessage } from '../../api/githubFeedback'
import { githubIdentityQueries } from '../../queryOptions'
import { githubFeedbackQueryKeys, githubIdentityQueryKeys } from '../../queryKeys'
import { githubIdentityAuthorizationReturnPath } from '../../lib/integrationReturnPath'
import { GitHubDeviceCode } from '../integrations/GitHubIntegrationSettings'

type DeviceLogin = Extract<IntegrationAuthorizationStart, { kind: 'device' }>
const ENDED_DEVICE_CODES = new Set(['access_denied', 'expired_token', 'flow_expired', 'provider_denied'])

/**
 * The signed-in person's verified GitHub account (personal settings). This proves who they are on
 * GitHub so squads can trust feedback they write; it is never a squad integration credential.
 */
export function LinkedGitHubAccount() {
  const client = useQueryClient()
  const query = useQuery(githubIdentityQueries.status())
  const [device, setDevice] = useState<DeviceLogin | null>(null)
  const [confirmUnlink, setConfirmUnlink] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  // Trust in every squad this person can update follows their link, so both namespaces refresh.
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: githubIdentityQueryKeys.all }),
      client.invalidateQueries({ queryKey: githubFeedbackQueryKeys.all }),
    ])
  const fail = (fallback: string) => (failure: unknown) => setError(githubFeedbackErrorMessage(failure, fallback))

  const start = useMutation({
    mutationFn: () => startGitHubIdentityLink(githubIdentityAuthorizationReturnPath()),
    onMutate: () => {
      setError('')
      setNotice('')
    },
    onSuccess: (result) => {
      if ('authorizationUrl' in result) window.location.assign(result.authorizationUrl)
      else setDevice(result)
    },
    onError: fail("Couldn't start GitHub sign-in."),
  })
  const cancel = useMutation({
    mutationFn: (id: string) => cancelGitHubIdentityDevice(id),
    onSuccess: () => setDevice(null),
    onError: fail("Couldn't cancel the GitHub sign-in."),
  })
  const confirm = useMutation({
    mutationFn: (proofId: string) => confirmGitHubIdentity(proofId),
    onMutate: () => setError(''),
    onSuccess: async () => {
      setNotice('GitHub account linked.')
      await refresh()
    },
    onError: fail("Couldn't link the GitHub account."),
  })
  const unlink = useMutation({
    mutationFn: () => unlinkGitHubIdentity(),
    onMutate: () => setError(''),
    onSuccess: async () => {
      setConfirmUnlink(false)
      setNotice('GitHub account unlinked.')
      await refresh()
    },
    onError: fail("Couldn't unlink the GitHub account."),
  })

  useEffect(() => {
    if (!device) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const result = await pollGitHubIdentityDevice(device.id)
        if (stopped) return
        if (result.status === 'complete') {
          setDevice(null)
          await client.invalidateQueries({ queryKey: githubIdentityQueryKeys.all })
        } else if (result.status === 'failed') {
          setDevice(null)
          setError(
            ENDED_DEVICE_CODES.has(result.code)
              ? 'GitHub sign-in expired or was declined. Start again to link your account.'
              : 'GitHub sign-in failed. Start again to link your account.'
          )
        } else timer = setTimeout(poll, Math.max(1, result.retryAfterSeconds) * 1000)
      } catch {
        if (stopped) return
        setError('Unable to check GitHub sign-in. Retrying…')
        timer = setTimeout(poll, Math.max(5, device.intervalSeconds) * 1000)
      }
    }
    timer = setTimeout(poll, device.intervalSeconds * 1000)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [device, client])

  const data = query.data
  const configured = data?.authorization?.configured ?? false
  const loadError = query.isError ? githubFeedbackErrorMessage(query.error, "Couldn't load your GitHub account.") : ''
  return (
    <section className="ficus-section py-5 space-y-4" aria-labelledby="linked-github-account">
      <div>
        <h4
          id="linked-github-account"
          data-setting-target="github-identity"
          className="text-md font-medium text-primary"
        >
          GitHub account
        </h4>
        <p className="text-sm text-muted mt-1">
          Link the GitHub account you write pull request and issue feedback from. In squads where you can update
          settings, that feedback reaches agents without waiting for review. This only proves which GitHub account is
          yours: it does not connect repositories or give Ficus access to your GitHub account.
        </p>
      </div>
      {query.isPending && (
        <p role="status" className="text-sm text-muted">
          Loading GitHub account…
        </p>
      )}
      {data && !configured && (
        <p className="text-sm text-muted">
          GitHub sign-in is not configured on this Ficus instance. Ask an administrator to set up the GitHub
          integration.
        </p>
      )}
      {data?.linked && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-primary break-words">
              Linked <strong>@{data.linked.login}</strong>
            </p>
            <p className="text-xs text-muted break-all">
              GitHub account ID {data.linked.accountId} · since {new Date(data.linked.linkedAt).toLocaleDateString()}
            </p>
          </div>
          {!confirmUnlink && (
            <button
              type="button"
              className="ficus-button ficus-button-secondary px-3 py-2 text-sm shrink-0"
              onClick={() => setConfirmUnlink(true)}
            >
              Unlink
            </button>
          )}
        </div>
      )}
      {data?.linked && confirmUnlink && (
        <div className="ficus-inset p-4 space-y-3" role="group" aria-label="Confirm unlinking GitHub account">
          <p className="text-sm text-primary">
            Feedback from @{data.linked.login} will no longer be trusted because of your Ficus permissions. Entries that
            a squad added to its own trusted-author list stay trusted until someone removes them there.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="ficus-button ficus-button-secondary px-3 py-2 text-sm text-status-danger-600 dark:text-status-danger-400"
              disabled={unlink.isPending}
              onClick={() => unlink.mutate()}
            >
              Unlink GitHub account
            </button>
            <button
              type="button"
              className="ficus-button ficus-button-secondary px-3 py-2 text-sm"
              onClick={() => setConfirmUnlink(false)}
            >
              Keep linked
            </button>
          </div>
        </div>
      )}
      {data?.confirmation && !data.linked && (
        <div className="ficus-inset p-4 space-y-3">
          <p className="text-sm text-primary">
            GitHub verified this account: <strong>@{data.confirmation.login}</strong>
          </p>
          <p className="text-xs text-muted break-all">GitHub account ID {data.confirmation.accountId}</p>
          <p className="text-sm text-muted">Link it only if this is your own GitHub account.</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="ficus-button ficus-button-primary px-3 py-2 text-sm"
              disabled={confirm.isPending}
              onClick={() => confirm.mutate(data.confirmation!.id)}
            >
              Link this account
            </button>
            <button
              type="button"
              className="ficus-button ficus-button-secondary px-3 py-2 text-sm"
              disabled={start.isPending}
              onClick={() => start.mutate()}
            >
              Use a different account
            </button>
          </div>
        </div>
      )}
      {device && (
        <div className="ficus-inset space-y-2 p-3" role="status">
          <p className="text-sm">Enter this code on GitHub:</p>
          <GitHubDeviceCode key={device.id} code={device.userCode} />
          <div className="flex gap-3">
            <a
              className="ficus-button ficus-button-primary px-3 py-2 text-sm"
              href={device.verificationUri}
              target="_blank"
              rel="noreferrer"
            >
              Open GitHub
            </a>
            <button
              type="button"
              className="ficus-button ficus-button-secondary px-3 py-2 text-sm"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate(device.id)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {data && !data.linked && !data.confirmation && !device && (
        <button
          type="button"
          className="ficus-button ficus-button-secondary px-3 py-2 text-sm"
          disabled={!configured || start.isPending}
          onClick={() => start.mutate()}
        >
          Link GitHub account
        </button>
      )}
      {notice && !error && (
        <p role="status" className="text-sm text-muted">
          {notice}
        </p>
      )}
      {(error || loadError) && (
        <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
          {error || loadError}
        </p>
      )}
    </section>
  )
}
