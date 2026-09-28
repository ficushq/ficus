import { Command } from 'commander'
import { apiGet, apiPostSSE } from '../client'
import { outputTable, outputError } from '../output'

interface Agent {
  id: string
  agentTypeId: string
  status: string
  context: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export function registerChatCommands(program: Command) {
  program
    .command('chat [message]')
    .description('Chat with your user assistant')
    .option('-a, --agent <agentId>', 'Continue existing agent conversation')
    .option('-l, --list', 'List chat agents')
    .option('-s, --scope <scope>', 'Filter agents by scope type (for --list)')
    .action(async (message, options) => {
      try {
        // List agents
        if (options.list) {
          const params = new URLSearchParams({ agentTypeId: 'system-manager' })
          if (options.scope) {
            params.set('scopeType', options.scope)
          }
          const agents = await apiGet<Agent[]>(`/api/agents?${params}`)
          const rows = agents.map((a) => {
            const scope = (a.context as any)?.scope
            return {
              id: a.id,
              status: a.status,
              scope: scope ? `${scope.type}${scope.id ? ':' + scope.id : ''}` : '—',
              updatedAt: a.updatedAt,
            }
          })
          outputTable(rows, ['id', 'status', 'scope', 'updatedAt'])
          return
        }

        // Require message for chat
        if (!message) {
          console.error('Error: message is required')
          console.error('Usage: ficus chat <message>')
          process.exit(1)
        }

        // Build request
        const body: Record<string, unknown> = { message }

        if (options.agent) {
          body.agentId = options.agent
        } else if (options.task) {
          body.scope = { type: 'task', id: options.task }
        }

        let resolvedAgentId = ''
        let finished = false

        // Stream response
        // The worker streams the reply as `text` events (`chunk` is the older
        // name) and repeats `agent`/`done` when the execution settles. The
        // stream also carries keepalive `ping` events with empty data and
        // events this command does not render (thinking, flush_agent, ...), so
        // only parse the events it reads.
        await apiPostSSE('/api/chat', body, (event, data) => {
          if (event === 'agent') {
            resolvedAgentId = JSON.parse(data).agentId
          } else if (event === 'text' || event === 'chunk') {
            process.stdout.write(JSON.parse(data).text)
          } else if (event === 'done' && !finished) {
            finished = true
            console.log() // newline after response
            console.log(`\n[Agent: ${resolvedAgentId}]`)
          }
        })
      } catch (error) {
        outputError(error as Error)
      }
    })
}
