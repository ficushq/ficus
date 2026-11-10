import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  discoverTestFiles,
  parseBunTestSummary,
  stripTerminalControls,
  validateBaselineAndInventory,
  type TestBaseline,
} from './run-full-test-gate'

export type OrderCase = { name: string; seed: number }
type CasesFile = { schemaVersion: 1; cases: OrderCase[] }
type Child = {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number>
  kill(signal?: number | NodeJS.Signals): void
}
export type GatePrimitives = {
  readFile(path: string): Promise<string>
  mkdir(path: string): Promise<unknown>
  writeFile(path: string, value: string): Promise<unknown>
  rename(from: string, to: string): Promise<unknown>
  rm(path: string): Promise<unknown>
  spawn(command: string[], cwd: string): Child
  onSignal(signal: NodeJS.Signals, listener: () => void): void
  offSignal(signal: NodeJS.Signals, listener: () => void): void
}
const webRoot = resolve(import.meta.dir, '..')

export function mulberry32(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}
export function fisherYates(files: string[], seed: number) {
  const result = [...files],
    random = mulberry32(seed)
  for (let index = result.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1))
    ;[result[index], result[swap]] = [result[swap]!, result[index]!]
  }
  return result
}
export function validateCases(value: unknown): OrderCase[] {
  const parsed = value as Partial<CasesFile>
  if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.cases) || parsed.cases.length !== 2)
    throw new Error('dom order cases must use schemaVersion 1 with exactly two cases')
  const names = new Set<string>(),
    seeds = new Set<number>()
  for (const entry of parsed.cases) {
    if (
      !entry ||
      typeof entry.name !== 'string' ||
      !/^[a-z][a-z0-9-]*$/.test(entry.name) ||
      !Number.isInteger(entry.seed) ||
      entry.seed < 0 ||
      entry.seed > 0xffffffff
    )
      throw new Error('dom order case requires a name and uint32 seed')
    names.add(entry.name)
    seeds.add(entry.seed)
  }
  if (names.size !== 2 || seeds.size !== 2) throw new Error('dom order case names and seeds must be unique')
  return parsed.cases
}
export function emittedFileOrder(output: string, inventory: string[]) {
  const wanted = new Set(inventory)
  return stripTerminalControls(output)
    .split('\n')
    .map((line) =>
      line
        .trim()
        .replace(/^::group::/, '')
        .replace(/^\.\//, '')
        .replace(/:$/, '')
    )
    .filter((line) => wanted.has(line))
}
export function validateOrderResult(
  baseline: TestBaseline,
  discovered: string[],
  order: string[],
  stdout: string,
  exitCode: number
) {
  const errors = validateBaselineAndInventory(baseline, discovered)
  let summary
  try {
    summary = parseBunTestSummary(stdout)
  } catch (error) {
    return [...errors, String(error instanceof Error ? error.message : error)]
  }
  if (exitCode !== 0) errors.push(`test process exited ${exitCode}`)
  // Floor semantics, matching run-full-test-gate.ts (2026-08-27): live
  // discovery pins the exact file set; the baseline only guards decreases so
  // adding tests never requires a baseline bump.
  if (summary.files !== discovered.length)
    errors.push(`expected ${discovered.length} discovered files, received ${summary.files}`)
  if (summary.files < baseline.fileCount)
    errors.push(`collected files fell below the baseline floor (${summary.files} < ${baseline.fileCount})`)
  if (summary.tests < baseline.testCount)
    errors.push(`collected tests fell below the baseline floor (${summary.tests} < ${baseline.testCount})`)
  if (summary.skip !== baseline.skipCount || summary.skip !== 0)
    errors.push(`expected 0 skipped tests, received ${summary.skip}`)
  if (summary.fail !== 0 || summary.todo !== 0)
    errors.push(`expected no failed or todo tests, received ${summary.fail} fail and ${summary.todo} todo`)
  if (summary.pass + summary.fail + summary.skip + summary.todo !== summary.tests)
    errors.push('aggregate counts do not equal collected tests')
  const emitted = emittedFileOrder(stdout, discovered)
  if (emitted.length !== order.length || emitted.some((file, index) => file !== order[index]))
    errors.push(`emitted file order mismatch at index ${firstMismatch(order, emitted)}`)
  return errors
}
function firstMismatch(expected: string[], actual: string[]) {
  const n = Math.max(expected.length, actual.length)
  for (let i = 0; i < n; i++) if (expected[i] !== actual[i]) return i
  return -1
}
async function capture(stream: ReadableStream<Uint8Array>, sink: { write(value: Uint8Array): unknown }) {
  const chunks: Uint8Array[] = []
  for await (const chunk of stream) {
    chunks.push(chunk)
    sink.write(chunk)
  }
  return Buffer.concat(chunks).toString()
}

const defaults: GatePrimitives = {
  readFile: (path) => readFile(path, 'utf8'),
  mkdir: (path) => mkdir(path, { recursive: true }),
  writeFile,
  rename,
  rm: (path) => rm(path, { force: true }),
  spawn: (command, cwd) => Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe' }),
  onSignal: (signal, listener) => process.on(signal, listener),
  offSignal: (signal, listener) => process.off(signal, listener),
}
export async function atomicArtifact(
  path: string,
  value: string,
  io: Pick<GatePrimitives, 'mkdir' | 'writeFile' | 'rename' | 'rm'> = defaults
) {
  await io.mkdir(dirname(path))
  const temporary = `${path}.${process.pid}.tmp`
  try {
    await io.writeFile(temporary, value)
    await io.rename(temporary, path)
  } catch (error) {
    try {
      await io.rm(temporary)
    } catch {
      // Preserve the write/rename failure that prevented the artifact from becoming atomic.
    }
    throw error
  }
}

export async function runDomOrderGate(argv = Bun.argv.slice(2), io: GatePrimitives = defaults) {
  const cases = validateCases(JSON.parse(await io.readFile(resolve(import.meta.dir, 'dom-order-cases.json'))))
  const seedArg = argv.length === 2 && argv[0] === '--seed' ? Number(argv[1]) : undefined
  if (argv.length && seedArg === undefined) throw new Error('usage: run-dom-order-gate.ts [--seed <uint32>]')
  if (seedArg !== undefined && (!Number.isInteger(seedArg) || seedArg < 0 || seedArg > 0xffffffff))
    throw new Error('seed must be uint32')
  const selected =
    seedArg === undefined
      ? cases
      : [cases.find((entry) => entry.seed === seedArg) ?? { name: `seed-${seedArg}`, seed: seedArg }]
  if (process.env.CI === 'true' && selected.some((entry) => !cases.some((recorded) => recorded.seed === entry.seed)))
    throw new Error('CI only permits recorded dom order seeds')
  const baseline = JSON.parse(await io.readFile(resolve(webRoot, 'test-baseline.json'))) as TestBaseline
  const discovered = await discoverTestFiles()
  const preflight = validateBaselineAndInventory(baseline, discovered)
  if (preflight.length) throw new Error(preflight.join('; '))
  for (const testCase of selected) {
    const order = fisherYates(discovered, testCase.seed)
    if (order.every((file, index) => file === discovered[index]))
      throw new Error(`case ${testCase.name} seed ${testCase.seed} produced forbidden discovered default order`)
    const artifact = resolve(webRoot, '.test-artifacts/dom-order', `${testCase.name}.json`)
    await atomicArtifact(
      artifact,
      JSON.stringify(
        {
          schemaVersion: 1,
          case: testCase.name,
          bunVersion: Bun.version,
          seed: testCase.seed,
          seedHex: `0x${testCase.seed.toString(16).padStart(8, '0')}`,
          order: order.map((file, index) => ({ index, file })),
        },
        null,
        2
      ) + '\n',
      io
    )
    const child = io.spawn(['bun', 'test', ...order.map((file) => `./${file}`)], webRoot)
    const signals = ['SIGINT', 'SIGTERM'] as NodeJS.Signals[],
      listeners = signals.map((signal) => () => child.kill(signal))
    signals.forEach((signal, index) => io.onSignal(signal, listeners[index]!))
    let stderr: string,
      code = -1
    try {
      ;[, stderr, code] = await Promise.all([
        capture(child.stdout, process.stdout),
        capture(child.stderr, process.stderr),
        child.exited,
      ])
    } finally {
      signals.forEach((signal, index) => io.offSignal(signal, listeners[index]!))
      if (code === -1) {
        child.kill('SIGTERM')
        await child.exited
      }
    }
    const errors = validateOrderResult(baseline, discovered, order, stderr, code)
    if (errors.length) {
      const firstFile = emittedFileOrder(stderr, discovered)[0] ?? 'none'
      const firstTest =
        stripTerminalControls(stderr)
          .split('\n')
          .map((line) => line.trim())
          .find((line) => /^(?:\((?:fail|pass)\)|[✗✓])/.test(line)) ?? 'none'
      const diagnostic = `DOM_ORDER_GATE_FAILURE case=${testCase.name} seed=${testCase.seed} seedHex=0x${testCase.seed.toString(16).padStart(8, '0')} order=${order.join(',')} firstFile=${firstFile} firstTest=${firstTest} cleanup=signals-detached errors=${errors.join('; ')}`
      console.log(diagnostic)
      throw new Error(diagnostic)
    }
  }
}
if (import.meta.main) await runDomOrderGate()
