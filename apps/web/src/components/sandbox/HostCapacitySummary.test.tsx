import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { HostCapacitySummary } from './HostCapacitySummary'

const capacity = { allowed: true, reason: 'already-accounted' as const, cpus: 8, budgetCpus: 12, activeQuotaCpus: 8 }
test('separates measured host load from reserved CPU quota and explains the budget', () => {
  const html = renderToStaticMarkup(
    <HostCapacitySummary
      capacity={capacity}
      pressure={{ cpus: 8, load: [4, 3, 2], memTotalMb: 16000, memAvailableMb: 8000 }}
    />
  )
  expect(html).toContain('Host load 0.5×')
  expect(html).toContain('quota 8/12 CPUs')
  expect(html).toContain('1.5× host CPUs')
  expect(html).toContain('not measured CPU usage')
  expect(html).toContain('Host memory 50% used')
})
test('explains saturation without claiming that sampled host CPU is fully used', () => {
  const html = renderToStaticMarkup(<HostCapacitySummary capacity={{ ...capacity, activeQuotaCpus: 12 }} />)
  expect(html).toContain('quota 12/12 CPUs')
  expect(html).toContain('Additional box demand waits')
  expect(html).not.toContain('Host load')
})
test('unknown capacity fails visibly, while an older payload adds no misleading zero', () => {
  expect(renderToStaticMarkup(<HostCapacitySummary capacity={{ allowed: false, reason: 'unknown' }} />)).toContain(
    'Host quota unknown'
  )
  expect(renderToStaticMarkup(<HostCapacitySummary />)).toBe('')
})

test.each([
  [8, 'text-secondary'],
  [12, 'text-status-attention-fg'],
  [60, 'text-status-attention-fg'],
])('uses a theme divider independently of quota color at %i CPUs', (activeQuotaCpus, textClass) => {
  const html = renderToStaticMarkup(<HostCapacitySummary capacity={{ ...capacity, activeQuotaCpus }} />)
  expect(html).toContain('border-l border-th-border pl-1.5')
  expect(html).not.toContain('border-current')
  expect(html).toContain(textClass)
  expect(html).toContain(`Host quota ${activeQuotaCpus}/12 CPUs`)
})
