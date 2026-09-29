import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ATTACHED_LOG_PATH_MAX_LENGTH,
  LocalDeploymentLogPathOutsideWorkspaceError,
  buildResolveAttachedLogPathCommand,
  buildStreamAttachedLogCommand,
  normalizeAttachedLogPathInput,
} from './local-deployment-log-path'

const SQUAD = '11111111-2222-4333-8444-555555555555'

describe('normalizeAttachedLogPathInput', () => {
  test('null / undefined / blank → null (field absent)', () => {
    expect(normalizeAttachedLogPathInput(null, SQUAD)).toBeNull()
    expect(normalizeAttachedLogPathInput(undefined, SQUAD)).toBeNull()
    expect(normalizeAttachedLogPathInput('   ', SQUAD)).toBeNull()
  })

  test('relative path joins the squad workspace mount', () => {
    // container layout is /workspace/<squadId>
    expect(normalizeAttachedLogPathInput('my-app/server.log', SQUAD)).toBe(`/workspace/${SQUAD}/my-app/server.log`)
  })

  test('absolute path inside the workspace is normalized', () => {
    expect(normalizeAttachedLogPathInput(`/workspace/${SQUAD}/./a/../b.log`, SQUAD)).toBe(`/workspace/${SQUAD}/b.log`)
  })

  test('absolute path outside the workspace is rejected', () => {
    expect(() => normalizeAttachedLogPathInput('/etc/passwd', SQUAD)).toThrow(
      LocalDeploymentLogPathOutsideWorkspaceError
    )
  })

  test('a path pointing at ANOTHER squad workspace is rejected', () => {
    const other = '99999999-8888-4777-8666-555555555554'
    expect(() => normalizeAttachedLogPathInput(`/workspace/${other}/app.log`, SQUAD)).toThrow(
      LocalDeploymentLogPathOutsideWorkspaceError
    )
  })

  test('relative traversal escaping the workspace is rejected', () => {
    expect(() => normalizeAttachedLogPathInput('../../etc/passwd', SQUAD)).toThrow(
      LocalDeploymentLogPathOutsideWorkspaceError
    )
  })

  test('the workspace root itself is rejected (must name a file under it)', () => {
    expect(() => normalizeAttachedLogPathInput('.', SQUAD)).toThrow(LocalDeploymentLogPathOutsideWorkspaceError)
  })

  test('control characters are rejected', () => {
    expect(() => normalizeAttachedLogPathInput('a\nb.log', SQUAD)).toThrow(/control characters/)
    expect(() => normalizeAttachedLogPathInput('a\0b.log', SQUAD)).toThrow(/control characters/)
  })

  test('over-long paths are rejected', () => {
    expect(() => normalizeAttachedLogPathInput(`${'a'.repeat(ATTACHED_LOG_PATH_MAX_LENGTH)}.log`, SQUAD)).toThrow(
      /too long/
    )
  })

  test('non-string input is rejected', () => {
    expect(() => normalizeAttachedLogPathInput(42 as unknown as string, SQUAD)).toThrow(/string/)
  })
})

describe('command builders', () => {
  test('missing nested paths resolve their physical ancestor and cannot escape through a symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ficus-log-containment-'))
    try {
      const workspace = join(root, 'workspace')
      const outside = join(root, 'outside')
      await mkdir(workspace)
      await mkdir(outside)
      await symlink(outside, join(workspace, 'escape'))
      const run = async (command: string) => {
        const child = Bun.spawn(['sh', '-c', command], { stdout: 'pipe', stderr: 'pipe' })
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        expect(child.signalCode).toBeNull()
        return { code, stdout, stderr }
      }
      const safe = await run(buildResolveAttachedLogPathCommand(workspace, join(workspace, 'missing/nested/log')))
      expect(safe).toMatchObject({ code: 0, stdout: `MISSING\n${await realpath(workspace)}/missing/nested/log\n` })
      const escaped = join(workspace, 'escape/missing/nested/log')
      expect(await run(buildResolveAttachedLogPathCommand(workspace, escaped))).toMatchObject({
        code: 0,
        stdout: 'OUTSIDE\n',
      })
      expect(await run(buildStreamAttachedLogCommand(workspace, escaped, 10))).toMatchObject({
        code: 3,
        stdout: '',
        stderr: 'attached log path is outside the squad workspace\n',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('resolve command quotes path and workspace and always exits 0', () => {
    const cmd = buildResolveAttachedLogPathCommand(`/workspace/${SQUAD}`, `/workspace/${SQUAD}/a'b/app.log`)
    expect(cmd).toContain(`'/workspace/${SQUAD}/a'"'"'b/app.log'`) // shell-quoted
    expect(cmd).toContain(`w='/workspace/${SQUAD}'`)
    expect(cmd).toContain('realpath -m -- "$w"')
    expect(cmd).toContain('"$w"/*)')
    expect(cmd).not.toMatch(/exit\s+[1-9]/) // no non-zero exits
  })

  test('stream command re-resolves the path and tails the re-resolved file with an inline containment guard', () => {
    const cmd = buildStreamAttachedLogCommand(`/workspace/${SQUAD}`, `/workspace/${SQUAD}/app.log`, 50)
    // Containment must hold on the path tail actually opens: a symlink swapped
    // in after the resolve exec would pass a lexical check on the stored string,
    // so the guard re-resolves here — inside the same exec as the open.
    expect(cmd).toContain(`realpath -m -- "$p"`)
    expect(cmd).toContain('realpath -m -- "$w"')
    expect(cmd).toContain('"$w"/*)')
    expect(cmd).toContain(`tail -n 50 -F "$r"`)
  })
})

describe('parseResolveAttachedLogPathOutput', () => {
  test('parses EXISTS with the resolved path', async () => {
    const { parseResolveAttachedLogPathOutput } = await import('./local-deployment-log-path')
    expect(parseResolveAttachedLogPathOutput(`EXISTS\n/workspace/1/app.log\n`)).toEqual({
      resolved: '/workspace/1/app.log',
      exists: true,
    })
  })

  test('parses MISSING', async () => {
    const { parseResolveAttachedLogPathOutput } = await import('./local-deployment-log-path')
    expect(parseResolveAttachedLogPathOutput(`MISSING\n/workspace/1/app.log\n`)).toEqual({
      resolved: '/workspace/1/app.log',
      exists: false,
    })
  })

  test('rejects malformed output', async () => {
    const { parseResolveAttachedLogPathOutput, LocalDeploymentLogPathError } =
      await import('./local-deployment-log-path')
    expect(() => parseResolveAttachedLogPathOutput('')).toThrow(LocalDeploymentLogPathError)
    expect(() => parseResolveAttachedLogPathOutput('WEIRD\n/x\n')).toThrow(LocalDeploymentLogPathError)
    expect(() => parseResolveAttachedLogPathOutput('EXISTS\n')).toThrow(LocalDeploymentLogPathError)
  })
})
