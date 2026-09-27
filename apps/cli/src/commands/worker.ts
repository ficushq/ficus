import { Command } from 'commander'
import { apiGet } from '../client'
import { output, outputError } from '../output'

interface WorkerStatus {
  status: 'online' | 'offline'
}

export function registerWorkerCommands(program: Command) {
  const worker = program.command('worker').description('Manage the worker process')

  // ficus worker status
  worker
    .command('status')
    .description('Check worker process status')
    .action(async () => {
      try {
        const result = await apiGet<WorkerStatus>('/api/worker/status')
        output(result, `Worker: ${result.status}`)
      } catch (error) {
        outputError(error as Error)
      }
    })
}
