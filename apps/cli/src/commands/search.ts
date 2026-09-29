import { Command } from 'commander'
import { entitySearchQuerySchema, type EntitySearchResponse } from '@ficus/shared'
import { apiGet } from '../client'
import { outputTable, outputError } from '../output'

export function registerSearchCommands(program: Command): void {
  program
    .command('search <query>')
    .description('Search squads, work streams, consultant chats, and your saved Assistant conversations')
    .option('--limit <number>', 'Maximum results (1–50)', '20')
    .option('--kind <kind>', 'squad, work_stream, consultant_conversation, or assistant_conversation')
    .option('--squad <id>', 'Restrict to a squad UUID')
    .action(async (query, options) => {
      try {
        const input = entitySearchQuerySchema.parse({
          q: query,
          limit: options.limit,
          kind: options.kind,
          squadId: options.squad,
        })
        const params = new URLSearchParams({ q: input.q, limit: String(input.limit) })
        if (input.kind) params.set('kind', input.kind)
        if (input.squadId) params.set('squadId', input.squadId)
        const { results } = await apiGet<EntitySearchResponse>(`/api/search?${params}`)
        // An Assistant conversation's id is not an agent id; show the agent so `ficus agent messages` can follow.
        const withAgent = results.some((row) => row.kind === 'assistant_conversation')
        outputTable(
          results.map((row) => ({ ...row, id: row.kind === 'work_stream' && row.number ? `#${row.number}` : row.id })),
          ['kind', 'id', 'label', 'squadName', 'status', ...(withAgent ? ['agentId'] : [])]
        )
      } catch (error) {
        outputError(error as Error)
      }
    })
}
