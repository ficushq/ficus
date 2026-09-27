import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { Command } from 'commander'
import { apiGet, apiPost } from '../client'
import { registerAssistantTaskCommands, renderAssistantTask } from './assistant-task'

const taskId = '507a9ac0-164e-4f49-9441-e57522bdc52b'
const task = {
  id: taskId,
  currentRequestId: '6a1c0b4e-8c2d-4f3e-9a7b-1c2d3e4f5a6b',
  agentId: 'agent-1',
  kind: 'background' as const,
  squadId: null,
  label: 'Compare options',
  status: 'waiting' as const,
  unavailable: false,
  createdAt: '2026-09-15T00:00:00.000Z',
  updatedAt: '2026-09-15T00:05:00.000Z',
}

describe('ficus assistant-task', () => {
  beforeEach(() => {
    ;(apiPost as ReturnType<typeof mock>).mockClear()
    ;(apiGet as ReturnType<typeof mock>).mockClear()
    ;(apiPost as ReturnType<typeof mock>).mockResolvedValue({ task, messageId: 'm1' })
    ;(apiGet as ReturnType<typeof mock>).mockResolvedValue(task)
  })

  async function run(args: string[]): Promise<void> {
    const program = new Command()
    program.exitOverride()
    registerAssistantTaskCommands(program)
    await program.parseAsync(args, { from: 'user' })
  }

  it('posts the exact status body with an optional message', async () => {
    await run([
      'assistant-task',
      'status',
      taskId,
      '--status',
      'completed',
      '--request-id',
      task.currentRequestId,
      '-m',
      'All done.',
    ])
    expect(apiPost).toHaveBeenCalledWith(`/api/assistant-tasks/${taskId}/status`, {
      status: 'completed',
      message: 'All done.',
      requestId: task.currentRequestId,
    })
    await run(['assistant-task', 'status', taskId, '--status', 'waiting'])
    expect(apiPost).toHaveBeenLastCalledWith(`/api/assistant-tasks/${taskId}/status`, { status: 'waiting' })
  })

  it('rejects unsupported statuses and requires one', async () => {
    await expect(run(['assistant-task', 'status', taskId, '--status', 'done'])).rejects.toThrow()
    await expect(run(['assistant-task', 'status', taskId])).rejects.toThrow()
    expect(apiPost).not.toHaveBeenCalled()
  })

  it('reads a task and renders its tracked state', async () => {
    await run(['assistant-task', 'get', taskId])
    expect(apiGet).toHaveBeenCalledWith(`/api/assistant-tasks/${taskId}`)
    const rendered = renderAssistantTask({ ...task, unavailable: true })
    expect(rendered).toContain('status:   waiting (agent unavailable)')
    expect(rendered).toContain('Compare options')
  })
})
