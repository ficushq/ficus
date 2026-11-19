import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as yaml from 'js-yaml'
import type { Responder } from './define'
import { FIXTURE_SQUAD } from './prompt'
import { FIXTURE_WORK_STREAM_ID } from './fixtures'
import { executedCommands } from './shell-commands'
import { workingTreeVariant } from './variant'

export const REQUESTER = { userId: '51846fad-3980-4ec3-943c-1ebe9c822b2e', name: 'noah' }
const otherSender = { userId: '7a9e3c21-5b4d-4f6e-8a1b-2c3d4e5f6a7b', name: 'priya' }
export const REQUESTER_MESSAGE =
  'Please open a work stream to fix the flaky host budget test in apps/core/src/services/slots/host-budget.test.ts, and make me the reviewer.'
export const CREATED_STREAM_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

/** The real preset is fixture data, not a new prompt instruction or a fabricated workflow. */
const preset = yaml.load(readFileSync(join(workingTreeVariant().root, 'config/workflows/reviewed-coding.yaml'), 'utf8'))

/** Fresh state per run. Help never creates a stream; get cannot alias a different stream. */
export function requesterResponder(): Responder {
  let created: { id: string; number: number; title: string; assignedReviewerIds: string[] } | undefined
  const metadata = { workflow: { preset: 'reviewed-coding' }, policies: { completion: { mode: 'pr-merge' } } }
  return (call) => {
    const results: string[] = []
    for (const raw of executedCommands(call.command ?? '')) {
      const argv = raw.filter((word, index) => index === 0 || !['--json', '--quiet'].includes(word))
      if (argv[0] !== 'ficus' || argv.includes('--help') || argv.includes('-h') || argv[1] === 'help') continue
      const [, group, action, target] = argv
      if (group === 'agent' && action === 'messages' && ['manager', FIXTURE_SQUAD.agentId].includes(target!)) {
        results.push(
          JSON.stringify({
            messages: [
              {
                id: 'm-1',
                role: 'human',
                createdAt: '2026-11-18T15:20:11Z',
                content: 'Is the slot pool rename done?',
                metadata: { sender: otherSender },
              },
              {
                id: 'm-2',
                role: 'human',
                createdAt: '2026-11-18T15:58:40Z',
                content: REQUESTER_MESSAGE,
                metadata: { sender: REQUESTER },
              },
            ],
          })
        )
      } else if (group === 'workflow' && action === 'get' && target === 'reviewed-coding')
        results.push(JSON.stringify(preset))
      else if (group === 'workflow' && action === 'list') results.push(JSON.stringify([preset]))
      else if (group === 'squad' && ['get', 'get-meta'].includes(action!) && target === FIXTURE_SQUAD.id)
        results.push(JSON.stringify({ id: FIXTURE_SQUAD.id, metadata }))
      else if (group === 'whoami')
        results.push(
          `Instance: https://ficus.example\nIdentity: agent ${FIXTURE_SQUAD.agentId} (Manager)\nCredential: injected FICUS_TOKEN`
        )
      else if (['workstream', 'ws'].includes(group!)) {
        if (action === 'reviewers') results.push(JSON.stringify([REQUESTER, otherSender]))
        else if (action === 'list') results.push(JSON.stringify(created ? [created] : []))
        else if (action === 'create' || action === 'new') {
          if (created) {
            results.push('Error: the fixture stream already exists. Inspect it before creating another.')
            continue
          }
          const reviewers = argv.flatMap((word, index) =>
            word === '--reviewer'
              ? [argv[index + 1]!]
              : word.startsWith('--reviewer=')
                ? [word.slice('--reviewer='.length)]
                : []
          )
          created = { id: CREATED_STREAM_ID, number: 1301, title: target ?? '', assignedReviewerIds: reviewers }
          results.push(JSON.stringify(created))
        } else if (action === 'get' && !['1300', FIXTURE_WORK_STREAM_ID].includes(target!))
          results.push(
            created && ['1301', CREATED_STREAM_ID].includes(target!)
              ? JSON.stringify(created)
              : 'Error: work stream not found'
          )
        else if (action === 'update' && created && ['1301', CREATED_STREAM_ID].includes(target!)) {
          const at = argv.indexOf('--reviewer')
          if (at >= 0 && argv[at + 1]) created.assignedReviewerIds = [argv[at + 1]!]
          results.push(JSON.stringify(created))
        }
      }
    }
    return results.length ? results.join('\n') : undefined
  }
}
