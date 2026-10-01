import { describe, expect, it } from 'bun:test'
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveRepoRoot } from './server-bundle'
import {
  buildCliBundle,
  CLI_REMOTE_PATH,
  CLI_WRAPPER_BYTES,
  CLI_WRAPPER_PATH,
  cliArtifact,
  currentCliBundleCached,
} from './cli-bundle'

/**
 * Fake spawn for buildCliBundle: records the spawned command, optionally writes
 * fixture bytes to the `--outfile` path (BEFORE `exited` resolves, matching the
 * real ordering), and replies with a scripted exit code + stderr. No real
 * `bun build` runs in these tests.
 */
function makeFakeSpawn(reply: { exitCode: number; stderr?: string; bytes?: Uint8Array }): {
  spawn: typeof Bun.spawn
  commands: string[][]
} {
  const commands: string[][] = []
  const spawn = ((cmd: string[]) => {
    commands.push(cmd)
    const outfile = cmd[cmd.indexOf('--outfile') + 1]
    const exited = (async () => {
      if (reply.bytes !== undefined) await writeFile(outfile, reply.bytes)
      return reply.exitCode
    })()
    return { stderr: reply.stderr ?? '', exited }
  }) as unknown as typeof Bun.spawn
  return { spawn, commands }
}

const FIXTURE_JS = new TextEncoder().encode('#!/usr/bin/env bun\nconsole.log("ficus cli fixture")\n')

const genPath = join(resolveRepoRoot(), 'apps/cli/src/build-info.generated.ts')
const bakPath = `${genPath}.artifactbuild.bak`

/**
 * Fake fs deps over a Map of path → content, recording renames/writes/rms into
 * a shared events array so ordering relative to the build spawn is provable,
 * and capturing every written content (the stamped file is gone from the tree
 * by the time the build returns — restored or deleted — so assertions on what
 * the build SAW need the capture).
 */
function makeFakeFs(files: Map<string, string>, events: string[]) {
  const writes: Array<{ path: string; content: string }> = []
  const fs = {
    existsSync: (p: string) => files.has(p),
    rename: async (from: string, to: string) => {
      events.push(`rename:${from}->${to}`)
      const content = files.get(from)
      if (content === undefined) throw new Error(`ENOENT: rename ${from}`)
      files.delete(from)
      files.set(to, content)
    },
    writeFile: async (p: string, content: string) => {
      events.push(`write:${p}`)
      writes.push({ path: p, content })
      files.set(p, content)
    },
    rm: async (p: string) => {
      events.push(`rm:${p}`)
      files.delete(p)
    },
  }
  return { fs, writes }
}

/** Wrap a fake spawn to record 'spawn' into the shared events array. */
function eventedSpawn(events: string[], reply: Parameters<typeof makeFakeSpawn>[0]): typeof Bun.spawn {
  const inner = makeFakeSpawn(reply).spawn as unknown as (...args: unknown[]) => unknown
  return ((...args: unknown[]) => {
    events.push('spawn')
    return inner(...args)
  }) as unknown as typeof Bun.spawn
}

/** Stub git runner keyed on the joined argv; throws on anything unscripted. */
function stubGit(replies: Record<string, string>): (args: string[]) => Promise<string> {
  return (args) => {
    const reply = replies[args.join(' ')]
    if (reply === undefined) return Promise.reject(new Error(`unexpected git args: ${args.join(' ')}`))
    return Promise.resolve(reply)
  }
}

const COMMIT_A = { 'rev-parse --short HEAD': 'abc1234', 'show -s --format=%cI HEAD': '2026-07-01T12:00:00+02:00' }
const COMMIT_B = { 'rev-parse --short HEAD': 'def5678', 'show -s --format=%cI HEAD': '2026-07-02T09:30:00+02:00' }

/** The exact generated-module shape the CLI's build-info.ts imports (matches
 *  the CLI package build's own writer: JSON.stringify(…, null, 2)). */
const stamp = (info: { version: string; commit: string; buildDate: string }) =>
  `export const generatedBuildInfo = ${JSON.stringify(info, null, 2)} as const\n`

// This file spawns real `bun build` subprocesses and drives real cross-process
// exclusion — too jitter-prone for the shared CI runner. It runs only in the
// dedicated `subprocess-tests` CI job (see ci.yml); the main sweep sets
// FICUS_TEST_SKIP_SUBPROCESS=1 to skip it here.
const describeSubprocess = describe.skipIf(process.env.FICUS_TEST_SKIP_SUBPROCESS === '1')

describeSubprocess('CLI wrapper constants', () => {
  it('pins the exact wrapper script: sh shebang exec-ing the machine bun against the pushed bundle', () => {
    // The wrapper is what makes `ficus …` work in every box shell; its bytes are
    // part of the pushed artifact AND folded into the version hash, so this
    // string is a wire contract, not an implementation detail.
    expect(new TextDecoder().decode(CLI_WRAPPER_BYTES)).toBe(
      '#!/bin/sh\nexec /opt/ficus/bin/bun /opt/ficus/cli/ficus.js "$@"\n'
    )
    expect(CLI_REMOTE_PATH).toBe('/opt/ficus/cli/ficus.js')
    expect(CLI_WRAPPER_PATH).toBe('/usr/local/bin/ficus')
  })

  it('exports no second (legacy) wrapper path or bundle name', async () => {
    const exported = Object.entries(await import('./cli-bundle'))
      .filter(([, value]) => typeof value === 'string')
      .map(([name, value]) => [name, value])
    expect(exported).toEqual([
      ['CLI_REMOTE_PATH', CLI_REMOTE_PATH],
      ['CLI_WRAPPER_PATH', '/usr/local/bin/ficus'],
    ])
  })
})

describeSubprocess('buildCliBundle prebuilt fallback', () => {
  // A shipped core artifact carries ficus.js prebuilt under <root>/machine and NO
  // apps/cli/src; runtime must READ it from disk (same sha256(ficus.js ||
  // wrapper) stamp) and skip the git-stamp / advisory-lock / build machinery
  // entirely. spawn, lock, and git all throw here to prove none of them run.
  it('reads ficus.js from the prebuilt dir and hashes it with the wrapper (no build, no lock, no git)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ficus-prebuilt-cli-'))
    try {
      const js = new TextEncoder().encode('#!/usr/bin/env bun\nconsole.log("prebuilt ficus")\n')
      await writeFile(join(dir, 'ficus.js'), js)

      const { js: gotJs, version } = await buildCliBundle({
        prebuiltDir: dir,
        spawn: (() => {
          throw new Error('must not build when prebuilt ficus.js is present')
        }) as unknown as typeof Bun.spawn,
        lock: () => {
          throw new Error('must not take the build lock when prebuilt ficus.js is present')
        },
        git: () => Promise.reject(new Error('must not shell out to git when prebuilt ficus.js is present')),
      })

      expect(gotJs).toEqual(js)
      // EXACT same version contract as the source path — sha256 over ficus.js and
      // the wrapper bytes.
      expect(version).toBe(createHash('sha256').update(js).update(CLI_WRAPPER_BYTES).digest('hex'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('with no prebuiltDir, a git checkout never reads a prebuilt bundle (lock + source build run, no default <root>/machine dir)', async () => {
    // Pre-refactor, buildCliBundle defaulted prebuiltDir to
    // `<MONOREPO_ROOT>/machine` and read it unconditionally — a stray
    // `machine/` dir in a dev checkout would silently be treated as prebuilt.
    // Post-refactor, `deps.prebuiltDir` passes straight through to the shared
    // reader's explicit `dir`; when omitted, the reader falls to its
    // artifact-mode gate, which is false in this git checkout, so it must
    // ALWAYS fall through to the lock/build machinery with no dir arg.
    const events: string[] = []
    const files = new Map<string, string>()
    const { fs } = makeFakeFs(files, events)
    const lock = async <T>(section: () => Promise<T>): Promise<T> => {
      events.push('lock')
      try {
        return await section()
      } finally {
        events.push('unlock')
      }
    }
    const { js } = await buildCliBundle({
      spawn: eventedSpawn(events, { exitCode: 0, bytes: FIXTURE_JS }),
      fs,
      git: stubGit(COMMIT_A),
      lock,
    })
    expect(js).toEqual(FIXTURE_JS)
    expect(events).toEqual(['lock', `write:${genPath}`, 'spawn', `rm:${genPath}`, 'unlock'])
  })

  it('falls through to the source build when no prebuilt ficus.js exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ficus-prebuilt-cli-empty-'))
    const { spawn, commands } = makeFakeSpawn({ exitCode: 0, bytes: FIXTURE_JS })
    const { fs } = makeFakeFs(new Map(), [])
    try {
      const { js } = await buildCliBundle({
        prebuiltDir: dir,
        spawn,
        fs,
        git: stubGit(COMMIT_A),
        // Bypass the real Postgres advisory lock — this test only proves the
        // fallthrough reaches the source build.
        lock: (section) => section(),
      })
      expect(js).toEqual(FIXTURE_JS)
      expect(commands).toHaveLength(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describeSubprocess('buildCliBundle', () => {
  // These inject fake fs + git alongside the fake spawn so no real repo file is
  // touched and no real git shells out.
  it('bun-builds the CLI entry into a scratch ficus.js and returns its bytes + content version', async () => {
    const { spawn, commands } = makeFakeSpawn({ exitCode: 0, bytes: FIXTURE_JS })
    const { fs } = makeFakeFs(new Map(), [])
    const { js, version } = await buildCliBundle({ spawn, fs, git: stubGit(COMMIT_A) })

    expect(commands).toHaveLength(1)
    // The command is asserted EXACTLY (length + order + no extra flags): any
    // volatile flag a regression injects (e.g. `--define BUILD=<date>`) would
    // change the output hash on every rebuild of unchanged code and re-push
    // the CLI to every machine forever — so it must fail this test.
    expect(commands[0]).toEqual([
      'bun',
      'build',
      // The entry is the CLI's real source entry, resolved from the repo root.
      join(resolveRepoRoot(), 'apps/cli/src/index.ts'),
      '--outfile',
      expect.stringMatching(/\/ficus\.js$/) as unknown as string,
      '--target',
      'bun',
    ])

    expect(js).toEqual(FIXTURE_JS)
    // The version folds the bundle AND the wrapper bytes, so a wrapper edit
    // alone re-stamps (and re-pushes) the artifact.
    expect(version).toBe(createHash('sha256').update(FIXTURE_JS).update(CLI_WRAPPER_BYTES).digest('hex'))
  })

  it('throws with bun stderr when the build exits non-zero', async () => {
    const { spawn } = makeFakeSpawn({ exitCode: 1, stderr: 'error: could not resolve module' })
    const { fs } = makeFakeFs(new Map(), [])
    await expect(buildCliBundle({ spawn, fs, git: stubGit(COMMIT_A) })).rejects.toThrow(/could not resolve module/)
  })

  it('throws when the build produces no ficus.js', async () => {
    const { spawn } = makeFakeSpawn({ exitCode: 0 })
    const { fs } = makeFakeFs(new Map(), [])
    await expect(buildCliBundle({ spawn, fs, git: stubGit(COMMIT_A) })).rejects.toThrow(/ficus\.js/)
  })

  it('throws when the build produces an empty ficus.js', async () => {
    const { spawn } = makeFakeSpawn({ exitCode: 0, bytes: new Uint8Array() })
    const { fs } = makeFakeFs(new Map(), [])
    await expect(buildCliBundle({ spawn, fs, git: stubGit(COMMIT_A) })).rejects.toThrow(/empty/)
  })
})

describeSubprocess('buildCliBundle stable build-info stamping', () => {
  // The bundle must inline an INFORMATIVE `ficus --version` (real commit + that
  // commit's own date) while staying churn-free: the stamped values are a pure
  // function of the commit, NOT the wall clock, so two builds of the same code
  // hash identically and the artifact only re-pushes on a real deploy. The
  // shared repo file build-info.generated.ts is saved, overwritten with the
  // stable stamp for the build, and ALWAYS restored (or deleted if we created
  // it) — it's the dev's file, not ours to keep.
  const DEV_CONTENT =
    "export const generatedBuildInfo = { version: '1.2.3', commit: 'wallclk', buildDate: '2026-05-05T05:05:05Z' } as const\n"

  it('saves the dev original aside, writes the commit-stamped file BEFORE the build, and restores the original after', async () => {
    const events: string[] = []
    const files = new Map([[genPath, DEV_CONTENT]])
    const { fs, writes } = makeFakeFs(files, events)
    const bundle = await buildCliBundle({
      spawn: eventedSpawn(events, { exitCode: 0, bytes: FIXTURE_JS }),
      fs,
      git: stubGit(COMMIT_A),
    })
    expect(events).toEqual([
      `rename:${genPath}->${bakPath}`,
      `write:${genPath}`,
      'spawn',
      `rename:${bakPath}->${genPath}`,
    ])
    // The build saw the STABLE stamp: git short commit + the COMMIT's date
    // (never a wall-clock read), version left at the CLI's stable default.
    expect(writes).toEqual([
      {
        path: genPath,
        content: stamp({ version: 'dev', commit: 'abc1234', buildDate: '2026-07-01T12:00:00+02:00' }),
      },
    ])
    // The dev's file ends up back where they left it, byte-identical.
    expect(files).toEqual(new Map([[genPath, DEV_CONTENT]]))
    expect(bundle.js).toEqual(FIXTURE_JS)
  })

  it('deletes the stamped file it wrote when no generated file existed before', async () => {
    const events: string[] = []
    const files = new Map<string, string>()
    const { fs } = makeFakeFs(files, events)
    await buildCliBundle({
      spawn: eventedSpawn(events, { exitCode: 0, bytes: FIXTURE_JS }),
      fs,
      git: stubGit(COMMIT_A),
    })
    expect(events).toEqual([`write:${genPath}`, 'spawn', `rm:${genPath}`])
    expect(files).toEqual(new Map())
  })

  it('restores the dev original even when the build fails', async () => {
    const events: string[] = []
    const files = new Map([[genPath, DEV_CONTENT]])
    const { fs } = makeFakeFs(files, events)
    await expect(
      buildCliBundle({
        spawn: eventedSpawn(events, { exitCode: 1, stderr: 'boom' }),
        fs,
        git: stubGit(COMMIT_A),
      })
    ).rejects.toThrow(/boom/)
    expect(events[events.length - 1]).toBe(`rename:${bakPath}->${genPath}`)
    expect(files).toEqual(new Map([[genPath, DEV_CONTENT]]))
  })

  it('restores an orphaned bak from a crashed prior run (generated file absent)', async () => {
    const events: string[] = []
    const files = new Map([[bakPath, DEV_CONTENT]])
    const { fs } = makeFakeFs(files, events)
    await buildCliBundle({
      spawn: eventedSpawn(events, { exitCode: 0, bytes: FIXTURE_JS }),
      fs,
      git: stubGit(COMMIT_A),
    })
    // No save-aside needed (the bak already holds the dev original); the fresh
    // stamp overwrites whatever was at genPath and the original comes back.
    expect(events).toEqual([`write:${genPath}`, 'spawn', `rename:${bakPath}->${genPath}`])
    expect(files).toEqual(new Map([[genPath, DEV_CONTENT]]))
  })

  it("never clobbers a crashed run's bak (the dev original) with that run's leftover stamp", async () => {
    // Crash state: bak = dev original, genPath = the crashed run's stamped
    // file. Renaming gen→bak here would overwrite the original with OUR stamp
    // and lose the dev's file forever — the bak must win the restore.
    const events: string[] = []
    const staleStamp = stamp({ version: 'dev', commit: 'stale00', buildDate: '2026-01-01T00:00:00+00:00' })
    const files = new Map([
      [bakPath, DEV_CONTENT],
      [genPath, staleStamp],
    ])
    const { fs } = makeFakeFs(files, events)
    await buildCliBundle({
      spawn: eventedSpawn(events, { exitCode: 0, bytes: FIXTURE_JS }),
      fs,
      git: stubGit(COMMIT_A),
    })
    expect(events).toEqual([`write:${genPath}`, 'spawn', `rename:${bakPath}->${genPath}`])
    expect(files).toEqual(new Map([[genPath, DEV_CONTENT]]))
  })

  it('falls back to dev build-info when git is unavailable — the build still succeeds', async () => {
    // The core host may not be a git checkout (dist deploy): a missing/failing
    // git must degrade to the uninformative-but-stable 'dev' stamp, never fail
    // the build.
    const events: string[] = []
    const files = new Map<string, string>()
    const { fs, writes } = makeFakeFs(files, events)
    const bundle = await buildCliBundle({
      spawn: eventedSpawn(events, { exitCode: 0, bytes: FIXTURE_JS }),
      fs,
      git: () => Promise.reject(new Error('fatal: not a git repository')),
    })
    expect(bundle.js).toEqual(FIXTURE_JS)
    expect(writes).toEqual([{ path: genPath, content: stamp({ version: 'dev', commit: 'dev', buildDate: 'dev' }) }])
    expect(events).toEqual([`write:${genPath}`, 'spawn', `rm:${genPath}`])
  })

  it('same commit → identical version across rebuilds (churn-free); different commit → different version (re-push)', async () => {
    // The fake spawn inlines the generated file's content into the output —
    // exactly what real `bun build` does — so the version hash moves iff the
    // stamped content moves, i.e. iff the commit moves.
    const build = async (git: (args: string[]) => Promise<string>) => {
      const files = new Map<string, string>()
      const { fs } = makeFakeFs(files, [])
      const spawn = ((cmd: string[]) => {
        const outfile = cmd[cmd.indexOf('--outfile') + 1]
        const exited = (async () => {
          await writeFile(outfile, `// bundle\n${files.get(genPath) ?? 'ABSENT'}`)
          return 0
        })()
        return { stderr: '', exited }
      }) as unknown as typeof Bun.spawn
      return buildCliBundle({ spawn, fs, git })
    }
    const first = await build(stubGit(COMMIT_A))
    const again = await build(stubGit(COMMIT_A))
    const moved = await build(stubGit(COMMIT_B))
    expect(again.version).toBe(first.version)
    expect(moved.version).not.toBe(first.version)
  })

  // The save → stamp → build → restore section mutates the SHARED repo file,
  // and core runs as TWO processes (api + worker) whose first CLI builds can
  // race: memoizeBuild is single-flight only within a process, so without a
  // cross-process mutex one process's rename hits ENOENT (gen already moved by
  // the other) or a restore lands mid-build of the other process — a stale
  // stamp gets inlined into one bundle and the two processes cache DIFFERENT
  // versions, re-push ping-ponging forever. The lock dep is injected here
  // (like spawn/fs/git) to pin that the ENTIRE section runs inside it.
  it('runs the whole save → stamp → build → restore section inside the cross-process build lock', async () => {
    const events: string[] = []
    const files = new Map([[genPath, DEV_CONTENT]])
    const { fs } = makeFakeFs(files, events)
    const lock = async <T>(section: () => Promise<T>): Promise<T> => {
      events.push('lock')
      try {
        return await section()
      } finally {
        events.push('unlock')
      }
    }
    await buildCliBundle({
      spawn: eventedSpawn(events, { exitCode: 0, bytes: FIXTURE_JS }),
      fs,
      git: stubGit(COMMIT_A),
      lock,
    })
    expect(events).toEqual([
      'lock',
      `rename:${genPath}->${bakPath}`,
      `write:${genPath}`,
      'spawn',
      `rename:${bakPath}->${genPath}`,
      'unlock',
    ])
    expect(files).toEqual(new Map([[genPath, DEV_CONTENT]]))
  })

  it('releases the cross-process build lock even when the build fails (after the restore)', async () => {
    const events: string[] = []
    const files = new Map([[genPath, DEV_CONTENT]])
    const { fs } = makeFakeFs(files, events)
    const lock = async <T>(section: () => Promise<T>): Promise<T> => {
      events.push('lock')
      try {
        return await section()
      } finally {
        events.push('unlock')
      }
    }
    await expect(
      buildCliBundle({
        spawn: eventedSpawn(events, { exitCode: 1, stderr: 'boom' }),
        fs,
        git: stubGit(COMMIT_A),
        lock,
      })
    ).rejects.toThrow(/boom/)
    // The restore happens INSIDE the lock (a post-unlock restore could land
    // mid-build of the other process), and the lock is always released.
    expect(events.slice(-2)).toEqual([`rename:${bakPath}->${genPath}`, 'unlock'])
    expect(files).toEqual(new Map([[genPath, DEV_CONTENT]]))
  })
})

describeSubprocess('buildCliBundle cross-process exclusion (two real processes)', () => {
  it('two processes building concurrently with a leftover generated file BOTH succeed with IDENTICAL versions and restore the file byte-identical', async () => {
    // The reviewer's probe for the api+worker first-build race: without a
    // cross-process mutex one process's rename fails ENOENT, or a mid-build
    // restore poisons one bundle with the leftover wall-clock stamp (version
    // mismatch → per-ensure re-push ping-pong). Both processes use the REAL
    // default lock (Postgres advisory lock on the test DB via the inherited
    // DATABASE_URL) and the REAL default git — same repo, same HEAD — so
    // same-commit builds must be byte-identical.
    const original = existsSync(genPath) ? await readFile(genPath) : null
    const content =
      "export const generatedBuildInfo = { version: '5.5.5', commit: 'ccccccc', buildDate: '2026-06-06T06:06:06Z' } as const\n"
    const script = [
      `const { buildCliBundle } = await import(${JSON.stringify(join(import.meta.dir, 'cli-bundle.ts'))})`,
      `const bundle = await buildCliBundle()`,
      `console.log('CLI_BUNDLE_RESULT ' + JSON.stringify({ version: bundle.version }))`,
    ].join('\n')
    const spawnBuild = () =>
      Bun.spawn(['bun', '-e', script], {
        cwd: resolveRepoRoot(),
        env: { ...process.env },
        stdout: 'pipe',
        stderr: 'pipe',
      })
    try {
      await writeFile(genPath, content)
      const a = spawnBuild()
      const b = spawnBuild()
      const [aOut, aErr, aExit, bOut, bErr, bExit] = await Promise.all([
        new Response(a.stdout).text(),
        new Response(a.stderr).text(),
        a.exited,
        new Response(b.stdout).text(),
        new Response(b.stderr).text(),
        b.exited,
      ])
      expect(aExit, `process A failed: ${aErr}`).toBe(0)
      expect(bExit, `process B failed: ${bErr}`).toBe(0)
      const parse = (out: string): { version: string } => {
        const line = out.split('\n').find((l) => l.startsWith('CLI_BUNDLE_RESULT '))
        if (!line) throw new Error(`no result line in output: ${out}`)
        return JSON.parse(line.slice('CLI_BUNDLE_RESULT '.length)) as { version: string }
      }
      const versionA = parse(aOut).version
      const versionB = parse(bOut).version
      // Identical versions: neither bundle inlined the leftover wall-clock
      // file, so the two processes agree and per-machine ensure never
      // ping-pongs.
      expect(versionA).toBe(versionB)
      // The dev's file survives, byte-identical.
      expect(await readFile(genPath, 'utf8')).toBe(content)
    } finally {
      if (original !== null) await writeFile(genPath, original)
      else await rm(genPath, { force: true })
    }
  }, 180000)
})

describeSubprocess('buildCliBundle stamps the real bundle with stable commit info (real builds)', () => {
  it('inlines the stubbed commit + commit-date, stays byte-stable per commit regardless of leftover file contents, and moves on a commit change', async () => {
    // End-to-end churn guard with REAL bun builds: the version must be a pure
    // function of the commit — identical across rebuilds at the same commit
    // even with DIFFERENT wall-clock-shaped leftover files on disk (leaking
    // those would churn the hash every deploy), and different when the commit
    // moves (a real deploy SHOULD re-push). Also proves `ficus --version` gets
    // the real commit + commit-date, and the dev's file survives unchanged.
    const original = existsSync(genPath) ? await readFile(genPath) : null
    const contentA =
      "export const generatedBuildInfo = { version: '1.0.0', commit: 'aaaaaaa', buildDate: '2026-01-01T00:00:00Z' } as const\n"
    const contentB =
      "export const generatedBuildInfo = { version: '9.9.9', commit: 'bbbbbbb', buildDate: '2026-12-31T23:59:59Z' } as const\n"
    try {
      await writeFile(genPath, contentA)
      const a = await buildCliBundle({ git: stubGit(COMMIT_A) })
      expect(await readFile(genPath, 'utf8')).toBe(contentA) // restored, unchanged

      // The stable stamp is inlined into the bundle (informative ficus --version)…
      const text = new TextDecoder().decode(a.js)
      expect(text).toContain('abc1234')
      expect(text).toContain('2026-07-01T12:00:00+02:00')
      // …and the leftover wall-clock stamp is NOT.
      expect(text).not.toContain('2026-01-01T00:00:00Z')
      expect(text).not.toContain('1.0.0')

      await writeFile(genPath, contentB)
      const b = await buildCliBundle({ git: stubGit(COMMIT_A) })
      expect(await readFile(genPath, 'utf8')).toBe(contentB)
      expect(b.version).toBe(a.version) // same commit → churn-free

      const c = await buildCliBundle({ git: stubGit(COMMIT_B) })
      expect(c.version).not.toBe(a.version) // commit moved → re-push
    } finally {
      if (original !== null) await writeFile(genPath, original)
      else await rm(genPath, { force: true })
    }
  }, 120000)
})

describeSubprocess('cliArtifact', () => {
  // These build the REAL CLI bundle once (memoized per process), mirroring
  // serverArtifact's tests — the artifact's exact file layout against real
  // bytes is the wire contract Task 4's ensure loop pushes.
  it('is named "cli" and ships ficus.js + the /usr/local/bin/ficus wrapper, both 0755, wrapper-folded version', async () => {
    expect(cliArtifact.name).toBe('cli')
    const { files, version } = await cliArtifact.build()
    const bundle = await currentCliBundleCached()
    expect(files).toHaveLength(2)
    expect(files[0]).toEqual({ remotePath: CLI_REMOTE_PATH, bytes: bundle.js, mode: '0755' })
    expect(files[1]).toEqual({ remotePath: CLI_WRAPPER_PATH, bytes: CLI_WRAPPER_BYTES, mode: '0755' })
    // The only PATH entry the artifact installs is /usr/local/bin/ficus, and it runs exactly the
    // bundle pushed beside it (byte-identical to the staged CLI).
    expect(files.map((f) => f.remotePath).filter((p) => /^\/usr\/(local\/)?s?bin\//.test(p))).toEqual([
      '/usr/local/bin/ficus',
    ])
    expect(new TextDecoder().decode(files[1].bytes).endsWith(` ${files[0].remotePath} "$@"\n`)).toBe(true)
    expect(Buffer.from(files[0].bytes).equals(Buffer.from(bundle.js))).toBe(true)
    expect(version).toBe(bundle.version)
    expect(version).toBe(createHash('sha256').update(bundle.js).update(CLI_WRAPPER_BYTES).digest('hex'))
  })

  it('reuses the per-process memoized bundle (no rebuild per ensure)', async () => {
    const a = await cliArtifact.build()
    const b = await cliArtifact.build()
    expect(b.files[0].bytes).toBe(a.files[0].bytes)
    expect(b.version).toBe(a.version)
  })
})
