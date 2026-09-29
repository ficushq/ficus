import { describe, expect, it } from 'bun:test'
import {
  countOwnServiceCgroupChildren,
  formatDetachedProcessWarning,
  isServiceCgroupManaged,
  parseUnifiedCgroupPath,
  resolveCgroupProcsPath,
  SERVICE_CGROUP_ARG,
} from './service-cgroup'

const MOUNTINFO = '29 23 0:26 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime - cgroup2 cgroup rw\n'
const CGROUP = '0::/system.slice/tau-box-x.service\n'

describe('service cgroup parsing', () => {
  it('resolves an Ubuntu unified service cgroup', () => {
    expect(parseUnifiedCgroupPath(CGROUP)).toBe('/system.slice/tau-box-x.service')
    expect(resolveCgroupProcsPath(MOUNTINFO, '/system.slice/tau-box-x.service')).toBe(
      '/sys/fs/cgroup/system.slice/tau-box-x.service/cgroup.procs'
    )
  })

  it('rejects legacy, ambiguous, and unsafe cgroup paths', () => {
    expect(() => parseUnifiedCgroupPath('2:cpu:/legacy\n')).toThrow('unified cgroup')
    expect(() => parseUnifiedCgroupPath('0::/a\n0::/b\n')).toThrow('unified cgroup')
    expect(() => parseUnifiedCgroupPath('0::/../../escape\n')).toThrow('invalid cgroup path')
    expect(() => parseUnifiedCgroupPath('0::/system.slice/x (deleted)\n')).toThrow('invalid cgroup path')
  })

  it('accounts for a non-root cgroup2 mount root', () => {
    const mount = '29 23 0:26 /system.slice /sys/fs/cgroup rw - cgroup2 cgroup rw\n'
    expect(resolveCgroupProcsPath(mount, '/system.slice/app.service')).toBe('/sys/fs/cgroup/app.service/cgroup.procs')
    expect(() => resolveCgroupProcsPath(mount, '/user.slice/app.service')).toThrow('cgroup2 mount')
  })
})

describe('isServiceCgroupManaged', () => {
  // The merged #1363 defect: host.env/server.env are systemd
  // `EnvironmentFile=` inputs, and EnvironmentFile content replaces
  // `Environment=` values regardless of unit order — so the marker had to move
  // to the one channel those configurable files cannot override: the unit's
  // ExecStart argv.
  it('the ExecStart switch is authoritative over every hostile/empty/false environment value', () => {
    const argv = ['bun', '/opt/tau/server/server.js', SERVICE_CGROUP_ARG]
    for (const hostile of ['0', '', 'garbage', '1']) {
      expect(isServiceCgroupManaged(argv, { EXECUTOR_SERVICE_CGROUP: hostile })).toBe(true)
    }
    expect(isServiceCgroupManaged(argv, {})).toBe(true)
  })

  it('the legacy environment marker still affirms for units provisioned before the switch existed', () => {
    // Transitional fallback: a unit provisioned before the flag still carries
    // `Environment=EXECUTOR_SERVICE_CGROUP=1` and must keep its census.
    expect(isServiceCgroupManaged(['bun', '/opt/tau/server/server.js'], { EXECUTOR_SERVICE_CGROUP: '1' })).toBe(true)
  })

  it('a non-service server (k8s/docker/local test) assumes no systemd ownership', () => {
    const argv = ['bun', '/opt/tau/server/server.js']
    expect(isServiceCgroupManaged(argv, {})).toBe(false)
    for (const value of ['0', '', 'no', 'true']) {
      expect(isServiceCgroupManaged(argv, { EXECUTOR_SERVICE_CGROUP: value })).toBe(false)
    }
  })
})

describe('countOwnServiceCgroupChildren', () => {
  it('deduplicates members, requires self, and returns only a child count', async () => {
    const paths: string[] = []
    const fixtures = new Map([
      ['/proc/self/cgroup', CGROUP],
      ['/proc/self/mountinfo', MOUNTINFO],
      ['/sys/fs/cgroup/system.slice/tau-box-x.service/cgroup.procs', '41\n42\n42\n43\n'],
    ])
    const count = await countOwnServiceCgroupChildren({
      platform: 'linux',
      selfPid: 41,
      readFile: async (path) => {
        paths.push(path)
        return fixtures.get(path)!
      },
    })
    expect(count).toBe(2)
    expect(paths).toEqual([
      '/proc/self/cgroup',
      '/proc/self/mountinfo',
      '/sys/fs/cgroup/system.slice/tau-box-x.service/cgroup.procs',
    ])
  })

  it('fails closed for malformed membership, missing self, and oversized control data', async () => {
    const run = (members: string) =>
      countOwnServiceCgroupChildren({
        platform: 'linux',
        selfPid: 41,
        readFile: async (path) =>
          path === '/proc/self/cgroup' ? CGROUP : path === '/proc/self/mountinfo' ? MOUNTINFO : members,
      })
    await expect(run('041\n')).rejects.toThrow('invalid cgroup member')
    await expect(run('42\n')).rejects.toThrow('server process')
    await expect(run('41\n' + '9'.repeat(65_536))).rejects.toThrow('size limit')
  })

  it('does not read proc on unsupported platforms', async () => {
    let reads = 0
    await expect(
      countOwnServiceCgroupChildren({
        platform: 'darwin',
        selfPid: 41,
        readFile: async () => {
          reads += 1
          return ''
        },
      })
    ).rejects.toThrow('Linux')
    expect(reads).toBe(0)
  })
})

describe('formatDetachedProcessWarning', () => {
  it('returns fixed bounded text containing only the validated count', () => {
    expect(formatDetachedProcessWarning(2)).toBe(
      '[sandbox] WARN: idle exit will terminate 2 unsupported background processes in the box service cgroup'
    )
    expect(formatDetachedProcessWarning(1)).toBe(
      '[sandbox] WARN: idle exit will terminate 1 unsupported background process in the box service cgroup'
    )
    expect(formatDetachedProcessWarning(2)).not.toContain('SECRET_FIXTURE')
    expect(formatDetachedProcessWarning(2).length).toBeLessThan(180)
  })
})
