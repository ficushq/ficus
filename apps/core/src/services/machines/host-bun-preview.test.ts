import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../../../../..')
const script = join(root, 'scripts/machine/preview-bun-convergence.ts')
const desired = readFileSync(join(root, '.bun-version'), 'utf8').trim()

test('offline preview separates disk and process adoption, defers active/uncertain work and writes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bun-preview-'))
  try {
    const bin = join(dir, 'commands')
    mkdirSync(bin)
    for (const name of ['ssh', 'curl', 'sudo', 'systemctl', 'docker']) {
      writeFileSync(join(bin, name), '#!/bin/sh\necho FORBIDDEN >&2; exit 90\n', { mode: 0o755 })
    }
    const path = join(dir, 'inventory.json')
    writeFileSync(
      path,
      JSON.stringify({
        hosts: [
          {
            id: 'synthetic-host',
            prebaked: true,
            bunVersion: '1.2.23',
            boxes: [
              {
                id: 'idle',
                runningBunVersion: '1.2.23',
                work: 'idle',
                pendingInvocation: false,
                lifecycleGeneration: 'owned-1',
              },
              {
                id: 'busy',
                runningBunVersion: '1.2.23',
                work: 'active',
                pendingInvocation: false,
                lifecycleGeneration: 'owned-2',
              },
              {
                id: 'unknown',
                runningBunVersion: null,
                work: 'unknown',
                pendingInvocation: false,
                lifecycleGeneration: 'owned-3',
              },
              {
                id: 'pending',
                runningBunVersion: '1.2.23',
                work: 'idle',
                pendingInvocation: true,
                lifecycleGeneration: 'owned-4',
              },
              {
                id: 'current',
                runningBunVersion: desired,
                work: 'idle',
                pendingInvocation: false,
                lifecycleGeneration: 'owned-5',
              },
            ],
          },
        ],
      })
    )
    const before = { names: readdirSync(dir), content: readFileSync(path, 'utf8'), mtime: statSync(path).mtimeMs }
    const run = () =>
      Bun.spawnSync([process.execPath, script, '--inventory', path], {
        cwd: dir,
        env: { HOME: dir, PATH: bin },
      })
    const result = run()
    expect({ code: result.exitCode, stderr: result.stderr.toString() }).toEqual({ code: 0, stderr: '' })
    const plan = JSON.parse(result.stdout.toString())
    expect(plan).toEqual({
      mode: 'offline-preview',
      desiredBunVersion: desired,
      mutation: false,
      hosts: [
        {
          id: 'synthetic-host',
          prebaked: true,
          disk: 'replace-bun-only',
          boxes: [
            { id: 'idle', lifecycleGeneration: 'owned-1', adoption: 'idle-normal-reconcile' },
            { id: 'busy', lifecycleGeneration: 'owned-2', adoption: 'defer-active' },
            { id: 'unknown', lifecycleGeneration: 'owned-3', adoption: 'defer-uncertain' },
            { id: 'pending', lifecycleGeneration: 'owned-4', adoption: 'defer-uncertain' },
            { id: 'current', lifecycleGeneration: 'owned-5', adoption: 'current' },
          ],
        },
      ],
    })
    expect(run().stdout.toString()).toBe(result.stdout.toString())
    expect({ names: readdirSync(dir), content: readFileSync(path, 'utf8'), mtime: statSync(path).mtimeMs }).toEqual(
      before
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('offline preview rejects incomplete inventory instead of inventing safe activity or ownership', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bun-preview-'))
  try {
    const path = join(dir, 'inventory.json')
    for (const inventory of [
      {
        hosts: [
          {
            id: 'bad',
            prebaked: true,
            bunVersion: null,
            boxes: [
              {
                id: 'box',
                runningBunVersion: null,
                work: ['idle'],
                pendingInvocation: false,
                lifecycleGeneration: 'owned',
              },
            ],
          },
        ],
      },
      { hosts: [{ id: 'bad', prebaked: true, bunVersion: null, boxes: [{}] }] },
      {
        hosts: [
          {
            id: 'bad',
            prebaked: true,
            bunVersion: null,
            boxes: [{ id: 'box', runningBunVersion: null, work: 'idle', pendingInvocation: false }],
          },
        ],
      },
    ]) {
      writeFileSync(path, JSON.stringify(inventory))
      const result = Bun.spawnSync([process.execPath, script, '--inventory', path], { cwd: dir, env: { HOME: dir } })
      expect(result.exitCode).toBe(1)
      expect(result.stdout.toString()).toBe('')
      expect(result.stderr.toString()).toContain('Invalid offline inventory')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
