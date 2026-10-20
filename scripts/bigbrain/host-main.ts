#!/usr/bin/env bun
// The single compiled Ficus host binary (`ficus-bigbrain-host <role> ...`). One binary keeps the
// release small; each role validates its own argv and runs with the unit's own identity/limits.
import { backupMain } from './backup'
import { controlMain } from './control'
import { gatewayMain } from './gateway'
import { installMain } from './install'
import { preflightMain, sandboxMain } from './preflight'

const [role, ...rest] = process.argv.slice(2)
if (role === 'install') await installMain(rest)
else if (role === 'control') await controlMain(rest)
else if (role === 'gateway') await gatewayMain(rest)
else if (role === 'preflight') await preflightMain(rest)
else if (role === 'sandbox') await sandboxMain(rest)
else if (role === 'backup-stage' || role === 'backup-release' || role === 'reconcile-maintenance')
  await backupMain(role, rest)
else {
  console.error('Managed BigBrain host role unavailable')
  process.exitCode = 64
}
