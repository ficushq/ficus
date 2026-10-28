import { join } from 'node:path'
import { testDbProjectName } from '@ficus/shared/testDbPort'

export const TEST_POOLER_COMMAND_TIMEOUT_MS = 10000
const STOP_GRACE_SECONDS = 2

type TestPooler = { repoRoot: string; container?: string; env?: NodeJS.ProcessEnv }

/** Stop grace must fit inside the CLI deadline, including daemon/CLI overhead. */
export function testPoolerCommand(options: TestPooler, action: 'stop' | 'start'): string[] {
  const grace = action === 'stop' ? ['--timeout', String(STOP_GRACE_SECONDS)] : []
  return options.container
    ? ['docker', action, ...grace, options.container]
    : [
        'docker',
        'compose',
        '-p',
        testDbProjectName(options.repoRoot),
        '-f',
        join(options.repoRoot, 'docker-compose.test.yml'),
        action,
        ...grace,
        'pgbouncer',
      ]
}

export function changeTestPoolerState(options: TestPooler, action: 'stop' | 'start'): void {
  const argv = testPoolerCommand(options, action)
  const result = Bun.spawnSync(argv, {
    stdout: 'ignore',
    stderr: 'pipe',
    env: { ...(options.env ?? process.env), TEST_REPO_ROOT: options.repoRoot },
    timeout: TEST_POOLER_COMMAND_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  })
  if (result.exitCode !== 0 || result.signalCode)
    throw new Error(
      `${argv.join(' ')} failed: ${result.stderr.toString().slice(-2000) || result.signalCode || result.exitCode}`
    )
}

/** A failed stop may still have reached Docker; always attempt restoration. */
export async function withStoppedTestPooler<T>(options: TestPooler, check: () => Promise<T>): Promise<T> {
  try {
    changeTestPoolerState(options, 'stop')
    return await check()
  } finally {
    changeTestPoolerState(options, 'start')
  }
}
