import { parseLaunchdJobIdentity } from '@ficus/shared'
import { isApiRestartCommand } from './change-detector'
import type { PlannedCommand } from './types'

export interface ProcessResult {
  exitCode: number
  output: string
}
export type RunProcess = (
  command: string[],
  cwd: string,
  timeoutMs: number,
  onOutput?: (chunk: string) => void
) => Promise<ProcessResult>
export type DispatchProcess = (command: string[], cwd: string) => void

/** Exit status of a child that received SIGTERM (128 + 15): the fate of a systemctl child when
 *  the unit it just asked to restart is stopped before it returns. */
export const SIGTERM_EXIT_CODE = 143
export function isKilledByOwnRestart(exitCode: number): boolean {
  return exitCode === SIGTERM_EXIT_CODE
}

export class UpdateCommandError extends Error {
  constructor(
    public command: string[],
    public exitCode: number | undefined,
    public outputTail: string
  ) {
    super(`Update command failed: ${command.join(' ')}`)
  }
}

function tail(text: string, max = 8192): string {
  return text.length > max ? text.slice(text.length - max) : text
}

async function readProcessStream(
  stream: ReadableStream<Uint8Array>,
  onOutput?: (chunk: string) => void
): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let output = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = decoder.decode(value, { stream: true })
    output += chunk
    onOutput?.(chunk)
  }

  const finalChunk = decoder.decode()
  if (finalChunk) {
    output += finalChunk
    onOutput?.(finalChunk)
  }

  return output
}

async function defaultRunProcess(
  command: string[],
  cwd: string,
  timeoutMs: number,
  onOutput?: (chunk: string) => void
): Promise<ProcessResult> {
  const proc = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const timeout = setTimeout(() => proc.kill(), timeoutMs)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readProcessStream(proc.stdout, onOutput),
      readProcessStream(proc.stderr, onOutput),
      proc.exited,
    ])
    return { exitCode, output: `${stdout}${stderr}` }
  } finally {
    clearTimeout(timeout)
  }
}

function defaultDispatchProcess(command: string[], cwd: string): void {
  Bun.spawn(command, { cwd, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }).unref()
}

function launchdTarget(command: string[]): string | undefined {
  return command.length === 4 && command[0] === 'launchctl' && command[1] === 'kickstart' && command[2] === '-k'
    ? command[3]
    : undefined
}

export class CommandRunner {
  private cwd: string
  private timeoutMs: number
  private runProcess: RunProcess
  private dispatchProcess: DispatchProcess
  private onUpdate?: () => void

  constructor(options: {
    cwd: string
    timeoutMs?: number
    runProcess?: RunProcess
    dispatchProcess?: DispatchProcess
    onUpdate?: () => void
  }) {
    this.cwd = options.cwd
    this.timeoutMs = options.timeoutMs ?? 30 * 60 * 1000
    this.runProcess = options.runProcess ?? defaultRunProcess
    this.dispatchProcess = options.dispatchProcess ?? defaultDispatchProcess
    this.onUpdate = options.onUpdate
  }

  async runAll(commands: PlannedCommand[]): Promise<void> {
    // launchd labels live independently from their plist files. Prove every
    // target still belongs to this checkout before the first kickstart, so a
    // stale API target cannot be discovered only after the worker was mutated.
    const launchdRestarts = commands.filter((planned) =>
      /^gui\/\d+\/ai\.hiretau\.tau(?:-[a-z0-9-]+)?-(?:worker|api)$/.test(launchdTarget(planned.command) ?? '')
    )
    for (const planned of launchdRestarts) {
      const target = launchdTarget(planned.command) as string
      const probe = await this.runProcess(['launchctl', 'print', target], this.cwd, this.timeoutMs)
      const identity = parseLaunchdJobIdentity(probe.output)
      if (probe.exitCode !== 0 || identity.workingDirectory !== this.cwd) {
        planned.status = 'failed'
        planned.exitCode = probe.exitCode === 0 ? 1 : probe.exitCode
        planned.outputTail = tail(
          probe.exitCode !== 0
            ? probe.output
            : `launchd job ${target} could not be verified for checkout ${this.cwd} (working directory ${identity.workingDirectory ?? '?'})`
        )
        this.onUpdate?.()
        throw new UpdateCommandError(planned.command, planned.exitCode, planned.outputTail)
      }
    }

    for (const planned of commands) {
      planned.status = 'running'
      planned.outputTail = ''
      this.onUpdate?.()
      // PM2 and launchd API restarts terminate this process before a child result can be observed,
      // so they must be handed off. The systemd flavors queue asynchronously, but their stop
      // job can still kill this process the instant the manager accepts it — so the accepted
      // outcome is persisted BEFORE issuing the command, and a manager rejection observed
      // afterwards still overwrites it with the real failure.
      if (isApiRestartCommand(planned.command) && !planned.command.includes('systemctl')) {
        planned.status = 'succeeded'
        planned.exitCode = 0
        planned.outputTail = 'API restart handed off; process is restarting.'
        this.onUpdate?.()
        this.dispatchProcess(planned.command, this.cwd)
        return
      }
      if (isApiRestartCommand(planned.command)) {
        planned.status = 'succeeded'
        planned.exitCode = 0
        planned.outputTail = 'API restart accepted by systemd; queued for this unit.'
        this.onUpdate?.()
        const result = await this.runProcess(planned.command, this.cwd, this.timeoutMs)
        if (isKilledByOwnRestart(result.exitCode)) {
          // The manager began stopping this unit — and with it this whole cgroup, the
          // systemctl child included — before systemctl could return. That is the restart
          // working; the boot-time reconciler will finish the run.
          planned.exitCode = result.exitCode
          planned.outputTail = 'API restart accepted by systemd; this process was stopped before systemctl returned.'
          this.onUpdate?.()
          continue
        }
        if (result.exitCode !== 0) {
          planned.status = 'failed'
          planned.exitCode = result.exitCode
          planned.outputTail = tail(result.output)
          this.onUpdate?.()
          throw new UpdateCommandError(planned.command, result.exitCode, planned.outputTail)
        }
        continue
      }
      const result = await this.runProcess(planned.command, this.cwd, this.timeoutMs, (chunk) => {
        planned.outputTail = tail(`${planned.outputTail ?? ''}${chunk}`)
        this.onUpdate?.()
      })
      planned.exitCode = result.exitCode
      planned.outputTail = tail(result.output)
      if (result.exitCode !== 0) {
        planned.status = 'failed'
        this.onUpdate?.()
        throw new UpdateCommandError(planned.command, result.exitCode, planned.outputTail)
      }
      planned.status = 'succeeded'
      this.onUpdate?.()
    }
  }
}
