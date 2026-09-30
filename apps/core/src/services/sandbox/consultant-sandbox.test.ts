import { expect, test } from 'bun:test'
import { consultantSandboxId, consultantSandboxSquadId, consultantScratchPath } from './consultant-sandbox'
import { buildWorkspacePrompt } from '../../lib/prompts/workspace-prompt'
import { resolveAgentBashCwd } from '../../tools/sandbox-tools'

test('consultant scratch paths are distinct and the prompt describes shared custody', () => {
  const sandboxId = consultantSandboxId('squad-one')
  expect(consultantSandboxSquadId(sandboxId)).toBe('squad-one')
  expect(consultantSandboxSquadId('agent_one')).toBeNull()
  expect(consultantScratchPath('/private', sandboxId, 'chat-one')).toBe('/private/conversations/chat-one')
  expect(consultantScratchPath('/private', sandboxId, 'chat-two')).toBe('/private/conversations/chat-two')
  expect(() => consultantScratchPath('/private', sandboxId, '../escape')).toThrow()
  expect(() => consultantScratchPath('/private', sandboxId)).toThrow()
  const prompt = buildWorkspacePrompt({ sandboxId, squadId: 'squad-one', agentId: 'chat-one' })
  expect(prompt).toContain(resolveAgentBashCwd(sandboxId, 'chat-one'))
  expect(prompt).toContain('other consultant chats can access this runtime')
  expect(prompt).not.toContain('no teammate can read it')
})
