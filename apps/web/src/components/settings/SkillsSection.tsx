import { CatalogSearch } from './CatalogSearch'
import { Modal } from '../Modal'
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queries } from '../../queryOptions'
import { queryKeys } from '../../queryKeys'
import {
  createSkill,
  deleteSkill,
  disableSkill,
  enableSkill,
  exportSkillMarkdown,
  importSkill,
  revertSkill,
  revertSkillFields,
  updateSkill,
  type SkillConfig,
} from '../../api/config'
import { TemplateDiffDialog } from './TemplateDiffDialog'
import { TemplateFieldActions } from './TemplateFieldActions'
import { usePermissions } from '../../hooks/usePermissions'
import { useLoadingShapeCount } from '../../hooks/useLoadingShapeCount'
import { CollectionSkeleton } from '../loading/Skeleton'

export function SkillsSection() {
  const queryClient = useQueryClient()
  const { data: skills = [], isLoading } = useQuery(queries.skills.list())
  const loadingCardCount = useLoadingShapeCount('settings:skills', isLoading ? undefined : skills.length, {
    fallbackCount: 5,
    maxCount: 10,
  })
  const [editing, setEditing] = useState<Partial<SkillConfig> | null>(null)
  const [importContent, setImportContent] = useState('')
  const [diffId, setDiffId] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [search, setSearch] = useState('')
  const [importing, setImporting] = useState(false)
  const filteredSkills = [...skills]
    .filter((skill) =>
      `${skill.name} ${skill.id} ${skill.description ?? ''}`.toLowerCase().includes(search.trim().toLowerCase())
    )
    .sort((a, b) => a.name.localeCompare(b.name))
  const { can, isLoading: permissionsLoading } = usePermissions()
  const canWriteSkills = !permissionsLoading && can('skills:write')
  const diffQuery = useQuery({ ...queries.skills.templateDiff(diffId ?? ''), enabled: !!diffId })
  const editingTemplateId =
    editing?.id && skills.some((skill) => skill.id === editing.id && skill.hasTemplate) ? editing.id : ''
  const editingDiffQuery = useQuery({ ...queries.skills.templateDiff(editingTemplateId), enabled: !!editingTemplateId })
  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.skills.all })

  const save = useMutation({
    mutationFn: (skill: Partial<SkillConfig>) =>
      skill.id && skills.some((s) => s.id === skill.id)
        ? updateSkill(skill.id, skill)
        : createSkill({
            id: skill.id ?? '',
            name: skill.name ?? '',
            content: skill.content ?? '',
            description: skill.description,
            supportFiles: skill.supportFiles ?? {},
          }),
    onSuccess: () => {
      setEditing(null)
      invalidate()
    },
  })
  const importer = useMutation({
    mutationFn: () => importSkill({ content: importContent }),
    onSuccess: () => {
      setImportContent('')
      setImporting(false)
      invalidate()
    },
  })
  const remove = useMutation({ mutationFn: deleteSkill, onSuccess: invalidate })
  const toggle = useMutation({
    mutationFn: (skill: SkillConfig) => (skill.disabled ? enableSkill(skill.id) : disableSkill(skill.id)),
    onSuccess: invalidate,
  })
  const revert = useMutation({
    mutationFn: (id: string) => revertSkill(id),
    onSuccess: () => {
      setDiffId(null)
      invalidate()
    },
  })

  const revertFields = useMutation({
    mutationFn: ({ id, fields }: { id: string; fields: string[] }) => revertSkillFields(id, fields),
    onSuccess: (_data, variables) => {
      invalidate()
      queryClient.invalidateQueries({ queryKey: queryKeys.skills.templateDiff(variables.id) })
      if (diffId) queryClient.invalidateQueries({ queryKey: queryKeys.skills.templateDiff(diffId) })
    },
  })

  const editingSkill = editing?.id ? skills.find((skill) => skill.id === editing.id) : null

  useEffect(() => {
    if (!editing?.id || !editingSkill) return
    setEditing({ ...editingSkill, supportFiles: editingSkill.supportFiles ?? {} })
  }, [editing?.id, editingSkill])

  const skillFieldActions = (field: string) =>
    editingSkill?.hasTemplate ? (
      <TemplateFieldActions
        field={field}
        current={editingDiffQuery.data?.current ?? null}
        template={editingDiffQuery.data?.template ?? null}
        fieldOverrides={editingDiffQuery.data?.fieldOverrides ?? editingSkill.yamlFieldOverrides}
        onRevert={(field) => canWriteSkills && revertFields.mutate({ id: editingSkill.id, fields: [field] })}
        isReverting={revertFields.isPending}
      />
    ) : null

  function editSkill(skill: Partial<SkillConfig>) {
    setEditing({ ...skill, supportFiles: skill.supportFiles ?? {} })
    save.reset()
  }

  function updateSupportFilePath(oldPath: string, newPath: string) {
    const supportFiles = { ...(editing?.supportFiles ?? {}) }
    const content = supportFiles[oldPath] ?? ''
    delete supportFiles[oldPath]
    supportFiles[newPath] = content
    setEditing({ ...editing, supportFiles })
  }

  function updateSupportFileContent(path: string, content: string) {
    setEditing({ ...editing, supportFiles: { ...(editing?.supportFiles ?? {}), [path]: content } })
  }

  function addSupportFile() {
    const supportFiles = editing?.supportFiles ?? {}
    let path = 'support.md'
    let index = 2
    while (path in supportFiles) {
      path = `support-${index}.md`
      index += 1
    }
    setEditing({ ...editing, supportFiles: { ...supportFiles, [path]: '' } })
  }

  function removeSupportFile(path: string) {
    const supportFiles = { ...(editing?.supportFiles ?? {}) }
    delete supportFiles[path]
    setEditing({ ...editing, supportFiles })
  }

  async function exportMarkdown(id: string) {
    try {
      await navigator.clipboard.writeText(await exportSkillMarkdown(id))
      setMessage('Markdown copied to clipboard')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Export failed')
    }
  }

  if (isLoading) return <CollectionSkeleton label="Loading skills" count={loadingCardCount} layout="cards" />

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-primary">Skills</h3>
          <p className="text-sm text-muted mt-1">Give agents reusable instructions and resources for specific tasks.</p>
        </div>
        {canWriteSkills && (
          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => setImporting(true)}
              className="ficus-button ficus-button-secondary px-3 py-1.5 text-sm"
            >
              Import
            </button>
            <button
              className="ficus-button ficus-button-primary px-3 py-1.5 text-sm rounded-md"
              onClick={() =>
                editSkill({
                  id: '',
                  name: '',
                  content: '# New Skill\n\nDescribe when to use this skill.',
                  supportFiles: {},
                })
              }
            >
              New skill
            </button>
          </div>
        )}
      </div>

      {message && <div className="text-sm text-muted">{message}</div>}

      {canWriteSkills && importing && (
        <Modal isOpen onClose={() => setImporting(false)} title="Import skill" maxWidth="wide">
          <div
            className="space-y-4"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation()
                setImporting(false)
              }
            }}
          >
            <h4 className="text-sm font-medium text-primary">Import Markdown</h4>
            <textarea
              className="ficus-field w-full min-h-24 px-3 py-2 font-mono text-sm bg-input border border-th-border"
              placeholder="# Skill Name\n\nSkill content..."
              value={importContent}
              onChange={(e) => setImportContent(e.target.value)}
            />
            <button
              className="ficus-button ficus-button-primary px-3 py-1.5 text-sm rounded-md disabled:opacity-50"
              disabled={!importContent.trim() || importer.isPending}
              onClick={() => importer.mutate()}
            >
              {importer.isPending ? 'Importing…' : 'Import Markdown'}
            </button>
            {importer.isError && (
              <span className="ml-2 text-xs text-status-danger-600 dark:text-status-danger-400">
                {(importer.error as Error).message}
              </span>
            )}
          </div>
        </Modal>
      )}

      {canWriteSkills && editing && (
        <Modal
          isOpen
          onClose={() => setEditing(null)}
          title={editingSkill ? `Edit ${editingSkill.name}` : 'New skill'}
          maxWidth="wide"
        >
          <form
            className="space-y-5"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation()
                setEditing(null)
              }
            }}
            onSubmit={(event) => {
              event.preventDefault()
              save.mutate(editing)
            }}
          >
            <input
              className="ficus-field w-full px-3 py-2 bg-input border border-th-border"
              aria-label="Skill ID"
              required
              placeholder="skill-id"
              value={editing.id ?? ''}
              onChange={(e) => setEditing({ ...editing, id: e.target.value })}
              disabled={skills.some((s) => s.id === editing.id)}
            />
            <div>
              <label className="text-xs text-muted flex items-center gap-2 mb-1">
                <span>Name</span>
                {skillFieldActions('name')}
              </label>
              <input
                className="ficus-field w-full px-3 py-2 bg-input border border-th-border"
                aria-label="Name"
                required
                placeholder="Name"
                value={editing.name ?? ''}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </div>
            <div>
              <label className="text-xs text-muted flex items-center gap-2 mb-1">
                <span>Description</span>
                {skillFieldActions('description')}
              </label>
              <input
                className="ficus-field w-full px-3 py-2 bg-input border border-th-border"
                aria-label="Description"
                placeholder="Description"
                value={editing.description ?? ''}
                onChange={(e) => setEditing({ ...editing, description: e.target.value })}
              />
            </div>
            <div>
              <label className="text-xs text-muted flex items-center gap-2 mb-1">
                <span>Content</span>
                {skillFieldActions('content')}
              </label>
              <textarea
                className="ficus-field w-full min-h-64 px-3 py-2 font-mono text-sm bg-input border border-th-border"
                aria-label="Content"
                required
                value={editing.content ?? ''}
                onChange={(e) => setEditing({ ...editing, content: e.target.value })}
              />
            </div>

            <div className="border-b border-panel-border last:border-b-0 space-y-3 p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h4 className="text-sm font-medium text-primary flex items-center gap-2">
                    <span>Support files</span>
                    {skillFieldActions('supportFiles')}
                  </h4>
                  <p className="text-xs text-muted">Additional files materialized beside SKILL.md.</p>
                </div>
                <button
                  type="button"
                  className="ficus-button ficus-button-secondary px-3 py-1.5 text-sm rounded-md"
                  onClick={addSupportFile}
                >
                  Add file
                </button>
              </div>
              {Object.entries(editing.supportFiles ?? {}).length === 0 ? (
                <div className="text-sm text-muted">No support files.</div>
              ) : (
                Object.entries(editing.supportFiles ?? {}).map(([path, content]) => (
                  <div key={path} className="space-y-2 rounded-md bg-background p-3">
                    <div className="flex items-center gap-2">
                      <input
                        className="ficus-field flex-1 px-3 py-2 font-mono text-sm bg-input border border-th-border"
                        placeholder="helper.md"
                        value={path}
                        onChange={(e) => updateSupportFilePath(path, e.target.value)}
                      />
                      <button
                        type="button"
                        className="ficus-button ficus-button-danger px-2 py-1 text-sm"
                        onClick={() => removeSupportFile(path)}
                      >
                        Remove
                      </button>
                    </div>
                    <textarea
                      className="ficus-field w-full min-h-32 px-3 py-2 font-mono text-sm bg-input border border-th-border"
                      value={content}
                      onChange={(e) => updateSupportFileContent(path, e.target.value)}
                    />
                  </div>
                ))
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                className="ficus-button ficus-button-primary px-3 py-1.5 text-sm rounded-md"
                disabled={save.isPending}
              >
                Save
              </button>
              <button
                type="button"
                className="ficus-button ficus-button-secondary px-3 py-1.5 text-sm rounded-md"
                onClick={() => setEditing(null)}
              >
                Cancel
              </button>
              {save.isError && (
                <span className="text-xs text-status-danger-600 dark:text-status-danger-400">
                  {(save.error as Error).message}
                </span>
              )}
            </div>
          </form>
        </Modal>
      )}

      <CatalogSearch label="Search skills" placeholder="Find a skill…" value={search} onChange={setSearch} />
      <div className="space-y-3">
        {!filteredSkills.length && (
          <p className="py-8 text-center text-muted">
            {search ? 'No skills match your search.' : 'No skills configured.'}
          </p>
        )}
        {filteredSkills.map((skill) => (
          <article
            key={skill.id}
            className="min-w-0 rounded-xl border border-panel-border bg-surface p-4 flex flex-col sm:flex-row sm:items-start justify-between gap-3"
          >
            <div>
              <div className="font-semibold text-primary">{skill.name}</div>
              <div className="text-xs text-muted">
                {skill.id} {skill.hasTemplate ? '· default' : '· custom'}{' '}
                {skill.yamlFieldOverrides.length > 0 ? '· modified' : ''} {skill.disabled ? '· disabled' : ''}
              </div>
              {skill.description && <p className="text-sm text-secondary mt-1">{skill.description}</p>}
            </div>
            <div className="flex gap-2 shrink-0 flex-wrap justify-end">
              {canWriteSkills && (
                <button className="ficus-button ficus-button-link text-sm" onClick={() => editSkill(skill)}>
                  Edit
                </button>
              )}
              <button className="ficus-button ficus-button-link text-sm" onClick={() => exportMarkdown(skill.id)}>
                Export
              </button>
              {skill.hasTemplate && (
                <button className="ficus-button ficus-button-link text-sm" onClick={() => setDiffId(skill.id)}>
                  Diff
                </button>
              )}
              {canWriteSkills && (
                <button className="ficus-button ficus-button-link text-sm" onClick={() => toggle.mutate(skill)}>
                  {skill.disabled ? 'Enable' : 'Disable'}
                </button>
              )}
              {canWriteSkills && !skill.hasTemplate && (
                <button
                  className="ficus-button ficus-button-danger px-2 py-1 text-sm"
                  onClick={() => remove.mutate(skill.id)}
                >
                  Delete
                </button>
              )}
            </div>
          </article>
        ))}
      </div>

      <TemplateDiffDialog
        isOpen={!!diffId}
        onClose={() => setDiffId(null)}
        title={`Template Diff — ${diffId}`}
        current={diffQuery.data?.current ?? null}
        template={diffQuery.data?.template ?? null}
        onRevert={() => canWriteSkills && diffId && revert.mutate(diffId)}
        onRevertFields={(fields) => canWriteSkills && diffId && revertFields.mutate({ id: diffId, fields })}
        fieldOverrides={diffQuery.data?.fieldOverrides ?? []}
        isReverting={revert.isPending || revertFields.isPending}
      />
    </div>
  )
}
