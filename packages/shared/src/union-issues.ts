import { z } from 'zod'

/**
 * Readable messages for failed unions.
 *
 * Zod reports a failed union as one `invalid_union` issue ("Invalid input") and hides the
 * member errors in `errors`, so a wrong `kind` reads the same as a missing field. These
 * helpers pick the member the input meant (by its discriminator literal, or by a field only
 * that member has) and describe that member's issues with their field paths, for example
 * `human-approval step: output is required`. When no member matches they list the valid kinds.
 *
 * Messages only change wording: the issue code, path and what validates stay the same.
 * Text taken from the input (unknown field names, record keys such as outcome names, an
 * unknown kind) is always single-quoted, so callers that must not echo input can redact it.
 */

type Path = PropertyKey[]
type Issue = z.core.$ZodIssue
type RawIssue = z.core.$ZodRawIssue

/** Remove wrappers that do not change a value's shape: defaults, optionals, preprocess, transforms and lazies. */
export function unwrapZodSchema(schema: z.ZodType): z.ZodType {
  for (;;) {
    if (
      schema instanceof z.ZodDefault ||
      schema instanceof z.ZodPrefault ||
      schema instanceof z.ZodOptional ||
      schema instanceof z.ZodNullable ||
      schema instanceof z.ZodNonOptional ||
      schema instanceof z.ZodReadonly ||
      schema instanceof z.ZodCatch
    )
      schema = schema.unwrap() as z.ZodType
    // z.preprocess(fn, s) is pipe(transform, s); s.transform(fn) is pipe(s, transform).
    else if (schema instanceof z.ZodPipe)
      schema = (schema.in instanceof z.ZodTransform ? schema.out : schema.in) as z.ZodType
    else if (schema instanceof z.ZodLazy) schema = schema.unwrap() as z.ZodType
    else return schema
  }
}

function objectShape(schema: z.ZodType): z.ZodRawShape | undefined {
  const inner = unwrapZodSchema(schema)
  return inner instanceof z.ZodObject ? (inner.shape as z.ZodRawShape) : undefined
}

/** The literal a union member requires for its discriminator, e.g. `human-approval` for a step's `kind`. */
export function discriminatorLiteral(option: z.ZodType, discriminator: string): string | undefined {
  const field = objectShape(option)?.[discriminator]
  const literal = field && unwrapZodSchema(field as z.ZodType)
  return literal instanceof z.ZodLiteral && typeof literal.value === 'string' ? literal.value : undefined
}

function unionOptions(schema: z.ZodType): readonly z.ZodType[] | undefined {
  return schema instanceof z.ZodUnion ? (schema.options as readonly z.ZodType[]) : undefined
}

/** `steps[1].outcomes.'approved'.next`: schema field names as-is, input-chosen keys quoted. */
function describePath(schema: z.ZodType | undefined, path: Path): string {
  let text = ''
  for (const part of path) {
    const node = schema && unwrapZodSchema(schema)
    if (typeof part === 'number') {
      text += `[${part}]`
      schema = node instanceof z.ZodArray ? (node.element as z.ZodType) : undefined
      continue
    }
    const key = String(part)
    const shape = node && objectShape(node)
    const option = node && unionOptions(node)?.find((candidate) => objectShape(candidate)?.[key])
    const field = shape?.[key] ?? (option && objectShape(option)?.[key])
    if (field) {
      text += text ? `.${key}` : key
      schema = field as z.ZodType
    } else {
      text += text ? `.'${key}'` : `'${key}'`
      schema = node instanceof z.ZodRecord ? (node.valueType as z.ZodType) : undefined
    }
  }
  return text
}

const TYPE_NAMES: Record<string, string> = {
  object: 'an object',
  array: 'a list',
  string: 'text',
  number: 'a number',
  int: 'a whole number',
  integer: 'a whole number',
  boolean: 'true or false',
}

const SIZE_UNITS: Record<string, string> = { string: 'characters', array: 'items', set: 'items' }

function valueAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let current = root
  for (const part of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<PropertyKey, unknown>)[part]
  }
  return current
}

/** Whether the value an `invalid_type` issue is about was absent. Zod 4 issues carry no `received`. */
function isMissing(issue: Issue | RawIssue, message: string, context?: { root: unknown }): boolean {
  if (context) return valueAt(context.root, issue.path ?? []) === undefined
  if ('input' in issue) return issue.input === undefined
  return / received undefined$/.test(message)
}

/**
 * One issue as `<field> <problem>`, using only schema wording plus single-quoted input.
 * `field` is the already-described path relative to the reader's context; empty means the value itself.
 * `context.root` is the value `issue.path` is relative to; it tells a missing field from a wrong type.
 */
export function describeZodIssue(issue: Issue | RawIssue, field = '', context?: { root: unknown }): string {
  const subject = field || 'value'
  const message = issue.message ?? issue.code ?? 'Invalid input'
  switch (issue.code) {
    case 'invalid_type':
      return isMissing(issue, message, context)
        ? `${subject} is required`
        : `${subject} must be ${TYPE_NAMES[issue.expected] ?? issue.expected}`
    case 'invalid_value':
      return issue.values.length === 1
        ? `${subject} must be ${JSON.stringify(issue.values[0])}`
        : `${subject} must be one of: ${issue.values.map(String).join(', ')}`
    case 'invalid_union': {
      // A discriminated union with no member for the given discriminator lists the valid values.
      const options = (issue as { options?: unknown }).options
      if (issue.errors.length === 0 && Array.isArray(options))
        return `${subject} must be one of: ${options.map(String).join(', ')}`
      return field ? `${field}: ${message}` : message
    }
    case 'too_small':
    case 'too_big': {
      const limit = issue.code === 'too_small' ? issue.minimum : issue.maximum
      const bound = issue.code === 'too_small' ? 'at least' : 'at most'
      const unit = SIZE_UNITS[issue.origin]
      return unit ? `${subject} must have ${bound} ${limit} ${unit}` : `${subject} must be ${bound} ${limit}`
    }
    case 'unrecognized_keys': {
      const keys = issue.keys.map((key) => `'${key}'`).join(', ')
      return `${field ? `${field} has ` : ''}unknown field${issue.keys.length === 1 ? '' : 's'} ${keys}`
    }
    default:
      return field ? `${field}: ${message}` : message
  }
}

function samePath(a: readonly PropertyKey[], b: readonly PropertyKey[]) {
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
  options: readonly z.ZodType[],
  issue: RawIssue,
  data: unknown = issue.input,
  { discriminator, label = 'value' }: UnionExplanationOptions = {}
): string | undefined {
  if (issue.code !== 'invalid_union') return undefined
  // Member issues have paths relative to the union.
  const memberIssues = issue.errors
  if (!data || typeof data !== 'object' || Array.isArray(data))
    return `each ${label} must be an object${discriminator ? ` with a ${discriminator}` : ''}`
  const record = data as Record<string, unknown>

  let selected: number
  if (discriminator) {
    // The member whose discriminator accepted the input (after defaults) is the one meant.
    selected = memberIssues.findIndex((member) => !member.some((inner) => samePath(inner.path, [discriminator])))
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
  const details = memberIssues[selected]!.map((inner) =>
    describeZodIssue(inner, describePath(member, inner.path), { root: data })
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
export function explainedUnion<const T extends readonly [z.ZodType, z.ZodType, ...z.ZodType[]]>(
  options: T,
  explanation: UnionExplanationOptions
) {
  return z.union(options, {
    // Returning undefined keeps zod's default message.
    error: (issue) => explainUnionIssue(options, issue, issue.input, explanation),
  })
}
