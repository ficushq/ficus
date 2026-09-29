import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { generateSshSigningKey, signSshSig, sshKeyFingerprint } from './ssh-signature'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ficus-sshsig-')))
  dirs.push(dir)
  return dir
}

function run(command: string[], options: { cwd?: string; stdin?: Buffer; env?: Record<string, string> } = {}) {
  const result = Bun.spawnSync(command, {
    cwd: options.cwd,
    stdin: options.stdin ?? 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...options.env },
  })
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

describe('SSHSIG signing', () => {
  it('produces signatures ssh-keygen verifies for the git namespace', () => {
    const dir = tempDir()
    const key = generateSshSigningKey('tau-test')
    const data = Buffer.from('tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\ncommitter A <a@x> 1 +0000\n\nmsg\n')
    writeFileSync(join(dir, 'allowed'), `a@x ${key.publicKey}\n`)
    writeFileSync(join(dir, 'data.sig'), signSshSig(key.privateKey, data, 'git'))

    const verify = run(
      ['ssh-keygen', '-Y', 'verify', '-f', join(dir, 'allowed'), '-I', 'a@x', '-n', 'git', '-s', join(dir, 'data.sig')],
      { stdin: data }
    )
    expect(verify.stdout + verify.stderr).toContain('Good "git" signature for a@x')
    expect(verify.code).toBe(0)

    // Any change to the signed bytes or the namespace must fail verification.
    const tampered = run(
      ['ssh-keygen', '-Y', 'verify', '-f', join(dir, 'allowed'), '-I', 'a@x', '-n', 'git', '-s', join(dir, 'data.sig')],
      { stdin: Buffer.concat([data, Buffer.from('x')]) }
    )
    expect(tampered.code).not.toBe(0)
    const otherNamespace = run(
      [
        'ssh-keygen',
        '-Y',
        'verify',
        '-f',
        join(dir, 'allowed'),
        '-I',
        'a@x',
        '-n',
        'file',
        '-s',
        join(dir, 'data.sig'),
      ],
      { stdin: data }
    )
    expect(otherNamespace.code).not.toBe(0)
  })

  it('reports the same fingerprint as ssh-keygen -l', () => {
    const dir = tempDir()
    const key = generateSshSigningKey('tau-test')
    writeFileSync(join(dir, 'key.pub'), `${key.publicKey}\n`)
    const listed = run(['ssh-keygen', '-l', '-f', join(dir, 'key.pub')])
    expect(listed.code).toBe(0)
    expect(listed.stdout.split(' ')[1]).toBe(sshKeyFingerprint(key.publicKey))
  })

  it('signs the exact buffer git hands its signing program, and git verifies the commit', () => {
    const repo = tempDir()
    const key = generateSshSigningKey('tau-test')
    const env = {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Agent',
      GIT_AUTHOR_EMAIL: 'agent@example.com',
      GIT_COMMITTER_NAME: 'Agent',
      GIT_COMMITTER_EMAIL: 'agent@example.com',
    }
    expect(run(['git', 'init', '-q'], { cwd: repo, env }).code).toBe(0)
    expect(run(['git', 'commit', '-q', '--allow-empty', '-m', 'unsigned'], { cwd: repo, env }).code).toBe(0)

    // An unsigned commit object is byte-for-byte the payload git signs; add
    // the gpgsig header the way git does and let git itself verify it.
    const payload = Buffer.from(run(['git', 'cat-file', 'commit', 'HEAD'], { cwd: repo, env }).stdout)
    const signature = signSshSig(key.privateKey, payload, 'git').trimEnd()
    const text = payload.toString()
    const headerEnd = text.indexOf('\n\n')
    const signed = `${text.slice(0, headerEnd)}\ngpgsig ${signature.split('\n').join('\n ')}${text.slice(headerEnd)}`
    const written = run(['git', 'hash-object', '-t', 'commit', '-w', '--stdin'], {
      cwd: repo,
      env,
      stdin: Buffer.from(signed),
    })
    expect(written.code).toBe(0)

    writeFileSync(join(repo, '.allowed'), `agent@example.com ${key.publicKey}\n`)
    const verify = run(
      ['git', '-c', `gpg.ssh.allowedSignersFile=${join(repo, '.allowed')}`, 'verify-commit', written.stdout.trim()],
      {
        cwd: repo,
        env,
      }
    )
    expect(verify.stderr).toContain('Good "git" signature for agent@example.com')
    expect(verify.code).toBe(0)
  })
})
