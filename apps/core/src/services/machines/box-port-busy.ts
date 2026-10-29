/**
 * A box's socket could not bind because something else holds its port.
 *
 * Box ports sat inside the kernel's ephemeral range until hosts reserved them
 * (box-ports.ts), so an outgoing loopback connection could hold one for a while
 * (ESTABLISHED, then TIME_WAIT). A squatting box user can hold one too, on hosts
 * where systemd cannot enforce the port guard. Either way the box cannot start
 * right now, but may be able to shortly. Like host-lock contention, this is
 * transient at execution startup (startup-retry.ts matches it by name).
 * Other box-provision failures stay terminal.
 */

/**
 * box-provision.sh's exit status for a busy port (`BOX_PORT_BUSY_EXIT`, sysexits'
 * EX_TEMPFAIL). The resume path's remote command exits with the same status.
 */
export const BOX_PORT_BUSY_EXIT_CODE = 75

/** Longest summary carried into user-facing stream text. */
const MAX_SUMMARY_LENGTH = 240

export class BoxPortBusyError extends Error {
  constructor(
    readonly sandboxId: string,
    readonly machineName: string,
    readonly port: number,
    /** The script's full stderr: systemd's status and journal, plus `ss` holders. */
    readonly diagnostics: string,
    /** Which step hit it: the provision script, or the resume's socket enable. */
    readonly step: 'provision' | 'resume'
  ) {
    super(
      `box ${step === 'provision' ? 'provisioning' : 'resume'} for ${sandboxId} could not bind 127.0.0.1:${port} ` +
        `on machine ${machineName} (port busy, will retry): ${diagnostics.trim()}`
    )
    this.name = 'BoxPortBusyError'
  }

  /**
   * One line naming the cause: the first socket holding the port, or systemd's
   * own bind error when the holder is already gone.
   */
  get summary(): string {
    const holder = sectionLines(this.diagnostics, '--- sockets holding port').find((line) => line !== '<none>')
    const systemd = this.diagnostics.split('\n').find((line) => line.includes('Address already in use'))
    const detail = holder ? `held by ${holder}` : systemd ? systemd : 'held by another socket'
    const text = `port ${this.port} on ${this.machineName} is busy: ${detail.trim().replace(/\s+/g, ' ')}`
    return text.length > MAX_SUMMARY_LENGTH ? `${text.slice(0, MAX_SUMMARY_LENGTH - 1)}…` : text
  }
}

/** The non-empty lines after a `--- <heading> ...` line, up to the next heading or marker. */
function sectionLines(text: string, heading: string): string[] {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.startsWith(heading))
  if (start < 0) return []
  const out: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('--- ') || line.includes('FICUS_BOX_PORT_BUSY')) break
    if (line.trim()) out.push(line.trim())
  }
  return out
}
