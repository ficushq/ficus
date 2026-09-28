/**
 * `ficus` as git's `gpg.ssh.program`. Squad sandboxes point git at `ficus` when
 * commit signing is on, so git runs it exactly like `ssh-keygen`:
 *
 *   ficus -Y sign -n git -f <public key file> [-U] <buffer file>
 *
 * Signing is forwarded to Core, which holds the private key and returns the
 * armored signature; it is written to `<buffer file>.sig` as ssh-keygen would.
 * Every other `-Y` operation (verify, find-principals, check-novalidate) runs
 * the real ssh-keygen unchanged.
 */

export interface GitSigningDependencies {
  env: Record<string, string | undefined>
  readFile(path: string): Promise<Buffer>
  writeFile(path: string, content: string): Promise<void>
  sign(squadId: string, payload: Buffer): Promise<string>
  /** Run the real ssh-keygen with inherited stdio; resolves to its exit code. */
  passthrough(args: string[]): Promise<number>
  stderr(line: string): void
}

/** True when argv (after `ficus`) is an ssh-keygen invocation git made. */
export function isSshKeygenInvocation(args: readonly string[]): boolean {
  return args[0] === '-Y'
}

export async function runSshKeygenCompat(args: string[], deps: GitSigningDependencies): Promise<number> {
  if (args[1] !== 'sign') return deps.passthrough(args)

  let namespace: string | undefined
  const files: string[] = []
  for (let i = 2; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '-n') namespace = args[++i]
    else if (arg === '-f' || arg === '-O')
      i++ // key file is git's copy of the public key; Core signs
    else if (arg.startsWith('-'))
      continue // -U and friends need nothing here
    else files.push(arg)
  }
  if (namespace !== 'git' || files.length !== 1) {
    deps.stderr('ficus: only git commit and tag signing is supported (expected -Y sign -n git ... <file>)')
    return 1
  }
  const squadId = deps.env.FICUS_GIT_SIGNING_SQUAD
  if (!squadId) {
    deps.stderr(
      'ficus: commit signing is only available through the squad git wrapper (FICUS_GIT_SIGNING_SQUAD is unset)'
    )
    return 1
  }
  const file = files[0]!
  try {
    const signature = await deps.sign(squadId, await deps.readFile(file))
    await deps.writeFile(`${file}.sig`, signature)
    return 0
  } catch (error) {
    deps.stderr(`ficus: commit signing failed: ${(error as Error).message}`)
    return 1
  }
}

export function defaultGitSigningDependencies(): GitSigningDependencies {
  return {
    env: process.env,
    readFile: async (path) => Buffer.from(await Bun.file(path).arrayBuffer()),
    writeFile: async (path, content) => {
      await Bun.write(path, content)
    },
    sign: async (squadId, payload) => {
      const { apiPost } = await import('./client')
      const result = await apiPost<{ signature: string }>(
        `/api/squads/${encodeURIComponent(squadId)}/integrations/github/sign`,
        { payload: payload.toString('base64') }
      )
      return result.signature
    },
    passthrough: async (args) => {
      const sshKeygen = Bun.which('ssh-keygen')
      if (!sshKeygen) {
        process.stderr.write('ficus: ssh-keygen is not installed; only signing works without it\n')
        return 127
      }
      const child = Bun.spawn([sshKeygen, ...args], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
      return child.exited
    },
    stderr: (line) => {
      process.stderr.write(`${line}\n`)
    },
  }
}
