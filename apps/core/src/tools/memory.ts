/**
 * Memory Tools
 *
 * Agent tools for interacting with squad memory:
 * - memory_search: Search memory using hybrid retrieval
 * - memory_get: Read a memory file
 * - memory_write: Write (overwrite) a memory file
 * - memory_patch: Patch a memory file (exact match replacement)
 * - memory_append: Append content to a memory file
 * - memory_backlinks: Get documents that link to a given document
 * - memory_outline: Browse or search the map of folders, documents and headings
 */

import { Type } from '@sinclair/typebox'
import type { MemorySourceType } from '@ficus/shared'
import { AGENT_THREAD_SEARCH_ENABLED, DEFAULT_MEMORY_SEARCH_SOURCE_TYPES, MEMORY_SOURCE_TYPES } from '@ficus/shared'
import type { ToolDefinition, AgentToolResult } from '@earendil-works/pi-coding-agent'
import {
  WriteService,
  MemoryErrorCodes,
  MemoryWriteError,
  SearchService,
  IndexingService,
  OutlineService,
  findSections,
  formatTrail,
  outlineMarkdown,
  parseFrontmatter,
  sliceSection,
  type OutlineBrowse,
  type OutlineMatch,
  type OutlineSection,
} from '../services/memory'
import { Squad } from '../entities/Squad'
import { resolveSearchDefaults } from '../services/memory/access/defaults'
import { resolveWorkspaceLayout } from '../services/sandbox/workspace-layout'
import type { ScopeRequest } from '../services/memory/access/scope-expander'
import type { SensitivityTier } from '../services/memory/access/sensitivity'

export type MemoryToolWithKey = ToolDefinition & { key: string }

type MemorySearchSourceType = MemorySourceType

function resolveEnabledSearchSourceTypes(sourceTypes: MemorySearchSourceType[] | undefined): {
  sourceTypes: MemorySearchSourceType[] | undefined
  disabledOnly: boolean
} {
  if (AGENT_THREAD_SEARCH_ENABLED) {
    return { sourceTypes, disabledOnly: false }
  }

  const enabledSourceTypes = (sourceTypes ?? DEFAULT_MEMORY_SEARCH_SOURCE_TYPES).filter(
    (sourceType) => sourceType !== 'agent_thread'
  )

  return { sourceTypes: enabledSourceTypes, disabledOnly: enabledSourceTypes.length === 0 }
}

// --- TypeBox Schemas ---

const searchableSourceTypes = () =>
  Type.Array(
    Type.Union(
      MEMORY_SOURCE_TYPES.filter((sourceType) => AGENT_THREAD_SEARCH_ENABLED || sourceType !== 'agent_thread').map(
        (sourceType) => Type.Literal(sourceType)
      )
    ),
    {
      description: 'Filter by source types',
    }
  )

const SearchSchema = Type.Object({
  query: Type.String({
    description: 'Search query text. Semantic and keyword matching will be used.',
  }),
  limit: Type.Optional(
    Type.Number({
      description: 'Maximum number of results to return (default: 10)',
      minimum: 1,
      maximum: 50,
    })
  ),
  sourceTypes: Type.Optional(searchableSourceTypes()),
  kinds: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Filter by frontmatter kind (e.g., "decision", "pattern")',
    })
  ),
  tags: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Filter by frontmatter tags (matches if any tag present)',
    })
  ),
  paths: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Filter by path globs (e.g., "decisions/**", "patterns/*.md")',
    })
  ),
  sourceSquadIds: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Restrict to source squad IDs (own squad plus any granted squads).',
    })
  ),
  sensitivity: Type.Optional(
    Type.Union(
      [Type.Literal('public'), Type.Literal('internal'), Type.Literal('restricted'), Type.Literal('confidential')],
      {
        description: 'Maximum sensitivity tier to include in results.',
      }
    )
  ),
})

// The path-bearing schemas are factories over the RESOLVED memory root: the
// agent-facing root differs by runtime (`/memory/<squadId>` on k8s/docker, the
// squad box's `~/memory` on vm), so the param descriptions must show the root
// the calling agent actually sees. The container-literal form stays accepted
// at execution time (acceptedRoots back-compat) — only the description varies.
const memoryPathDescription = (memoryRoot: string) =>
  `Memory file path: ${memoryRoot}/<rel> or a bare squad-relative path (e.g. decisions/auth.md)`

const GetSchema = (memoryRoot: string) =>
  Type.Object({
    path: Type.String({ description: memoryPathDescription(memoryRoot) }),
    section: Type.Optional(
      Type.String({
        description:
          'Read only this section: a heading ("Rollout") or a heading trail from memory_outline ("Deploy > Rollout"). Includes its subsections.',
      })
    ),
    squad: Type.Optional(Type.String({ description: 'Squad id for the path (defaults to your squad).' })),
  })

const WriteSchema = (memoryRoot: string) =>
  Type.Object({
    path: Type.String({ description: memoryPathDescription(memoryRoot) }),
    content: Type.Union([Type.String(), Type.Null()], {
      description: 'Content to write to the file (replaces entire file). If null, deletes the file.',
    }),
    targetSquadId: Type.Optional(
      Type.String({
        format: 'uuid',
        description: 'Optional target squad ID for cross-squad writes granted by that squad.',
      })
    ),
    squad: Type.Optional(Type.String({ description: 'Squad id for the path (defaults to your squad).' })),
  })

const PatchSchema = (memoryRoot: string) =>
  Type.Object({
    path: Type.String({ description: memoryPathDescription(memoryRoot) }),
    match: Type.String({
      description: 'Exact text to find and replace (must appear exactly once, case-sensitive)',
    }),
    replacement: Type.String({
      description: 'Text to replace the match with',
    }),
    targetSquadId: Type.Optional(
      Type.String({
        format: 'uuid',
        description: 'Optional target squad ID for cross-squad writes granted by that squad.',
      })
    ),
    squad: Type.Optional(Type.String({ description: 'Squad id for the path (defaults to your squad).' })),
  })

const AppendSchema = (memoryRoot: string) =>
  Type.Object({
    path: Type.String({ description: memoryPathDescription(memoryRoot) }),
    content: Type.String({
      description: 'Content to append to the file',
    }),
    ensureNewline: Type.Optional(
      Type.Boolean({
        description: 'If true, ensures a newline before appending (default: false)',
      })
    ),
    targetSquadId: Type.Optional(
      Type.String({
        format: 'uuid',
        description: 'Optional target squad ID for cross-squad writes granted by that squad.',
      })
    ),
    squad: Type.Optional(Type.String({ description: 'Squad id for the path (defaults to your squad).' })),
  })

const OutlineSchema = (memoryRoot: string) =>
  Type.Object({
    path: Type.Optional(
      Type.String({
        description: `Folder or document to open: ${memoryRoot}/<rel>, a bare squad-relative path, or another indexed path such as /workspace/docs. Omit for the top level.`,
      })
    ),
    query: Type.Optional(
      Type.String({
        description:
          'Words to find in document titles, paths and section headings. Returns the matching sections instead of a listing.',
      })
    ),
    sourceTypes: Type.Optional(searchableSourceTypes()),
    sourceSquadIds: Type.Optional(
      Type.Array(Type.String(), {
        description: 'Restrict to source squad IDs (own squad plus any granted squads).',
      })
    ),
    limit: Type.Optional(
      Type.Number({
        description: 'Maximum entries or matches to return (default: 100 entries, 15 matches)',
        minimum: 1,
        maximum: 200,
      })
    ),
  })

const BacklinksSchema = (memoryRoot: string) =>
  Type.Object({
    path: Type.String({ description: memoryPathDescription(memoryRoot) }),
    squad: Type.Optional(Type.String({ description: 'Squad id for the path (defaults to your squad).' })),
  })

// --- Factory ---

export interface CreateMemoryToolsOptions {
  readOnly?: boolean
  searchDefaults?: {
    agentType?: Partial<ScopeRequest>
    agent?: Partial<ScopeRequest>
  }
}

export function createMemoryTools(callerSquadId: string, options?: CreateMemoryToolsOptions): MemoryToolWithKey[] {
  const { readOnly = false } = options ?? {}

  // Agent-facing memory root: the runtime-resolved memory path for this squad
  // (`/memory/<squadId>` on k8s/docker, the squad box's `~/memory` on the vm
  // runtime — matching what prompts show the agent). The container-namespace
  // form is always accepted too, so paths from either surface work.
  const agentMemoryRoot = resolveWorkspaceLayout({ squadId: callerSquadId }).memoryMount
  const acceptedRoots = [...new Set([agentMemoryRoot, `/memory/${callerSquadId}`])]

  // Translate an agent-facing memory path to the internal `/memory/<rel>` form the
  // (unchanged) memory services expect. Accepts `<agentMemoryRoot>/<rel>`,
  // `/memory/<callerSquadId>/<rel>`, or a bare `<rel>` (+ optional `squad`).
  // Rejects cross-squad / out-of-tree paths.
  function toInternalMemoryPath(rawPath: string, squad?: string): string {
    if (squad !== undefined && squad !== callerSquadId) {
      throw new MemoryWriteError(
        MemoryErrorCodes.MEMORY_PATH_INVALID,
        `squad '${squad}' does not match your squad — you can only access ${agentMemoryRoot}/`,
        { squad, callerSquadId }
      )
    }
    if (rawPath.startsWith('/')) {
      for (const root of acceptedRoots) {
        if (rawPath === root || rawPath.startsWith(`${root}/`)) {
          return `/memory${rawPath.slice(root.length)}`
        }
      }
      throw new MemoryWriteError(
        MemoryErrorCodes.MEMORY_PATH_INVALID,
        `Path does not match your squad memory root ${agentMemoryRoot}/ — got ${rawPath}`,
        { path: rawPath, callerSquadId }
      )
    }
    return `/memory/${rawPath}`
  }

  // Re-prefix an internal `/memory/<rel>` path to the agent-facing `<agentMemoryRoot>/<rel>` form.
  function toAgentMemoryPath(internalPath: string | null | undefined): string | null | undefined {
    if (internalPath && internalPath.startsWith('/memory/')) {
      return `${agentMemoryRoot}/${internalPath.slice('/memory/'.length)}`
    }
    return internalPath
  }

  // Search-style read scope: squad, agent-type and agent defaults layered
  // under the request, with disabled source types removed.
  async function resolveReadScope(request: ScopeRequest) {
    const squad = await Squad.find(callerSquadId)
    const squadDefaults = (squad?.metadata?.memory as { searchDefaults?: Partial<ScopeRequest> } | undefined)
      ?.searchDefaults
    const resolved = resolveSearchDefaults({
      squad: squadDefaults,
      agentType: options?.searchDefaults?.agentType,
      agent: options?.searchDefaults?.agent,
      request,
    })
    const enabled = resolveEnabledSearchSourceTypes(resolved.sourceTypes as MemorySearchSourceType[] | undefined)
    return { ...resolved, sourceTypes: enabled.sourceTypes, disabledOnly: enabled.disabledOnly }
  }

  // Outline paths: agent memory paths become `/memory/...`; other absolute
  // indexed paths (e.g. /workspace/...) pass through; bare paths are memory.
  function toOutlinePath(rawPath: string | undefined): string | undefined {
    const path = rawPath?.trim()
    if (!path || path === '/') return undefined
    for (const root of acceptedRoots) {
      if (path === root || path.startsWith(`${root}/`)) return `/memory${path.slice(root.length)}`
    }
    return path.startsWith('/') ? path : `/memory/${path.replace(/^\.?\//, '')}`
  }

  function toAgentOutlinePath(internalPath: string): string {
    if (internalPath === '/memory' || internalPath === '/memory/') return `${agentMemoryRoot}${internalPath.slice(7)}`
    return toAgentMemoryPath(internalPath) ?? internalPath
  }

  const search: MemoryToolWithKey = {
    name: 'memory_search',
    key: 'memory_search',
    label: 'Search Memory',
    description:
      'Search the squad memory vault using hybrid retrieval (semantic + keyword). Returns relevant documents and snippets.',
    parameters: SearchSchema,
    async execute(
      _toolCallId: string,
      params: {
        query: string
        limit?: number
        sourceTypes?: MemorySearchSourceType[]
        kinds?: string[]
        tags?: string[]
        paths?: string[]
        sourceSquadIds?: string[]
        sensitivity?: SensitivityTier
      }
    ): Promise<AgentToolResult<unknown>> {
      try {
        const internalPaths = params.paths?.map((p) => {
          for (const root of acceptedRoots) {
            if (p.startsWith(`${root}/`)) return `/memory/${p.slice(root.length + 1)}`
          }
          return p
        })
        const resolved = await resolveReadScope({
          sourceTypes: params.sourceTypes,
          paths: internalPaths,
          sourceSquadIds: params.sourceSquadIds,
          sensitivity: params.sensitivity,
        })

        if (resolved.disabledOnly) {
          return {
            content: [{ type: 'text' as const, text: 'No matching documents found.' }],
            details: { resultCount: 0 },
          }
        }

        const results = await SearchService.instance().search(callerSquadId, params.query, {
          limit: params.limit ?? 10,
          sourceTypes: resolved.sourceTypes,
          kinds: params.kinds,
          tags: params.tags,
          paths: resolved.paths,
          sourceSquadIds: resolved.sourceSquadIds,
          sensitivity: resolved.sensitivity,
        })

        if (results.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No matching documents found.' }],
            details: { resultCount: 0 },
          }
        }

        const provenance = results.map((r) => ({
          documentId: r.documentId,
          sourceSquadId: r.sourceSquadId,
          sourceType: r.sourceType ?? null,
          sensitivity: r.sensitivity,
          path: toAgentMemoryPath(r.path),
          title: r.title,
          score: Number(r.score.toFixed(4)),
          url: typeof r.provenance?.url === 'string' ? r.provenance.url : undefined,
        }))

        // Format results
        const formatted = results
          .map(
            (r, i) =>
              `**${i + 1}. ${toAgentMemoryPath(r.path)}**${r.title ? ` — ${r.title}` : ''}\n` +
              `Source squad: \`${r.sourceSquadId.slice(0, 8)}\` · Sensitivity: ${r.sensitivity}\n` +
              `Score: ${r.score.toFixed(3)}\n` +
              `\`\`\`\n${r.snippet}\n\`\`\`\n`
          )
          .join('\n')

        // HTML comment is invisible in chat/channel markdown but parseable by web tool traces.
        const provenanceBlock = `\n<!--ficus:memory-provenance ${JSON.stringify(provenance)} -->`

        return {
          content: [
            {
              type: 'text' as const,
              text: `Found ${results.length} result(s):\n\n${formatted}${provenanceBlock}`,
            },
          ],
          details: { resultCount: results.length, results: provenance },
        }
      } catch (e) {
        const error = e as Error
        return {
          content: [{ type: 'text' as const, text: `Search error: ${error.message}` }],
          details: { error: error.message },
        }
      }
    },
  }

  const get: MemoryToolWithKey = {
    name: 'memory_get',
    key: 'memory_get',
    label: 'Get Memory File',
    description:
      'Read the contents of a memory file. Accepts a path under your squad memory root or a bare squad-relative path.',
    parameters: GetSchema(agentMemoryRoot),
    async execute(
      _toolCallId: string,
      params: { path: string; section?: string; squad?: string }
    ): Promise<AgentToolResult<unknown>> {
      let internalPath: string
      try {
        internalPath = toInternalMemoryPath(params.path, params.squad)
      } catch (e) {
        const err = e as MemoryWriteError
        return {
          content: [{ type: 'text' as const, text: `Error reading ${params.path}: ${err.message}\nCode: ${err.code}` }],
          details: { error: { code: err.code, message: err.message } },
        }
      }
      const result = await WriteService.instance().read(callerSquadId, internalPath)
      const agentPath = toAgentMemoryPath(result.path)
      if (!result.success) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error reading ${agentPath}: ${result.error.message}\nCode: ${result.error.code}`,
            },
          ],
          details: { error: result.error },
        }
      }

      const header = `**${agentPath}**${result.sourceSquadId !== callerSquadId ? ` _(from squad ${result.sourceSquadId.slice(0, 8)})_` : ''}`
      if (params.section?.trim()) {
        const body = parseFrontmatter(result.content).content
        const sections = outlineMarkdown(body)
        const matches = findSections(sections, params.section)
        if (matches.length === 0) {
          const available = sections.slice(0, 40).map((section) => `- ${formatTrail(section.trail)}`)
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  `No section "${params.section}" in ${agentPath}.` +
                  (available.length > 0 ? `\n\nSections:\n${available.join('\n')}` : ' It has no headings.'),
              },
            ],
            details: { path: agentPath, section: params.section, error: 'section_not_found' },
          }
        }
        const [section] = matches
        const text = sliceSection(body, section)
        const note =
          matches.length > 1
            ? `\n\n_${matches.length} sections match "${params.section}"; showing the first. Pass a longer trail such as "${formatTrail(matches[1].trail).replace(/ › /g, ' > ')}"._`
            : ''
        return {
          content: [{ type: 'text' as const, text: `${header} › ${formatTrail(section.trail)}\n\n${text}${note}` }],
          details: {
            path: agentPath,
            section: formatTrail(section.trail),
            length: text.length,
            sourceSquadId: result.sourceSquadId,
          },
        }
      }

      return {
        content: [{ type: 'text' as const, text: `${header}\n\n${result.content}` }],
        details: { path: agentPath, length: result.content.length, sourceSquadId: result.sourceSquadId },
      }
    },
  }

  const write: MemoryToolWithKey = {
    name: 'memory_write',
    key: 'memory_write',
    label: 'Write Memory File',
    description:
      'Write (overwrite) a memory file. Creates the file if it does not exist. If content is null, deletes the file. Accepts a path under your squad memory root or a bare squad-relative path.',
    parameters: WriteSchema(agentMemoryRoot),
    async execute(
      _toolCallId: string,
      params: { path: string; content: string | null; targetSquadId?: string; squad?: string }
    ): Promise<AgentToolResult<unknown>> {
      let internalPath: string
      try {
        internalPath = toInternalMemoryPath(params.path, params.squad)
      } catch (e) {
        const err = e as MemoryWriteError
        return {
          content: [{ type: 'text' as const, text: `Error writing ${params.path}: ${err.message}\nCode: ${err.code}` }],
          details: { error: { code: err.code, message: err.message } },
        }
      }
      const targetSquadId = params.targetSquadId ?? callerSquadId
      const isCrossSquad = targetSquadId !== callerSquadId
      const result = await WriteService.instance().writeAs(callerSquadId, targetSquadId, internalPath, params.content)

      if (!result.success) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error writing ${params.path}: ${result.error!.message}\nCode: ${result.error!.code}`,
            },
          ],
          details: { error: result.error },
        }
      }

      const agentPath = toAgentMemoryPath(result.path)

      if (result.deleted) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Successfully deleted ${isCrossSquad ? `(to squad ${targetSquadId.slice(0, 8)}) ` : ''}${agentPath}`,
            },
          ],
          details: { path: agentPath, deleted: true, success: true, ...(isCrossSquad ? { targetSquadId } : {}) },
        }
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Successfully wrote ${isCrossSquad ? `(to squad ${targetSquadId.slice(0, 8)}) ` : ''}${agentPath} (${params.content!.length} chars)`,
          },
        ],
        details: { path: agentPath, success: true, ...(isCrossSquad ? { targetSquadId } : {}) },
      }
    },
  }

  const patch: MemoryToolWithKey = {
    name: 'memory_patch',
    key: 'memory_patch',
    label: 'Patch Memory File',
    description:
      'Replace an exact match in a memory file. The match must appear exactly once (case-sensitive, byte-for-byte). Use this for surgical edits.',
    parameters: PatchSchema(agentMemoryRoot),
    async execute(
      _toolCallId: string,
      params: { path: string; match: string; replacement: string; targetSquadId?: string; squad?: string }
    ): Promise<AgentToolResult<unknown>> {
      let internalPath: string
      try {
        internalPath = toInternalMemoryPath(params.path, params.squad)
      } catch (e) {
        const err = e as MemoryWriteError
        return {
          content: [
            { type: 'text' as const, text: `Error patching ${params.path}: ${err.message}\nCode: ${err.code}` },
          ],
          details: { error: { code: err.code, message: err.message } },
        }
      }
      const targetSquadId = params.targetSquadId ?? callerSquadId
      const isCrossSquad = targetSquadId !== callerSquadId
      const result = await WriteService.instance().patchAs(
        callerSquadId,
        targetSquadId,
        internalPath,
        params.match,
        params.replacement
      )

      if (!result.success) {
        let message = `Error patching ${params.path}: ${result.error!.message}`

        if (result.error!.code === MemoryErrorCodes.PATCH_AMBIGUOUS_MATCH) {
          const count = (result.error!.details?.matchCount as number) ?? 'multiple'
          message += `\n\nThe match string appears ${count} times. Please use a more specific match that occurs exactly once.`
        } else if (result.error!.code === MemoryErrorCodes.PATCH_NO_MATCH) {
          message += '\n\nThe match string was not found. Check for exact spelling and whitespace.'
        }

        message += `\nCode: ${result.error!.code}`

        return {
          content: [{ type: 'text' as const, text: message }],
          details: { error: result.error },
        }
      }

      const agentPath = toAgentMemoryPath(result.path)

      return {
        content: [
          {
            type: 'text' as const,
            text: `Successfully patched ${isCrossSquad ? `(to squad ${targetSquadId.slice(0, 8)}) ` : ''}${agentPath}`,
          },
        ],
        details: { path: agentPath, success: true, ...(isCrossSquad ? { targetSquadId } : {}) },
      }
    },
  }

  const append: MemoryToolWithKey = {
    name: 'memory_append',
    key: 'memory_append',
    label: 'Append to Memory File',
    description:
      'Append content to a memory file. Creates the file if it does not exist. Accepts a path under your squad memory root or a bare squad-relative path.',
    parameters: AppendSchema(agentMemoryRoot),
    async execute(
      _toolCallId: string,
      params: { path: string; content: string; ensureNewline?: boolean; targetSquadId?: string; squad?: string }
    ): Promise<AgentToolResult<unknown>> {
      let internalPath: string
      try {
        internalPath = toInternalMemoryPath(params.path, params.squad)
      } catch (e) {
        const err = e as MemoryWriteError
        return {
          content: [
            { type: 'text' as const, text: `Error appending to ${params.path}: ${err.message}\nCode: ${err.code}` },
          ],
          details: { error: { code: err.code, message: err.message } },
        }
      }
      const targetSquadId = params.targetSquadId ?? callerSquadId
      const isCrossSquad = targetSquadId !== callerSquadId
      const result = await WriteService.instance().appendAs(
        callerSquadId,
        targetSquadId,
        internalPath,
        params.content,
        {
          ensureNewline: params.ensureNewline,
        }
      )

      if (!result.success) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error appending to ${params.path}: ${result.error!.message}\nCode: ${result.error!.code}`,
            },
          ],
          details: { error: result.error },
        }
      }

      const agentPath = toAgentMemoryPath(result.path)

      return {
        content: [
          {
            type: 'text' as const,
            text: `Successfully appended ${params.content.length} chars ${isCrossSquad ? `(to squad ${targetSquadId.slice(0, 8)}) ` : ''}to ${agentPath}`,
          },
        ],
        details: { path: agentPath, success: true, ...(isCrossSquad ? { targetSquadId } : {}) },
      }
    },
  }

  const backlinks: MemoryToolWithKey = {
    name: 'memory_backlinks',
    key: 'memory_backlinks',
    label: 'Get Backlinks',
    description:
      'Get documents that link to a given memory file. Useful for understanding relationships between documents.',
    parameters: BacklinksSchema(agentMemoryRoot),
    async execute(_toolCallId: string, params: { path: string; squad?: string }): Promise<AgentToolResult<unknown>> {
      let internalPath: string
      try {
        internalPath = toInternalMemoryPath(params.path, params.squad)
      } catch (e) {
        const err = e as MemoryWriteError
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error getting backlinks for ${params.path}: ${err.message}\nCode: ${err.code}`,
            },
          ],
          details: { error: { code: err.code, message: err.message } },
        }
      }
      try {
        const links = await IndexingService.instance().getBacklinks(callerSquadId, internalPath)
        const agentPath = toAgentMemoryPath(internalPath)

        if (links.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No backlinks found for ${agentPath}`,
              },
            ],
            details: { path: agentPath, backlinks: [] },
          }
        }

        const formatted = links
          .map((l) => `- ${toAgentMemoryPath(l.sourcePath)}${l.heading ? ` (heading: ${l.heading})` : ''}`)
          .join('\n')

        return {
          content: [
            {
              type: 'text' as const,
              text: `Backlinks to ${agentPath}:\n\n${formatted}`,
            },
          ],
          details: { path: agentPath, backlinks: links },
        }
      } catch (e) {
        const error = e as Error
        return {
          content: [{ type: 'text' as const, text: `Error getting backlinks: ${error.message}` }],
          details: { error: error.message },
        }
      }
    },
  }

  const outline: MemoryToolWithKey = {
    name: 'memory_outline',
    key: 'memory_outline',
    label: 'Memory Outline',
    description:
      'Browse the map of memory: folders, documents and their section headings. With `query`, find documents and sections whose titles, paths or headings match. Then read a section with memory_get({ path, section }). Use it to see what exists before searching, or when memory_search misses.',
    parameters: OutlineSchema(agentMemoryRoot),
    async execute(
      _toolCallId: string,
      params: {
        path?: string
        query?: string
        sourceTypes?: MemorySearchSourceType[]
        sourceSquadIds?: string[]
        limit?: number
      }
    ): Promise<AgentToolResult<unknown>> {
      try {
        const resolved = await resolveReadScope({
          sourceTypes: params.sourceTypes,
          sourceSquadIds: params.sourceSquadIds,
        })
        const scope = {
          sourceTypes: resolved.sourceTypes,
          paths: resolved.paths,
          sourceSquadIds: resolved.sourceSquadIds,
          sensitivity: resolved.sensitivity,
        }
        const service = OutlineService.instance()
        if (params.query?.trim()) {
          const matches = resolved.disabledOnly
            ? []
            : await service.search(callerSquadId, params.query, scope, { limit: params.limit })
          return {
            content: [{ type: 'text' as const, text: formatOutlineMatches(matches) }],
            details: {
              resultCount: matches.length,
              matches: matches.map((match) => ({
                path: match.document.path ? toAgentOutlinePath(match.document.path) : null,
                title: match.document.title,
                sourceType: match.document.sourceType,
                sourceSquadId: match.document.sourceSquadId,
                section: match.section ? formatTrail(match.section.trail) : null,
                score: Number(match.score.toFixed(4)),
              })),
            },
          }
        }

        const browsed: OutlineBrowse = resolved.disabledOnly
          ? { kind: 'folder', prefix: '/', entries: [], truncated: false, unpathed: [] }
          : await service.browse(callerSquadId, toOutlinePath(params.path), scope, { limit: params.limit })
        return {
          content: [{ type: 'text' as const, text: formatOutlineBrowse(browsed) }],
          details:
            browsed.kind === 'document'
              ? { kind: 'document', path: params.path, documents: browsed.documents.length }
              : { kind: 'folder', path: toAgentOutlinePath(browsed.prefix), entries: browsed.entries.length },
        }
      } catch (e) {
        const error = e as Error
        return {
          content: [{ type: 'text' as const, text: `Outline error: ${error.message}` }],
          details: { error: error.message },
        }
      }
    },
  }

  function squadNote(sourceSquadId: string): string {
    return sourceSquadId === callerSquadId ? '' : ` _(squad ${sourceSquadId.slice(0, 8)})_`
  }

  function sectionLines(section: OutlineSection): string {
    const lines = section.endLine - section.startLine + 1
    return `${lines} line${lines === 1 ? '' : 's'}`
  }

  function formatOutlineMatches(matches: OutlineMatch[]): string {
    if (matches.length === 0) {
      return 'No titles, paths or headings match. Try other words, memory_outline without a query, or memory_search.'
    }
    const lines = matches.map((match, index) => {
      const { document, section } = match
      const where = document.path ? toAgentOutlinePath(document.path) : `[${document.sourceType}]`
      const title = document.title ? ` — ${document.title}` : ''
      const target = section ? ` › ${formatTrail(section.trail)} (${sectionLines(section)})` : ''
      return `${index + 1}. ${where}${target}${title}${squadNote(document.sourceSquadId)}`
    })
    return (
      `Found ${matches.length} match(es):\n\n${lines.join('\n')}\n\n` +
      'Read a memory file section with memory_get({ path, section: "Heading > Subheading" }).'
    )
  }

  function formatOutlineBrowse(browsed: OutlineBrowse): string {
    if (browsed.kind === 'document') {
      return browsed.documents
        .map((document) => {
          const path = document.path ? toAgentOutlinePath(document.path) : `[${document.sourceType}]`
          const title = document.title ? ` — ${document.title}` : ''
          const header = `**${path}**${title} (${document.lineCount} lines)${squadNote(document.sourceSquadId)}`
          if (document.sections.length === 0) return `${header}\n\nNo headings.`
          const minLevel = Math.min(...document.sections.map((section) => section.level))
          const tree = document.sections
            .slice(0, 200)
            .map((section) => `${'  '.repeat(section.level - minLevel)}- ${section.heading} (${sectionLines(section)})`)
          const more = document.sections.length > 200 ? `\n… ${document.sections.length - 200} more headings` : ''
          const hint =
            document.sourceType === 'memory_file'
              ? '\n\nRead one with memory_get({ path, section: "Heading > Subheading" }).'
              : `\n\nSearch inside it with memory_search({ query, paths: ["${path}"] }).`
          return `${header}\n\n${tree.join('\n')}${more}${hint}`
        })
        .join('\n\n')
    }

    const folder = toAgentOutlinePath(browsed.prefix)
    if (browsed.entries.length === 0 && browsed.unpathed.length === 0) {
      return browsed.prefix === '/' ? 'Memory is empty.' : `Nothing indexed under ${folder}.`
    }
    const lines = browsed.entries.map((entry) => {
      const name = entry.kind === 'folder' ? `${entry.name}/` : entry.name
      const detail =
        entry.kind === 'folder'
          ? ` (${entry.documentCount} document${entry.documentCount === 1 ? '' : 's'})`
          : entry.title
            ? ` — ${entry.title}`
            : ''
      return `- ${name}${detail}${squadNote(entry.sourceSquadId)}`
    })
    const sections = [`**${browsed.prefix === '/' ? 'Memory map' : folder}**\n\n${lines.join('\n')}`]
    if (browsed.truncated) sections.push('More entries not shown: open a subfolder, or pass a query.')
    if (browsed.unpathed.length > 0) {
      const groups = browsed.unpathed.map(
        (group) =>
          `- ${group.sourceType}: ${group.documentCount} document${group.documentCount === 1 ? '' : 's'}${squadNote(group.sourceSquadId)}`
      )
      sections.push(`Also indexed without paths (use memory_search with sourceTypes):\n${groups.join('\n')}`)
    }
    sections.push('Open a folder or document with memory_outline({ path }).')
    return sections.join('\n\n')
  }

  return readOnly ? [search, outline, get, backlinks] : [search, outline, get, write, patch, append, backlinks]
}
