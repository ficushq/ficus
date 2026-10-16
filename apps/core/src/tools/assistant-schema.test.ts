import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { createAssistantTools } from './assistant'

test('delegate_task requires a short, described label so task chips can name the work', () => {
  const tools = createAssistantTools(randomUUID(), randomUUID(), randomUUID())
  const delegate = tools.find((tool) => tool.name === 'delegate_task')!
  const parameters = delegate.parameters as unknown as {
    required: string[]
    properties: Record<string, { type: string; minLength?: number; maxLength?: number; description?: string }>
  }

  expect(delegate.description).toContain('Give every task a short label.')
  expect(parameters.required).toContain('label')
  expect(parameters.properties.label).toMatchObject({ type: 'string', minLength: 1, maxLength: 80 })
  expect(parameters.properties.label!.description).toContain('3–6 words naming the task')
  expect(parameters.properties.label!.description).toContain('No status words or secrets.')
})
