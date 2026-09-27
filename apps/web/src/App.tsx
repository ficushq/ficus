import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { ChatPage } from './components/ChatPage'
import { ChatDrawer } from './components/ChatDrawer'
import { SquadsPage } from './components/SquadsPage'
import { ActivityPage } from './components/ActivityPage'
import { SquadDetailPage } from './components/SquadDetailPage'
import { SquadManagerChatPage } from './components/SquadManagerChatPage'
import { SquadConsultantChatPage } from './components/SquadConsultantChatPage'
import { SettingsPage } from './components/SettingsPage'
import { OAuthCallbackPage } from './components/integrations/OAuthCallbackPage'
import { FeedPage } from './components/FeedPage'
import { UpdateBanner } from './components/UpdateBanner'
import { OfflineBanner } from './components/OfflineBanner'
import { StorageBanner } from './components/StorageBanner'
import { MaintenanceBanner } from './components/MaintenanceBanner'
import { AppHeader, MobileBottomNav, DesktopFooter } from './components/AppNav'
import { LoginPage } from './components/LoginPage'
import { DemoAccessPage } from './components/auth/DemoAccessPage'
import { TokenRegisterPage } from './components/auth/TokenRegisterPage'
import { FinishAdminSetupPage } from './components/auth/FinishAdminSetupPage'
import { InboxPopup } from './components/InboxPopup'
import { ActionsPage } from './components/ActionsPage'
import { InboxPage } from './components/InboxPage'
import { SchedulesPage } from './components/SchedulesPage'
import { VoiceWorkspacePage } from './components/VoiceWorkspacePage'
import { OnboardingPage } from './components/onboarding/OnboardingPage'
import { OnboardingBanner } from './components/onboarding/OnboardingBanner'
import { useAuth } from './providers/AuthProvider'
import { useRef } from 'react'
import { useVisualViewportShell } from './hooks/useVisualViewportShell'
import { DesktopNotifications } from './components/DesktopNotifications'
import { useDesktopShellChrome } from './hooks/useDesktopShellChrome'

export default function App() {
  // Fit the fixed shell to the visible area while a software keyboard is open (see the hook).
  const shellRef = useRef<HTMLDivElement>(null)
  useVisualViewportShell(shellRef)
  // Inside Ficus Desktop with an inset title bar, the header doubles as the window's title bar.
  useDesktopShellChrome()
  const {
    authRequired,
    authStatus,
    isAuthenticated,
    needsFirstAdminSetup,
    needsAdminCompletion,
    session,
    loginWithToken,
    logout,
  } = useAuth()
  const location = useLocation()

  // Still checking auth status
  if (authRequired === null) return null

  // Invite / passkey-recovery deep link. Checked BEFORE the auth gate (the /voice
  // precedent) because the whole point is that the visitor has no session yet — the
  // gate would otherwise swallow the path and render the login page instead. Also
  // checked before the authenticated shell, so an already-signed-in person opening
  // an invite for a DIFFERENT account still lands on the ceremony.
  if (location.pathname === '/register') {
    return <TokenRegisterPage onSuccess={loginWithToken} />
  }
  // App-store reviewer access on a designated demo instance: same reasoning, the
  // visitor has no session. The page redirects home unless the server opted in.
  if (location.pathname === '/demo') {
    return <DemoAccessPage enabled={authStatus?.demoReviewerAccess === true} />
  }

  // Auth required but not authenticated — show login. `needsFirstAdminSetup` forces
  // the same funnel even when authenticated: the bootstrap instance password is a
  // valid identity, so a refresh mid-setup would otherwise render an adminless shell.
  if (authRequired && (!isAuthenticated || needsFirstAdminSetup)) return <LoginPage />

  // Signed in with the bootstrap instance password while an account still waits for
  // its first admin passkey. That session is nobody, so the shell would half-work
  // (person-scoped actions like connecting GitHub fail); finish setup first.
  if (needsAdminCompletion && session?.firstAdmin) {
    return (
      <FinishAdminSetupPage
        accounts={session.firstAdmin.accounts}
        onSuccess={(firstAdmin) => loginWithToken(firstAdmin)}
        onSignOut={() => void logout()}
      />
    )
  }

  if (location.pathname === '/voice') {
    return (
      <>
        <DesktopNotifications />
        <Routes>
          <Route path="/voice" element={<VoiceWorkspacePage />} />
          <Route path="*" element={<Navigate to="/voice" replace />} />
        </Routes>
      </>
    )
  }

  return (
    <div
      ref={shellRef}
      data-testid="app-shell"
      className="h-full max-h-full overflow-hidden overscroll-none flex flex-col bg-page text-primary"
    >
      <AppHeader />
      <DesktopNotifications />

      {/* PWA status banners — in flow so they can never half-hide under the notch */}
      <UpdateBanner />
      <OfflineBanner />
      <MaintenanceBanner />
      <StorageBanner />
      <OnboardingBanner />

      <div className="grow min-h-0 flex flex-col overflow-hidden overscroll-none">
        <main
          data-testid="app-scroll-container"
          className="grow min-h-0 flex flex-col overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch] max-w-7xl w-full mx-auto p-4 md:pt-6 md:px-6"
        >
          <Routes>
            <Route path="/" element={<FeedPage />} />
            <Route path="/feed" element={<Navigate to="/" replace />} />
            <Route path="/chat" element={<ChatPage />} />
            <Route path="/chat/:agentId" element={<ChatPage />} />
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="/squads" element={<SquadsPage />} />
            <Route path="/squads/:squadId/manager" element={<SquadManagerChatPage />} />
            <Route path="/squads/:squadId/consultant" element={<SquadConsultantChatPage />} />
            <Route path="/squads/:squadId/:tab?" element={<SquadDetailPage />} />
            <Route path="/actions" element={<ActionsPage />} />
            <Route path="/actions/:actionId" element={<ActionsPage />} />
            <Route path="/inbox" element={<InboxPage />} />
            <Route path="/settings/integrations/oauth/callback" element={<OAuthCallbackPage />} />
            <Route path="/settings/integrations/oauth/callback/github" element={<OAuthCallbackPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/onboarding" element={<OnboardingPage />} />
            <Route path="/schedules" element={<SchedulesPage />} />
            <Route path="/recommendations" element={<Navigate to="/settings?section=ops-insights" replace />} />
            <Route path="/voice" element={<VoiceWorkspacePage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          <DesktopFooter />
        </main>
      </div>

      <MobileBottomNav />

      {/* Action Center panel */}
      {/* <ActionCenter /> */}

      {/* Inbox popup - triggered from header (desktop) */}
      <InboxPopup />

      {/* Floating chat button - desktop only, hidden on chat page */}
      <Routes>
        <Route path="/chat/*" element={null} />
        <Route path="*" element={<ChatDrawer />} />
      </Routes>
    </div>
  )
}
