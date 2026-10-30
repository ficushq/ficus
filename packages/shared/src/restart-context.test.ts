import { describe, expect, it } from 'bun:test'
import {
  restartPauseChatNotice,
  restartResumeChatNotice,
  restartResumeFailedChatNotice,
  restartResumeNotice,
} from './restart-context'

describe('restart notices: the agent copy and the chat copies', () => {
  const restart = { restartId: 'restart-7', restartedAt: '2026-10-30T16:35:22.839Z' }

  it('the agent copy names the restart id, which also appears on every command the restart cancelled', () => {
    expect(restartResumeNotice(restart)).toContain('[restart id: restart-7]')
  })

  it('the chat copies render as system rows for people: no id, no raw timestamp', () => {
    for (const text of [restartPauseChatNotice(), restartResumeChatNotice(), restartResumeFailedChatNotice('boom')]) {
      expect(text).toStartWith('[System] ')
      expect(text).not.toContain('restart id')
      expect(text).not.toContain('2026-10-30')
    }
    expect(restartResumeFailedChatNotice('boom')).toEndWith('could not finish: boom')
  })
})
