/* global structuredClone, console */
// Operator-only post-run reproductions. Never supplied to any benchmark agent.
// Run with Bun against /app at each recorded commit in an offline restored clone.
import assert from 'node:assert/strict'

const { createWorld, relation, createTraitRegistry } = await import('/app/packages/core/src/index.ts')
const results = []
for (const exclusive of [false, true]) {
  for (const scenario of ['exact-record', 'record-callback', 'date-callback', 'ordinary-add-control']) {
    try {
      const date = scenario === 'date-callback'
      const Link = relation({ exclusive, store: date ? () => new Date(0) : () => ({ count: 0 }) })
      const registry = createTraitRegistry(['link', Link])
      const world = createWorld()
      const target = world.spawn()
      const seen = []
      if (scenario === 'ordinary-add-control') {
        world.onAdd(Link, (source, addedTarget) => seen.push(structuredClone(source.get(Link(addedTarget)))))
        const entity = world.spawn(Link(target, { fresh: 7 }))
        assert.deepEqual(entity.get(Link(target)), { count: 0, fresh: 7 })
        assert.deepEqual(seen, [{ count: 0, fresh: 7 }])
      } else {
        const entity = world.spawn(Link(target))
        const wanted = date ? new Date(4321) : { fresh: 7 }
        entity.set(Link(target), wanted)
        const saved = entity.snapshot(registry)
        entity.remove(Link(target))
        if (scenario.endsWith('callback')) {
          world.onAdd(Link, (source, addedTarget) => {
            const value = source.get(Link(addedTarget))
            seen.push(date ? value.getTime() : structuredClone(value))
          })
        }
        entity.rollback(registry, saved)
        assert.deepEqual(entity.get(Link(target)), wanted)
        if (scenario.endsWith('callback')) assert.deepEqual(seen, [date ? 4321 : wanted])
      }
      results.push({ exclusive, scenario, passed: true })
    } catch (error) {
      results.push({ exclusive, scenario, passed: false, error: error.message })
    }
  }
}
console.log(
  JSON.stringify({ passed: results.filter((result) => result.passed).length, total: results.length, results })
)
