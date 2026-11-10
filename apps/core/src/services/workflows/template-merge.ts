/**
 * Field-level reconciliation between a shared workflow preset and its code template.
 *
 * A preset row stores the effective `description` and `definition` plus `yamlTemplate`, the
 * template the row was last reconciled with. When the code template changes, the sync merges
 * three versions: that stored template (the base the local edits were made against), the
 * current row (local edits) and the new template (code update). Each part changed on only one
 * side takes that side's value; a part changed on both sides keeps the local value and is
 * reported as a conflict. So a tier edit on one participant no longer holds back renamed steps
 * or new instructions elsewhere in the same preset.
 *
 * Merging and diffing work on a keyed tree: objects are compared key by key, the `steps` array
 * is keyed by step ID (with its order kept separately under {@link STEP_ORDER}), and every other
 * array is one value. Paths are `/`-joined segments, for example
 * `definition/participants/engineer/tier` or `definition/steps/implement/instructions`.
 */
import { workflowPresetSchema, type WorkflowDefinition } from '@ficus/shared'

/** Path segment that holds the step order inside the keyed `steps` node. Never a valid step ID. */
export const STEP_ORDER = '@order'

/** The preset fields that the code template owns. `id` and `scope` never change through sync. */
export const TEMPLATE_FIELDS = ['description', 'definition'] as const
export type TemplateFields = { description?: unknown; definition?: unknown }

export interface WorkflowTemplateDifference {
  /** `/`-joined path into the preset, for selective restore. */
  path: string
  /** A readable name for the place that differs, such as "Step implement: instructions". */
  label: string
  /** The preset's current value; absent when only the code template has this part. */
  current?: unknown
  /** The code template's value; absent when only the preset has this part. */
  template?: unknown
}

export interface TemplateMergeResult {
  /** The merged `description` and `definition`. */
  merged: TemplateFields
  /** Paths changed both locally and in the code template; the local value was kept. */
  conflicts: string[]
}

type Tree = Record<string, unknown>

function isObject(value: unknown): value is Tree {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (isObject(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])])
    )
  return value
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a ?? null)) === JSON.stringify(sortKeys(b ?? null))
}

function stepId(step: unknown): string | undefined {
  return isObject(step) && typeof step.id === 'string' ? step.id : undefined
}

/** Key the definition's steps by ID so a change to one step does not touch the others. */
function toTree(fields: TemplateFields): Tree {
  const tree: Tree = { description: fields.description ?? undefined }
  if (!isObject(fields.definition)) {
    tree.definition = fields.definition
    return tree
  }
  const definition: Tree = { ...fields.definition }
  const steps = definition.steps
  if (Array.isArray(steps) && steps.every((step) => stepId(step) !== undefined)) {
    const keyed: Tree = { [STEP_ORDER]: steps.map((step) => stepId(step)!) }
    for (const step of steps) keyed[stepId(step)!] = step
    definition.steps = keyed
  }
  tree.definition = definition
  return tree
}

function fromTree(tree: Tree): TemplateFields {
  const definition = tree.definition
  if (!isObject(definition) || !isObject(definition.steps)) return compact(tree)
  const keyed = definition.steps
  const ids = Object.keys(keyed).filter((key) => key !== STEP_ORDER && keyed[key] !== undefined)
  const order = Array.isArray(keyed[STEP_ORDER]) ? (keyed[STEP_ORDER] as string[]) : []
  const ordered = [...new Set(order)].filter((id) => ids.includes(id))
  for (const id of ids) if (!ordered.includes(id)) ordered.push(id)
  return compact({ ...tree, definition: { ...definition, steps: ordered.map((id) => keyed[id]) } })
}

/** Drop keys whose merged value is absent, recursively, so removals do not leave `undefined`. */
function compact<T>(value: T): T {
  if (Array.isArray(value)) return value.map(compact) as T
  if (!isObject(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, compact(item)])
  ) as T
}

/**
 * Merge the step order: take whichever side changed it; when both did, keep the local order and
 * insert steps that only the code template added after the step that precedes them there.
 */
function mergeOrder(base: unknown, local: unknown, theirs: unknown): unknown {
  if (same(local, theirs) || same(local, base)) return theirs
  if (same(theirs, base) || !Array.isArray(local) || !Array.isArray(theirs)) return local
  const result = [...(local as string[])]
  for (const id of theirs as string[]) insertInOrder(result, theirs as string[], id)
  return result
}

/** Insert `id` into `order` after the nearest step that precedes it in `reference`, if missing. */
function insertInOrder(order: string[], reference: readonly string[], id: string): void {
  if (order.includes(id)) return
  const index = reference.indexOf(id)
  const anchor = reference
    .slice(0, Math.max(index, 0))
    .reverse()
    .find((previous) => order.includes(previous))
  order.splice(anchor === undefined ? 0 : order.indexOf(anchor) + 1, 0, id)
}

function mergeNode(base: unknown, local: unknown, theirs: unknown, path: string[], conflicts: string[]): unknown {
  if (path[path.length - 1] === STEP_ORDER) return mergeOrder(base, local, theirs)
  if (same(local, theirs)) return local
  if (same(local, base)) return theirs
  if (same(theirs, base)) return local
  // Recurse only into a part both sides inherited. A part both sides added with different content
  // (such as a step with the same new ID) stays local as a whole, so no code fields leak into it.
  if (isObject(local) && isObject(theirs) && isObject(base)) {
    const merged: Tree = {}
    for (const key of new Set([...Object.keys(local), ...Object.keys(theirs), ...Object.keys(base)]))
      merged[key] = mergeNode(base[key], local[key], theirs[key], [...path, key], conflicts)
    return merged
  }
  conflicts.push(path.join('/'))
  return local
}

/**
 * Three-way merge of a preset's template-owned fields. Callers must validate the merged preset;
 * independent edits can still combine into an invalid graph.
 */
export function mergeWorkflowTemplate(base: TemplateFields, local: TemplateFields, theirs: TemplateFields) {
  const conflicts: string[] = []
  const merged = mergeNode(toTree(base), toTree(local), toTree(theirs), [], conflicts) as Tree
  return { merged: fromTree(merged), conflicts } satisfies TemplateMergeResult
}

function diffNode(current: unknown, template: unknown, path: string[], out: WorkflowTemplateDifference[]) {
  if (path[path.length - 1] === STEP_ORDER) {
    // Report order only among the steps both sides have; added and removed steps are listed themselves.
    const common = (ids: unknown, other: unknown) =>
      Array.isArray(ids) && Array.isArray(other) ? ids.filter((id) => other.includes(id)) : ids
    if (!same(common(current, template), common(template, current))) out.push(difference(path, current, template))
    return
  }
  if (same(current, template)) return
  if (isObject(current) && isObject(template)) {
    for (const key of new Set([...Object.keys(current), ...Object.keys(template)]))
      diffNode(current[key], template[key], [...path, key], out)
    return
  }
  out.push(difference(path, current, template))
}

function difference(path: string[], current: unknown, template: unknown): WorkflowTemplateDifference {
  return {
    path: path.join('/'),
    label: describeTemplatePath(path),
    ...(current === undefined ? {} : { current }),
    ...(template === undefined ? {} : { template }),
  }
}

/** Every place where the preset differs from its code template, at the merge's granularity. */
export function diffWorkflowTemplate(current: TemplateFields, template: TemplateFields): WorkflowTemplateDifference[] {
  const out: WorkflowTemplateDifference[] = []
  diffNode(toTree(current), toTree(template), [], out)
  return out
}

/** A readable name for a template path. */
export function describeTemplatePath(path: string[] | string): string {
  const parts = typeof path === 'string' ? path.split('/') : path
  const [field, section, key, ...rest] = parts
  if (field === 'description') return 'Description'
  if (field !== 'definition') return parts.join(' / ')
  const tail = rest.length ? `: ${rest.join(' / ')}` : ''
  if (section === undefined) return 'Definition'
  if (section === 'name' && key === undefined) return 'Name'
  if (section === 'participants' && key !== undefined) return `Participant ${key}${tail}`
  if (section === 'steps' && key === STEP_ORDER) return 'Step order'
  if (section === 'steps' && key !== undefined) return `Step ${key}${tail}`
  const label = section.charAt(0).toUpperCase() + section.slice(1)
  return key === undefined ? label : `${label}: ${[key, ...rest].join(' / ')}`
}

/**
 * Restore the given paths to the template's values and leave everything else as it is.
 * Throws when a path is not one of the current differences. The caller validates the result.
 */
export function restoreWorkflowTemplatePaths(
  current: TemplateFields,
  template: TemplateFields,
  paths: readonly string[]
): TemplateFields {
  const known = new Set(diffWorkflowTemplate(current, template).map((item) => item.path))
  const unknown = paths.filter((path) => !known.has(path))
  if (unknown.length) throw new Error(`These parts do not differ from the code template: ${unknown.join(', ')}`)
  const tree = toTree(current)
  const source = toTree(template)
  for (const path of paths) {
    const segments = path.split('/')
    let target = tree
    let from: unknown = source
    for (const segment of segments.slice(0, -1)) {
      from = isObject(from) ? from[segment] : undefined
      if (!isObject(target[segment])) target[segment] = {}
      target[segment] = { ...(target[segment] as Tree) }
      target = target[segment] as Tree
    }
    const last = segments[segments.length - 1]!
    target[last] = isObject(from) ? structuredClone(from[last]) : undefined
    // A restored step goes back to its place in the template order.
    const steps = (tree.definition as Tree | undefined)?.steps
    const templateOrder = ((source.definition as Tree | undefined)?.steps as Tree | undefined)?.[STEP_ORDER]
    if (
      segments.length === 3 &&
      segments[1] === 'steps' &&
      last !== STEP_ORDER &&
      isObject(steps) &&
      Array.isArray(templateOrder)
    ) {
      const order = Array.isArray(steps[STEP_ORDER]) ? [...(steps[STEP_ORDER] as string[])] : []
      if (target[last] !== undefined) insertInOrder(order, templateOrder as string[], last)
      steps[STEP_ORDER] = order
    }
  }
  return fromTree(tree)
}

/** Parse merged fields as a complete preset, so a broken graph is never stored. */
export function parseMergedPreset(
  id: string,
  fields: TemplateFields
): { description?: string; definition: WorkflowDefinition } {
  return workflowPresetSchema.parse({
    id,
    ...(typeof fields.description === 'string' ? { description: fields.description } : {}),
    definition: fields.definition,
  })
}
