import { z } from 'zod'

/**
 * Readable messages for failed unions.
 *
 * Zod reports a failed union as one `invalid_union` issue ("Invalid input") and hides the
 * member errors in `unionErrors`, so a wrong `kind` reads the same as a missing field. These
 * helpers pick the member the input meant (by its discriminator literal, or by a field only
 * that member has) and describe that member's issues with their field paths, for example
 * `human-approval step: output is required`. When no member matches they list the valid kinds.
 *
 * Messages only change wording: the issue code, path and what validates stay the same.
 * Text taken from the input (unknown field names, record keys such as outcome names, an
 * unknown kind) is always single-quoted, so callers that must not echo input can redact it.
 */

type Path = (string | number)[]

/** Remove wrappers that do not change a value's shape: defaults, optionals, preprocess and refinements. */
export function unwrapZodSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  for (;;) {
    if (schema instanceof z.ZodDefault || schema instanceof z.ZodOptional || schema instanceof z.ZodNullable)
      schema = schema._def.innerType
    else if (schema instanceof z.ZodEffects) schema = schema._def.schema
    else if (schema instanceof z.ZodLazy) schema = schema._def.getter()
    else return schema
  }
}

function objectShape(schema: z.ZodTypeAny): z.ZodRawShape | undefined {
  const inner = unwrapZodSchema(schema)
  return inner instanceof z.ZodObject ? (inner.shape as z.ZodRawShape) : undefined
}

/** The literal a union member requires for its discriminator, e.g. `human-approval` for a step's `kind`. */
export function discriminatorLiteral(option: z.ZodTypeAny, discriminator: string): string | undefined {
  const field = objectShape(option)?.[discriminator]
  const literal = field && unwrapZodSchema(field)
  return literal instanceof z.ZodLiteral && typeof literal.value === 'string' ? literal.value : undefined
}

function unionOptions(schema: z.ZodTypeAny): readonly z.ZodTypeAny[] | undefined {
  return schema instanceof z.ZodUnion || schema instanceof z.ZodDiscriminatedUnion ? schema.options : undefined
}

/** `steps[1].outcomes.'approved'.next`: schema field names as-is, input-chosen keys quoted. */
function describePath(schema: z.ZodTypeAny | undefined, path: Path): string {
  let text = ''
  for (const part of path) {
    const node = schema && unwrapZodSchema(schema)
    if (typeof part === 'number') {
      text += `[${part}]`
      schema = node instanceof z.ZodArray ? node.element : undefined
      continue
    }
    const shape = node && objectShape(node)
    const option = node && unionOptions(node)?.find((candidate) => objectShape(candidate)?.[part])
    const field = shape?.[part] ?? (option && objectShape(option)?.[part])
    if (field) {
      text += text ? `.${part}` : part
      schema = field
    } else {
      text += text ? `.'${part}'` : `'${part}'`
      schema = node instanceof z.ZodRecord ? node.valueSchema : undefined
    }
  }
  return text
}

const TYPE_NAMES: Record<string, string> = {
  object: 'an object',
  array: 'a list',
  string: 'text',
  number: 'a number',
  integer: 'a whole number',
  boolean: 'true or false',
}

const SIZE_UNITS: Record<string, string> = { string: 'characters', array: 'items', set: 'items' }

/**
 * One issue as `<field> <problem>`, using only schema wording plus single-quoted input.
 * `field` is the already-described path relative to the reader's context; empty means the value itself.
 */
export function describeZodIssue(issue: z.ZodIssue, field = ''): string {
  const subject = field || 'value'
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      return issue.received === 'undefined'
        ? `${subject} is required`
        : `${subject} must be ${TYPE_NAMES[issue.expected] ?? issue.expected}`
    case z.ZodIssueCode.invalid_literal:
      return `${subject} must be ${JSON.stringify(issue.expected)}`
    case z.ZodIssueCode.invalid_enum_value:
      return `${subject} must be one of: ${issue.options.join(', ')}`
    case z.ZodIssueCode.invalid_union_discriminator:
      return `${subject} must be one of: ${issue.options.map(String).join(', ')}`
    case z.ZodIssueCode.too_small:
    case z.ZodIssueCode.too_big: {
      const limit = issue.code === 'too_small' ? issue.minimum : issue.maximum
      const bound = issue.code === 'too_small' ? 'at least' : 'at most'
      const unit = SIZE_UNITS[issue.type]
      return unit ? `${subject} must have ${bound} ${limit} ${unit}` : `${subject} must be ${bound} ${limit}`
    }
    case z.ZodIssueCode.unrecognized_keys: {
      const keys = issue.keys.map((key) => `'${key}'`).join(', ')
      return `${field ? `${field} has ` : ''}unknown field${issue.keys.length === 1 ? '' : 's'} ${keys}`
    }
    default:
      return field ? `${field}: ${issue.message}` : issue.message
  }
}

function samePath(a: Path, b: Path) {
  return a.length === b.length && a.every((part, index) => part === b[index])
}

export interface UnionExplanationOptions {
  /** Field whose literal selects the member, e.g. `kind`. Without one, a field only one member has selects it. */
  discriminator?: string
  /** Noun for the value, e.g. `step` gives `human-approval step: …`. */
  label?: string
}

/**
 * Explain a failed union over `options` for `data`. Returns undefined when the issue is not a
 * union failure, so the default message applies.
 */
export function explainUnionIssue(
  options: readonly z.ZodTypeAny[],
  issue: z.ZodIssueOptionalMessage,
  data: unknown,
  { discriminator, label = 'value' }: UnionExplanationOptions = {}
): string | undefined {
  if (issue.code !== z.ZodIssueCode.invalid_union) return undefined
  if (!data || typeof data !== 'object' || Array.isArray(data))
    return `each ${label} must be an object${discriminator ? ` with a ${discriminator}` : ''}`
  const record = data as Record<string, unknown>

  let selected: number
  if (discriminator) {
    // The member whose discriminator accepted the input (after defaults) is the one meant.
    const at = [...issue.path, discriminator]
    selected = issue.unionErrors.findIndex((error) => !error.issues.some((inner) => samePath(inner.path, at)))
    if (selected === -1) {
      const kinds = options.map((option) => discriminatorLiteral(option, discriminator)).filter(Boolean)
      const given = record[discriminator]
      return typeof given === 'string'
        ? `unknown ${label} ${discriminator} '${given}'; use one of: ${kinds.join(', ')}`
        : `${discriminator} is required; use one of: ${kinds.join(', ')}`
    }
  } else {
    const shapes = options.map(objectShape)
    const keys = Object.keys(record)
    selected = shapes.findIndex(
      (shape, index) =>
        shape &&
        keys.some((key) => Object.hasOwn(shape, key) && shapes.every((other, i) => i === index || !other?.[key]))
    )
    if (selected === -1) {
      const forms = shapes.filter(Boolean).map((shape) => `{ ${Object.keys(shape!).join(', ')} }`)
      return `${label} must have one of these shapes: ${forms.join(' or ')}`
    }
  }

  const member = options[selected]!
  const details = issue.unionErrors[selected]!.issues.map((inner) =>
    describeZodIssue(inner, describePath(member, inner.path.slice(issue.path.length)))
  )
  const name = discriminator && discriminatorLiteral(member, discriminator)
  const defaulted = discriminator && record[discriminator] === undefined ? `, the default ${discriminator}` : ''
  const prefix = name ? `${name} ${label}${defaulted}` : label
  return `${prefix}: ${details.join('; ')}`
}

/**
 * `z.union` whose failure message names the member the input meant and that member's problems.
 * Parsing behaves exactly like `z.union(options)`.
 */
export function explainedUnion<const T extends readonly [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]>(
  options: T,
  explanation: UnionExplanationOptions
) {
  return z.union(options, {
    errorMap: (issue, context) => ({
      message: explainUnionIssue(options, issue, context.data, explanation) ?? context.defaultError,
    }),
  })
}
