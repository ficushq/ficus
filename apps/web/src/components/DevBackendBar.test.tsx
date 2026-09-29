import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { DevBackendBarContent, type DevBackendState } from './DevBackendBar'

function render(state: DevBackendState) {
  return renderToStaticMarkup(
    <DevBackendBarContent
      state={state}
      pending={false}
      error={null}
      onSwitchBackend={() => {}}
      onSetProductionWrites={() => {}}
    />
  )
}

describe('DevBackendBarContent', () => {
  const backends = [
    { label: '@local', apiUrl: 'http://localhost:3000', isProduction: false },
    { label: 'cloud', apiUrl: 'https://example.ficus.sh', isProduction: true },
  ]

  test('keeps local development compact without a production-writes control', () => {
    const html = render({
      selectedLabel: '@local',
      apiUrl: 'http://localhost:3000',
      isProduction: false,
      productionWritesEnabled: false,
      backends,
    })
    expect(html).toContain('Dev UI')
    expect(html).toContain('Local · localhost:3000')
    expect(html).not.toContain('Enable production writes')
  })

  test('labels a production backend read-only by default', () => {
    const html = render({
      selectedLabel: 'cloud',
      apiUrl: 'https://example.ficus.sh',
      isProduction: true,
      productionWritesEnabled: false,
      backends,
    })
    expect(html).toContain('Production · example.ficus.sh')
    expect(html).toContain('Enable production writes')
    expect(html).toContain('Resets on switch or restart')
    expect(html).toContain('Read only')
    expect(html).not.toContain('Writes enabled')
  })

  test('makes the enabled production-writes state unmistakable', () => {
    const html = render({
      selectedLabel: 'cloud',
      apiUrl: 'https://example.ficus.sh',
      isProduction: true,
      productionWritesEnabled: true,
      backends,
    })
    expect(html).toContain('Writes enabled')
    expect(html).toContain('bg-status-danger-950')
    expect(html).toContain('checked=""')
  })
})
