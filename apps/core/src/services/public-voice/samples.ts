import { DERIVATION_SURFACES, type DerivationFilters, type DerivationSurface } from '@ficus/shared'
import { DerivationError, type CollectedActivity, type RawActivityItem } from './github-activity'

/**
 * Cleans collected GitHub writing into samples for one derivation call:
 * strips code, quotes, comments and template checklists, redacts emails and
 * URLs, drops tool-authored, bot and template items, and interleaves the
 * surfaces up to a fixed budget. Pure; see design §4.10.
 */

export interface VoiceSample {
  id: number
  surface: DerivationSurface
  text: string
  repository: string
  isPrivate: boolean
  createdAt: string
}

export interface SamplingCounts {
  collected: number
  kept: number
  droppedByFilter: { date: number; repository: number }
  droppedAsToolAuthored: number
  droppedAsTemplate: number
}

export interface SamplingSummary {
  filters: DerivationFilters
  counts: SamplingCounts
  /** Per surface, the oldest and newest kept item (ISO dates). */
  dateRange: Partial<Record<DerivationSurface, { oldest: string; newest: string }>>
  publicRepositories: string[]
  privateRepositories: string[]
  pagingCapped: boolean
  /** The tool-authored filter is a heuristic; dates and repositories are the reliable filters. */
  toolAuthoredIsHeuristic: true
}

export const SAMPLE_TARGETS: Record<DerivationSurface, number> = {
  'pull-requests': 30,
  'issue-comments': 40,
  reviews: 30,
  commits: 30,
}
export const MAX_SAMPLES = 120
export const MAX_SAMPLE_INPUT_BYTES = 40_000
export const MAX_SAMPLE_CHARS = 1_200
export const MIN_SAMPLE_CHARS = 20
export const MIN_SAMPLES = 15

const ASSISTANT_COAUTHOR =
  /^co-authored-by:.*(claude|copilot|codex|cursor|devin|ficus|\[bot\]|noreply@anthropic\.com|gemini|chatgpt|openai)/im
const TOOL_MARKERS = [/generated (with|by)\b/i, /🤖/u, /this pull request was created by/i]
const BOT_TEMPLATE_MARKERS = [
  /\b(dependabot|renovate)\b/i,
  /^bumps? \S+ from \S+ to \S+/im,
  /<!--\s*(dependabot|renovate|release-please)/i,
]

/** Whether an item looks written by an assistant or a bot (heuristic). */
export function isToolAuthored(item: Pick<RawActivityItem, 'title' | 'text'>): boolean {
  const all = `${item.title ?? ''}\n${item.text}`
  return ASSISTANT_COAUTHOR.test(all) || TOOL_MARKERS.some((marker) => marker.test(all))
}

function isBotTemplate(item: Pick<RawActivityItem, 'title' | 'text'>): boolean {
  const all = `${item.title ?? ''}\n${item.text}`
  return BOT_TEMPLATE_MARKERS.some((marker) => marker.test(all))
}

/** Strip what is not the person's prose, and redact contact details and links. */
export function cleanSampleText(text: string): string {
  return (
    text
      .replace(/\r\n?/g, '\n')
      .replace(/```[\s\S]*?(```|$)/g, '')
      .replace(/~~~[\s\S]*?(~~~|$)/g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .split('\n')
      .filter((line) => !/^\s*>/.test(line))
      .filter((line) => !/^\s*[-*]\s+\[[ xX]\]/.test(line))
      .filter((line) => !/^\s*co-authored-by:/i.test(line) && !/^\s*signed-off-by:/i.test(line))
      .join('\n')
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
      .replace(/\bhttps?:\/\/[^\s)>\]]+/g, '<url>')
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}

function joinTitle(item: RawActivityItem, body: string): string {
  return item.title ? [item.title.trim(), body].filter(Boolean).join('\n\n') : body
}

/** Only headings and blank structure left: a template nobody filled in. */
function isOnlyStructure(text: string): boolean {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .every((line) => /^#{1,6}\s/.test(line) || /^[-*]\s*$/.test(line))
}

export function prepareSamples(
  collected: CollectedActivity,
  filters: DerivationFilters
): { samples: VoiceSample[]; summary: SamplingSummary } {
  const excludeToolAuthored = filters.excludeToolAuthored ?? true
  const counts: SamplingCounts = {
    collected: collected.items.length + collected.droppedByFilter.date + collected.droppedByFilter.repository,
    kept: 0,
    droppedByFilter: { ...collected.droppedByFilter },
    droppedAsToolAuthored: 0,
    droppedAsTemplate: 0,
  }

  const bySurface = new Map<DerivationSurface, Omit<VoiceSample, 'id'>[]>()
  for (const item of collected.items) {
    if (excludeToolAuthored && isToolAuthored(item)) {
      counts.droppedAsToolAuthored++
      continue
    }
    if (isBotTemplate(item)) {
      counts.droppedAsTemplate++
      continue
    }
    const cleaned = cleanSampleText(item.text)
    // A body that is only an unfilled template's headings contributes nothing.
    const body = cleaned && isOnlyStructure(cleaned) ? '' : cleaned
    const text = joinTitle(item, body)
    if (text.length < MIN_SAMPLE_CHARS || isOnlyStructure(text)) {
      counts.droppedAsTemplate++
      continue
    }
    const list = bySurface.get(item.surface) ?? []
    list.push({
      surface: item.surface,
      text: text.length > MAX_SAMPLE_CHARS ? `${text.slice(0, MAX_SAMPLE_CHARS).trimEnd()}…` : text,
      repository: item.repository,
      isPrivate: item.isPrivate,
      createdAt: item.createdAt,
    })
    bySurface.set(item.surface, list)
  }

  // Newest first within each surface, capped per surface, then interleaved.
  for (const [surface, list] of bySurface) {
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    bySurface.set(surface, list.slice(0, SAMPLE_TARGETS[surface]))
  }
  const samples: VoiceSample[] = []
  let bytes = 0
  const encoder = new TextEncoder()
  for (let index = 0; samples.length < MAX_SAMPLES; index++) {
    let any = false
    for (const surface of DERIVATION_SURFACES) {
      const next = bySurface.get(surface)?.[index]
      if (!next) continue
      any = true
      const size = encoder.encode(next.text).length
      if (bytes + size > MAX_SAMPLE_INPUT_BYTES || samples.length >= MAX_SAMPLES) continue
      bytes += size
      samples.push({ id: samples.length + 1, ...next })
    }
    if (!any) break
  }
  counts.kept = samples.length

  const dateRange: SamplingSummary['dateRange'] = {}
  for (const sample of samples) {
    const day = sample.createdAt.slice(0, 10)
    const range = dateRange[sample.surface]
    if (!range) dateRange[sample.surface] = { oldest: day, newest: day }
    else {
      if (day < range.oldest) range.oldest = day
      if (day > range.newest) range.newest = day
    }
  }
  const repos = (isPrivate: boolean) =>
    [...new Set(samples.filter((s) => s.isPrivate === isPrivate).map((s) => s.repository))].sort()

  const summary: SamplingSummary = {
    filters,
    counts,
    dateRange,
    publicRepositories: repos(false),
    privateRepositories: repos(true),
    pagingCapped: collected.pagingCapped,
    toolAuthoredIsHeuristic: true,
  }
  if (samples.length < MIN_SAMPLES) throw new DerivationError('derivation_too_few_samples', { counts, minimum: MIN_SAMPLES })
  return { samples, summary }
}
