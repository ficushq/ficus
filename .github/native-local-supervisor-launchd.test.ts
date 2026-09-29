import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { launchdNames, launchdSupervisor, nativeLogPath } from '../apps/cli/src/local-server/launchd'
import { defaultRunner } from '../apps/cli/src/local-server/runner'
import { makeSupervisorContext } from '../apps/cli/src/local-server/supervisor'

async function eventually<T>(read: () => Promise<T>, ready: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = performance.now() + timeoutMs
  let value = await read()
  while (!ready(value) && performance.now() < deadline) {
    await Bun.sleep(200)
    value = await read()
  }
  expect(ready(value), `Readiness never reached; last observation: ${JSON.stringify(value)}`).toBe(true)
  return value
}

test('real launchd adapter lifecycle in the current GUI session', async () => {
  expect(process.platform).toBe('darwin')
  const root = mkdtempSync(join(process.env.RUNNER_TEMP ?? '/tmp', 'ficus-launchd-'))
  const label = `ci-${process.pid}`
  const home = homedir()
  const context = makeSupervisorContext({
    supervisor: 'launchd',
    root,
    label,
    runner: defaultRunner,
    log: () => {},
    home,
    platform: 'darwin',
    bunPath: process.execPath,
  })
  const definitions = ['api', 'worker'].map((component) => launchdNames(context, component as 'api' | 'worker'))
  try {
    mkdirSync(join(root, 'apps/core/dist'), { recursive: true })
    mkdirSync(join(root, 'node_modules/bun-pty/rust-pty/target/release'), { recursive: true })
    writeFileSync(
      join(
        root,
        'node_modules/bun-pty/rust-pty/target/release',
        process.arch === 'arm64' ? 'librust_pty_arm64.dylib' : 'librust_pty.dylib'
      ),
      ''
    )
    for (const file of ['index.js', 'worker.js'])
      writeFileSync(
        join(root, 'apps/core/dist', file),
        `console.log('${file} ready ' + process.pid); console.error('${file} stderr ' + process.pid); setInterval(() => {}, 1000)\n`
      )

    await launchdSupervisor.start(context)
    const first = await eventually(
      () => launchdSupervisor.status(context),
      (rows) => rows.every((row) => row.pid > 0)
    )
    const pids = new Map(first.map((row) => [row.name, row.pid]))
    // launchd reports a PID while xpcproxy is still preparing exec. Restarting
    // that PID can kill startup before the fixture runs. Await the actual fixture,
    // and match its incarnation so old log output cannot make restart green.
    const awaitLogs = (incarnations: Map<string, number>) =>
      eventually(
        async () => definitions.map((d) => (existsSync(d.log) ? readFileSync(d.log, 'utf8') : '')),
        (logs) =>
          logs.every(
            (log, index) =>
              log.includes(`ready ${incarnations.get(definitions[index]!.process)}`) &&
              log.includes(`stderr ${incarnations.get(definitions[index]!.process)}`)
          )
      )
    await awaitLogs(pids)
    await launchdSupervisor.restart(context)
    const restarted = await eventually(
      () => launchdSupervisor.status(context),
      (rows) => rows.every((row) => row.pid > 0 && row.pid !== pids.get(row.name))
    )
    await awaitLogs(new Map(restarted.map((row) => [row.name, row.pid])))

    await launchdSupervisor.stop(context)
    await launchdSupervisor.uninstall(context)
    expect(definitions.every((d) => !existsSync(d.plist))).toBe(true)
    expect(definitions.every((d) => existsSync(d.log))).toBe(true)
  } catch (error) {
    for (const d of definitions) {
      const state = await defaultRunner(['launchctl', 'print', `gui/${context.uid}/${d.label}`])
      console.error(
        d.label,
        state.stdout
          .split('\n')
          .filter((line) =>
            /^\s*(state|pid|last exit code|stdout path|stderr path|working directory|program) =/.test(line)
          )
          .join('\n')
      )
      console.error('fixture log:', existsSync(d.log) ? readFileSync(d.log, 'utf8') : '<missing>')
    }
    throw error
  } finally {
    for (const d of definitions) {
      await defaultRunner(['launchctl', 'bootout', `gui/${context.uid}/${d.label}`])
      rmSync(d.plist, { force: true })
      rmSync(nativeLogPath(context, d.process.endsWith('-api') ? 'api' : 'worker'), { force: true })
    }
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
