import { Command } from 'commander'
import { apiGet } from '../client'
import { outputTable, outputError } from '../output'

export function registerActionCommands(program: Command) {
  const action = program.command('action').description('View pending actions')

  // ficus action list [--type <type>]
  action
    .command('list')
    .description('List pending actions requiring attention')
    .option('-t, --type <type>', 'Filter by type (question, checkpoint, blocked, failed)')
    .action(async (options) => {
      try {
        let actions = await apiGet<any[]>('/api/actions/pending')
        if (options.type) {
          actions = actions.filter((a) => a.type === options.type)
        }
        outputTable(actions, ['type', 'taskId', 'taskTitle', 'createdAt'])
      } catch (error) {
        outputError(error as Error)
      }
    })
}
