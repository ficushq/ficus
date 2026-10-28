#!/usr/bin/env bun
/**
 * Manual test DB management using the same isolation logic as test-setup.ts.
 * Usage: bun run src/test-db.ts up|down
 */
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { findFreeTestDbPort, testDbPortFile, testDbProjectName } from '@ficus/shared/testDbPort'
import { isComposePostgresReady } from '@ficus/shared/testDbReady'
import { ownTestDb, sweepStaleTestDbs, stopOwnedTestDb } from '@ficus/shared/testDbLifecycle'
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
  sweepStaleTestDbs(repoRoot)
  ownTestDb(repoRoot)
  const READY_TIMEOUT_MS = 5000
  const isReady = (port: number) =>
    isComposePostgresReady(port, { projectName, composeFile, cwd: appCwd, timeoutMs: READY_TIMEOUT_MS })

  const result = ensureTestDbUp({
    portFileExists: () => existsSync(portFile),
    readCachedPort: () => parseInt(readFileSync(portFile, 'utf-8').trim(), 10),
    isReady,
    allocatePort: findFreeTestDbPort,
    dockerComposeUp: (port) => {
      const up = Bun.spawnSync(['docker', 'compose', '-p', projectName, '-f', composeFile, 'up', '-d', 'postgres'], {
        stdout: 'inherit',
        stderr: 'inherit',
        env: { ...process.env, TEST_DB_PORT: String(port), TEST_REPO_ROOT: repoRoot },
        timeout: 30000,
        killSignal: 'SIGKILL',
      })
      if (up.exitCode !== 0 || up.signalCode)
        throw new Error('Test database startup failed; see Compose diagnostic above')
    },
    waitUntilReady: (port) => {
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        if (isReady(port)) return true
        Bun.sleepSync(1000)
      }
      return false
    },
    writePortFile: (port) => writeFileSync(portFile, String(port)),
    log: (msg) => console.log(msg),
  })

  if (!result.ok) {
    console.error(result.error)
    process.exit(1)
  }
  console.log(`Test postgres ready on port ${result.port} (project: ${projectName}); wrote ${portFile}`)
  console.log('Database is owned by this foreground session; Ctrl-C tears it down (including volumes).')
  setInterval(() => {}, 60000)
} else if (command === 'down') {
  process.exit(stopOwnedTestDb(repoRoot) ? 0 : 1)
} else {
  console.error('Usage: bun run src/test-db.ts up|down')
  process.exit(1)
}
