#!/usr/bin/env bun
/** Offline planning only: no imports of Core, network clients or host executors.
 * Inventory is supplied metadata, NOT a live safety check or mutation authority.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

interface BoxInventory {
  id: string
  runningBunVersion: string | null
  work: 'idle' | 'active' | 'unknown'
  pendingInvocation: boolean
  lifecycleGeneration: string | null
}
interface HostInventory {
  id: string
  prebaked: boolean
  bunVersion: string | null
  boxes: BoxInventory[]
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const nullableText = (v: unknown): v is string | null => v === null || text(v)
const version = (v: unknown): v is string | null => v === null || (typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v))

export function previewBunConvergence(input: unknown, desired: string) {
  if (!object(input) || !Array.isArray(input.hosts)) throw new Error('Invalid offline inventory')
  for (const host of input.hosts) {
    if (
      !object(host) ||
      !text(host.id) ||
      typeof host.prebaked !== 'boolean' ||
      !version(host.bunVersion) ||
      !Array.isArray(host.boxes)
    )
      throw new Error('Invalid offline inventory')
    for (const box of host.boxes) {
      if (
        !object(box) ||
        !text(box.id) ||
        !version(box.runningBunVersion) ||
        typeof box.work !== 'string' ||
        !['idle', 'active', 'unknown'].includes(box.work) ||
        typeof box.pendingInvocation !== 'boolean' ||
        !nullableText(box.lifecycleGeneration)
      )
        throw new Error('Invalid offline inventory')
    }
  }
  return {
    mode: 'offline-preview',
    desiredBunVersion: desired,
    mutation: false,
    convergence: 'eventual-idle-adoption',
    hosts: (input.hosts as unknown as HostInventory[]).map((host) => ({
      id: host.id,
      prebaked: host.prebaked,
      disk:
        host.bunVersion === desired
          ? 'current'
          : host.bunVersion === null
            ? 'inspect-version-first'
            : 'replace-bun-only',
      boxes: host.boxes.map((box) => ({
        id: box.id,
        lifecycleGeneration: box.lifecycleGeneration,
        adoption:
          box.runningBunVersion === desired
            ? 'current'
            : box.pendingInvocation || box.work === 'unknown' || !box.lifecycleGeneration
              ? 'defer-uncertain'
              : box.work === 'active'
                ? 'defer-active'
                : 'await-natural-idle-exit-then-normal-ensure',
      })),
    })),
  }
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--inventory')
      throw new Error('usage: bun scripts/machine/preview-bun-convergence.ts --inventory <offline.json>')
    const inventory = JSON.parse(readFileSync(process.argv[3]!, 'utf8'))
    const desired = readFileSync(join(import.meta.dir, '../../.bun-version'), 'utf8').trim()
    process.stdout.write(`${JSON.stringify(previewBunConvergence(inventory, desired), null, 2)}\n`)
  } catch (error) {
    // Do not echo supplied inventory (it could contain private host metadata).
    console.error(
      error instanceof SyntaxError
        ? 'Invalid offline inventory JSON'
        : error instanceof Error
          ? error.message
          : 'Invalid offline inventory'
    )
    process.exitCode = 1
  }
}
