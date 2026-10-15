import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

/**
 * Commit signing leaves a commit or tag unsigned by having `ficus -Y sign`
 * return an empty signature, which relies on undocumented git behavior. The
 * check script pins that behavior down; the Docker sandbox image runs it at
 * build time and this test runs it against the host git, so a git release that
 * changes the behavior fails here or in the image build.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..')
const scriptPath = 'apps/core/docker-sandbox/check-git-unsigned-signing.sh'
const script = readFileSync(resolve(repoRoot, scriptPath), 'utf8')
const dockerfile = readFileSync(resolve(repoRoot, 'apps/core/docker-sandbox/Dockerfile'), 'utf8')

const scratch = mkdtempSync(join(tmpdir(), 'git-unsigned-signing-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function run(source: string): { exitCode: number; output: string } {
  const path = join(scratch, `check-${crypto.randomUUID()}.sh`)
  writeFileSync(path, source)
  const result = Bun.spawnSync(['sh', path], { stdout: 'pipe', stderr: 'pipe' })
  return { exitCode: result.exitCode, output: `${result.stdout.toString()}${result.stderr.toString()}` }
}

/** The script with its stub signing program's signature line replaced. */
function withStubSignature(line: string): string {
  const original = `printf '%s' "\${STUB_SIGNATURE:-}" >"$last.sig"`
  expect(script).toContain(original)
  return script.replace(original, line)
}

describe('git leaves objects unsigned for an empty SSH signature', () => {
  test('holds for the host git', () => {
    const result = run(script)
    expect(result.output).toContain('check-git-unsigned-signing: ok')
    expect(result.exitCode).toBe(0)
  })

  test('fails when the unsigned commit gets a gpgsig header', () => {
    const result = run(withStubSignature(`printf 'x' >"$last.sig"`))
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('commit.gpgsign commit has a gpgsig header')
  })

  test('fails when the unsigned commit cannot be made', () => {
    const result = run(
      withStubSignature(`printf '%s' "\${STUB_SIGNATURE:-}" >"$last.sig"; [ -n "$STUB_SIGNATURE" ] || exit 1`)
    )
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('git commit -q --allow-empty -m unsigned by config failed')
  })

  test('the Docker sandbox image runs the check after installing git', () => {
    const installGit = dockerfile.search(/^RUN apk add --no-cache \\\n(?:\s+.*\\\n)*?\s+git \\$/m)
    const copy = dockerfile.indexOf(`COPY ${scriptPath} /opt/ficus/check-git-unsigned-signing.sh`)
    const check = dockerfile.indexOf('RUN sh /opt/ficus/check-git-unsigned-signing.sh')
    expect(installGit).toBeGreaterThan(-1)
    expect(copy).toBeGreaterThan(installGit)
    expect(check).toBeGreaterThan(copy)
  })
})
