import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import os from 'node:os'
import { classifyServerAddress, type ServerAddressClass } from '@ficus/shared'
import { beyondLoopback } from '../../lib/infra/bind-host'

/**
 * What an administrator needs to make this server reachable from a mobile device: where the current address can be
 * opened from, whether the server is listening beyond this computer, and what this machine could offer
 * (home-network addresses, Tailscale). Everything here only reads; nothing changes the machine.
 */
export interface PhoneReachReport {
  current: { url: string | null } & ServerAddressClass
  listening: { host: string; port: number; beyondThisComputer: boolean }
  homeNetwork: { addresses: string[] }
  tailscale: TailscaleReport
}

export interface TailscaleReport {
  state: 'not-installed' | 'stopped' | 'running'
  /**
   * How the Tailscale command-line tool was found: on PATH, or only inside the macOS app (where plain
   * `tailscale` would be "command not found"). Null when Tailscale was not found.
   */
  cli: 'path' | 'app' | null
  /** The machine's HTTPS address on its tailnet, once Tailscale is running. */
  address?: string
  /** Serves this Ficus at that address, written for the tool that was found. Shown to copy; Ficus does not run it. */
  serveCommand: string
}

/** The tool that answered, and what it printed for `status --json`. */
export interface TailscaleProbe {
  output: string | null
  command: string
  kind: 'path' | 'app'
}

type Interfaces = Record<string, readonly { address: string; family: string | number; internal: boolean }[] | undefined>

/**
 * Addresses a mobile device on the same network could use. A Mac answers to its Bonjour name, which survives a new
 * IP address, so that comes first; other systems need a responder we cannot assume, so they get addresses only.
 */
export function homeNetworkAddresses(input: {
  interfaces: Interfaces
  hostname: string
  platform: string
  port: number
}): string[] {
  const addresses: string[] = []
  if (input.platform === 'darwin') {
    const name = input.hostname.toLowerCase().replace(/\.local$/, '')
    if (/^[a-z0-9-]+$/.test(name)) addresses.push(`http://${name}.local:${input.port}`)
  }
  for (const list of Object.values(input.interfaces))
    for (const entry of list ?? []) {
      if (entry.internal || (entry.family !== 'IPv4' && entry.family !== 4)) continue
      const url = `http://${entry.address}:${input.port}`
      if (classifyServerAddress(url).reach === 'home-network' && !addresses.includes(url)) addresses.push(url)
    }
  return addresses
}

function readStatus(
  output: string | null | undefined
): { BackendState?: unknown; Self?: { DNSName?: unknown } } | null {
  try {
    const parsed: unknown = output ? JSON.parse(output) : null
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

export function parseTailscaleStatus(probe: TailscaleProbe | null, port: number): TailscaleReport {
  const serveCommand = `${probe?.command ?? 'tailscale'} serve --bg http://127.0.0.1:${port}`
  const status = readStatus(probe?.output)
  if (!probe || !status) return { state: 'not-installed', cli: null, serveCommand }
  const cli = probe.kind
  const name = typeof status.Self?.DNSName === 'string' ? status.Self.DNSName.replace(/\.$/, '').toLowerCase() : ''
  if (status.BackendState !== 'Running' || !/^[a-z0-9.-]+\.ts\.net$/.test(name))
    return { state: 'stopped', cli, serveCommand }
  return { state: 'running', cli, address: `https://${name}`, serveCommand }
}

/** The macOS app carries its own copy of the tool; it is only on PATH if the person installed it there. */
const TAILSCALE_APP_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'

/** `status --json` from whichever Tailscale tool this machine has, or null when there is none. Read-only. */
export async function readTailscaleStatus(): Promise<TailscaleProbe | null> {
  const onPath = Bun.which('tailscale')
  const found: Pick<TailscaleProbe, 'command' | 'kind'> | null = onPath
    ? { command: 'tailscale', kind: 'path' }
    : existsSync(TAILSCALE_APP_CLI)
      ? { command: TAILSCALE_APP_CLI, kind: 'app' }
      : null
  if (!found) return null
  try {
    const child = Bun.spawn([onPath ?? TAILSCALE_APP_CLI, 'status', '--json'], {
      stdout: 'pipe',
      stderr: 'ignore',
      stdin: 'ignore',
    })
    const timer = setTimeout(() => child.kill(), 2500)
    try {
      const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
      return { ...found, output: code === 0 ? output : null }
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return { ...found, output: null }
  }
}

export async function phoneReachReport(input: {
  currentUrl: string | null | undefined
  bindHost: string
  port: number
  interfaces?: Interfaces
  hostname?: string
  platform?: string
  tailscaleStatus?: () => Promise<TailscaleProbe | null>
}): Promise<PhoneReachReport> {
  const { port } = input
  return {
    current: { url: input.currentUrl ?? null, ...classifyServerAddress(input.currentUrl) },
    listening: { host: input.bindHost, port, beyondThisComputer: beyondLoopback(input.bindHost) },
    homeNetwork: {
      addresses: homeNetworkAddresses({
        interfaces: input.interfaces ?? os.networkInterfaces(),
        hostname: input.hostname ?? os.hostname(),
        platform: input.platform ?? process.platform,
        port,
      }),
    },
    tailscale: parseTailscaleStatus(await (input.tailscaleStatus ?? readTailscaleStatus)(), port),
  }
}

/**
 * A secret only this process knows. `checkAddress` asks an address for it, and `/health/address-check/:token`
 * answers 204 only to the right one, so a success means the address leads back to this very server and not to
 * some other site that happens to answer.
 */
const PROCESS_PROBE_TOKEN = randomBytes(24).toString('base64url')
export const addressProbeToken = () => PROCESS_PROBE_TOKEN

export function matchesAddressProbe(candidate: string, token = PROCESS_PROBE_TOKEN): boolean {
  const a = Buffer.from(candidate)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

export type AddressCheckResult =
  { ok: true } | { ok: false; reason: 'invalid' | 'unreachable' | 'timeout' | 'certificate' | 'not-this-server' }

/**
 * Whether an address leads back to this server, tried from the server itself. That proves the name, port,
 * proxy and certificate line up. It cannot prove the path from outside: a mobile device on another network may still
 * be blocked by a router or firewall this request never crossed.
 */
export async function checkAddress(
  address: string,
  deps: { token?: string; fetch?: (url: string, init: RequestInit) => Promise<Response> } = {}
): Promise<AddressCheckResult> {
  let base: URL
  try {
    base = new URL(address)
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password)
    return { ok: false, reason: 'invalid' }
  const probe = `${base.origin}${base.pathname.replace(/\/+$/, '')}/health/address-check/${deps.token ?? PROCESS_PROBE_TOKEN}`
  try {
    const response = await (deps.fetch ?? fetch)(probe, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(6000),
      headers: { accept: '*/*' },
    })
    return response.status === 204 ? { ok: true } : { ok: false, reason: 'not-this-server' }
  } catch (error) {
    const { name, code, message } = error as { name?: string; code?: string; message?: string }
    if (name === 'TimeoutError' || name === 'AbortError') return { ok: false, reason: 'timeout' }
    if (/CERT|SSL|TLS|certificate|UNABLE_TO_VERIFY|SELF_SIGNED/i.test(`${code ?? ''} ${message ?? ''}`))
      return { ok: false, reason: 'certificate' }
    return { ok: false, reason: 'unreachable' }
  }
}
