import { z } from 'zod'
import { discriminatorLiteral, unwrapZodSchema } from './union-issues'
import {
  WORKFLOW_RESERVED_IDS,
  workflowIdentifierSchema,
  workflowStepSchema,
  workflowTransitionSchema,
} from './workflows'

/**
 * A readable reference for workflow steps, generated from the zod schema so it cannot drift
 * from what validation accepts. `ficus workflow schema` prints it.
 */

export interface WorkflowSchemaField {
  name: string
  /** Allowed values, e.g. `assigned-reviewers | reviewers` or `text, 1–64000 characters`. */
  type: string
  default?: unknown
  description?: string
}

export interface WorkflowStepKindReference {
  kind: string
  description?: string
  required: WorkflowSchemaField[]
  optional: WorkflowSchemaField[]
}

export interface WorkflowSchemaOverview {
  kinds: { kind: string; description?: string }[]
  defaultKind?: string
  /** What an `ID` is: steps, participants and outcomes use it. */
  id: string
  /** The shapes an outcome's `transition` can take. */
  transitions: string[]
}

function range(min: number | undefined, max: number | undefined, unit: string) {
  if (min !== undefined && max !== undefined) return min === max ? `${min} ${unit}` : `${min}–${max} ${unit}`
  if (min !== undefined) return `at least ${min} ${unit}`
  if (max !== undefined) return `at most ${max} ${unit}`
  return undefined
}

/** The definitions of a schema's checks, e.g. `{ check: 'min_length', minimum: 1 }`. */
function checkDefs(schema: z.ZodType): z.core.$ZodCheckDef[] {
  return (schema._zod.def.checks ?? []).map((check) => check._zod.def)
}

function describeString(schema: z.ZodString) {
  let min: number | undefined
  let max: number | undefined
  let pattern: string | undefined
  for (const check of checkDefs(schema)) {
    if (check.check === 'min_length') min = (check as z.core.$ZodCheckMinLengthDef).minimum
    else if (check.check === 'max_length') max = (check as z.core.$ZodCheckMaxLengthDef).maximum
    else if (check.check === 'string_format') {
      const format = check as z.core.$ZodCheckStringFormatDef
      if (format.format === 'regex' && format.pattern) pattern = format.pattern.source
      else if (format.format === 'uuid') pattern = 'UUID'
    }
  }
  const length = range(min, max, 'characters')
  return [pattern ? (pattern === 'UUID' ? 'UUID' : `text matching ${pattern}`) : 'text', length]
    .filter(Boolean)
    .join(', ')
}

function describeNumber(schema: z.ZodNumber) {
  let min: number | undefined
  let max: number | undefined
  let integer = false
  for (const check of checkDefs(schema)) {
    if (check.check === 'greater_than') min = Number((check as z.core.$ZodCheckGreaterThanDef).value)
    else if (check.check === 'less_than') max = Number((check as z.core.$ZodCheckLessThanDef).value)
    else if (check.check === 'number_format') integer = true
  }
  return [integer ? 'whole number' : 'number', min !== undefined || max !== undefined ? range(min, max, '') : '']
    .filter(Boolean)
    .join(' ')
    .trim()
}

function describeArrayLength(schema: z.ZodArray) {
  let min: number | undefined
  let max: number | undefined
  for (const check of checkDefs(schema)) {
    if (check.check === 'min_length') min = (check as z.core.$ZodCheckMinLengthDef).minimum
    else if (check.check === 'max_length') max = (check as z.core.$ZodCheckMaxLengthDef).maximum
    else if (check.check === 'length_equals') min = max = (check as z.core.$ZodCheckLengthEqualsDef).length
  }
  return range(min, max, 'items')
}

/** `.describe()` text sits on whichever wrapper it was called on. */
function descriptionOf(schema: z.ZodType): string | undefined {
  let described: z.ZodType | undefined = schema
  while (described && !described.description)
    described =
      described instanceof z.ZodDefault || described instanceof z.ZodOptional
        ? (described.unwrap() as z.ZodType)
        : described instanceof z.ZodPipe
          ? ((described.in instanceof z.ZodTransform ? described.out : described.in) as z.ZodType)
          : undefined
  return described?.description
}

/**
 * `{ type: choice, instructions, options }`: literal fields show their value, optional ones a `?`.
 * With `types`, every field shows its allowed values.
 */
function describeObjectKeys(schema: z.ZodObject, depth: number, types = false) {
  const keys = Object.entries(schema.shape).map(([key, field]) => {
    const inner = unwrapZodSchema(field as z.ZodType)
    const label = (field as z.ZodType).isOptional() ? `${key}?` : key
    if (inner instanceof z.ZodLiteral) return `${key}: ${String(inner.value)}`
    return types ? `${label}: ${describeZodType(field as z.ZodType, depth + 1)}` : label
  })
  return `{ ${keys.join(', ')} }`
}

/**
 * Shared types the reference names instead of expanding; the overview explains each name.
 * Keyed by definition: `.describe()` returns a copy that shares its original's definition.
 */
let namedTypes: Map<z.core.$ZodTypeDef, string> | undefined
function typeName(schema: z.ZodType) {
  namedTypes ??= new Map([
    [unwrapZodSchema(workflowIdentifierSchema)._zod.def, 'ID'],
    [unwrapZodSchema(workflowTransitionSchema)._zod.def, 'transition'],
  ])
  return namedTypes.get(schema._zod.def)
}

/** Allowed values of a schema in one line; nested objects show their field names only. */
export function describeZodType(schema: z.ZodType, depth = 0): string {
  const inner = unwrapZodSchema(schema)
  const name = depth > 0 || schema !== workflowTransitionSchema ? typeName(inner) : undefined
  if (name) return name
  if (inner instanceof z.ZodString) return describeString(inner)
  if (inner instanceof z.ZodNumber) return describeNumber(inner)
  if (inner instanceof z.ZodBoolean) return 'true | false'
  if (inner instanceof z.ZodLiteral) return String(inner.value)
  if (inner instanceof z.ZodEnum) return (inner.options as string[]).join(' | ')
  if (inner instanceof z.ZodArray) {
    const length = describeArrayLength(inner)
    return `list of ${describeZodType(inner.element as z.ZodType, depth + 1)}${length ? ` (${length})` : ''}`
  }
  if (inner instanceof z.ZodRecord)
    return `map of ${describeZodType(inner.keyType as z.ZodType, depth + 1)} → ${describeZodType(inner.valueType as z.ZodType, depth + 1)}`
  if (inner instanceof z.ZodUnion)
    return (inner.options as z.ZodType[]).map((option) => describeZodType(option, depth + 1)).join(' | ')
  if (inner instanceof z.ZodObject) return describeObjectKeys(inner, depth)
  return inner._zod.def.type ?? 'value'
}

function stepOptions(): z.ZodType[] {
  return workflowStepSchema.options as unknown as z.ZodType[]
}

export function workflowStepKinds(): string[] {
  return stepOptions().flatMap((option) => discriminatorLiteral(option, 'kind') ?? [])
}

export function workflowSchemaOverview(): WorkflowSchemaOverview {
  const kinds = stepOptions().map((option) => ({
    kind: discriminatorLiteral(option, 'kind')!,
    description: option.description,
  }))
  const defaultKind = stepOptions()
    .map((option) => (unwrapZodSchema(option) as z.ZodObject).shape.kind)
    .find((field): field is z.ZodDefault => field instanceof z.ZodDefault)?._zod.def.defaultValue as string | undefined
  return {
    kinds,
    defaultKind,
    id: `${describeString(unwrapZodSchema(workflowIdentifierSchema) as z.ZodString)}; not ${WORKFLOW_RESERVED_IDS.join(', ')}`,
    transitions: (workflowTransitionSchema.options as readonly z.ZodType[]).map((option) =>
      describeObjectKeys(unwrapZodSchema(option) as z.ZodObject, 0, true)
    ),
  }
}

/** Fields of one step kind, or undefined for an unknown kind. */
export function workflowStepKindReference(kind: string): WorkflowStepKindReference | undefined {
  const option = stepOptions().find((candidate) => discriminatorLiteral(candidate, 'kind') === kind)
  if (!option) return undefined
  const reference: WorkflowStepKindReference = { kind, description: option.description, required: [], optional: [] }
  const shape = (unwrapZodSchema(option) as z.ZodObject).shape
  // The kind identifies the step, so it leads; the rest keep schema order.
  const names = ['kind', ...Object.keys(shape).filter((name) => name !== 'kind')]
  for (const [name, field] of names.map((name) => [name, shape[name]] as const)) {
    const schema = field as z.ZodType
    const entry: WorkflowSchemaField = { name, type: describeZodType(schema) }
    if (schema instanceof z.ZodDefault) entry.default = schema._zod.def.defaultValue
    const description = descriptionOf(schema)
    if (description) entry.description = description
    ;(schema.isOptional() ? reference.optional : reference.required).push(entry)
  }
  return reference
}

function sharedTypeLines(overview: WorkflowSchemaOverview) {
  return [`ID: ${overview.id}.`, 'transition: one of', ...overview.transitions.map((transition) => `  ${transition}`)]
}

function fieldLines(fields: WorkflowSchemaField[]) {
  const width = Math.max(...fields.map((field) => field.name.length))
  return fields.map((field) => {
    const notes = [
      field.type,
      field.default !== undefined ? `default: ${JSON.stringify(field.default)}` : '',
      field.description ?? '',
    ].filter(Boolean)
    return `  ${field.name.padEnd(width)}  ${notes.join('. ')}`
  })
}

/** Plain-text rendering of `workflowSchemaOverview()` or one kind's reference. */
export function formatWorkflowSchemaReference(kind?: string): string {
  if (kind === undefined) {
    const overview = workflowSchemaOverview()
    const width = Math.max(...overview.kinds.map((entry) => entry.kind.length))
    return [
      `Step kinds (the step's kind field${overview.defaultKind ? `; ${overview.defaultKind} when omitted` : ''}):`,
      ...overview.kinds.map((entry) => `  ${entry.kind.padEnd(width)}  ${entry.description ?? ''}`.trimEnd()),
      '',
      ...sharedTypeLines(overview),
      '',
      'Run ficus workflow schema <kind> for its required and optional fields.',
    ].join('\n')
  }
  const reference = workflowStepKindReference(kind)
  if (!reference) throw new Error(`Unknown step kind; use one of: ${workflowStepKinds().join(', ')}`)
  return [
    `${reference.kind} step${reference.description ? `: ${reference.description}` : ''}`,
    '',
    'Required:',
    ...fieldLines(reference.required),
    ...(reference.optional.length ? ['', 'Optional:', ...fieldLines(reference.optional)] : []),
    '',
    ...sharedTypeLines(workflowSchemaOverview()),
  ].join('\n')
}
