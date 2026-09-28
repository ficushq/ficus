import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// The prompter reads fd 0 of a real process, so every case runs it in a child.
const dir = mkdtempSync(join(tmpdir(), 'ficus-prompt-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const fixture = join(dir, 'ask.ts')
writeFileSync(
  fixture,
  `import { terminalPrompter } from ${JSON.stringify(join(import.meta.dir, 'prompt'))}
import { defaultRunner } from ${JSON.stringify(join(import.meta.dir, 'runner'))}
if (process.argv[2] === 'handoff') {
  // What \`ficus server install\` does: hand the terminal to a child that prompts.
  const r = await defaultRunner([process.execPath, import.meta.path], { inherit: true })
  process.exit(r.code)
}
const p = terminalPrompter()
try {
  const runtime = await p.select('Where should agents run?', [
    { value: 'host', label: 'host' },
    { value: 'docker', label: 'docker' },
  ])
  const ok = await p.confirm('Proceed?')
  process.stdout.write('GOT=' + runtime + ',' + ok + '\\n')
} catch (error) {
  process.stdout.write('ERR=' + (error as Error).name + ': ' + (error as Error).message + '\\n')
}
`
)

async function runPiped(input: string): Promise<string> {
  const proc = Bun.spawn([process.execPath, fixture], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  proc.stdin.write(input)
  await proc.stdin.end()
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out
}

describe('terminalPrompter', () => {
  it('reads one answer per question, keeping type-ahead for the next one', async () => {
    expect(await runPiped('2\nn\n')).toBe('GOT=docker,false\n')
  })

  it('re-asks an invalid choice and takes a final line without a newline', async () => {
    expect(await runPiped('9\nhost\r\nyes')).toBe('GOT=host,true\n')
  })

  it('fails instead of spinning when stdin ends before an answer', async () => {
    expect(await runPiped('')).toBe('ERR=StdinClosedError: stdin closed before an answer was given\n')
  })

  // The installer regression. `curl … | bash` gives the CLI its terminal back
  // with `exec ficus server install < /dev/tty`; every process below inherits
  // that descriptor. On macOS kqueue refuses a /dev/tty descriptor, so a
  // readline prompter printed "Choose [1-2]:" and never saw a keystroke.
  // Linux's epoll accepts it, so there this case passes either way.
  //
  // Needs a pseudo-terminal that is the child's CONTROLLING terminal, or
  // /dev/tty cannot be opened at all (ENXIO): Bun.Terminal does not make one,
  // Python's pty.fork does (setsid + TIOCSCTTY) on both macOS and Linux.
  // Skipped only where python3 is missing (it ships on the CI runners and macOS).
  const python = Bun.which('python3')
  it.skipIf(!python || process.platform === 'win32')(
    'gets keyboard input through a handoff on a stdin opened from /dev/tty',
    async () => {
      const driver = `
import os, pty, select, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.execvp('sh', ['sh', '-c', 'exec "$0" "$1" handoff < /dev/tty', sys.argv[1], sys.argv[2]])
buf = b''
def until(token, timeout):
    global buf
    end = time.time() + timeout
    while token not in buf and time.time() < end:
        if select.select([fd], [], [], 0.1)[0]:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                break
            buf += data
    return token in buf
if until(b'Choose [1-2]: ', 20):
    time.sleep(0.3)
    os.write(fd, b'2\\r')
    if until(b'[Y/n] ', 5):
        time.sleep(0.3)
        os.write(fd, b'n\\r')
        until(b'GOT=', 5)
try:
    os.kill(pid, 9)
except OSError:
    pass
sys.stdout.write(buf.decode(errors='replace'))
`
      const proc = Bun.spawn([python!, '-c', driver, process.execPath, fixture], { stdout: 'pipe', stderr: 'pipe' })
      const transcript = await new Response(proc.stdout).text()
      await proc.exited
      expect(transcript).toContain('Choose [1-2]: ')
      expect(transcript).toContain('GOT=docker,false')
    },
    40_000
  )
})
