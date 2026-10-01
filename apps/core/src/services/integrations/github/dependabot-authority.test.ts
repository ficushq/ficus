import { expect, test } from 'bun:test'
import { dependabotRepositoryInterest } from './dependabot-authority'

const repo = 'private/widgets'
const connectionId = 'f60534c2-ded4-4be3-84ca-6cbd9ffb43a4'
const fact = {
  output: 'dependabot_alert.updated',
  version: 1,
  eventKey: 'k',
  resourceKey: 'dependabot:101:7',
  occurredAt: '2026-09-01T00:00:00Z',
  subject: 'alert',
  body: '',
  data: { repository: repo, alert: { externalId: '101:7' } },
}
test('Dependabot webhooks require explicit squad repository interest; installation visibility is not routing', () => {
  expect(dependabotRepositoryInterest({}, [], fact, connectionId)).toBe(false)
  expect(dependabotRepositoryInterest({ github: [{ repo: 'other/*' }] }, [], fact, connectionId)).toBe(false)
  expect(dependabotRepositoryInterest({ github: [{ repo: 'private/*' }] }, [], fact, connectionId)).toBe(true)
  expect(
    dependabotRepositoryInterest({ github: [{ repo }], integrationRules: { github: [] } }, [], fact, connectionId)
  ).toBe(false)
  const metadata = {
    tracked: [
      {
        integration: 'github',
        repository: 'old/name',
        kind: 'dependabot_alert',
        number: 7,
        externalId: '101:7',
        connectionId,
      },
    ],
  }
  expect(dependabotRepositoryInterest({}, [{ metadata }], fact, connectionId)).toBe(true)
  expect(dependabotRepositoryInterest({}, [{ metadata }], fact, '7ea41c2f-d5f8-4a17-8d0b-5a7c0b4e5c0c')).toBe(false)
})
