import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { JSONRPCMessageSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { BigbrainError } from './errors'

const active = new Set<BigbrainStdioTransport>()
export async function stopAllBigbrainProcesses(): Promise<void> {
  await Promise.all([...active].map((transport) => transport.close()))
}
export interface BigbrainProcessOptions {
  executablePath: string
  vaultPath: string
  clientId: string
  tokenStorePath?: string
}
function trustedDirectory(path: string): boolean {
  try {
    let current = realpathSync(path)
    while (true) {
      const meta = statSync(current)
      if (!meta.isDirectory() || ![0, process.getuid?.()].includes(meta.uid) || (meta.mode & 0o022) !== 0) return false
      const parent = dirname(current)
      if (parent === current) return true
      current = parent
    }
  } catch {
    return false
  }
}
/** A per-operation, bounded transport. Never retains stderr or forwards Core's environment. */
export class BigbrainStdioTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  #child?: ChildProcessWithoutNullStreams
  #cwd?: string
  #cwdReady?: Promise<string>
  #closing?: Promise<void>
  #exited?: Promise<void>
  #buffer = Buffer.alloc(0)
  #stdoutBytes = 0
  #stderrBytes = 0
  #started = false
  constructor(readonly options: BigbrainProcessOptions) {}
  get pid(): number | undefined {
    return this.#child?.pid
  }
  async start(): Promise<void> {
    if (this.#closing) throw new BigbrainError('cancelled')
    if (this.#started) throw new BigbrainError('invalid_configuration')
    if (active.size >= 2) throw new BigbrainError('busy')
    this.#started = true
    active.add(this)
    try {
      this.#cwdReady = mkdtemp(join(tmpdir(), 'ficus-bigbrain-cwd-'))
      this.#cwd = await this.#cwdReady
      if (this.#closing) throw new BigbrainError('cancelled')
      // SDK's OS basics deliberately preserve OS HOME, not Ficus HOME_DIR.
      const env = getDefaultEnvironment()
      env.PATH = [
        ...new Set([
          dirname(realpathSync(process.execPath)),
          dirname(this.options.executablePath),
          '/usr/local/bin',
          '/usr/bin',
          '/bin',
        ]),
      ]
        .filter(trustedDirectory)
        .join(':')
      env.BIGBRAIN_VAULT = this.options.vaultPath
      if (this.options.tokenStorePath) env.BIGBRAIN_TOKENS = this.options.tokenStorePath
      const child = spawn(this.options.executablePath, ['mcp', '--client', this.options.clientId], {
        cwd: this.#cwd,
        env,
        shell: false,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.#child = child
      this.#exited = new Promise<void>((resolve) => child.once('close', () => resolve()))
      child.once('error', () => this.#fail('unavailable'))
      child.once('exit', () => {
        if (!this.#closing) this.#fail('unavailable')
      })
      child.stdin.on('error', () => {
        if (!this.#closing) this.#fail('unavailable')
      })
      child.stdout.on('data', (data: Buffer) => this.#receive(data))
      child.stderr.on('data', (data: Buffer) => {
        this.#stderrBytes += data.length
        if (this.#stderrBytes > 65536) this.#fail('response_too_large')
      })
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', () => reject(new BigbrainError('unavailable')))
      })
    } catch (error) {
      await this.close()
      throw error instanceof BigbrainError ? error : new BigbrainError('unavailable')
    }
  }
  #fail(code: 'invalid_response' | 'response_too_large' | 'unavailable'): void {
    if (this.#closing) return
    this.onerror?.(new BigbrainError(code))
    void this.close()
  }
  #receive(data: Buffer): void {
    if (this.#closing) return
    this.#stdoutBytes += data.length
    if (this.#stdoutBytes > 2 * 1024 * 1024) return this.#fail('response_too_large')
    this.#buffer = Buffer.concat([this.#buffer, data])
    while (true) {
      const newline = this.#buffer.indexOf(10)
      if (newline < 0) {
        if (this.#buffer.length > 1024 * 1024) this.#fail('response_too_large')
        return
      }
      if (newline > 1024 * 1024) return this.#fail('response_too_large')
      const frame = this.#buffer.subarray(0, newline)
      this.#buffer = this.#buffer.subarray(newline + 1)
      try {
        const message = JSONRPCMessageSchema.parse(JSON.parse(frame.toString('utf8')))
        this.onmessage?.(message)
      } catch {
        return this.#fail('invalid_response')
      }
    }
  }
  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.#child || this.#closing) throw new BigbrainError('unavailable')
    const frame = JSON.stringify(message) + '\n'
    if (Buffer.byteLength(frame) > 1024 * 1024) throw new BigbrainError('response_too_large')
    await new Promise<void>((resolve, reject) =>
      this.#child!.stdin.write(frame, (error) => (error ? reject(new BigbrainError('unavailable')) : resolve()))
    )
  }
  close(): Promise<void> {
    this.#closing ??= this.#close()
    return this.#closing
  }
  async #close(): Promise<void> {
    await this.#cwdReady?.catch(() => {})
    const child = this.#child
    const kill = (signal: NodeJS.Signals) => {
      if (child?.pid) {
        try {
          process.kill(-child.pid, signal)
        } catch {
          /* already gone */
        }
      }
    }
    try {
      child?.stdin.end()
      kill('SIGTERM')
      // The wrapper may exit before its children. Always escalate the owned group.
      if (child) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1000))
        kill('SIGKILL')
        await this.#exited
      }
    } finally {
      this.#buffer = Buffer.alloc(0)
      if (this.#cwd) await rm(this.#cwd, { recursive: true, force: true })
      active.delete(this)
      this.onclose?.()
    }
  }
}
