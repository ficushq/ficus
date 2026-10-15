/**
 * The Workspace tab's agent target: pick an agent, see its private folder path
 * and sandbox state, start its sandbox, and create a file there.
 */

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { isLiveAgentStatus, type Agent } from '@ficus/shared'
import type { AgentPrivateStatus } from '../../api/agentPrivate'
import { startAgentPrivateSandbox } from '../../api/agentPrivate'
import { queryKeys } from '../../queryKeys'
import { getAgentPrimaryLabel } from '../../lib/agentDisplay'
import { newFilePathError, privateAreaAgents, sandboxStatusLabel } from './agentPrivateTargets'
import { Modal } from '../Modal'
import { KeyIcon, PlayIcon, PlusIcon, SpinnerIcon } from '../icons'
import { CopyPathButton } from './CopyPathButton'
import { agentVisiblePath, type WorkspaceSource } from './workspaceSource'

export function WorkspaceTargetSelect({
  agents,
  value,
  onChange,
  className,
}: {
  agents: Agent[]
  /** Selected agent id, or null for the squad workspace. */
  value: string | null
  onChange: (agentId: string | null) => void
  className?: string
}) {
  const listed = privateAreaAgents(agents)
  const known = value === null || listed.some((agent) => agent.id === value)
  return (
    <select
      aria-label="Workspace to browse"
      className={clsx('ficus-field rounded-md border border-th-border px-3 py-1.5 text-sm', className)}
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value || null)}
    >
      <option value="">Squad workspace</option>
      {listed.length > 0 && (
        <optgroup label="Agent private folders">
          {listed.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {getAgentPrimaryLabel(agent)}
              {isLiveAgentStatus(agent.status) ? '' : ' (dormant)'}
            </option>
          ))}
        </optgroup>
      )}
      {!known && <option value={value!}>Unknown agent</option>}
    </select>
  )
}

export function AgentPrivateStatusBar({
  agentId,
  status,
  source,
}: {
  agentId: string
  status: AgentPrivateStatus
  source: WorkspaceSource
}) {
  const queryClient = useQueryClient()
  const [newFileOpen, setNewFileOpen] = useState(false)
  const start = useMutation({
    mutationFn: () => startAgentPrivateSandbox(agentId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.agentPrivate.agent(agentId) }),
  })
  const running = status.sandbox.status === 'running'

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted">
      <span className="inline-flex min-w-0 items-center gap-1">
        <KeyIcon className="h-3.5 w-3.5 shrink-0" />
        <span>Private folder</span>
        <code
          className="truncate rounded bg-surface-hover px-1.5 py-0.5 font-mono text-secondary"
          title={status.privateRoot}
        >
          {status.privateRoot}
        </code>
        <CopyPathButton path={status.privateRoot} />
      </span>
      <span className={clsx('inline-flex items-center gap-1', running ? 'text-secondary' : 'text-muted')}>
        <span
          aria-hidden
          className={clsx('h-2 w-2 rounded-full', running ? 'bg-status-success-500' : 'bg-th-border')}
        />
        {sandboxStatusLabel(status)}
      </span>
      {status.canStart && !running && (
        <button
          type="button"
          onClick={() => start.mutate()}
          disabled={start.isPending}
          className="ficus-button ficus-button-secondary inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs disabled:opacity-60"
        >
          {start.isPending ? (
            <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <PlayIcon className="h-3.5 w-3.5" />
          )}
          {start.isPending ? 'Starting…' : 'Start sandbox'}
        </button>
      )}
      {start.isError && (
        <span className="text-status-danger-500">
          {start.error instanceof Error ? start.error.message : 'Could not start the sandbox'}
        </span>
      )}
      {status.filesAvailable && (
        <button
          type="button"
          onClick={() => setNewFileOpen(true)}
          className="ficus-button ficus-button-ghost inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs"
        >
          <PlusIcon className="h-3.5 w-3.5" /> New file
        </button>
      )}
      <NewPrivateFileDialog
        isOpen={newFileOpen}
        onClose={() => setNewFileOpen(false)}
        source={source}
        privateRoot={status.privateRoot}
      />
    </div>
  )
}

function NewPrivateFileDialog({
  isOpen,
  onClose,
  source,
  privateRoot,
}: {
  isOpen: boolean
  onClose: () => void
  source: WorkspaceSource
  privateRoot: string
}) {
  const queryClient = useQueryClient()
  const [path, setPath] = useState('')
  const [content, setContent] = useState('')
  const [created, setCreated] = useState<string | null>(null)
  const pathError = path ? newFilePathError(path) : null
  const create = useMutation({
    mutationFn: async () => {
      const relativePath = path.split('/').filter(Boolean).join('/')
      const name = relativePath.split('/').pop()!
      const response = await source.upload([{ file: new File([content], name), relativePath }], {})
      const result = response.results[0]
      if (!result || result.status === 'error') throw new Error(result?.error ?? 'Could not create the file')
      if (result.status === 'skipped') throw new Error('A file with this name already exists')
      return result.agentPath ?? agentVisiblePath(privateRoot, relativePath)
    },
    onSuccess: (agentPath) => {
      setCreated(agentPath)
      queryClient.invalidateQueries({ queryKey: source.treeQueryPrefix })
    },
  })

  const close = () => {
    setPath('')
    setContent('')
    setCreated(null)
    create.reset()
    onClose()
  }

  return (
    <Modal isOpen={isOpen} onClose={close} title="New file in private folder">
      {created ? (
        <div className="space-y-4">
          <p className="text-sm text-secondary">
            Saved. Only this agent can read it. Paste this path into a message to the agent:
          </p>
          <div className="flex items-center gap-2 rounded-md bg-surface-hover px-3 py-2">
            <code className="flex-1 truncate font-mono text-sm text-primary">{created}</code>
            <CopyPathButton path={created} label="Copy path" />
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={close}
              className="ficus-button ficus-button-primary rounded px-4 py-2 text-sm"
            >
              Done
            </button>
          </div>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (!newFilePathError(path)) create.mutate()
          }}
        >
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-secondary">File name</span>
            <input
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="credentials/api-token.txt"
              autoComplete="off"
              spellCheck={false}
              className="ficus-field w-full rounded-md border border-input-border bg-input-bg px-3 py-2 font-mono text-primary"
            />
            <span className="mt-1 block text-xs text-muted">
              {pathError ??
                `Saved at ${agentVisiblePath(privateRoot, path.split('/').filter(Boolean).join('/') || '…')}`}
            </span>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-secondary">Contents</span>
            <textarea
              value={content}
              onChange={(event) => setContent(event.target.value)}
              rows={6}
              autoComplete="off"
              spellCheck={false}
              className="ficus-field w-full rounded-md border border-input-border bg-input-bg px-3 py-2 font-mono text-primary"
            />
          </label>
          {create.isError && (
            <p className="text-sm text-status-danger-500">
              {create.error instanceof Error ? create.error.message : 'Could not create the file'}
            </p>
          )}
          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={close}
              className="ficus-button ficus-button-secondary rounded px-4 py-2 text-sm"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!path || !!pathError || create.isPending}
              className="ficus-button ficus-button-primary rounded px-4 py-2 text-sm disabled:opacity-60"
            >
              {create.isPending ? 'Saving…' : 'Save file'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  )
}
