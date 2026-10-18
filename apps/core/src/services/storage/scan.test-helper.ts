import type { Machine } from '../machines/queries'
import type { SshResult, SshRunner } from '../machines/ssh'
import { CHUNK_TIMEOUT_SECONDS, TOTAL_TIMEOUT_SECONDS } from './chunk'

/**
 * Test doubles for the storage scanner's SSH side. Nothing here contacts a real
 * machine.
 */

/**
 * Runs the real command templates with the local shell against `root`, which
 * stands in for `/` (so `/home/box_x` is `${root}/home/box_x`). Privilege and
 * I/O-class wrappers are dropped; everything else (df, timeout, xargs, du, find)
 * runs as written.
 */
export function localRunner(root: string): SshRunner & { commands: string[] } {
  const commands: string[] = []
  return {
    commands,
    async run(_machine, command, opts): Promise<SshResult> {
      commands.push(command)
      const local = command
        .replace('sudo -n ', '')
        .replace('ionice -c 3 ', '')
        .replace('df -B1 --output=used,size /home', `df -B1 --output=used,size ${root}`)
      const stdin = String(opts?.stdin ?? '')
        .split('\0')
        .map((path) => (path ? `${root}${path}` : path))
        .join('\0')
      const proc = Bun.spawn(['sh', '-c', local], {
        stdin: new TextEncoder().encode(stdin),
        stdout: 'pipe',
        stderr: 'pipe',
        cwd: root,
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      return { exitCode, stdout: stdout.split(root).join(''), stderr }
    },
  }
}

export interface FakeRemoteOptions {
  /** Directory visits (du) or listed entries (find) one chunk can afford before its time limit. */
  budget: number
  /** Paths whose command reports a permission error (exit 1) but still prints totals. */
  denied?: Set<string>
  /** Work units a directory costs (default 1), e.g. a huge flat directory. */
  cost?: Map<string, number>
  used?: number
  size?: number
  /**
   * What one total-only du reports for a path when it is less than the sum of its parts (files
   * hard-linked into several subdirectories are counted once by a single du).
   */
  totals?: Map<string, number>
  /** Work units one total-only du can afford (default: `budget` scaled by its longer time limit). */
  totalBudget?: number
}

/**
 * A simulated remote host: `dirs` maps each directory to the bytes of the
 * directory itself plus its files (multiples of 512). Speaks the chunk protocol
 * (df, NUL records, per-path `#status` markers) and stops a chunk once its work
 * budget is spent, exactly as `timeout` would (exit 124, output cut short).
 */
export function fakeRemote(dirs: Map<string, number>, options: FakeRemoteOptions) {
  const calls: Array<{ kind: 'measure' | 'list' | 'total'; paths: string[]; command: string }> = []
  let failure: (() => SshResult | never) | null = null
  const children = (path: string) =>
    [...dirs.keys()].filter((other) => other.startsWith(`${path}/`) && !other.slice(path.length + 1).includes('/'))
  const total = (path: string): number => dirs.get(path)! + children(path).reduce((sum, child) => sum + total(child), 0)
  const runner: SshRunner = {
    async run(_machine: Machine, command: string, opts) {
      const paths = String(opts?.stdin ?? '')
        .split('\0')
        .slice(0, -1)
      const kind = command.includes('find "$1"') ? 'list' : command.includes('du -x -s ') ? 'total' : 'measure'
      calls.push({ kind, paths, command })
      if (failure) return failure()
      let out = `Used 1B-blocks\n${options.used ?? 1000} ${options.size ?? 2000}\n\0`
      let budget =
        kind === 'total'
          ? (options.totalBudget ?? (options.budget * TOTAL_TIMEOUT_SECONDS) / CHUNK_TIMEOUT_SECONDS)
          : options.budget
      let timedOut = false
      const maxDepth = Number(/--max-depth=(\d+)/.exec(command)?.[1] ?? 0)
      const visit = (path: string, depth: number): boolean => {
        for (const child of children(path)) if (!visit(child, depth + 1)) return false
        budget -= options.cost?.get(path) ?? 1
        if (budget < 0) return false
        const size = kind === 'total' ? (options.totals?.get(path) ?? total(path)) : total(path)
        if (depth <= maxDepth) out += `${size}\t${path}\0`
        return true
      }
      for (const path of paths) {
        if (!dirs.has(path)) {
          out += '#1\0'
          continue
        }
        if (kind !== 'list') {
          if (!visit(path, 0)) {
            timedOut = true
            break
          }
        } else {
          const entries = children(path)
          budget -= (options.cost?.get(path) ?? 1) + entries.length
          if (budget < 0) {
            timedOut = true
            break
          }
          out += `2049\td\t1\t2\t${dirs.get(path)! / 512}\t\0`
          entries.forEach((child, index) => {
            out += `2049\td\t${index + 2}\t2\t8\t${child.slice(path.length + 1)}\0`
          })
        }
        out += options.denied?.has(path) ? '#1\0' : '#0\0'
      }
      // A cut-off record, as if `timeout` struck mid-write.
      return timedOut
        ? { exitCode: 124, stdout: `${out}12\t/home/bo`, stderr: '' }
        : { exitCode: 0, stdout: out, stderr: '' }
    },
  }
  return {
    runner,
    calls,
    total,
    /** Make every following call fail (or succeed again with null). */
    fail(next: (() => SshResult | never) | null) {
      failure = next
    },
  }
}

/** A tree of `homes` box homes, each with `width` x `width` nested subdirectories. */
export function fixtureTree(homes: number, width: number, bytes = 4096) {
  const dirs = new Map<string, number>()
  for (let h = 0; h < homes; h++) {
    const home = `/home/box_${h.toString(16).padStart(12, '0')}`
    dirs.set(home, bytes)
    for (let i = 0; i < width; i++) {
      dirs.set(`${home}/d${i}`, bytes)
      for (let j = 0; j < width; j++) dirs.set(`${home}/d${i}/e${j}`, bytes * (h + 1))
    }
  }
  return dirs
}
