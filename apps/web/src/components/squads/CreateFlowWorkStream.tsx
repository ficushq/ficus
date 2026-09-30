import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { WorkflowSource } from '@ficus/shared'
import { client } from '../../api/clientInstance'
import { queryKeys } from '../../queryKeys'
import { usePermissions } from '../../hooks/usePermissions'
import { Modal } from '../Modal'
import { WorkflowEditor } from './WorkflowEditor'
import { PlusIcon } from '../icons'

export function CreateFlowWorkStream({ squadId }: { squadId: string }) {
  const { can } = usePermissions(squadId)
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [source, setSource] = useState<WorkflowSource | undefined>()
  const queryClient = useQueryClient()
  const create = useMutation({
    mutationFn: () =>
      client.workflows.createStream({ squadId, title, description, ...(source ? { workflow: source } : {}) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.all })
      setOpen(false)
      setTitle('')
      setDescription('')
    },
  })
  if (!can('workstreams:create')) return null
  return (
    <>
      <button
        type="button"
        className="ficus-button ficus-button-primary flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium"
        onClick={() => setOpen(true)}
      >
        <PlusIcon className="h-4 w-4" />
        New work stream
      </button>
      <Modal isOpen={open} onClose={() => setOpen(false)} title="New work stream">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            create.mutate()
          }}
        >
          <label className="block text-sm">
            Title
            <input
              required
              className="ficus-field w-full p-2 border border-th-border rounded-md"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            What should be delivered?
            <textarea
              required
              className="ficus-field w-full p-2 border border-th-border rounded-md"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <WorkflowEditor squadId={squadId} value={source} onChange={setSource} disabled={create.isPending} />
          {create.error && (
            <p role="alert" className="text-sm text-status-danger-400">
              {create.error.message}
            </p>
          )}
          <button
            type="submit"
            disabled={create.isPending || !title.trim()}
            className="px-3 py-2 text-sm rounded-md bg-accent text-on-accent"
          >
            Create work stream
          </button>
        </form>
      </Modal>
    </>
  )
}
