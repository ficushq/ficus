import { expect, test } from 'bun:test'
import {
  commandExecutionEnvironment,
  inheritedExecutionSelection,
  INTEGRATION_EXEC_SELECTION_ENV,
} from './integration-exec'

const scope = { providerKey: 'github', squadId: 'squad-one' }
const selection = { ...scope, connectionId: 'attached-alternate' }

test('selection parsing defers scope resolution to Core; explicit inner choice discards inherited intent', () => {
  const inherited = { [INTEGRATION_EXEC_SELECTION_ENV]: JSON.stringify(selection) }
  expect(inheritedExecutionSelection(undefined, inherited)).toEqual(selection)
  expect(inheritedExecutionSelection('inner-alternate', inherited)).toBeUndefined()
  expect(
    inheritedExecutionSelection('inner-alternate', { [INTEGRATION_EXEC_SELECTION_ENV]: 'malformed' })
  ).toBeUndefined()
  expect(inheritedExecutionSelection(undefined, {})).toBeUndefined()
})

test('malformed inherited selection refuses without echoing data or falling back to default', () => {
  for (const raw of [
    '',
    'not-json',
    'null',
    'false',
    '[]',
    '{}',
    JSON.stringify({ ...selection, connectionId: '' }),
    JSON.stringify({ ...selection, squadId: 5 }),
  ]) {
    expect(() => inheritedExecutionSelection(undefined, { [INTEGRATION_EXEC_SELECTION_ENV]: raw })).toThrow(
      'Invalid integration execution selection context'
    )
  }
})

test('only the current explicit selection reaches the child; unrelated/default exec clears prior intent', () => {
  const inherited = { [INTEGRATION_EXEC_SELECTION_ENV]: JSON.stringify(selection), GH_TOKEN: 'synthetic-old' }
  const result = { environment: { LINEAR_API_KEY: 'synthetic-new' }, scrubVariables: ['GH_TOKEN', 'LINEAR_API_KEY'] }
  const environment = commandExecutionEnvironment(inherited, result)
  expect(environment).toEqual({ LINEAR_API_KEY: 'synthetic-new' })
  const next = { ...selection, connectionId: 'inner-alternate' }
  const selected = commandExecutionEnvironment(inherited, result, next)
  expect(selected).toEqual({ LINEAR_API_KEY: 'synthetic-new', [INTEGRATION_EXEC_SELECTION_ENV]: JSON.stringify(next) })
  expect(inherited[INTEGRATION_EXEC_SELECTION_ENV]).toBe(JSON.stringify(selection))
})

test('exec scrubs every declared provider, including selected-provider stale values, without restricting commands', () => {
  const inherited = {
    GH_TOKEN: 'synthetic-inherited-gh',
    GITHUB_USER: 'old-user',
    LINEAR_API_KEY: 'synthetic-inherited-linear',
    EXAMPLE_TOKEN: 'synthetic-other',
    PATH: '/bin',
    ORDINARY: 'production',
  }
  const environment = commandExecutionEnvironment(inherited, {
    environment: { LINEAR_API_KEY: 'synthetic-selected' },
    scrubVariables: ['GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_USER', 'LINEAR_API_KEY', 'EXAMPLE_TOKEN'],
  })
  expect(environment).toEqual({ LINEAR_API_KEY: 'synthetic-selected', PATH: '/bin', ORDINARY: 'production' })
  expect(inherited.GH_TOKEN).toBe('synthetic-inherited-gh')
})

test('an older Core without the scrub contract fails closed rather than retaining cross-provider credentials', () => {
  expect(() => commandExecutionEnvironment({ LINEAR_API_KEY: 'synthetic-old' }, { environment: {} } as never)).toThrow(
    'execution environment contract'
  )
})

test('unrestricted exec passes exact argv and the selected environment to a real child and returns its status', async () => {
  const { runIntegrationCommand } = await import('./integration-exec')
  const before = process.listenerCount('SIGTERM')
  const code = await runIntegrationCommand(
    [
      process.execPath,
      '-e',
      'if (process.argv[1] !== "arg with spaces" || process.env.LINEAR_API_KEY !== "synthetic-selected" || process.env.GH_TOKEN) process.exit(99); process.exit(23)',
      'arg with spaces',
    ],
    {
      environment: { LINEAR_API_KEY: 'synthetic-selected' },
      scrubVariables: ['GH_TOKEN', 'LINEAR_API_KEY'],
    },
    { PATH: process.env.PATH, GH_TOKEN: 'synthetic-old-gh' }
  )
  expect(code).toBe(23)
  expect(process.listenerCount('SIGTERM')).toBe(before)
})

test.each(['SIGINT', 'SIGTERM'] as const)(
  'exec forwards %s to the real command and returns its exit status',
  async (signal) => {
    const modulePath = new URL('./integration-exec.ts', import.meta.url).pathname
    const inner = `process.on('${signal}', () => process.exit(42)); console.log('ready'); setTimeout(() => process.exit(98), 2000)`
    const program = `import { runIntegrationCommand } from ${JSON.stringify(modulePath)}; process.exitCode = await runIntegrationCommand(${JSON.stringify([process.execPath, '-e', inner])}, { environment: {}, scrubVariables: [] })`
    const child = Bun.spawn([process.execPath, '-e', program], { stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => child.kill('SIGKILL'), 4000)
    try {
      const reader = child.stdout.getReader()
      const ready = await reader.read()
      expect(new TextDecoder().decode(ready.value)).toContain('ready')
      child.kill(signal)
      expect(await child.exited).toBe(42)
      reader.releaseLock()
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) {
        child.kill('SIGKILL')
        await child.exited
      }
    }
  }
)
