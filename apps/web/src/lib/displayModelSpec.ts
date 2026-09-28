import type { ThinkingLevel as SharedThinkingLevel } from '@ficus/shared'
type ThinkingLevel = SharedThinkingLevel | 'max'

const THINKING_LEVELS = new Set<ThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

export interface ParsedDisplayModelSpec {
  provider: string
  modelId: string
  thinkingLevel?: ThinkingLevel
}

export function parseDisplayModelSpec(modelSpec: string): ParsedDisplayModelSpec {
  const value = modelSpec.trim()
  const slashIndex = value.indexOf('/')
  const colonIndex = value.indexOf(':')
  const separatorIndex = colonIndex > 0 && (slashIndex < 0 || colonIndex < slashIndex) ? colonIndex : slashIndex

  if (separatorIndex <= 0) {
    return { provider: '', modelId: value }
  }

  const provider = value.slice(0, separatorIndex).trim().toLowerCase()
  let modelId = value.slice(separatorIndex + 1).trim()
  let thinkingLevel: ThinkingLevel | undefined

  const lastColonIndex = modelId.lastIndexOf(':')
  if (lastColonIndex > 0) {
    const suffix = modelId.slice(lastColonIndex + 1).trim()
    if (THINKING_LEVELS.has(suffix as ThinkingLevel)) {
      thinkingLevel = suffix as ThinkingLevel
      modelId = modelId.slice(0, lastColonIndex).trim()
    }
  }

  return { provider, modelId, thinkingLevel }
}

/**
 * Whether a model spec string is a comma-separated priority list (more than one
 * candidate). A single spec returns false.
 */
export function isModelPriorityList(modelSpec: string): boolean {
  return modelSpec.split(',').filter((s) => s.trim()).length > 1
}

/**
 * Split a (possibly comma-separated) model spec into a list of display specs,
 * preserving order. A single spec returns a one-element list.
 */
export function parseDisplayModelPriorityList(modelSpec: string): ParsedDisplayModelSpec[] {
  return modelSpec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseDisplayModelSpec)
}
