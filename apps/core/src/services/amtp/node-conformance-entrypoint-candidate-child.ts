import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync, realpathSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const HASH_PATTERN = /^[a-f0-9]{64}$/
const ACTION_MARKER = 'action-settled'
const IMPORT_MARKER = 'import-settled'

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`candidate-entrypoint:${name.toLowerCase()}-missing`)
  return value
}

function resolveCandidateEntrypoint(candidateRoot: string): string {
  const root = realpathSync(resolve(candidateRoot))
  const entrypoint = realpathSync(join(root, 'src', 'index.ts'))
  const entryRelativeToRoot = relative(root, entrypoint)
  if (entryRelativeToRoot.startsWith(`..${sep}`) || entryRelativeToRoot === '..') {
    throw new Error('candidate-entrypoint:path-escaped-root')
  }
  if (entryRelativeToRoot !== join('src', 'index.ts')) {
    throw new Error(`candidate-entrypoint:unexpected-path:${entryRelativeToRoot}`)
  }
  return entrypoint
}

async function waitForActionMarker(markerPath: string, timeoutMs: number): Promise<string[]> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const markers = readFileSync(markerPath, 'utf8').trim().split('\n').filter(Boolean)
    if (markers.includes(ACTION_MARKER)) return markers
    await Bun.sleep(5)
  }
  throw new Error('candidate-entrypoint:action-marker-timeout')
}

const candidateRoot = requiredEnvironment('AMTP_NODE_CANDIDATE_ROOT')
const expectedDigest = requiredEnvironment('AMTP_NODE_CANDIDATE_SHA256')
const markerPath = requiredEnvironment('AMTP_NODE_CANDIDATE_MARKER_PATH')
if (!HASH_PATTERN.test(expectedDigest)) throw new Error('candidate-entrypoint:invalid-sha256')

const entrypoint = resolveCandidateEntrypoint(candidateRoot)
const beforeDigest = sha256(entrypoint)
if (beforeDigest !== expectedDigest) {
  throw new Error(`candidate-entrypoint:pre-execution-digest-mismatch:${beforeDigest}`)
}

process.argv = [process.execPath, entrypoint, '__ficus-lifecycle-probe']
await import(`${pathToFileURL(entrypoint).href}?candidateSha256=${beforeDigest}`)
appendFileSync(markerPath, `${IMPORT_MARKER}\n`)
const markers = await waitForActionMarker(markerPath, 1_000)

const afterDigest = sha256(entrypoint)
if (afterDigest !== expectedDigest) {
  throw new Error(`candidate-entrypoint:post-execution-digest-mismatch:${afterDigest}`)
}

console.log(
  JSON.stringify({
    kind: 'amtp-node-candidate-result',
    entrypoint,
    beforeDigest,
    afterDigest,
    markers,
  })
)
