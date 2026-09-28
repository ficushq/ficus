/**
 * `ficus demo` — the operator side of app-store reviewer access on a designated
 * demo instance (FICUS_DEMO_REVIEWER_ACCESS). Seeding is idempotent: run it after
 * an upgrade or a partial failure and it only creates what is missing, leaving
 * whatever was curated on top in place.
 */

import { Command } from 'commander'
import { apiPost as defaultApiPost } from '../client'
import { output as defaultOutput, outputError } from '../output'

export interface DemoDependencies {
  apiPost: typeof defaultApiPost
  output: typeof defaultOutput
}

const defaultDependencies: DemoDependencies = { apiPost: defaultApiPost, output: defaultOutput }

export interface DemoSeedSummary {
  version: number
  user: { id: string; email: string; role: string }
  squads: { id: string; name: string; agents: number; workStreams: number }[]
  transcriptMessages: number
  questions: number
  inboxMessages: number
  modelProviderConfigured: boolean
  created: string[]
}

export function renderSeedSummary(summary: DemoSeedSummary): string {
  const lines = [
    `Demo seed v${summary.version}: ${summary.created.length ? `created ${summary.created.length} item(s)` : 'already up to date'}`,
    `Reviewer account: ${summary.user.email} (${summary.user.role})`,
  ]
  for (const squad of summary.squads) {
    lines.push(`  ${squad.name}: ${squad.agents} agents, ${squad.workStreams} work streams`)
  }
  lines.push(
    `  ${summary.transcriptMessages} chat messages, ${summary.questions} open questions, ${summary.inboxMessages} inbox messages`
  )
  if (summary.created.length) lines.push('', ...summary.created.map((item) => `+ ${item}`))
  if (!summary.modelProviderConfigured) {
    lines.push(
      '',
      'No model provider is connected: agents cannot answer reviewers. Connect one under Settings → Models.'
    )
  }
  return lines.join('\n')
}

export function registerDemoCommands(program: Command, dependencies = defaultDependencies): void {
  const demo = program
    .command('demo')
    .description('App-store reviewer access on a designated demo instance (requires FICUS_DEMO_REVIEWER_ACCESS)')

  // ficus demo seed
  demo
    .command('seed')
    .description('Create or refresh the shared reviewer account and its demo squads (idempotent)')
    .action(async () => {
      try {
        const summary = await dependencies.apiPost<DemoSeedSummary>('/api/demo/seed')
        dependencies.output(summary, renderSeedSummary(summary))
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus demo revoke
  demo
    .command('revoke')
    .description('Sign every reviewer device out (rotate DEMO_REVIEWER_SECRET to stop new pairings)')
    .action(async () => {
      try {
        const result = await dependencies.apiPost<{ revoked: number }>('/api/demo/revoke-devices')
        dependencies.output(
          result,
          result.revoked ? `Revoked ${result.revoked} reviewer device(s)` : 'No reviewer devices were paired'
        )
      } catch (error) {
        outputError(error as Error)
      }
    })
}
