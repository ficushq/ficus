import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Agent } from '@ficus/shared'
import { StaticAgentTypeNames } from '../../hooks/useAgentTypeNames'
import { AgentDetailsHeading } from './AgentVisualization'

const agent = { id: 'a1', agentTypeId: 'qa-bot', metadata: { name: 'Quin', purpose: 'Release checks' } } as Agent

function heading(names: Record<string, string>) {
  return renderToStaticMarkup(
    <StaticAgentTypeNames names={names}>
      <AgentDetailsHeading agent={agent} />
    </StaticAgentTypeNames>
  )
}

test('the selected agent heading names its type as people read it, never the raw type id', () => {
  const named = heading({ 'qa-bot': 'Release QA' })
  expect(named).toContain('>Release QA (Release checks)</h3>')
  expect(named).toContain('>Release QA</p>')
  expect(named).not.toContain('qa-bot')
  expect(heading({})).toContain('>Qa Bot</p>')
})
