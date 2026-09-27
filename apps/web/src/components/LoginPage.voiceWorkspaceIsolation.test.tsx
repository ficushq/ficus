import { describe, expect, mock, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { LoginPage } from './LoginPage'
import { VoiceWorkspacePage, type VoiceWorkspaceEnvironment } from './VoiceWorkspacePage'
import type { useRealtimeVoiceAssistant } from '../voice/useRealtimeVoiceAssistant'

const authModes = [
  {
    name: 'first passkey admin',
    status: { authEnabled: true, mode: 'passkey', hasUsers: false, hasAdminUser: false },
    authenticated: false,
    marker: 'Create Admin Account',
  },
  {
    name: 'password bootstrap',
    status: { authEnabled: true, mode: 'password', hasUsers: false, hasAdminUser: false },
    authenticated: false,
    marker: 'Enter the instance password',
  },
  {
    name: 'authenticated bootstrap',
    status: { authEnabled: true, mode: 'password', hasUsers: false, hasAdminUser: false },
    authenticated: true,
    marker: 'Create the first admin account',
  },
  {
    name: 'passkey login',
    status: { authEnabled: true, mode: 'passkey', hasUsers: true, hasAdminUser: true },
    authenticated: false,
    marker: 'Sign in with Passkey',
  },
  {
    name: 'invite-only login',
    status: { authEnabled: true, mode: 'passkey', hasUsers: true, hasAdminUser: true, canSelfRegister: false },
    authenticated: false,
    marker: 'Lost your passkey?',
  },
  {
    name: 'open registration',
    status: { authEnabled: true, mode: 'passkey', hasUsers: true, hasAdminUser: true, canSelfRegister: true },
    authenticated: false,
    marker: 'Create account',
  },
  {
    name: 'bootstrap ignores policy',
    status: { authEnabled: true, mode: 'passkey', hasUsers: false, hasAdminUser: false, canSelfRegister: false },
    authenticated: false,
    marker: 'Set up Ficus',
  },
  {
    name: 'legacy password',
    status: { authEnabled: true, mode: 'password', hasUsers: true, hasAdminUser: false },
    authenticated: false,
    marker: 'Login',
  },
  {
    name: 'passkey recovery',
    status: { authEnabled: true, mode: 'passkey', hasUsers: true, hasAdminUser: true, canSelfRegister: true },
    authenticated: false,
    marker: 'Lost your passkey?',
  },
  {
    name: 'invite-only recovery',
    status: { authEnabled: true, mode: 'passkey', hasUsers: true, hasAdminUser: true, canSelfRegister: false },
    authenticated: false,
    marker: 'Lost your passkey?',
  },
] as const

function renderLoginModes() {
  for (const mode of authModes) {
    const html = renderToStaticMarkup(
      <LoginPage
        auth={{
          authStatus: mode.status,
          isAuthenticated: mode.authenticated,
          login: async () => {},
          loginWithToken: async () => {},
        }}
      />
    )
    expect(html, mode.name).toContain(mode.marker)
  }
}

function renderRouterConsumer() {
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={['/unrelated']}>
      <Routes>
        <Route path="/unrelated" element={<span>unrelated router consumer</span>} />
      </Routes>
    </MemoryRouter>
  )
  expect(html).toContain('unrelated router consumer')
}

function scenarioFixture() {
  let voiceFixtureCalls = 0
  const environment: VoiceWorkspaceEnvironment = {
    mediaDevices: { getUserMedia: mock(async () => undefined) },
    isSecureContext: true,
    storage: { getItem: () => null, setItem: () => undefined },
  }
  const hook = (() => {
    voiceFixtureCalls++
    return {
      status: 'idle',
      history: [],
      error: null,
      connect: async () => undefined,
      disconnect: () => undefined,
      restartFresh: async () => undefined,
      updateInstructions: () => undefined,
      interrupt: () => undefined,
      toggleMicMuted: () => undefined,
      startUserSpeech: () => undefined,
      submitUserSpeech: () => undefined,
      isConnected: false,
      isMicMuted: false,
      inputLevel: 0,
      rateLimitRetry: null,
      state: { activeCanvasId: null, canvases: [], displayedApps: [] },
    }
  }) as unknown as typeof useRealtimeVoiceAssistant
  const renderVoice = () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <VoiceWorkspacePage environment={environment} useRealtimeVoiceAssistant={hook} />
      </QueryClientProvider>
    )
    expect(html).toContain('Automatic')
  }
  return { renderVoice, calls: () => voiceFixtureCalls }
}

function assertEnvironmentPreserved(processWindow: Window & typeof globalThis, calls: number) {
  expect(globalThis.window).toBe(processWindow)
  expect(calls).toBeGreaterThan(0)
}

describe('LoginPage and VoiceWorkspacePage isolation', () => {
  test('forward: voice, all login modes, then router', () => {
    const processWindow = globalThis.window
    const fixture = scenarioFixture()
    fixture.renderVoice()
    renderLoginModes()
    renderRouterConsumer()
    assertEnvironmentPreserved(processWindow, fixture.calls())
  })

  test('reverse: router and login modes before and after voice', () => {
    const processWindow = globalThis.window
    const fixture = scenarioFixture()
    renderRouterConsumer()
    renderLoginModes()
    fixture.renderVoice()
    renderLoginModes()
    assertEnvironmentPreserved(processWindow, fixture.calls())
  })

  test('interleaves voice with every login mode', () => {
    const processWindow = globalThis.window
    const fixture = scenarioFixture()
    for (let index = 0; index < authModes.length; index++) {
      fixture.renderVoice()
      renderLoginModes()
    }
    renderRouterConsumer()
    assertEnvironmentPreserved(processWindow, fixture.calls())
  })

  test.concurrent('concurrently schedules independent voice, login, and router consumers', async () => {
    const processWindow = globalThis.window
    const fixture = scenarioFixture()
    await Promise.all([
      Promise.resolve().then(fixture.renderVoice),
      Promise.resolve().then(renderLoginModes),
      Promise.resolve().then(renderRouterConsumer),
    ])
    assertEnvironmentPreserved(processWindow, fixture.calls())
  })
})
