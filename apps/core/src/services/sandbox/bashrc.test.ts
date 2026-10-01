import { describe, test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildBashrcContent } from './bashrc'

describe('buildBashrcContent', () => {
  test('k8s/docker (no devboxDir): activation gated on a host-visible devbox.json, bare shellenv', () => {
    const ws = mkdtempSync(join(tmpdir(), 'bashrc-ws-'))
    writeFileSync(join(ws, 'devbox.json'), '{"packages":["ripgrep@latest"]}')

    const content = buildBashrcContent(ws, '/workspace')

    // Sources the workspace .env at the container mount.
    expect(content).toContain('[ -f /workspace/.ficus/.env ] && set -a && . /workspace/.ficus/.env && set +a')
    // Bare `devbox shellenv` (devbox.json is the shell's cwd on k8s/docker).
    expect(content).toContain('eval "$(devbox shellenv --init-hook 2>/dev/null)" 2>/dev/null || true')
    // NOT the box-mode `cd <dir> && devbox shellenv` form.
    expect(content).not.toContain('cd ')
    rmSync(ws, { recursive: true, force: true })
  })

  test('k8s/docker (no devboxDir): NO activation when the host workspace lacks devbox.json', () => {
    const ws = mkdtempSync(join(tmpdir(), 'bashrc-ws-'))
    const content = buildBashrcContent(ws, '/workspace')
    expect(content).not.toContain('devbox shellenv')
    rmSync(ws, { recursive: true, force: true })
  })

  test('vm box (devboxDir): activates the box devbox from its fixed dir, no host existsSync', () => {
    // No devbox.json on THIS host at all — box mode must still emit activation
    // (the devbox lives on the box, out of the shell cwd).
    const content = buildBashrcContent('/home/box_x/workspace', '/home/box_x/workspace', {
      devboxDir: '/home/box_x/.tau/devbox',
    })

    expect(content).toContain(
      'eval "$(cd /home/box_x/.tau/devbox && devbox shellenv --init-hook 2>/dev/null)" 2>/dev/null || true'
    )
    expect(content).toContain('devbox() {')
    expect(content).toContain('search="$PWD"')
    expect(content).toContain('command devbox "$@"')
    expect(content).toContain('.shellenv-dirty.$$')
    // Sources the box's physical workspace .env.
    expect(content).toContain('[ -f /home/box_x/workspace/.ficus/.env ]')
  })
})
