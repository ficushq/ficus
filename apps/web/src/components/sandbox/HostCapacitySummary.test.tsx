import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { HostCapacitySummary } from './HostCapacitySummary'

const capacity = {
  allowed: true,
  reason: 'available' as const,
  cpus: 8,
  activeBoxes: 15,
  startupLimit: 2,
  startingBoxes: 0,
}
test('shows measured host load without treating box ceilings as reserved CPUs', () => {
  const html = renderToStaticMarkup(
    <HostCapacitySummary
      capacity={capacity}
      pressure={{ cpus: 8, load: [4, 3, 2], memTotalMb: 16000, memAvailableMb: 8000 }}
    />
  )
  expect(html).toContain('Host load 0.5×')
  expect(html).toContain('Host memory 50% used')
  expect(html).toContain('Squads share host CPUs')
  expect(html).not.toContain('quota')
})
test('shows transient startup concurrency without implying running squads cannot fit', () => {
  const html = renderToStaticMarkup(<HostCapacitySummary capacity={{ ...capacity, startingBoxes: 2 }} />)
  expect(html).toContain('Starting 2/2 boxes')
  expect(html).toContain('running boxes do not occupy startup slots')
  expect(html).not.toContain('Host load')
})
test('missing samples and old reserved-quota payloads do not invent measured usage', () => {
  expect(renderToStaticMarkup(<HostCapacitySummary capacity={{ allowed: false, reason: 'unknown' }} />)).toBe('')
  expect(
    renderToStaticMarkup(
      <HostCapacitySummary capacity={{ allowed: true, reason: 'available', activeQuotaCpus: 60, budgetCpus: 12 }} />
    )
  ).toBe('')
  expect(renderToStaticMarkup(<HostCapacitySummary />)).toBe('')
})

test.each([0, 1, 2])('uses a theme divider with %i starting boxes', (startingBoxes) => {
  const html = renderToStaticMarkup(
    <HostCapacitySummary
      capacity={{ ...capacity, startingBoxes }}
      pressure={{ cpus: 8, load: [4, 3, 2], memTotalMb: 16000, memAvailableMb: 8000 }}
    />
  )
  expect(html).toContain('border-l border-th-border pl-1.5 text-secondary')
  expect(html).not.toContain('border-current')
  expect(html).toContain('Host load 0.5×')
  if (startingBoxes) expect(html).toContain(`Starting ${startingBoxes}/2 boxes`)
  else expect(html).not.toContain('Starting')
})
