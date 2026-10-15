import { describe, it, expect, beforeAll } from 'bun:test'
import { Command } from 'commander'
import { formatMonitorRestart, registerMonitorCommands } from './monitor'

describe('monitor CLI commands', () => {
  let monitorCommand: Command | undefined

  beforeAll(() => {
    const program = new Command()
    program.exitOverride()
    registerMonitorCommands(program)
    monitorCommand = program.commands.find((command) => command.name() === 'monitor')
  })

  it('exposes read and cancel management commands only', () => {
    expect(monitorCommand?.description()).toContain('read/cancel only')
    expect(monitorCommand?.commands.map((command) => command.name()).sort()).toEqual(['cancel', 'list', 'logs', 'show'])
  })

  it('supports scoped listing and bounded log tail options', () => {
    const list = monitorCommand?.commands.find((command) => command.name() === 'list')
    expect(list?.options.map((option) => option.long).sort()).toEqual(['--active', '--agent', '--squad', '--status'])
    const logs = monitorCommand?.commands.find((command) => command.name() === 'logs')
    expect(logs?.options.find((option) => option.long === '--tail')?.defaultValue).toBe('100')
  })

  it('formats the restart policy and relaunch state for the list table', () => {
    expect(formatMonitorRestart({})).toBe('never')
    expect(formatMonitorRestart({ restartPolicy: 'never', restartCount: 0 })).toBe('never')
    expect(formatMonitorRestart({ restartPolicy: 'on-loss', restartCount: 1 })).toBe('on-loss (1 restart)')
    expect(
      formatMonitorRestart({ restartPolicy: 'on-loss', restartCount: 3, nextRestartAt: '2026-10-15T00:00:00.000Z' })
    ).toBe('on-loss (3 restarts, relaunch pending)')
  })
})
