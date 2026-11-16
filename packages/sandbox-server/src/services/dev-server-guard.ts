/**
 * Dev-server guard: refuse to start a second dev server on a port this box
 * already listens on.
 *
 * On 2026-11-16 one box started `next dev --port <p>` twice from two
 * directories without stopping the first; the two servers grew to 6.7 GB
 * between them and pushed the whole machine host into memory exhaustion. Every
 * agent command reaches the box through this server's bash route (the agent
 * bash and squad bash tools on every runtime), so the check lives here rather
 * than in one tool: before a command that starts a known dev server on an
 * explicit port is spawned, the box's own listening sockets are read from
 * /proc, and a port that a process of this box already holds fails fast,
 * naming that process. Managed apps (`ficus deploy`) already stop their
 * previous session before starting and get a port Core assigns, so they pass
 * their command through an environment variable this check does not parse.
 *
 * Deliberately narrow: only recognized dev-server launchers with an explicit
 * port are checked, only sockets owned by this box's user count (another box's
 * port is the port guard's business), and a command that also stops processes
 * (kill, pkill, fuser, lsof) is left alone because it is replacing the server.
 */

import { readdir, readFile, readlink } from 'node:fs/promises'

/** The exit status of a refused start (Linux EADDRINUSE). */
export const DEV_SERVER_PORT_HELD_EXIT_CODE = 98

const DEV_SERVER_LAUNCHERS: readonly RegExp[] = [
  /\bnext\s+(?:dev|start)\b/,
  /\bvite\b/,
  /\bnuxi?\s+(?:dev|preview)\b/,
  /\bastro\s+(?:dev|preview)\b/,
  /\bremix\s+(?:vite:)?dev\b/,
  /\bwebpack(?:-dev-server|\s+serve)\b/,
  /\breact-scripts\s+start\b/,
  /\b(?:ng|nx)\s+serve\b/,
  /\bstorybook\s+dev\b/,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview)\b/,
  /\bhttp\.server\b/,
  /\buvicorn\b/,
  /\bflask\s+run\b/,
  /\bmanage\.py\s+runserver\b/,
  /\brails\s+(?:s|server)\b/,
  /\bhugo\s+server\b/,
  /\bjekyll\s+serve\b/,
  /\bphp\s+-S\b/,
]

const PORT_PATTERNS: readonly RegExp[] = [
  /--port(?:=|\s+)(\d{2,5})\b/,
  /(?:^|\s)-p(?:=|\s*)(\d{2,5})\b/,
  /\bPORT=(\d{2,5})\b/,
  /\bhttp\.server\s+(\d{2,5})\b/,
  /\brunserver\s+(?:[\w.]+:)?(\d{2,5})\b/,
  /\bphp\s+-S\s+[\w.]+:(\d{2,5})\b/,
]

/** The command replaces a server itself: stopping one and starting another. */
const STOPS_PROCESSES = /\b(?:kill|pkill|killall|fuser|lsof)\b/

/** The explicit port a dev-server command would listen on, if it is one. */
export function devServerPort(command: string): number | undefined {
  if (STOPS_PROCESSES.test(command)) return undefined
  if (!DEV_SERVER_LAUNCHERS.some((pattern) => pattern.test(command))) return undefined
  for (const pattern of PORT_PATTERNS) {
    const match = pattern.exec(command)
    const port = match ? Number(match[1]) : NaN
    if (Number.isInteger(port) && port >= 1 && port <= 65535) return port
  }
  return undefined
}

export interface PortHolder {
  pid?: number
  command?: string
  cwd?: string
}

const LISTEN = '0A'
const MAX_COMMAND_LENGTH = 200

/** Socket inodes in LISTEN state on `port`, owned by `uid`, from /proc/net/tcp{,6} text. */
export function listeningInodes(table: string, port: number, uid: number): string[] {
  const inodes: string[] = []
  for (const line of table.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 10) continue
    const local = fields[1]!
    const localPort = parseInt(local.slice(local.lastIndexOf(':') + 1), 16)
    if (localPort !== port || fields[3] !== LISTEN || Number(fields[7]) !== uid) continue
    inodes.push(fields[9]!)
  }
  return inodes
}

/**
 * The process of this box listening on `port`, or undefined when none is.
 * A socket the box owns but whose process cannot be identified still counts.
 */
export async function findPortHolder(
  port: number,
  options: { procRoot?: string; uid?: number } = {}
): Promise<PortHolder | undefined> {
  const procRoot = options.procRoot ?? '/proc'
  const uid = options.uid ?? process.getuid?.() ?? -1
  if (uid < 0) return undefined
  const tables = await Promise.all(
    ['tcp', 'tcp6'].map((name) => readFile(`${procRoot}/net/${name}`, 'utf8').catch(() => ''))
  )
  const inodes = new Set(tables.flatMap((table) => listeningInodes(table, port, uid)))
  if (inodes.size === 0) return undefined
  const wanted = new Set([...inodes].map((inode) => `socket:[${inode}]`))
  const pids = (await readdir(procRoot).catch(() => [] as string[])).filter((name) => /^\d+$/.test(name))
  for (const pid of pids) {
    const fds = await readdir(`${procRoot}/${pid}/fd`).catch(() => [] as string[])
    for (const fd of fds) {
      const target = await readlink(`${procRoot}/${pid}/fd/${fd}`).catch(() => '')
      if (!wanted.has(target)) continue
      const cmdline = await readFile(`${procRoot}/${pid}/cmdline`, 'utf8').catch(() => '')
      const command = cmdline.split('\0').filter(Boolean).join(' ')
      const cwd = await readlink(`${procRoot}/${pid}/cwd`).catch(() => undefined)
      return {
        pid: Number(pid),
        command: command.length > MAX_COMMAND_LENGTH ? `${command.slice(0, MAX_COMMAND_LENGTH - 1)}…` : command,
        ...(cwd ? { cwd } : {}),
      }
    }
  }
  return {}
}

export function devServerGuardMessage(port: number, holder: PortHolder): string {
  const who =
    holder.pid !== undefined
      ? `process ${holder.pid}${holder.command ? ` (${holder.command})` : ''}${holder.cwd ? `, running in ${holder.cwd}` : ''}`
      : 'a process of this box'
  const stop = holder.pid !== undefined ? `kill ${holder.pid}` : 'stop it'
  return (
    `Refusing to start a dev server on port ${port}: it is already in use in this box by ${who}. ` +
    'A second copy would not get the port and would double the memory this box uses. ' +
    `Use the server that is already running, or stop it first (${stop}) and then start it again.`
  )
}

/** The refusal message for this command, or undefined when it may run. */
export async function checkDevServerPort(
  command: string,
  options: { procRoot?: string; uid?: number; platform?: NodeJS.Platform } = {}
): Promise<string | undefined> {
  if ((options.platform ?? process.platform) !== 'linux') return undefined
  const port = devServerPort(command)
  if (port === undefined) return undefined
  const holder = await findPortHolder(port, options).catch(() => undefined)
  return holder ? devServerGuardMessage(port, holder) : undefined
}
