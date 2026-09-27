import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { queries } from '../../queryOptions'
import { channelLinkQueryKeys } from '../../queryKeys'
import { startChannelLink, confirmChannelLink, removeChannelLink } from '../../api/channelLinks'

export function LinkedChatAccounts() {
  const client = useQueryClient()
  const [code, setCode] = useState<{ id: string; code: string } | null>(null)
  const query = useQuery({
    ...queries.channelLinks.list(),
    refetchInterval: (q) => (q.state.data?.pending.length ? 2000 : false),
  })
  const refresh = () => client.invalidateQueries({ queryKey: channelLinkQueryKeys.all })
  const start = useMutation({
    mutationFn: startChannelLink,
    onSuccess: (result) => {
      setCode(result)
      void refresh()
    },
  })
  const confirm = useMutation({
    mutationFn: confirmChannelLink,
    onSuccess: () => {
      setCode(null)
      void refresh()
    },
  })
  const remove = useMutation({
    mutationFn: removeChannelLink,
    onSuccess: () => {
      setCode(null)
      void refresh()
    },
  })
  const error = query.error ?? start.error ?? confirm.error ?? remove.error
  return (
    <section className="ficus-section py-5 space-y-4" aria-labelledby="linked-chat-accounts">
      <div>
        <h4
          id="linked-chat-accounts"
          data-setting-target="linked-chat-accounts"
          className="text-md font-medium text-primary"
        >
          Linked chat accounts
        </h4>
        <p className="text-sm text-muted mt-1">
          Use Discord, Slack, or Telegram with your Ficus account’s squad chat permissions. Linking does not grant
          additional access. Answers are posted in the channel where you ask.
        </p>
      </div>
      {query.isPending && <p className="text-sm text-muted">Loading linked accounts…</p>}
      {query.data?.links.map((link) => (
        <div key={link.id} className="flex items-center gap-3 justify-between">
          <div className="min-w-0">
            <p className="text-sm text-primary break-words">
              {link.externalUserName} · {link.instanceName}
            </p>
            <p className="text-xs text-muted break-all">
              {link.provider} · {link.externalUserId}
            </p>
          </div>
          <button
            className="ficus-button px-3 py-2 text-sm shrink-0"
            disabled={remove.isPending}
            onClick={() => remove.mutate(link.id)}
          >
            Unlink
          </button>
        </div>
      ))}
      {query.data?.pending.map((pending) => (
        <div key={pending.id} className="ficus-inset p-4 space-y-3">
          {pending.externalUserId ? (
            <>
              <p className="text-sm text-primary">
                Confirm this is your account: <strong>{pending.externalUserName}</strong> on {pending.provider},{' '}
                {pending.instanceName}.
              </p>
              <p className="text-xs text-muted break-all">Account ID: {pending.externalUserId}</p>
              <p className="text-sm text-muted">Only confirm if you sent the code from this account.</p>
              <button
                className="ficus-button ficus-button-primary px-3 py-2 text-sm"
                disabled={confirm.isPending}
                onClick={() => confirm.mutate(pending.id)}
              >
                Link this account
              </button>
            </>
          ) : (
            <>
              <p className="text-sm text-primary">Send this to Ficus from the account you want to link:</p>
              {code?.id === pending.id ? (
                <ChannelLinkCommand key={code.id} code={code.code} />
              ) : (
                <p className="text-sm text-muted">
                  The code was shown when you started this request. Cancel and start again if you no longer have it.
                </p>
              )}
              <p className="text-sm text-muted">
                In Slack or Discord, you can also mention the bot with <code>link CODE</code>. Then return here to
                confirm. The code expires after 10 minutes.
              </p>
            </>
          )}
          <button
            className="ficus-button px-3 py-2 text-sm"
            disabled={remove.isPending}
            onClick={() => remove.mutate(pending.id)}
          >
            Cancel
          </button>
        </div>
      ))}
      <button
        className="ficus-button px-3 py-2 text-sm"
        onClick={() => start.mutate()}
        disabled={start.isPending || query.isPending || query.isError || !!query.data?.pending.length}
      >
        Link a chat account
      </button>
      {error && (
        <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
          {error.message}
        </p>
      )}
    </section>
  )
}

export function ChannelLinkCommand({ code }: { code: string }) {
  const command = `/ficus link ${code}`
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      setStatus('copied')
    } catch {
      setStatus('failed')
    }
  }
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <pre className="flex-1 min-w-0 text-sm whitespace-pre-wrap break-all select-all">{command}</pre>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy account linking command"
          className="ficus-button text-xs text-accent-light hover:text-accent-hover font-medium shrink-0 px-2 py-1"
        >
          <span role="status">{status === 'copied' ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      {status === 'failed' && (
        <p role="alert" className="text-xs text-danger">
          Couldn’t copy. Select the command and copy it manually.
        </p>
      )}
    </div>
  )
}
