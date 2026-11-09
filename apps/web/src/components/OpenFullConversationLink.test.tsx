import { expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { acquireDomHarness } from '../test/domHarness'
import { OpenFullConversationLink } from './OpenFullConversationLink'

test('the full conversation link carries the base path the app is served under', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/ficus/' })
  const { root, container } = dom.createRoot()
  try {
    await dom.act(async () =>
      root.render(
        <MemoryRouter basename="/ficus" initialEntries={['/ficus/']}>
          <OpenFullConversationLink squadSlug="core team" agentId="a1" />
        </MemoryRouter>
      )
    )
    const link = container.querySelector('a')
    expect(link?.getAttribute('href')).toBe('/ficus/squads/core%20team/agents?agent=a1')
    expect(link?.getAttribute('target')).toBe('_blank')
  } finally {
    await dom.cleanup()
  }
})
