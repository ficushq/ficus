/**
 * Squad relationship graph — connectivity, comms policy, BFS traversal.
 * Functions take the live Squad entity; the entity keeps thin delegates.
 */

import { and, eq, inArray, not, or } from 'drizzle-orm'
import { db, squadRelationships, squads } from '../../db'
import {
  SquadRelationship,
  SquadRelationshipSummary,
  SquadRelationshipType,
  SquadWithRelationships,
} from '@ficus/shared'
import { eventEmitter } from '../../lib/infra/event-emitter'
import type { Squad } from '../../entities/Squad'

const relationshipSummaryColumns = {
  id: squads.id,
  name: squads.name,
  purpose: squads.purpose,
  managerAgentId: squads.managerAgentId,
}

/**
 * Get this squad with all relationships categorized by type and direction.
 */
export async function withRelationships(squad: Squad): Promise<SquadWithRelationships> {
  const allRels = await squad.getRelationships()

  // Categorize relationships by type and direction
  const reportsTo: SquadRelationshipSummary[] = []
  const collaborates: SquadRelationshipSummary[] = []
  const dependsOn: SquadRelationshipSummary[] = []
  const reportedBy: SquadRelationshipSummary[] = []
  const dependedOnBy: SquadRelationshipSummary[] = []

  // Batch fetch all related squads to avoid N+1 queries
  const otherSquadIds = new Set<string>()
  for (const rel of allRels) {
    const otherId = rel.sourceSquadId === squad.id ? rel.targetSquadId : rel.sourceSquadId
    otherSquadIds.add(otherId)
  }

  const squadCache = new Map<string, SquadRelationshipSummary>()
  if (otherSquadIds.size > 0) {
    const relatedSquads = await db
      .select(relationshipSummaryColumns)
      .from(squads)
      .where(inArray(squads.id, [...otherSquadIds]))
    for (const relatedSquad of relatedSquads) squadCache.set(relatedSquad.id, relatedSquad)
  }

  for (const rel of allRels) {
    const isSource = rel.sourceSquadId === squad.id
    const otherId = isSource ? rel.targetSquadId : rel.sourceSquadId
    const otherSquad = squadCache.get(otherId)
    if (!otherSquad) continue

    switch (rel.relationshipType) {
      case 'reports_to':
        if (isSource) {
          reportsTo.push(otherSquad)
        } else {
          reportedBy.push(otherSquad)
        }
        break
      case 'collaborates':
        // Collaborates is bidirectional — both sides see each other
        collaborates.push(otherSquad)
        break
      case 'depends_on':
        if (isSource) {
          dependsOn.push(otherSquad)
        } else {
          dependedOnBy.push(otherSquad)
        }
        break
    }
  }

  await appendVirtualCollaborators(squad, collaborates)

  return {
    ...squad.toJson(),
    relationships: {
      reportsTo,
      collaborates,
      dependsOn,
      reportedBy,
      dependedOnBy,
    },
  }
}

/**
 * Append virtual collaborators created by the global collaboration setting.
 */
async function appendVirtualCollaborators(squad: Squad, collaborates: SquadRelationshipSummary[]): Promise<void> {
  const collaboratorIds = new Set(collaborates.map((s) => s.id))
  const conditions = [not(eq(squads.id, squad.id)), eq(squads.isAnonymous, false), eq(squads.status, 'active' as const)]

  if (!squad.globalCollaborationEnabled) {
    conditions.push(eq(squads.globalCollaborationEnabled, true))
  }

  const virtualCollaborators = await db
    .select(relationshipSummaryColumns)
    .from(squads)
    .where(and(...conditions))

  for (const collaborator of virtualCollaborators) {
    if (!collaboratorIds.has(collaborator.id)) {
      collaborates.push(collaborator)
      collaboratorIds.add(collaborator.id)
    }
  }
}

/**
 * Check if this squad can communicate with another squad.
 * Squads can communicate if they have any relationship, are the same squad,
 * or either squad has global collaboration enabled.
 */
export async function canCommunicateWith(squad: Squad, otherSquadId: string): Promise<boolean> {
  // Same squad can always communicate with itself
  if (squad.id === otherSquadId) return true

  const { Squad } = await import('../../entities/Squad')
  const otherSquad = await Squad.find(otherSquadId)
  if (!otherSquad) return false
  if (squad.globalCollaborationEnabled || otherSquad.globalCollaborationEnabled) return true

  const rels = await db
    .select()
    .from(squadRelationships)
    .where(
      or(
        and(eq(squadRelationships.sourceSquadId, squad.id), eq(squadRelationships.targetSquadId, otherSquadId)),
        and(eq(squadRelationships.sourceSquadId, otherSquadId), eq(squadRelationships.targetSquadId, squad.id))
      )
    )
    .limit(1)

  return rels.length > 0
}

/**
 * Get all squads connected to this squad via relationships.
 * Uses BFS traversal to find transitively connected squads.
 */
export async function getConnectedSquads(squad: Squad): Promise<Squad[]> {
  const { Squad } = await import('../../entities/Squad')
  const visited = new Set<string>()
  const queue = [squad.id]
  const result: Squad[] = []

  while (queue.length > 0) {
    const currentId = queue.shift()!
    if (visited.has(currentId)) continue
    visited.add(currentId)

    const current = await Squad.find(currentId)
    if (!current) continue

    result.push(current)

    // Get all related squads
    const rels = await current.getRelationships()
    for (const rel of rels) {
      const otherId = rel.sourceSquadId === currentId ? rel.targetSquadId : rel.sourceSquadId
      if (!visited.has(otherId)) {
        queue.push(otherId)
      }
    }
  }

  return result
}

/**
 * Add a relationship from this squad to another squad.
 * @param targetSquadId - The target squad ID.
 * @param relationshipType - The type of relationship.
 * @param metadata - Optional metadata for the relationship.
 * @throws Error if target squad doesn't exist or is the same as this squad.
 */
export async function addRelationship(
  squad: Squad,
  targetSquadId: string,
  relationshipType: SquadRelationshipType,
  metadata?: Record<string, unknown>
): Promise<SquadRelationship> {
  // Prevent self-relationships
  if (squad.id === targetSquadId) {
    throw new Error('A squad cannot have relationship with itself')
  }

  // Validate target squad exists
  const { Squad } = await import('../../entities/Squad')
  const target = await Squad.find(targetSquadId)
  if (!target) {
    throw new Error(`Target squad not found: ${targetSquadId}`)
  }

  const [rel] = await db
    .insert(squadRelationships)
    .values({
      sourceSquadId: squad.id,
      targetSquadId,
      relationshipType,
      metadata: metadata ?? {},
    })
    .returning()

  const mapped = mapRelationship(rel)
  eventEmitter.emit('squadRelationship.created', {
    relationshipId: mapped.id,
    sourceSquadId: mapped.sourceSquadId,
    targetSquadId: mapped.targetSquadId,
  })
  return mapped
}

/**
 * Remove relationship(s) between this squad and another squad.
 * @param targetSquadId - The target squad ID.
 * @param relationshipType - Optional filter by relationship type. If omitted, removes all relationships.
 */
export async function removeRelationship(
  squad: Squad,
  targetSquadId: string,
  relationshipType?: SquadRelationshipType
): Promise<void> {
  let condition = and(
    eq(squadRelationships.sourceSquadId, squad.id),
    eq(squadRelationships.targetSquadId, targetSquadId)
  )

  if (relationshipType) {
    condition = and(condition, eq(squadRelationships.relationshipType, relationshipType))
  }

  await db.delete(squadRelationships).where(condition!)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function mapRelationship(row: typeof squadRelationships.$inferSelect): SquadRelationship {
  return {
    id: row.id,
    sourceSquadId: row.sourceSquadId,
    targetSquadId: row.targetSquadId,
    relationshipType: row.relationshipType,
    metadata: row.metadata as Record<string, unknown>,
    createdAt: row.createdAt,
  }
}
