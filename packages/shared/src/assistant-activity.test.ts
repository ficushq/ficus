import { expect, test } from 'bun:test'
import {
  applyAssistantTaskStatus,
  assistantConversationPath,
  assistantTaskStatusSchema,
  isTerminalAssistantTaskStatus,
  reportableAssistantTaskStatusSchema,
} from './assistant-activity'

test('progress without a status does not complete a task', () => {
  expect(applyAssistantTaskStatus('working', undefined, true)).toBe('working')
})

test('an older request cannot overwrite a newer request', () => {
  expect(applyAssistantTaskStatus('working', 'completed', false)).toBe('working')
})

test('a late progress report cannot reopen a completed request', () => {
  expect(applyAssistantTaskStatus('completed', 'working', true)).toBe('completed')
  expect(applyAssistantTaskStatus('failed', 'needs-input', true)).toBe('failed')
  expect(applyAssistantTaskStatus('cancelled', 'waiting', true)).toBe('cancelled')
})

test('a current explicit completion completes the task', () => {
  expect(applyAssistantTaskStatus('waiting', 'completed', true)).toBe('completed')
  expect(applyAssistantTaskStatus('unknown', 'working', true)).toBe('working')
})

test('terminal statuses are exactly completed, failed, and cancelled', () => {
  expect(assistantTaskStatusSchema.options.filter(isTerminalAssistantTaskStatus)).toEqual([
    'completed',
    'failed',
    'cancelled',
  ])
})

test('agents may not report the historical unknown status', () => {
  expect(reportableAssistantTaskStatusSchema.safeParse('unknown').success).toBe(false)
  expect(reportableAssistantTaskStatusSchema.safeParse('done').success).toBe(false)
  expect(reportableAssistantTaskStatusSchema.safeParse('needs-input').success).toBe(true)
})

test('conversation URL uses the existing saved Assistant route', () => {
  const id = '507a9ac0-164e-4f49-9441-e57522bdc52b'
  const url = new URL(assistantConversationPath(id), 'https://ficus.invalid')
  expect(url.pathname).toBe('/')
  expect(url.searchParams.get('chat')).toBe('open')
  expect(url.searchParams.get('assistantConversation')).toBe(id)
  expect(() => assistantConversationPath('../settings')).toThrow()
})
