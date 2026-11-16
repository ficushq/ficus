import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { WorkloadCgroupBackend } from '../services/workload-cgroup'

/**
 * A cgroup2 mount faked in a temporary directory. Control files are plain
 * files; an xattr is stored as a `xattr.<name>` file inside the cgroup's
 * directory, so a test command (or the test) can set the counter systemd-oomd
 * would set. /proc/self/cgroup and mountinfo answer as the server process in
 * the given cgroup.
 */
export function fakeCgroupBackend(
  root: string,
  ownCgroup: string,
  options: { controllers?: string; failSetXattr?: boolean } = {}
): WorkloadCgroupBackend & { unitDir: string } {
  const unitDir = join(root, ownCgroup, '..')
  mkdirSync(join(root, ownCgroup), { recursive: true })
  writeFileSync(join(unitDir, 'cgroup.controllers'), options.controllers ?? 'cpu io memory pids')
  const proc: Record<string, string> = {
    '/proc/self/cgroup': `0::${ownCgroup}\n`,
    '/proc/self/mountinfo': `30 25 0:26 / ${root} rw,nosuid shared:4 - cgroup2 cgroup2 rw,nsdelegate,memory_recursiveprot\n`,
  }
  return {
    unitDir,
    async readFile(path) {
      if (path in proc) return proc[path]!
      return readFileSync(path, 'utf8')
    },
    async writeFile(path, data) {
      writeFileSync(path, data)
    },
    async mkdir(path) {
      mkdirSync(path, { recursive: true })
    },
    async rmdir(path) {
      rmSync(path, { recursive: true })
    },
    async readdir(path) {
      return readdirSync(path)
    },
    setXattr(path, name, value) {
      if (options.failSetXattr) throw new Error('setxattr user.oomd_omit failed (errno 95)')
      writeFileSync(join(path, `xattr.${name}`), value)
    },
    getXattr(path, name) {
      const file = join(path, `xattr.${name}`)
      return existsSync(file) ? readFileSync(file, 'utf8') : undefined
    },
  }
}
