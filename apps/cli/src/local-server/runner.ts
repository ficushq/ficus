export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export interface RunOptions {
  cwd?: string
  /** Laid over this process's environment; a key mapped to undefined is removed from the child's. */
  env?: Record<string, string | undefined>
  /** Inherit the terminal (interactive builds, pm2 logs -f). stdout/stderr are then ''. */
  inherit?: boolean
  timeoutMs?: number
}

/** Every subprocess the installer starts goes through one of these. */
export type Runner = (command: string[], options?: RunOptions) => Promise<RunResult>

export const defaultRunner: Runner = async (command, options = {}) => {
  let proc: ReturnType<typeof Bun.spawn>
  // options.env is laid over this process's environment; a key it maps to undefined is removed.
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries({ ...process.env, ...(options.env ?? {}) }))
    if (value !== undefined) env[key] = value
  try {
    proc = Bun.spawn(command, {
      cwd: options.cwd,
      env,
      stdin: options.inherit ? 'inherit' : 'ignore',
      stdout: options.inherit ? 'inherit' : 'pipe',
      stderr: options.inherit ? 'inherit' : 'pipe',
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { code: 127, stdout: '', stderr: msg }
  }

  const timer = options.timeoutMs ? setTimeout(() => proc.kill(), options.timeoutMs) : undefined
  try {
    const [stdout, stderr, code] = await Promise.all([
      options.inherit ? Promise.resolve('') : new Response(proc.stdout as ReadableStream).text(),
      options.inherit ? Promise.resolve('') : new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ])
    return { code, stdout, stderr }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { code: 127, stdout: '', stderr: msg }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export interface RecordedCall {
  command: string[]
  options: RunOptions
}

/**
 * Test/dry-run runner: records every call and answers from `responses`
 * (matched by the joined command prefix), defaulting to exit 0 / empty output.
 */
export function recordingRunner(responses: Record<string, Partial<RunResult>> = {}) {
  const calls: RecordedCall[] = []
  const runner: Runner = async (command, options = {}) => {
    calls.push({ command, options })
    const joined = command.join(' ')
    const key = Object.keys(responses).find((prefix) => joined.startsWith(prefix))
    return { code: 0, stdout: '', stderr: '', ...(key ? responses[key] : {}) }
  }
  return { runner, calls }
}
