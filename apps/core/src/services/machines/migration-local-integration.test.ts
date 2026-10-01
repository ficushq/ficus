import { expect, it } from 'bun:test'
import { randomBytes, randomUUID } from 'crypto'
import { createMigrationManifest, compareMigrationManifests } from './migration-manifest'
import { buildMigrationScanCommand, parseMigrationScanRecords } from './migration-scanner'
import { buildArchiveStreamCommand } from './box-manager'

const run = async (command: string) => {
  const proc = Bun.spawn(['bash', '-c', command], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

it('round-trips manifested durable roots through production archive and staged restore', async () => {
  if (process.getuid?.() !== 0) return
  const suffix = randomBytes(6).toString('hex')
  const sourceUser = `box_${suffix}`
  const targetUser = `box_${randomBytes(6).toString('hex')}`
  const operationId = randomUUID()
  const sourceHome = `/home/${sourceUser}`
  const targetHome = `/home/${targetUser}`
  const stagingHome = `${targetHome}/.ficus-migrate/${operationId}`
  const script = `${process.cwd()}/scripts/machine/box-provision.sh`
  const identity = {
    operationId,
    sandboxId: `agent_${randomUUID()}`,
    source: { machineId: 'source', generation: null, unixUser: sourceUser },
    target: { machineId: 'target', generation: null, unixUser: targetUser },
  }
  try {
    expect((await run(`useradd -m ${sourceUser}; useradd -m ${targetUser}`)).exitCode).toBe(0)
    expect(
      (
        await run(
          `install -d -o ${sourceUser} -g ${sourceUser} ${sourceHome}/workspace/'empty dir' ${sourceHome}/.private/nested; ` +
            `printf secret > ${sourceHome}/workspace/.hidden; printf unicode > '${sourceHome}/.private/nested/λ name'; ` +
            `ln -s missing ${sourceHome}/workspace/dangling; chown -R ${sourceUser}:${sourceUser} ${sourceHome}/workspace ${sourceHome}/.private; chmod 755 ${sourceHome}/workspace; chmod 700 ${sourceHome}/.private; ` +
            `install -d -o ${targetUser} -g ${targetUser} ${targetHome}/workspace ${targetHome}/.private`
        )
      ).exitCode
    ).toBe(0)
    const sourceScan = await run(buildMigrationScanCommand(sourceHome, sourceUser))
    expect(sourceScan.exitCode).toBe(0)
    const source = createMigrationManifest(identity, parseMigrationScanRecords(sourceScan.stdout))
    const archive = buildArchiveStreamCommand(sourceHome, ['workspace', '.private'], 'gzip')
    const restore = `sudo bash ${script} --unix-user ${targetUser} --restore-stream --codec gzip --state-dirs 'workspace .private' --staging-id ${operationId}`
    expect((await run(`${archive} | ${restore}`)).exitCode).toBe(0)
    const stagedScan = await run(buildMigrationScanCommand(stagingHome, targetUser))
    expect(stagedScan.exitCode).toBe(0)
    const staged = createMigrationManifest(identity, parseMigrationScanRecords(stagedScan.stdout))
    expect(compareMigrationManifests(source, staged)).toEqual({ ok: true })
  } finally {
    await run(`userdel -r ${sourceUser} 2>/dev/null || true; userdel -r ${targetUser} 2>/dev/null || true`)
  }
})
