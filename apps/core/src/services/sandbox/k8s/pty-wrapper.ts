import type { IPty, IDisposable, IExitEvent } from 'bun-pty'
import type { ClientDuplexStream, ShellMessage, ShellOutput } from '../client/http-client'
import { createLogger } from '../../../lib/infra/logger'

const log = createLogger('pty-wrapper')

/**
 * Helper class for implementing IPty-style event emitters.
 */
export class PtyEventEmitter<T> {
  private listeners: Set<(e: T) => void> = new Set()

  event = (listener: (e: T) => void): IDisposable => {
    this.listeners.add(listener)
    return {
      dispose: () => {
        this.listeners.delete(listener)
      },
    }
  }

  fire(data: T): void {
    for (const listener of this.listeners) {
      listener(data)
    }
  }
}

/**
 * IPty-compatible wrapper around a WebSocket-based Shell stream.
 * Allows TerminalManager to work unchanged with remote sandboxes.
 */
export class HttpPtyWrapper implements IPty {
  private readonly _onData = new PtyEventEmitter<string>()
  private readonly _onExit = new PtyEventEmitter<IExitEvent>()
  private _cols: number
  private _rows: number
  private _killed = false

  readonly pid = 0
  readonly process = 'bash'

  constructor(
    private readonly stream: ClientDuplexStream<ShellMessage, ShellOutput>,
    cols: number,
    rows: number
  ) {
    this._cols = cols
    this._rows = rows

    this.stream.on('data', (output: ShellOutput) => {
      if (this._killed) return

      if (output.data !== undefined) {
        const text = Buffer.from(output.data, 'base64').toString('utf-8')
        // log.debug(`Shell data: ${text.length} bytes`)
        this._onData.fire(text)
      } else if (output.exitCode !== undefined) {
        log.info(`Shell exited with code ${output.exitCode}`)
        this._onExit.fire({ exitCode: output.exitCode })
        this._killed = true
      } else if (output.error !== undefined) {
        log.error(`Shell error: ${output.error}`)
        this._onExit.fire({ exitCode: 1 })
        this._killed = true
      }
    })

    this.stream.on('error', (err) => {
      if (this._killed) return
      log.error(`Shell stream error:`, err)
      this._onExit.fire({ exitCode: 1 })
      this._killed = true
    })

    this.stream.on('end', () => {
      if (this._killed) return
      log.info('Shell stream ended')
      this._onExit.fire({ exitCode: 0 })
      this._killed = true
    })
  }

  get cols(): number {
    return this._cols
  }

  get rows(): number {
    return this._rows
  }

  get onData(): (listener: (data: string) => void) => IDisposable {
    return this._onData.event
  }

  get onExit(): (listener: (event: IExitEvent) => void) => IDisposable {
    return this._onExit.event
  }

  write(data: string): void {
    if (this._killed) return
    this.stream.write({ data: Buffer.from(data).toString('base64') })
  }

  resize(columns: number, rows: number): void {
    if (this._killed) return
    this._cols = columns
    this._rows = rows
    this.stream.write({ resize: { cols: columns, rows } })
  }

  kill(_signal?: string): void {
    if (this._killed) return
    this._killed = true
    this.stream.write({ kill: true })
    this.stream.end()
  }
}
