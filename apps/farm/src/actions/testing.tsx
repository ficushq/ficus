/**
 * Test harness for the action forms: a fake ActionsApi whose every call is a
 * bun mock, a QueryClient with an invalidation spy, and small DOM helpers in
 * the client-react house style (react-dom/client + act). Test-only; not
 * imported by the app.
 */
import { mock, spyOn, type Mock } from 'bun:test'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query'
import type { ActionsApi } from './api'
import { ActionsApiProvider } from './ActionsApiProvider'

type AnyFn = (...args: never[]) => unknown
export type MockedApi = { [K in keyof ActionsApi]: Mock<ActionsApi[K]> }

const notStubbed = (name: string) => () => Promise.reject(new Error(`${name} was not stubbed`))

export function fakeApi(overrides: Partial<ActionsApi> = {}): MockedApi {
  const defaults: ActionsApi = {
    getAgentQuestions: notStubbed('getAgentQuestions'),
    answerAgentQuestion: notStubbed('answerAgentQuestion'),
    dismissAgentQuestion: notStubbed('dismissAgentQuestion'),
    retryAgentQuestionAnswerDelivery: notStubbed('retryAgentQuestionAnswerDelivery'),
    sendAgentMessage: notStubbed('sendAgentMessage'),
    continueHaltedActions: notStubbed('continueHaltedActions'),
    resolveWorkStreamWait: notStubbed('resolveWorkStreamWait'),
    getWorkStream: notStubbed('getWorkStream'),
    workflowRun: notStubbed('workflowRun'),
    advanceWorkflow: notStubbed('advanceWorkflow'),
    finishWorkflow: notStubbed('finishWorkflow'),
    pauseWorkStream: notStubbed('pauseWorkStream'),
    resumeWorkStream: notStubbed('resumeWorkStream'),
    parkWorkStream: notStubbed('parkWorkStream'),
    getMyPermissions: () => Promise.resolve({ permissions: ['*'], identity: { type: 'user', userId: 'user-1' } }),
    newRequestId: () => 'request-1',
  }
  const merged = { ...defaults, ...overrides }
  const mocked: Record<string, unknown> = {}
  for (const [key, fn] of Object.entries(merged)) mocked[key] = mock(fn as AnyFn)
  return mocked as unknown as MockedApi
}

const mounted: Array<{ root: Root; container: HTMLElement }> = []

export interface Rendered {
  container: HTMLElement
  queryClient: QueryClient
  /** Every query key passed to invalidateQueries so far. */
  invalidated: () => QueryKey[]
}

export async function render(ui: ReactNode, api: ActionsApi, queryClient = testQueryClient()): Promise<Rendered> {
  const spy = spyOn(queryClient, 'invalidateQueries')
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ActionsApiProvider api={api}>{ui}</ActionsApiProvider>
      </QueryClientProvider>
    )
  })
  await settle()
  return {
    container,
    queryClient,
    invalidated: () => spy.mock.calls.map(([filters]) => filters?.queryKey ?? []),
  }
}

export function cleanup() {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount())
    container.remove()
  }
}

export function testQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
}

/** Let promises, React Query notifications and re-renders run. */
export async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

/** The button whose farm verb (or whole text, for plain buttons) is exactly `label`. */
export function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (candidate) => (candidate.querySelector('.g-verb-label')?.textContent ?? candidate.textContent)?.trim() === label
  )
  if (!found) {
    const labels = [...container.querySelectorAll('button')].map((b) => b.textContent)
    throw new Error(`No button "${label}". Buttons: ${JSON.stringify(labels)}`)
  }
  return found as HTMLButtonElement
}

export function hasButton(container: HTMLElement, label: string): boolean {
  try {
    button(container, label)
    return true
  } catch {
    return false
  }
}

export async function click(element: Element) {
  await act(async () => {
    ;(element as HTMLElement).click()
  })
  await settle()
}

/** Type into a controlled input/textarea the way React sees it. */
export async function typeInto(element: Element, value: string) {
  const proto = element instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement : window.HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto.prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

export function byLabel(container: HTMLElement, text: string): HTMLInputElement | HTMLTextAreaElement {
  const label = [...container.querySelectorAll('label')].find((candidate) => candidate.textContent?.trim() === text)
  const id = label?.getAttribute('for')
  const control = id ? container.ownerDocument.getElementById(id) : null
  if (!control) throw new Error(`No control labelled "${text}"`)
  return control as HTMLInputElement | HTMLTextAreaElement
}

export function hasKey(keys: QueryKey[], key: QueryKey): boolean {
  return keys.some((candidate) => JSON.stringify(candidate) === JSON.stringify(key))
}
