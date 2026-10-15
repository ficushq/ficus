import { Command } from 'commander'
import { apiDelete, apiGet, apiPost } from '../client'
import { output, outputTable, outputError, isJsonMode, setOutputOptions } from '../output'
import type { AgentQuestion } from '@ficus/shared'

function questionText(q: AgentQuestion): string {
  return q.questionData.questions.map((x) => x.question).join(' | ')
}

export function registerAgentQuestionCommands(program: Command) {
  const aq = program.command('agent-question').alias('aq').description('Manage async agent questions')

  // ficus agent-question list <agentId> [--status open|answered]
  aq.command('list <agentId>')
    .description("List an agent's async questions")
    .option('-s, --status <status>', 'Filter by status (open, or the answered/dismissed history)')
    .option('--json', 'Output in JSON format')
    .action(async (agentId, options) => {
      if (options.json) setOutputOptions({ json: true })
      try {
        const query = options.status ? `?status=${options.status}` : ''
        const questions = await apiGet<AgentQuestion[]>(`/api/agent-questions/by-agent/${agentId}${query}`)
        if (isJsonMode()) {
          output(questions)
          return
        }
        if (questions.length === 0) {
          console.log('No questions found')
          return
        }
        outputTable(
          questions.map((q) => ({
            ID: q.id.slice(0, 8),
            Status: q.status,
            Question: questionText(q).slice(0, 50),
            Answer: q.answer ? `${q.answerRelayedByAgentId ? '(relayed) ' : ''}${q.answer}`.slice(0, 30) : '-',
          })),
          ['ID', 'Status', 'Question', 'Answer']
        )
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus agent-question answer <id> <answer>
  aq.command('answer <id> <answer>')
    .description('Answer an open agent question as yourself (for humans; delivered to the agent, which wakes it)')
    .action(async (id, answer) => {
      try {
        const q = await apiPost<AgentQuestion>(`/api/agent-questions/${id}/answer`, { answer })
        output(q, `Answered question ${q.id.slice(0, 8)}`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus agent-question dismiss <id> [--reason <text>]
  aq.command('dismiss <id>')
    .description(
      'Dismiss an open question without answering it; nothing is recorded as an answer and the asking ' +
        'agent is NOT notified. If a human already answered your own question elsewhere, use resolve instead.'
    )
    .option('-r, --reason <reason>', 'Short reason recorded with the dismissal')
    .option('--json', 'Output in JSON format')
    .action(async (id, options) => {
      if (options.json) setOutputOptions({ json: true })
      try {
        const q = await apiDelete<AgentQuestion>(
          `/api/agent-questions/${id}`,
          options.reason ? { reason: options.reason } : undefined
        )
        output(q, `Dismissed question ${q.id.slice(0, 8)}`)
      } catch (error) {
        outputError(error as Error)
      }
    })

  // ficus agent-question resolve <id> --answer <text> --source <url-or-reference>
  aq.command('resolve <id>')
    .description(
      'Close YOUR OWN open question with the answer a human already gave in another channel ' +
        '(PR comment, chat, inbox). Recorded as answered, relayed by you, with its source; nothing is ' +
        'delivered back to you. Only the asking agent can do this. Never use it for your own or ' +
        "another agent's inferred answer, to unblock yourself, or in place of a human approval."
    )
    .requiredOption('-a, --answer <text>', "The human's answer, verbatim or a faithful summary")
    .requiredOption('-s, --source <url-or-reference>', 'Where the human answered (e.g. the PR comment URL)')
    .option('--json', 'Output in JSON format')
    .action(async (id, options) => {
      if (options.json) setOutputOptions({ json: true })
      try {
        const q = await apiPost<AgentQuestion>(`/api/agent-questions/${id}/resolve`, {
          answer: options.answer,
          source: options.source,
        })
        output(q, `Resolved question ${q.id.slice(0, 8)} with the answer from ${q.answerSource ?? options.source}`)
      } catch (error) {
        outputError(error as Error)
      }
    })
}
