/**
 * `ficus` as git's `gpg.ssh.program`. Squad sandboxes point git at `ficus` when
 * commit signing is on, so git runs it exactly like `ssh-keygen`:
 *
 *   ficus -Y sign -n git -f <public key file> [-U] <buffer file>
 *
 * Signing is forwarded to Core, which holds the private key and returns the
 * armored signature; it is written to `<buffer file>.sig` as ssh-keygen would.
 *
 * Core may instead decide the object stays unsigned (the committer's own GitHub
 * account has commit signing off). It then returns an empty signature: git
 * reads the empty `.sig` and creates the commit or tag without a signature
 * header. Git adds the header only for a non-empty signature and has no
 * empty-signature check for SSH signing (tested with git 2.43 and 2.54, read
 * in git's source at 2.56, and checked by
 * apps/core/docker-sandbox/check-git-unsigned-signing.sh). The reason is
 * written to stderr, but git shows a signing program's stderr only when it
 * fails, so `git commit` itself stays quiet.
 *
 * Every other `-Y` operation (verify, find-principals, check-novalidate) runs
 * the real ssh-keygen unchanged.
 */

import type { GitHubSignResponse } from '@ficus/shared'

export interface GitSigningDependencies {
  env: Record<string, string | undefined>
  readFile(path: string): Promise<Buffer>
  writeFile(path: string, content: string): Promise<void>
  sign(squadId: string, payload: Buffer): Promise<GitHubSignResponse>
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
    const result = await deps.sign(squadId, await deps.readFile(file))
    if (typeof result?.signature !== 'string') throw new Error('Ficus returned no signature')
    if (result.signature === '' && !result.unsigned) throw new Error('Ficus returned an empty signature')
    await deps.writeFile(`${file}.sig`, result.signature)
    if (result.unsigned) deps.stderr(`ficus: ${result.unsigned.message}`)
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
      return apiPost<GitHubSignResponse>(`/api/squads/${encodeURIComponent(squadId)}/integrations/github/sign`, {
        payload: payload.toString('base64'),
      })
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
