import { useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { isGrantablePermission } from '@ficus/shared'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import { createRole, updateRole, deleteRole } from '../../api/roles'
import type { RoleSummary } from '../../api/roles'
import { PermissionPicker } from './PermissionPicker'
import { useLoadingShapeCount } from '../../hooks/useLoadingShapeCount'
import { CollectionSkeleton } from '../loading/Skeleton'

type RoleRow = RoleSummary & { readOnly?: boolean }

type CreateDraft = {
  name: string
  slug: string
  permissions: string[]
  revision: number
}

function isCloneSource(role: RoleRow): boolean {
  return role.permissions.every(isGrantablePermission)
}

export function RolesSection() {
  const queryClient = useQueryClient()
  const { data: roles = [], isLoading } = useQuery(queries.roles.list())
  const loadingRowCount = useLoadingShapeCount('settings:roles', isLoading ? undefined : roles.length, {
    fallbackCount: 4,
    maxCount: 10,
  })
  const [showCreate, setShowCreate] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createSlug, setCreateSlug] = useState('')
  const [createPermissions, setCreatePermissions] = useState<string[]>([])
  const [cloneSourceId, setCloneSourceId] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editPermissions, setEditPermissions] = useState<string[]>([])
  const createCardRef = useRef<HTMLDivElement>(null)
  const createNameRef = useRef<HTMLInputElement>(null)
  const createDraftRevisionRef = useRef(0)
  const cloneSources = roles.filter((role: RoleRow) => isCloneSource(role))

  function markCreateDraftChanged() {
    createDraftRevisionRef.current += 1
  }

  function seedCreateFrom(source?: RoleRow) {
    markCreateDraftChanged()
    setCloneSourceId(source?.id ?? '')
    setCreatePermissions(source ? [...source.permissions] : [])
  }

  function openCreate(source?: RoleRow) {
    createMutation.reset()
    setCreateName('')
    setCreateSlug('')
    seedCreateFrom(source)
    setShowCreate(true)
    requestAnimationFrame(() => {
      createCardRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
      createNameRef.current?.focus()
    })
  }

  function resetCreate() {
    createMutation.reset()
    setShowCreate(false)
    setCreateName('')
    setCreateSlug('')
    seedCreateFrom()
  }

  const createMutation = useMutation({
    mutationFn: (draft: CreateDraft) =>
      createRole({
        name: draft.name,
        slug: draft.slug,
        permissions: draft.permissions,
      }),
    onSuccess: (_role, submittedDraft) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.roles.all })
      if (submittedDraft.revision === createDraftRevisionRef.current) resetCreate()
    },
  })

  const updateMutation = useMutation({
    mutationFn: (id: string) =>
      updateRole(id, {
        name: editName || undefined,
        permissions: editPermissions,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.roles.all })
      setEditingId(null)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: deleteRole,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.roles.all })
      queryClient.invalidateQueries({ queryKey: queryKeys.auth.settings() })
    },
  })

  if (isLoading) {
    return <CollectionSkeleton label="Loading roles" count={loadingRowCount} />
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-lg font-semibold text-primary">Access Roles</h3>
          <p className="text-sm text-muted mt-1">Define roles with specific permissions.</p>
        </div>
        <button
          type="button"
          aria-label="Create role"
          onClick={() => (showCreate ? resetCreate() : openCreate())}
          className="ficus-button ficus-button-primary px-4 py-2 bg-accent text-on-accent rounded-md text-sm font-medium hover:bg-accent-hover"
        >
          Create Role
        </button>
      </div>

      {showCreate && (
        <div ref={createCardRef} className="ficus-section py-4">
          <h4 className="text-sm font-medium text-primary mb-3">Create New Role</h4>
          <div className="space-y-3">
            <div>
              <label htmlFor="create-role-clone-source" className="mb-1.5 block text-xs font-medium text-secondary">
                Clone from
              </label>
              <select
                id="create-role-clone-source"
                aria-describedby="create-role-clone-source-help"
                value={cloneSourceId}
                onChange={(event) => {
                  const source = cloneSources.find((role) => role.id === event.target.value)
                  seedCreateFrom(source)
                }}
                className="ficus-field w-full rounded border border-th-border bg-surface-secondary px-3 py-2 text-sm text-primary  focus:ring-1 focus:ring-accent"
              >
                <option value="">None — start with no permissions</option>
                {cloneSources.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name} ({role.slug})
                  </option>
                ))}
              </select>
              <p id="create-role-clone-source-help" className="mt-1 text-xs text-muted">
                Copies permissions only. Enter a new role name and slug.
              </p>
            </div>
            <label htmlFor="create-role-name" className="sr-only">
              Role name
            </label>
            <input
              ref={createNameRef}
              id="create-role-name"
              type="text"
              value={createName}
              onChange={(e) => {
                markCreateDraftChanged()
                setCreateName(e.target.value)
              }}
              placeholder="Role name"
              className="ficus-field w-full text-sm bg-surface-secondary border border-th-border rounded px-3 py-2 text-primary placeholder:text-placeholder  focus:ring-1 focus:ring-accent"
              autoFocus
            />
            <label htmlFor="create-role-slug" className="sr-only">
              Slug
            </label>
            <input
              id="create-role-slug"
              type="text"
              value={createSlug}
              onChange={(e) => {
                markCreateDraftChanged()
                setCreateSlug(e.target.value)
              }}
              placeholder="Slug (e.g. team-lead)"
              className="ficus-field w-full text-sm bg-surface-secondary border border-th-border rounded px-3 py-2 text-primary placeholder:text-placeholder  focus:ring-1 focus:ring-accent"
            />
            <div>
              <p className="text-xs font-medium text-secondary mb-1.5">Permissions</p>
              <PermissionPicker
                value={createPermissions}
                onChange={(permissions) => {
                  markCreateDraftChanged()
                  setCreatePermissions(permissions)
                }}
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={() =>
                  createMutation.mutate({
                    name: createName,
                    slug: createSlug,
                    permissions: [...createPermissions],
                    revision: createDraftRevisionRef.current,
                  })
                }
                disabled={!createName || !createSlug || createMutation.isPending}
                className="ficus-button ficus-button-primary px-4 py-2 bg-accent text-on-accent rounded-md text-sm font-medium hover:bg-accent-hover disabled:opacity-50"
              >
                {createMutation.isPending ? 'Creating...' : 'Create'}
              </button>
              <button onClick={resetCreate} className="ficus-button px-4 py-2 text-sm text-muted hover:text-primary">
                Cancel
              </button>
            </div>
            {createMutation.isError && (
              <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
                {(createMutation.error as Error)?.message || 'Failed to create role'}
              </p>
            )}
          </div>
        </div>
      )}

      <div className="ficus-section overflow-hidden">
        {roles.length === 0 ? (
          <div className="px-4 py-8 text-center text-muted text-sm">No roles defined yet.</div>
        ) : (
          <div className="divide-y divide-th-border">
            {roles.map((role: RoleRow) => (
              <div key={role.id} className="px-4 py-3">
                {editingId === role.id ? (
                  <div className="space-y-3">
                    <label htmlFor={`edit-role-name-${role.id}`} className="sr-only">
                      Role name
                    </label>
                    <input
                      id={`edit-role-name-${role.id}`}
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      placeholder="Role name"
                      className="ficus-field w-full text-sm bg-surface-secondary border border-th-border rounded px-3 py-2 text-primary placeholder:text-placeholder  focus:ring-1 focus:ring-accent"
                      autoFocus
                    />
                    <div>
                      <p className="text-xs font-medium text-secondary mb-1.5">Permissions</p>
                      <PermissionPicker value={editPermissions} onChange={setEditPermissions} />
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => updateMutation.mutate(role.id)}
                        disabled={updateMutation.isPending}
                        className="ficus-button ficus-button-primary text-xs bg-accent text-on-accent px-3 py-1.5 rounded font-medium hover:bg-accent-hover disabled:opacity-50"
                      >
                        {updateMutation.isPending ? 'Saving...' : 'Save'}
                      </button>
                      <button
                        onClick={() => setEditingId(null)}
                        className="ficus-button text-xs text-muted hover:text-primary px-3 py-1.5"
                      >
                        Cancel
                      </button>
                    </div>
                    {updateMutation.isError && (
                      <p role="alert" className="text-xs text-status-danger-600 dark:text-status-danger-400">
                        {(updateMutation.error as Error)?.message || 'Failed to update role'}
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-primary">{role.name}</span>
                        <span className="text-xs text-muted font-mono">({role.slug})</span>
                        {role.isSystem && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-status-progress-100 dark:bg-status-progress-900/30 text-status-progress-700 dark:text-status-progress-400">
                            System
                          </span>
                        )}
                        {role.readOnly && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-status-attention-100 dark:bg-status-attention-900/30 text-status-attention-700 dark:text-status-attention-400">
                            Read-only
                          </span>
                        )}
                      </div>
                      {role.permissions && role.permissions.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {role.permissions.map((perm: string) => (
                            <span
                              key={perm}
                              className="text-xs px-1.5 py-0.5 rounded bg-surface-secondary text-secondary font-mono"
                            >
                              {perm}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 shrink-0 sm:ml-4">
                      {(() => {
                        const canDuplicate = isCloneSource(role)
                        const reasonId = `duplicate-role-${role.id}-reason`
                        return (
                          <>
                            <button
                              type="button"
                              onClick={() => {
                                if (canDuplicate) openCreate(role)
                              }}
                              aria-disabled={!canDuplicate || undefined}
                              aria-label={`Duplicate role ${role.name}`}
                              aria-describedby={!canDuplicate ? reasonId : undefined}
                              title={
                                !canDuplicate
                                  ? 'Cannot duplicate: this role has permissions that cannot be assigned to a new role.'
                                  : undefined
                              }
                              className={clsx(
                                'ficus-button',
                                'text-xs font-medium text-accent-light hover:text-accent-hover',
                                !canDuplicate && 'cursor-not-allowed opacity-50'
                              )}
                            >
                              Duplicate
                            </button>
                            {!canDuplicate && (
                              <span id={reasonId} className="sr-only">
                                This role cannot be duplicated because one or more permissions cannot be assigned to a
                                new role.
                              </span>
                            )}
                          </>
                        )
                      })()}
                      {!role.readOnly && (
                        <>
                          <span className="text-muted">·</span>
                          <button
                            onClick={() => {
                              setEditingId(role.id)
                              setEditName(role.name)
                              setEditPermissions(role.permissions || [])
                            }}
                            className="ficus-button text-xs text-accent-light hover:text-accent-hover font-medium"
                          >
                            Edit
                          </button>
                        </>
                      )}
                      {!role.isSystem && !role.readOnly && (
                        <>
                          <span className="text-muted">·</span>
                          <button
                            onClick={() => {
                              if (confirm(`Delete role "${role.name}"?`)) {
                                deleteMutation.mutate(role.id)
                              }
                            }}
                            disabled={deleteMutation.isPending}
                            aria-label={`Delete role ${role.name}`}
                            className="ficus-button text-xs text-status-danger-600 dark:text-status-danger-400 hover:text-status-danger-800 dark:hover:text-status-danger-300 font-medium disabled:opacity-50"
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
