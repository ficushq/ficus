import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  BOX_RESERVED_PORTS_SYSCTL,
  FIRST_BOX_PORT,
  LAST_BOX_PORT,
  MACHINE_CALLBACK_PORT,
  isBoxPort,
  isFicusReservedMachinePort,
} from './box-ports'
import { MACHINE_REVERSE_PORT } from './tunnel-manager'

const repoRoot = join(import.meta.dir, '../../../../../')
const bootstrapPath = join(repoRoot, 'scripts/machine/bootstrap.sh')
const boxProvisionPath = join(repoRoot, 'scripts/machine/box-provision.sh')
const bootstrapSh = readFileSync(bootstrapPath, 'utf8')
const boxProvisionSh = readFileSync(boxProvisionPath, 'utf8')

/** The shared reservation block, between its >>> / <<< marker lines. */
function reservationBlock(script: string): string {
  const match = script.match(/\n(# >>> ficus-box-ports:[\s\S]*?\n# <<< ficus-box-ports)\n/)
  if (!match) throw new Error('ficus-box-ports block not found')
  return match[1]
}

function printPortGuard(unitMode: 'system' | 'user', port: number): string {
  const result = Bun.spawnSync(
    [
      'bash',
      boxProvisionPath,
      '--unix-user',
      'box_aaaaaaaaaaaa',
      '--port',
      String(port),
      '--unit-mode',
      unitMode,
      '--print-port-guard',
    ],
    { stderr: 'pipe' }
  )
  if (result.exitCode !== 0) throw new Error(`--print-port-guard failed: ${result.stderr.toString()}`)
  return result.stdout.toString()
}

describe('box port range', () => {
  it('reserves the callback port and the box range, and nothing in between', () => {
    expect(BOX_RESERVED_PORTS_SYSCTL).toBe('50080,50100-59999')
    expect(MACHINE_REVERSE_PORT).toBe(MACHINE_CALLBACK_PORT)
    expect(isBoxPort(FIRST_BOX_PORT)).toBe(true)
    expect(isBoxPort(LAST_BOX_PORT)).toBe(true)
    expect(isBoxPort(FIRST_BOX_PORT - 1)).toBe(false)
    expect(isBoxPort(LAST_BOX_PORT + 1)).toBe(false)
    expect(isFicusReservedMachinePort(MACHINE_CALLBACK_PORT)).toBe(true)
    expect(isFicusReservedMachinePort(MACHINE_CALLBACK_PORT + 1)).toBe(false)
  })

  // The allocator, the kernel reservation and the port guard must name the
  // same ports: a box port outside the reservation can collide with an
  // ephemeral port again.
  it('both machine scripts reserve exactly the range Core allocates from', () => {
    for (const script of [bootstrapSh, boxProvisionSh]) {
      expect(script).toContain(`FICUS_BOX_RESERVED_PORTS="${BOX_RESERVED_PORTS_SYSCTL}"`)
    }
  })

  it('keeps the reservation block byte-identical in both scripts', () => {
    expect(reservationBlock(bootstrapSh)).toBe(reservationBlock(boxProvisionSh))
  })

  it('bootstrap applies the reservation and reports it with the port-guard capability', () => {
    expect(bootstrapSh).toMatch(/\n {2}ensure_box_port_reservation \|\|\n/)
    expect(bootstrapSh).toContain('"boxPorts":"%s","socketBind":"%s"')
  })
})

describe('box port guard (SocketBindDeny)', () => {
  const deny = [
    'SocketBindDeny=ipv4:tcp:50080',
    'SocketBindDeny=ipv6:tcp:50080',
    'SocketBindDeny=ipv4:tcp:50100-59999',
    'SocketBindDeny=ipv6:tcp:50100-59999',
  ]

  // System mode: PID1 binds the socket from system.slice, so the box's own
  // slice can deny the whole range.
  it('denies the whole range to a system-mode box slice', () => {
    expect(printPortGuard('system', 51276)).toBe(['[Slice]', ...deny, ''].join('\n'))
  })

  // User mode: the box user's systemd --user manager binds the socket from
  // inside user-<uid>.slice. Without the allow rule the guard would break the
  // box's own socket activation.
  it("allows a user-mode box only its own port, so its user manager can bind the box's socket", () => {
    expect(printPortGuard('user', 51276)).toBe(['[Slice]', 'SocketBindAllow=ipv4:tcp:51276', ...deny, ''].join('\n'))
  })

  it("keeps the system socket unit out of the box's guarded slice", () => {
    const result = Bun.spawnSync([
      'bash',
      boxProvisionPath,
      '--unix-user',
      'box_aaaaaaaaaaaa',
      '--port',
      '51276',
      '--unit-mode',
      'system',
      '--print-units',
    ])
    const units = result.stdout.toString()
    const socket = units.slice(units.indexOf('# path: /etc/systemd/system/ficus-box-box_aaaaaaaaaaaa.socket'))
    const socketBody = socket.slice(0, socket.indexOf('# path:', 1))
    expect(socketBody).toContain('ListenStream=127.0.0.1:51276')
    expect(socketBody).not.toContain('Slice=')
  })
})
