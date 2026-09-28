import type { RoutingEvidence, RoutingRecommendation, SquadSuggestion, SuggestSquadResponse } from '@ficus/shared'
export type { SquadSuggestion, SuggestSquadResponse } from '@ficus/shared'
import { Squad } from '../../entities/Squad'
import { expandReadScope } from '../memory/access'
import { SearchService, type SearchResult } from '../memory/SearchService'

/**
 * Squad-suggestion primitive.
 *
 * Heuristic ranking of the squads a caller can see by likely relevance to a
 * free-text question. Used for "ask the right squad" UI hints and for the
 * consultant deciding whether to forward to another squad. It does NOT resolve
 * a channel's starting squad.
 */

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'this',
  'that',
  'are',
  'was',
  'has',
  'have',
  'how',
  'why',
  'what',
  'who',
  'where',
  'when',
  'can',
  'should',
  'into',
  'from',
])

function normalizeToken(token: string): string {
  if (token.length > 5 && token.endsWith('ing')) return token.slice(0, -3).replace(/e$/, '')
  if (token.length > 3 && token.endsWith('s')) return token.slice(0, -1)
  if (token.length > 4 && token.endsWith('e')) return token.slice(0, -1)
  return token
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token))
    .map(normalizeToken)
}

/**
 * Fraction of distinct meaningful query terms that appear in `text`.
 * Returns 0..1.
 */
export function scoreKeywordOverlap(query: string, text: string): number {
  const queryTerms = [...new Set(tokenize(query))]
  if (queryTerms.length === 0) return 0

  const haystack = new Set(tokenize(text))
  const matched = queryTerms.filter((term) => haystack.has(term)).length
  return matched / queryTerms.length
}

/**
 * The squads a caller may receive suggestions for: its own squad plus any squad
 * it can read memory from. Never returns a squad outside the caller's
 * permission envelope.
 */
export async function gatherCandidateSquadIds(callerSquadId: string): Promise<string[]> {
  const scopes = await expandReadScope(callerSquadId, {})
  const ids = new Set<string>([callerSquadId])
  for (const scope of scopes) ids.add(scope.squadId)
  return [...ids]
}

export interface SuggestSquadOptions {
  limit?: number
  /** Drop suggestions whose total score is below this (default 0.05). */
  minScore?: number
}

const WEIGHTS = { purpose: 0.4, memory: 0.4, ownership: 0.2 }
const EXPLICIT_OWNERSHIP_BOOST = 0.45

// Conservative defaults: route only when the heuristic has a meaningful signal,
// clarify on close races, and escalate when there is no candidate at all.
export const MIN_ROUTE_CONFIDENCE = 0.25
export const TIE_EPSILON = 0.05

function evidenceSource(hit: SearchResult) {
  return {
    sourceSquadId: hit.sourceSquadId,
    sourceType: hit.sourceType ?? 'unknown',
    path: hit.path,
    title: hit.title,
    snippet: hit.snippet,
  }
}

function topHitBySquad(results: SearchResult[]): Map<string, SearchResult> {
  const bySquad = new Map<string, SearchResult>()
  for (const result of results) setBestHit(bySquad, result.sourceSquadId, result)
  return bySquad
}

function setBestHit(bySquad: Map<string, SearchResult>, squadId: string, hit: SearchResult): void {
  const prev = bySquad.get(squadId)
  if (!prev || hit.score > prev.score) bySquad.set(squadId, hit)
}

function ownershipOwnerIds(hit: SearchResult, candidateIds: Set<string>): string[] {
  const squadIds = hit.frontmatter?.squadIds
  if (!Array.isArray(squadIds)) return []

  return squadIds.filter((id): id is string => typeof id === 'string' && candidateIds.has(id))
}

function topOwnershipHitByOwner(results: SearchResult[], candidateIds: Set<string>): Map<string, SearchResult> {
  const byOwner = new Map<string, SearchResult>()

  for (const result of results) {
    setBestHit(byOwner, result.sourceSquadId, result)
    for (const ownerId of ownershipOwnerIds(result, candidateIds)) setBestHit(byOwner, ownerId, result)
  }

  return byOwner
}

function explicitOwnershipSquadIds(results: SearchResult[], candidateIds: Set<string>): Set<string> {
  const ids = new Set<string>()
  for (const result of results) {
    for (const ownerId of ownershipOwnerIds(result, candidateIds)) ids.add(ownerId)
  }
  return ids
}

function buildEvidence(
  squadId: string,
  purposeScore: number,
  memoryBySquad: Map<string, SearchResult>,
  ownershipBySquad: Map<string, SearchResult>,
  explicitOwnershipIds: Set<string>,
  memoryMax: number,
  ownershipMax: number
): RoutingEvidence[] {
  const evidence: RoutingEvidence[] = []

  if (purposeScore > 0) {
    evidence.push({
      kind: 'purpose',
      score: WEIGHTS.purpose * purposeScore,
      description: `Squad purpose matches the request (${purposeScore.toFixed(2)})`,
    })
  }

  const memHit = memoryBySquad.get(squadId)
  if (memHit) {
    const normalized = normalize(memHit.score, memoryMax)
    if (normalized > 0) {
      evidence.push({
        kind: 'memory',
        score: WEIGHTS.memory * normalized,
        source: evidenceSource(memHit),
        description: `Relevant memory in this squad (${normalized.toFixed(2)})`,
      })
    }
  }

  const ownHit = ownershipBySquad.get(squadId)
  if (ownHit) {
    const normalized = normalize(ownHit.score, ownershipMax)
    if (normalized > 0) {
      const explicitBoost = explicitOwnershipIds.has(squadId) ? EXPLICIT_OWNERSHIP_BOOST : 0
      evidence.push({
        kind: 'ownership',
        score: WEIGHTS.ownership * normalized + explicitBoost,
        source: evidenceSource(ownHit),
        description: explicitBoost
          ? `Explicit ownership doc names this squad (${normalized.toFixed(2)})`
          : `Matching ownership doc (${normalized.toFixed(2)})`,
      })
    }
  }

  return evidence
}

/** Normalize a raw search score into 0..1 relative to the best hit in the run. */
function normalize(value: number, max: number): number {
  if (max <= 0) return 0
  return Math.min(1, value / max)
}

export async function suggestSquad(
  callerSquadId: string,
  question: string,
  opts: SuggestSquadOptions = {}
): Promise<SquadSuggestion[]> {
  const limit = opts.limit ?? 3
  const minScore = opts.minScore ?? 0.05

  const candidateIds = await gatherCandidateSquadIds(callerSquadId)
  const squads = (await Promise.all(candidateIds.map((id) => Squad.find(id)))).filter(
    (squad): squad is Squad => squad !== null
  )
  if (squads.length === 0) return []

  const search = SearchService.instance()
  const [memoryHits, ownershipHits] = await Promise.all([
    search.search(callerSquadId, question, { limit: 20 }).catch(() => [] as SearchResult[]),
    search
      .search(callerSquadId, question, { limit: 20, paths: ['/memory/ownership/**'] })
      .catch(() => [] as SearchResult[]),
  ])

  const candidateIdSet = new Set(candidateIds)
  const memoryBySquad = topHitBySquad(memoryHits)
  const ownershipBySquad = topOwnershipHitByOwner(ownershipHits, candidateIdSet)
  const explicitOwnershipIds = explicitOwnershipSquadIds(ownershipHits, candidateIdSet)
  const memoryMax = Math.max(0, ...[...memoryBySquad.values()].map((hit) => hit.score))
  const ownershipMax = Math.max(0, ...[...ownershipBySquad.values()].map((hit) => hit.score))

  return squads
    .map((squad) => {
      const purposeScore = scoreKeywordOverlap(question, `${squad.name} ${squad.purpose ?? ''}`)
      const evidence = buildEvidence(
        squad.id,
        purposeScore,
        memoryBySquad,
        ownershipBySquad,
        explicitOwnershipIds,
        memoryMax,
        ownershipMax
      )
      const score = evidence.reduce((sum, item) => sum + item.score, 0)
      const reasons = evidence.map((item) => item.description)

      return { squadId: squad.id, squadName: squad.name, score, evidence, reasons }
    })
    .filter((suggestion) => suggestion.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

function recommendationFor(suggestions: SquadSuggestion[]): {
  recommendation: RoutingRecommendation
  confidence: number
  reason: string
} {
  const [top, second] = suggestions
  if (!top) {
    return {
      recommendation: 'escalate',
      confidence: 0,
      reason: 'No candidate squads matched the request strongly enough to route automatically.',
    }
  }

  if (top.score < MIN_ROUTE_CONFIDENCE) {
    return {
      recommendation: 'clarify',
      confidence: top.score,
      reason: `Top suggestion ${top.squadName} is below the routing confidence threshold (${top.score.toFixed(2)} < ${MIN_ROUTE_CONFIDENCE.toFixed(2)}).`,
    }
  }

  if (second && second.score >= MIN_ROUTE_CONFIDENCE && top.score - second.score < TIE_EPSILON) {
    return {
      recommendation: 'clarify',
      confidence: top.score,
      reason: `Top suggestions ${top.squadName} and ${second.squadName} are too close to choose confidently.`,
    }
  }

  return {
    recommendation: 'route',
    confidence: top.score,
    reason: `Top suggestion ${top.squadName} is the clear routing target.`,
  }
}

export async function suggestSquadWithRecommendation(
  callerSquadId: string,
  question: string,
  opts: SuggestSquadOptions = {}
): Promise<SuggestSquadResponse> {
  const suggestions = await suggestSquad(callerSquadId, question, opts)
  return { suggestions, ...recommendationFor(suggestions) }
}
