#!/usr/bin/env bun
/**
 * Manual test DB management using the same isolation logic as test-setup.ts.
 * Usage: bun run src/test-db.ts up|down
 */
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { findFreeTestDbPort, testDbPortFile, testDbProjectName } from '@ficus/shared/testDbPort'
import { isComposePostgresReady } from '@ficus/shared/testDbReady'
import { ensureTestDbUp } from '@ficus/shared/testDbUp'

const repoRoot = join(__dirname, '..')
const composeFile = join(repoRoot, 'docker-compose.test.yml')
const portFile = testDbPortFile(repoRoot)
const projectName = testDbProjectName(repoRoot)
// cwd for canExecuteQuery's spawned verification script — must resolve the
// `postgres` package via node_modules; apps/core's own root works.
const appCwd = existsSync(join(repoRoot, 'apps/core')) ? join(repoRoot, 'apps/core') : repoRoot

const command = process.argv[2]

if (command === 'up') {
  const READY_TIMEOUT_MS = 5000
  const isReady = (port: number) =>
    isComposePostgresReady(port, { projectName, composeFile, cwd: appCwd, timeoutMs: READY_TIMEOUT_MS })

  const result = ensureTestDbUp({
    portFileExists: () => existsSync(portFile),
    readCachedPort: () => parseInt(readFileSync(portFile, 'utf-8').trim(), 10),
    isReady,
    allocatePort: findFreeTestDbPort,
    dockerComposeUp: (port) => {
      Bun.spawnSync(['docker', 'compose', '-p', projectName, '-f', composeFile, 'up', '-d', 'postgres'], {
        stdout: 'inherit',
        stderr: 'inherit',
        env: { ...process.env, TEST_DB_PORT: String(port), TEST_REPO_ROOT: repoRoot },
      })
    },
    waitUntilReady: (port) => {
      const maxWait = 30
      for (let i = 0; i < maxWait; i++) {
        if (isReady(port)) return true
        Bun.sleepSync(1000)
      }
      return isReady(port)
    },
    writePortFile: (port) => writeFileSync(portFile, String(port)),
    log: (msg) => console.log(msg),
  })

  if (!result.ok) {
    console.error(result.error)
    process.exit(1)
  }
  console.log(`Test postgres ready on port ${result.port} (project: ${projectName}); wrote ${portFile}`)
  process.exit(0)
} else if (command === 'down') {
  // Use the cached port if we have one (matches the container's real
  // binding); otherwise fall back to the compose default. Either way, `down`
  // targets the project by name, not by port, so this only affects the env
  // docker-compose.test.yml substitutes into its label metadata.
  const port = existsSync(portFile) ? readFileSync(portFile, 'utf-8').trim() : '5433'
  const env = { ...process.env, TEST_DB_PORT: port, TEST_REPO_ROOT: repoRoot }
  // --volumes: test DBs are ephemeral; without it, any image-declared VOLUME
  // path not covered by the compose tmpfs orphans an anonymous volume per run.
  const result = Bun.spawnSync(['docker', 'compose', '-p', projectName, '-f', composeFile, 'down', '--volumes'], {
    stdout: 'inherit',
    stderr: 'inherit',
    env,
  })
  process.exit(result.exitCode ?? 0)
} else {
  console.error('Usage: bun run src/test-db.ts up|down')
  process.exit(1)
}
