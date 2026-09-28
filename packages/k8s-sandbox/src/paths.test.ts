import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { resolvePath, getDevboxDir, getDevboxJsonPath, rebaseLogicalRoot } from './paths'

// Save and restore WORKSPACE_PATH / FICUS_DEVBOX_DIR / FICUS_BOX_HOME / FICUS_SQUAD_ID across tests
const originalWorkspace = process.env.WORKSPACE_PATH
const originalDevboxDir = process.env.FICUS_DEVBOX_DIR
const originalBoxHome = process.env.FICUS_BOX_HOME
const originalSquadId = process.env.FICUS_SQUAD_ID

beforeEach(() => {
  process.env.WORKSPACE_PATH = '/workspace'
  delete process.env.FICUS_DEVBOX_DIR
  delete process.env.FICUS_BOX_HOME
  delete process.env.FICUS_SQUAD_ID
})

afterEach(() => {
  if (originalWorkspace !== undefined) {
    process.env.WORKSPACE_PATH = originalWorkspace
  } else {
    delete process.env.WORKSPACE_PATH
  }
  if (originalDevboxDir !== undefined) {
    process.env.FICUS_DEVBOX_DIR = originalDevboxDir
  } else {
    delete process.env.FICUS_DEVBOX_DIR
  }
  if (originalBoxHome !== undefined) {
    process.env.FICUS_BOX_HOME = originalBoxHome
  } else {
    delete process.env.FICUS_BOX_HOME
  }
  if (originalSquadId !== undefined) {
    process.env.FICUS_SQUAD_ID = originalSquadId
  } else {
    delete process.env.FICUS_SQUAD_ID
  }
})

describe('getDevboxDir / getDevboxJsonPath', () => {
  it('falls back to WORKSPACE_PATH when FICUS_DEVBOX_DIR is unset (squad box)', () => {
    process.env.WORKSPACE_PATH = '/workspace/squad-abc'
    expect(getDevboxDir()).toBe('/workspace/squad-abc')
    expect(getDevboxJsonPath()).toBe('/workspace/squad-abc/devbox.json')
  })

  it('honors FICUS_DEVBOX_DIR over WORKSPACE_PATH (per-agent light box)', () => {
    // The crux of the boot-hang bug: an agent box shares the squad WORKSPACE_PATH
    // (heavy, un-realized toolchain) but keeps its OWN empty devbox in /private.
    // The executor must resolve /private, matching the entrypoint, so the empty
    // devbox short-circuits cacheDevboxShellEnv instead of hanging on `devbox shellenv`.
    process.env.WORKSPACE_PATH = '/workspace/squad-abc'
    process.env.FICUS_DEVBOX_DIR = '/private'
    expect(getDevboxDir()).toBe('/private')
    expect(getDevboxJsonPath()).toBe('/private/devbox.json')
  })

  it('defaults to /workspace when neither is set', () => {
    delete process.env.WORKSPACE_PATH
    expect(getDevboxDir()).toBe('/workspace')
    expect(getDevboxJsonPath()).toBe('/workspace/devbox.json')
  })
})

describe('resolvePath', () => {
  it('resolves absolute paths within /workspace', () => {
    expect(resolvePath('/workspace/src/index.ts')).toBe('/workspace/src/index.ts')
  })

  it('resolves relative paths against workspace', () => {
    expect(resolvePath('src/index.ts')).toBe('/workspace/src/index.ts')
  })

  it('resolves paths in /memory', () => {
    expect(resolvePath('/memory/vault/notes.md')).toBe('/memory/vault/notes.md')
  })

  it('resolves paths in /home/tau', () => {
    expect(resolvePath('/home/tau/.ssh/known_hosts')).toBe('/home/tau/.ssh/known_hosts')
  })

  it('resolves paths in /nix', () => {
    expect(resolvePath('/nix/store/abc-package/bin/tool')).toBe('/nix/store/abc-package/bin/tool')
  })

  it('resolves paths in /opt/tau', () => {
    expect(resolvePath('/opt/tau/skills/some-skill/SKILL.md')).toBe('/opt/tau/skills/some-skill/SKILL.md')
  })

  it('resolves paths in /tmp', () => {
    expect(resolvePath('/tmp/scratch.txt')).toBe('/tmp/scratch.txt')
  })

  it('resolves paths in /private', () => {
    expect(resolvePath('/private/scratch.txt')).toBe('/private/scratch.txt')
  })

  it('rejects paths outside allowed directories', () => {
    expect(() => resolvePath('/etc/passwd')).toThrow('Path outside allowed directories')
    expect(() => resolvePath('/root/.ssh/id_rsa')).toThrow('Path outside allowed directories')
    expect(() => resolvePath('/var/log/syslog')).toThrow('Path outside allowed directories')
  })

  it('rejects path traversal attacks', () => {
    expect(() => resolvePath('/workspace/../../etc/passwd')).toThrow('Path outside allowed directories')
    expect(() => resolvePath('../../etc/shadow')).toThrow('Path outside allowed directories')
  })

  it('normalizes paths with . and ..', () => {
    expect(resolvePath('/workspace/src/../lib/util.ts')).toBe('/workspace/lib/util.ts')
    expect(resolvePath('/workspace/./src/index.ts')).toBe('/workspace/src/index.ts')
  })

  it('rejects the bare prefix without trailing content (except exact match)', () => {
    // /workspace itself is allowed
    expect(resolvePath('/workspace')).toBe('/workspace')
    // /workspacefoo is not (no slash separator)
    expect(() => resolvePath('/workspacefoo')).toThrow('Path outside allowed directories')
  })

  it('rejects sibling directory attacks on allowed prefixes', () => {
    expect(() => resolvePath('/workspace-evil/steal.sh')).toThrow('Path outside allowed directories')
    expect(() => resolvePath('/memory-evil/data')).toThrow('Path outside allowed directories')
    expect(() => resolvePath('/home/taurine/hack')).toThrow('Path outside allowed directories')
  })

  describe('FICUS_BOX_HOME (VM box runtime only)', () => {
    it('permits paths under FICUS_BOX_HOME when it is set (box file-sync targets)', () => {
      // VM boxes sync agent assets under the box user's HOME, which is not a static
      // ALLOWED_PREFIX. box-manager bakes FICUS_BOX_HOME so the server permits it.
      process.env.FICUS_BOX_HOME = '/home/box_abc123'
      expect(resolvePath('/home/box_abc123/bin/tau')).toBe('/home/box_abc123/bin/tau')
      expect(resolvePath('/home/box_abc123/.tau/skills/s/SKILL.md')).toBe('/home/box_abc123/.tau/skills/s/SKILL.md')
      expect(resolvePath('/home/box_abc123/memory/notes.md')).toBe('/home/box_abc123/memory/notes.md')
      // The box HOME itself resolves (exact-prefix match).
      expect(resolvePath('/home/box_abc123')).toBe('/home/box_abc123')
    })

    it('still rejects paths outside FICUS_BOX_HOME (and sibling box homes) when it is set', () => {
      process.env.FICUS_BOX_HOME = '/home/box_abc123'
      expect(() => resolvePath('/home/box_other/steal.sh')).toThrow('Path outside allowed directories')
      expect(() => resolvePath('/home/box_abc123-evil/x')).toThrow('Path outside allowed directories')
      expect(() => resolvePath('/etc/passwd')).toThrow('Path outside allowed directories')
    })

    it('does not widen the allow-list when FICUS_BOX_HOME is unset (k8s pods never set it)', () => {
      delete process.env.FICUS_BOX_HOME
      expect(() => resolvePath('/home/box_abc123/bin/tau')).toThrow('Path outside allowed directories')
    })
  })

  describe('logical-root rebasing (VM box runtime only)', () => {
    const HOME = '/home/box_abc123'

    describe('with a squad box (FICUS_SQUAD_ID set)', () => {
      beforeEach(() => {
        process.env.FICUS_BOX_HOME = HOME
        process.env.FICUS_SQUAD_ID = 'sq123'
        // A squad box's WORKSPACE_PATH is its physical ~/workspace.
        process.env.WORKSPACE_PATH = `${HOME}/workspace`
      })

      it('collapses the namespaced /workspace/<squadId> root onto ~/workspace', () => {
        expect(resolvePath('/workspace/sq123/src/index.ts')).toBe(`${HOME}/workspace/src/index.ts`)
        expect(resolvePath('/workspace/sq123')).toBe(`${HOME}/workspace`)
      })

      it('collapses the namespaced /memory/<squadId> root onto ~/memory', () => {
        expect(resolvePath('/memory/sq123/notes.md')).toBe(`${HOME}/memory/notes.md`)
        expect(resolvePath('/memory/sq123')).toBe(`${HOME}/memory`)
      })

      it('rebases /private onto ~/.private', () => {
        expect(resolvePath('/private/identity.pem')).toBe(`${HOME}/.private/identity.pem`)
        expect(resolvePath('/private')).toBe(`${HOME}/.private`)
      })

      it('rebases the bare /workspace and /memory roots too', () => {
        expect(resolvePath('/workspace/file')).toBe(`${HOME}/workspace/file`)
        expect(resolvePath('/memory/file')).toBe(`${HOME}/memory/file`)
      })

      it('leaves already-physical box paths untouched', () => {
        expect(resolvePath(`${HOME}/workspace/x`)).toBe(`${HOME}/workspace/x`)
        expect(resolvePath(`${HOME}/.private/x`)).toBe(`${HOME}/.private/x`)
      })

      it('resolves relative paths against the physical WORKSPACE_PATH (no rebasing needed)', () => {
        expect(resolvePath('src/index.ts')).toBe(`${HOME}/workspace/src/index.ts`)
      })
    })

    describe('with a solo agent box (no FICUS_SQUAD_ID)', () => {
      beforeEach(() => {
        process.env.FICUS_BOX_HOME = HOME
        process.env.WORKSPACE_PATH = `${HOME}/.private`
      })

      it('rebases every logical root onto the box HOME layout', () => {
        expect(resolvePath('/private/scratch.txt')).toBe(`${HOME}/.private/scratch.txt`)
        expect(resolvePath('/workspace/x')).toBe(`${HOME}/workspace/x`)
        expect(resolvePath('/memory/x')).toBe(`${HOME}/memory/x`)
      })
    })

    describe('security: no `..` escape above HOME after rebasing', () => {
      beforeEach(() => {
        process.env.FICUS_BOX_HOME = HOME
        process.env.FICUS_SQUAD_ID = 'sq123'
        process.env.WORKSPACE_PATH = `${HOME}/workspace`
      })

      it('normalizes `..` BEFORE rebasing so a traversal cannot escape the box HOME', () => {
        // /workspace/sq123/../../../etc/passwd normalizes to /etc/passwd (no rule
        // matches) → rejected, never rebased under HOME.
        expect(() => resolvePath('/workspace/sq123/../../../etc/passwd')).toThrow('Path outside allowed directories')
        expect(() => resolvePath('/private/../../etc/shadow')).toThrow('Path outside allowed directories')
      })

      it('rejects sibling box homes even when FICUS_BOX_HOME is set', () => {
        expect(() => resolvePath('/home/box_other/steal.sh')).toThrow('Path outside allowed directories')
      })

      it('a `..` that stays within a logical root rebases and stays under HOME', () => {
        // /workspace/sq123/sub/.. → /workspace/sq123 → ~/workspace (contained).
        expect(resolvePath('/workspace/sq123/sub/..')).toBe(`${HOME}/workspace`)
      })
    })
  })

  // Parity snapshot: with FICUS_BOX_HOME UNSET (k8s/docker), rebaseLogicalRoot is
  // the identity function and resolvePath is byte-identical to its pre-box
  // behavior. Locks k8s path handling so a future box-side change can't silently
  // alter it.
  describe('rebaseLogicalRoot parity (FICUS_BOX_HOME unset → identity)', () => {
    beforeEach(() => {
      delete process.env.FICUS_BOX_HOME
      process.env.FICUS_SQUAD_ID = 'sq123' // present but must be ignored with no HOME
    })

    const identityCases = [
      '/workspace/sq123/src/index.ts',
      '/workspace/src/index.ts',
      '/private/scratch.txt',
      '/memory/sq123/notes.md',
      '/memory/vault/notes.md',
      '/home/box_abc123/bin/tau',
      '/nix/store/x',
      'relative/path',
    ]

    it('returns its argument unchanged for every logical/physical/relative input', () => {
      for (const p of identityCases) {
        expect(rebaseLogicalRoot(p)).toBe(p)
      }
    })

    it('resolvePath output is byte-identical to the historical k8s mapping', () => {
      expect(resolvePath('/workspace/sq123/src/index.ts')).toBe('/workspace/sq123/src/index.ts')
      expect(resolvePath('/private/scratch.txt')).toBe('/private/scratch.txt')
      expect(resolvePath('/memory/sq123/notes.md')).toBe('/memory/sq123/notes.md')
    })
  })
})
