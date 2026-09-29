export function runOwnedDocker(args: string[], owner: string) {
  if (!owner.match(/^[a-zA-Z0-9_.-]+$/)) throw new Error('Invalid Docker test owner')
  return Bun.spawnSync(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' })
}

export function removeOwnedDockerContainers(owner: string): void {
  const listed = runOwnedDocker(['ps', '-aq', '--filter', `label=ficus.test-owner=${owner}`], owner)
  if (listed.exitCode !== 0) throw new Error('Unable to list owned Docker fixtures')
  const ids = listed.stdout.toString().trim().split(/\s+/).filter(Boolean)
  if (ids.length) runOwnedDocker(['rm', '-f', ...ids], owner)
  const remaining = runOwnedDocker(['ps', '-aq', '--filter', `label=ficus.test-owner=${owner}`], owner)
  if (remaining.exitCode !== 0 || remaining.stdout.toString().trim())
    throw new Error('Owned Docker cleanup was not proven')
}
