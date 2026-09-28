import { expect, test } from 'bun:test'
import { matchesGitHubRouting, shouldNotifyManager, eventRuleTrigger } from './default-routing'
import { workflowEventTriggerSchema, type WorkflowSource } from '@ficus/shared'
type Event = Parameters<typeof shouldNotifyManager>[1]
const metadata = { github: [{ repo: 'acme/project', labels: ['bug'] }] }
function event(output: string, data: Record<string, unknown> = {}, body = ''): Event {
  return {
    id: 'test',
    integration: 'github',
    sourceKey: 'test',
    eventKey: 'test',
    authority: { kind: 'instance' },
    triggerSquadIds: [],
    lastErrorCode: null,
    matchedAt: null,
    createdAt: new Date(0),
    fact: {
      output,
      version: 1,
      data: { repository: 'acme/project', ...data },
      body,
      subject: 'Test',
      eventKey: 'test',
      resourceKey: 'acme/project#3',
      occurredAt: new Date(0).toISOString(),
    },
  }
}
test('native repo routes preserve exact/glob and any-label matching without regex injection', () => {
  expect(matchesGitHubRouting(metadata, 'Acme/Project', ['bug', 'ui'])).toBe(true)
  expect(matchesGitHubRouting(metadata, 'acme/project', ['docs'])).toBe(false)
  expect(matchesGitHubRouting({ github: [{ repo: 'acme/*' }] }, 'acme/other', [])).toBe(true)
  expect(matchesGitHubRouting({ github: [{ repo: 'acme/a.b' }] }, 'acme/axb')).toBe(false)
  expect(matchesGitHubRouting({}, 'acme/project')).toBe(false)
})
test('assignment routing uses this connected account, not another account on the host', () => {
  const assigned = event('issue.assigned', { assignee: 'Noah', labels: ['bug'] })
  expect(shouldNotifyManager(metadata, assigned, 'noah')).toBe(true)
  expect(shouldNotifyManager(metadata, assigned, 'someone-else')).toBe(false)
  expect(shouldNotifyManager(metadata, event('issue.unassigned', assigned.fact.data), 'noah')).toBe(true)
})
test('comment routing respects mention boundaries, assignment, bots, and self comments', () => {
  expect(shouldNotifyManager(metadata, event('issue.comment', {}, 'Hi @noah, help?'), 'noah')).toBe(true)
  expect(shouldNotifyManager(metadata, event('issue.comment', {}, '@noah-other'), 'noah')).toBe(false)
  expect(shouldNotifyManager(metadata, event('issue.comment', { assignees: ['NOAH'] }), 'noah')).toBe(true)
  expect(shouldNotifyManager(metadata, event('issue.comment', { actor: 'Noah' }, '@noah'), 'noah')).toBe(false)
  expect(
    shouldNotifyManager(metadata, event('pull_request.review_comment', { actorType: 'Bot' }, '@noah'), 'noah')
  ).toBe(false)
})
test('review requests become ordinary typed triggers using the squad workflow', () => {
  const input = event('pull_request.review_requested', { requestedReviewer: 'Noah', pullRequest: { number: 3 } })
  const trigger = eventRuleTrigger(metadata, input, 'noah')!
  expect(workflowEventTriggerSchema.safeParse(trigger).success).toBe(true)
  expect(trigger.create.workflow).toEqual({ kind: 'preset', id: 'solo', customizations: [] })
  expect(eventRuleTrigger(metadata, input, 'someone-else')).toBeUndefined()
  expect(eventRuleTrigger({}, input, 'noah')).toBeUndefined()
  const workflow: WorkflowSource = { kind: 'preset', id: 'reviewed-coding', customizations: [] }
  expect(eventRuleTrigger({ ...metadata, workflow }, input, 'noah')!.create.workflow).toEqual(workflow)
})
test('Linear metadata routing accepts both team formats and ignores other teams', () => {
  const input = { ...event('issue.assigned', { teamId: 'team-1' }), integration: 'linear' }
  expect(shouldNotifyManager({ linear: { teamId: 'team-1' } }, input, '')).toBe(true)
  expect(shouldNotifyManager({ linear: [{ teamId: 'team-1' }] }, input, '')).toBe(true)
  expect(shouldNotifyManager({ linear: { teamId: 'team-2' } }, input, '')).toBe(false)
})
