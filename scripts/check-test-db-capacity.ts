import { requireTestDbCapacity } from '../packages/shared/src/testDbCapacity'

// A thrown preload error alone does NOT halt Bun's test run. Exit before any
// application preload can probe, sweep, start, or mutate a database.
try {
  requireTestDbCapacity()
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Test database capacity check failed')
  process.exit(1)
}
