import { readSync, writeSync } from 'fs'
import { isatty } from 'tty'
import type { Prompter } from './options'

// Type-ahead read past the end of one answer belongs to the next question.
let pending = ''
const decoder = new TextDecoder()

/** stdin reached end-of-file before a line was typed: nobody is there to answer. */
export class StdinClosedError extends Error {
  constructor() {
    super('stdin closed before an answer was given')
    this.name = 'StdinClosedError'
  }
}

function retryable(error: unknown): boolean {
  const code = (error as { code?: string }).code
  return code === 'EAGAIN' || code === 'EWOULDBLOCK' || code === 'EINTR'
}

/**
 * Ask on `outputFd` and read one line from fd 0 with blocking reads, leaving
 * echo, backspace and ^C to the terminal's own line discipline.
 *
 * Deliberately not readline over `process.stdin`: Bun's stdin reader waits on
 * fd 0 with kqueue, and macOS refuses kqueue on a descriptor opened from
 * /dev/tty (EINVAL). That is exactly the stdin `curl … | bash` installers hand
 * over (`exec ficus server install < /dev/tty`), and every process that
 * inherits it, so readline would print the question and never see a keystroke.
 * A blocking read(2) works on any terminal, pipe or file.
 *
 * Throws StdinClosedError when stdin reaches end-of-file before a line was typed.
 */
export function readLine(question: string, outputFd = 2): string {
  writeSync(outputFd, question)
  const chunk = new Uint8Array(4096)
  for (;;) {
    const newline = pending.indexOf('\n')
    if (newline !== -1) {
      const line = pending.slice(0, newline).replace(/\r$/, '')
      pending = pending.slice(newline + 1)
      return line
    }
    let n: number
    try {
      n = readSync(0, chunk, 0, chunk.length, null)
    } catch (error) {
      // A non-blocking description (another process may have set O_NONBLOCK on
      // the shared terminal) or a signal: wait a moment and read again.
      if (!retryable(error)) throw error
      Bun.sleepSync(20)
      continue
    }
    if (n === 0) {
      const last = pending + decoder.decode()
      pending = ''
      if (last) return last.replace(/\r$/, '')
      throw new StdinClosedError()
    }
    pending += decoder.decode(chunk.subarray(0, n), { stream: true })
  }
}

/**
 * A real terminal on both stdin and stderr — the only case that may prompt.
 * isatty, not `process.stdin.isTTY`: that getter builds Bun's stdin reader,
 * which the prompter never uses (see readLine).
 */
export function canPrompt(): boolean {
  return isatty(0) && isatty(2)
}

/** Interactive prompter on the controlling terminal (stderr keeps stdout clean for --json). */
export function terminalPrompter(): Prompter {
  const ask = async (question: string): Promise<string> => readLine(question).trim()
  return {
    async select(question, choices) {
      writeSync(2, `\n${question}\n`)
      choices.forEach((c, i) => writeSync(2, `  ${i + 1}) ${c.label}\n`))
      for (;;) {
        const answer = await ask(`Choose [1-${choices.length}]: `)
        const idx = Number(answer) - 1
        if (Number.isInteger(idx) && choices[idx]) return choices[idx].value
        const byValue = choices.find((c) => c.value === answer)
        if (byValue) return byValue.value
      }
    },
    async confirm(question) {
      const answer = await ask(`${question} [Y/n] `)
      return answer === '' || /^y(es)?$/i.test(answer)
    },
  }
}
