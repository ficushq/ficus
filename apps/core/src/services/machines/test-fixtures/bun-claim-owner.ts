// Owned child-loss boundary, never a live host command. Parent owns/removes root.
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { withIdleBunRuntimeClaim } from '../bun-runtime-adoption'

const root = process.env.FICUS_BUN_CLAIM_FIXTURE_ROOT
if (process.env.NODE_ENV !== 'test' || !root?.startsWith('/tmp/bun-owner-loss-'))
  throw new Error('Requires an owned fixture root')
const box = JSON.parse(process.env.FICUS_BUN_CLAIM_FIXTURE_BOX!)
const runner = {
  run: async (_machine: unknown, command: string) => {
    const result = Bun.spawnSync(
      [
        'bash',
        '-c',
        command
          .replaceAll(`/home/${box.unixUser}`, join(root, 'home'))
          .replaceAll('/opt/ficus/bin/bun', join(root, 'bin/bun')),
      ],
      {
        env: { PATH: `${root}/bin:/usr/bin:/bin`, STATE_ROOT: root, FICUS_HOST_ROOT: root },
      }
    )
    return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
  },
}
await withIdleBunRuntimeClaim(
  { id: 'm1' } as any,
  box,
  '1.4.2',
  async () => {
    const phase = process.env.FICUS_BUN_CLAIM_FIXTURE_PHASE
    if (phase === 'env-published') writeFileSync(join(root, 'home/server.env'), 'owned fixture env\n')
    if (phase === 'server-started') writeFileSync(join(root, 'server'), 'active\n')
    if (phase === 'pending') {
      const directory = join(root, 'home/.ficus/runtime/bash-invocations/active')
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'unknown.json'), '{"state":"quarantined"}')
    }
    // SIGKILL cannot run JavaScript finally or an exit hook.
    process.kill(process.pid, 'SIGKILL')
    await new Promise(() => {})
  },
  runner
)
throw new Error('Owner-loss boundary was not reached')
