import { expect, test } from 'bun:test'
import { acquireDomHarness } from '../test/domHarness'
import { StaticAgentTypeNames } from '../hooks/useAgentTypeNames'
import { RewindModal } from './RewindModal'

async function stepOptions(names: Record<string, string>) {
  const dom = await acquireDomHarness({})
  const rendered = dom.createRoot()
  try {
    await dom.act(async () =>
      rendered.root.render(
        <StaticAgentTypeNames names={names}>
          <RewindModal
            isOpen
            onClose={() => undefined}
            onConfirm={() => undefined}
            steps={[
              { agentTypeId: 'qa-bot', index: 0 },
              { agentTypeId: 'general', index: 1 },
            ]}
          />
        </StaticAgentTypeNames>
      )
    )
    return [...dom.window.document.querySelectorAll('option')]
      .filter((option) => option.value)
      .map((option) => ({ value: option.value, text: option.textContent }))
  } finally {
    await dom.cleanup()
  }
}

test('steps name their agent type as people read it, and still submit the type id', async () => {
  expect(await stepOptions({ 'qa-bot': 'Release QA' })).toEqual([
    { value: 'qa-bot', text: 'Step 1: Release QA' },
    { value: 'general', text: 'Step 2: General Purpose agent' },
  ])
  expect((await stepOptions({})).map((option) => option.text)).toEqual([
    'Step 1: Qa Bot',
    'Step 2: General Purpose agent',
  ])
})
