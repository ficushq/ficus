import { MobileProSection } from './settings/MobileProSection'
import { MobileSection } from './settings/MobileSection'
import { SETTINGS_SEARCH_ENTRIES } from './settings/settingsSearch'
import { LinkedChatAccounts } from './settings/LinkedChatAccounts'
import { LinkedGitHubAccount } from './settings/LinkedGitHubAccount'
import { SECTION_GROUPS, isSectionAllowed, isValidSection, type SectionId } from './settings/settingsSections'
import { SettingsSearchDestination } from './settings/SettingsSearchDestination'
import { useState, useEffect, useCallback, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { startRegistration } from '@simplewebauthn/browser'
import clsx from 'clsx'
import { useSearchParams } from 'react-router-dom'
import { useNotificationSound, createPingSound } from '../hooks/useNotificationSound'
import { useOfflineCache } from '../hooks/useOfflineCache'
import { usePushNotifications } from '../hooks/usePushNotifications'
import { usePWA } from '../hooks/usePWA'
import { useAuth } from '../providers/AuthProvider'
import { ThemeControl } from './settings/ThemeControl'
import { useTheme } from '../providers/ThemeProvider'
import { usePermissions } from '../hooks/usePermissions'
import { useOnboarding } from '../hooks/useOnboarding'
import { desktopInstance } from '../lib/desktop'
import { useRestartPolling } from './settings/useRestartPolling'
import { mergeDefined } from '../api/mergeDefined'
import {
  addCredentialOptions,
  addCredentialVerify,
  deleteMyCredential,
  renameMyCredential,
  updateCurrentUser,
  type AuthUser,
} from '../api/auth'
import { restartSystem } from '../api/secrets'
import { setAdminPause } from '../api/system'
import { integrationQueries, queries } from '../queryOptions'
import { queryKeys } from '../queryKeys'
import { maintenanceControlDisabled, maintenanceStatusText } from './maintenance-status'
import { CheckIcon, ShareIcon, WifiOffIcon } from './icons'
import { ConfirmButton } from './ConfirmButton'
import { SecretsSection } from './settings/SecretsSection'
import { ProviderAuthSection } from './settings/ProviderAuthSection'
import { AgentTypesSection } from './settings/AgentTypesSection'
import { SkillsSection } from './settings/SkillsSection'
import { WorkflowsSection } from './settings/WorkflowsSection'
import { SquadPresetsSection } from './settings/SquadPresetsSection'
import { IntegrationsSection } from './settings/IntegrationsSection'
import { NotificationsConfigSection } from './settings/NotificationsConfigSection'
import { NotificationPreferences } from './settings/NotificationPreferences'
import { AssistantMemorySection } from './settings/AssistantMemorySection'
import { AgentExecutionSection } from './settings/FeaturesSection'
import { SystemUpdateSection } from './settings/SystemUpdateSection'
import { UsersSection } from './settings/UsersSection'
import { RolesSection } from './settings/RolesSection'
import { SessionsSection } from './settings/SessionsSection'
import { DevicesSection } from './settings/DevicesSection'
import { SystemTokensSection } from './settings/SystemTokensSection'
import { SignupPolicySection } from './settings/SignupPolicySection'
import { AmtpSection } from './settings/AmtpSection'
import { StorageSection } from './settings/StorageSection'
import { SystemLogsSection } from './settings/SystemLogsSection'
import { RecommendationsPage } from './RecommendationsPage'
import { MachinesSection } from './settings/MachinesSection'
import { RemoteHostsSection } from './settings/RemoteHostsSection'
import { SettingsNavigation } from './settings/SettingsNavigation'
import { accountEmailLabel, isPlaceholderEmail } from '@ficus/shared'
import { AccountEmailForm } from './settings/AccountEmailForm'
import { ViewportDebugSection } from './settings/ViewportDebugSection'

interface SettingsPageDependencies {
  useAuth: typeof useAuth
  useTheme: typeof useTheme
  usePushNotifications: typeof usePushNotifications
  useNotificationSound: typeof useNotificationSound
  createPingSound: typeof createPingSound
  useOfflineCache: typeof useOfflineCache
  usePWA: typeof usePWA
}

interface SettingsPageProps {
  dependencies?: Partial<SettingsPageDependencies>
}

export function SettingsPage({ dependencies = {} }: SettingsPageProps) {
  const resolvedDependencies = mergeDefined<SettingsPageDependencies>(
    { useAuth, useTheme, usePushNotifications, useNotificationSound, createPingSound, useOfflineCache, usePWA },
    dependencies
  )
  const [searchParams, setSearchParams] = useSearchParams()
  const { can, identity, isLoading: permissionsLoading, isError: permissionsError } = usePermissions()
  // Same audience the /onboarding page and its nag banner serve — admins
  // (settings:read), never a plain teammate — so this link doesn't offer a
  // route non-admins can't act on. useOnboarding() already runs app-wide via
  // OnboardingBanner in App.tsx, so this is a cache read, not an extra query.
  const { isAdmin: showOnboardingLink } = useOnboarding()
  // On a platform-managed instance (FICUS_MANAGED=1) self-updates cannot work —
  // the checkout has no GitHub credentials and the hosting platform's upgrade
  // job owns the lifecycle — so the Updates tab disappears entirely. Only
  // queried when the viewer could see the tab at all; `managed` is absent from
  // older servers, and an unknown/loading answer keeps the tab (self-hosted is
  // the default posture, and a managed instance merely flashes it briefly).
  const updateSettings = useQuery({
    ...queries.updates.settings(),
    enabled: !permissionsLoading && can('updates:read'),
  })
  const catalog = useQuery(integrationQueries.catalog())
  const hideUpdates = updateSettings.data?.managed === true
  const mobilePageAllowed = identity?.type === 'user'
  const mobileSetupAllowed = mobilePageAllowed && can('settings:read')
  const integrationAllowed =
    catalog.isSuccess &&
    Array.isArray(catalog.data?.integrations) &&
    catalog.data.integrations.some((entry) => can(`integrations:read:${entry.key}`) || can('integrations:read'))
  const sectionVisible = useCallback(
    (section: SectionId) =>
      isSectionAllowed(
        section,
        can,
        permissionsLoading || (section === 'integrations' && catalog.isPending),
        integrationAllowed
      ) &&
      !(section === 'updates' && hideUpdates) &&
      !(section === 'mobile' && !mobilePageAllowed) &&
      !(section === 'mobile-pro' && !mobileSetupAllowed),
    [can, permissionsLoading, catalog.isPending, mobilePageAllowed, mobileSetupAllowed, integrationAllowed, hideUpdates]
  )
  const legacySection = searchParams.get('section')
  const target = searchParams.get('setting') ?? ''
  const rawSection =
    legacySection === 'secrets'
      ? target.includes('exe-provider')
        ? 'machines'
        : /apns|vapid/.test(target)
          ? 'integrations'
          : target.includes('ficus_password')
            ? 'account'
            : 'git'
      : legacySection
  const sectionParam =
    rawSection === 'features'
      ? searchParams.get('setting') === 'max-concurrent-agents'
        ? 'system'
        : 'memory'
      : rawSection === 'execution'
        ? 'system'
        : rawSection === 'channels'
          ? 'integrations'
          : rawSection
  const requestedSection: SectionId =
    sectionParam === 'general' ? 'app' : isValidSection(sectionParam) ? sectionParam : 'account'
  const checkingRequestedIntegrations =
    requestedSection === 'integrations' && (permissionsLoading || permissionsError || catalog.isPending)
  const activeSection: SectionId =
    checkingRequestedIntegrations || sectionVisible(requestedSection) ? requestedSection : 'account'
  const visibleGroups = SECTION_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((section) => sectionVisible(section.id)),
  })).filter((group) => group.items.length > 0)

  const setActiveSection = (section: SectionId, target?: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (target) next.set('setting', target)
      else next.delete('setting')
      if (section === 'account') {
        next.delete('section')
      } else {
        next.set('section', section)
      }
      return next
    })
  }

  return (
    <div className="h-full min-h-0 flex flex-col md:flex-row grow gap-4 md:gap-6">
      <SettingsNavigation
        groups={visibleGroups}
        searchEntries={SETTINGS_SEARCH_ENTRIES.filter((entry) => entry.section !== 'mobile-pro' || mobileSetupAllowed)}
        activeSection={activeSection}
        onSectionChange={setActiveSection}
        showOnboardingLink={showOnboardingLink}
      />

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <SettingsSearchDestination section={activeSection} target={searchParams.get('setting') ?? undefined}>
          {activeSection === 'memory' && <AssistantMemorySection />}
          {activeSection === 'skills' && <SkillsSection />}
          {activeSection === 'agent-types' && <AgentTypesSection />}
          {activeSection === 'squad-presets' && <SquadPresetsSection />}
          {activeSection === 'workflows' && <WorkflowsSection />}
          {activeSection === 'integrations' && <IntegrationsSection />}
          {activeSection === 'mobile' && <MobileSection />}
          {activeSection === 'mobile-pro' && <MobileProSection />}
          {activeSection === 'notification-rules' && <NotificationsConfigSection />}
          {activeSection === 'providers' && <ProviderAuthSection />}
          {activeSection === 'git' && <SecretsSection />}
          {activeSection === 'amtp' && <AmtpSection />}
          {activeSection === 'machines' && <MachinesSection />}
          {activeSection === 'remote-hosts' && <RemoteHostsSection />}
          {activeSection === 'notifications' && <NotificationsSection dependencies={resolvedDependencies} />}
          {activeSection === 'appearance' && <AppearanceSection dependencies={resolvedDependencies} />}
          {activeSection === 'app' && <AppSection dependencies={resolvedDependencies} />}
          {activeSection === 'account' && <AccountSection dependencies={resolvedDependencies} />}
          {activeSection === 'users' && <UsersSection />}
          {activeSection === 'roles' && <RolesSection />}
          {activeSection === 'sessions' && <SessionsSection />}
          {activeSection === 'devices' && <DevicesSection />}
          {activeSection === 'system-tokens' && <SystemTokensSection />}
          {activeSection === 'signup' && <SignupPolicySection />}
          {activeSection === 'system' && <SystemSection />}
          {activeSection === 'storage' && <StorageSection />}
          {activeSection === 'system-logs' && <SystemLogsSection />}
          {activeSection === 'ops-insights' && <RecommendationsPage />}
          {activeSection === 'updates' && <SystemUpdateSection />}
        </SettingsSearchDestination>
      </div>
    </div>
  )
}

// =============================================================================
// Notifications Section
// =============================================================================

function NotificationsSection({ dependencies }: { dependencies: SettingsPageDependencies }) {
  const {
    isSupported,
    isSubscribed,
    permission,
    subscriptions,
    currentSubscriptionId,
    subscribe,
    unsubscribe,
    removeSubscription,
    error,
  } = dependencies.usePushNotifications()
  const notificationSound = dependencies.useNotificationSound()

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-primary">Notifications</h3>
      </div>

      {/* Push Notifications */}
      <div className="ficus-section py-5">
        <h4 data-setting-target="push-notifications" className="text-md font-medium text-primary mb-4">
          Push Notifications
        </h4>

        {!isSupported ? (
          <p className="text-muted">Push notifications are not supported in this browser.</p>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <p className="font-medium text-primary">Enable notifications on this device</p>
                <p className="text-sm text-muted">
                  {permission === 'denied'
                    ? 'Permission denied. Please enable in browser settings.'
                    : isSubscribed
                      ? 'You will receive push notifications on this device.'
                      : 'Get notified when tasks need attention.'}
                </p>
              </div>
              <button
                onClick={isSubscribed ? unsubscribe : subscribe}
                disabled={permission === 'denied'}
                className={clsx(
                  'ficus-button px-4 py-2.5 md:py-2 rounded-md text-sm font-medium min-h-[44px] md:min-h-0 shrink-0',
                  isSubscribed ? 'ficus-button-secondary' : 'ficus-button-primary',
                  !isSubscribed && permission === 'denied' && 'cursor-not-allowed opacity-50'
                )}
              >
                {isSubscribed ? 'Disable' : 'Enable'}
              </button>
            </div>

            {error && <p className="text-sm text-status-danger-600 dark:text-status-danger-400">{error}</p>}

            {subscriptions.length > 0 && (
              <div className="mt-6">
                <h4 className="text-sm font-medium text-secondary mb-2">Registered Devices ({subscriptions.length})</h4>
                <ul className="divide-y divide-panel-border">
                  {subscriptions.map((sub) => (
                    <li
                      key={sub.id}
                      className="px-3 md:px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-primary truncate">
                          {sub.userAgent ? parseUserAgent(sub.userAgent) : 'Unknown device'}
                          {sub.id === currentSubscriptionId && (
                            <span className="ml-2 text-xs text-accent-light">(this device)</span>
                          )}
                        </p>
                        <p className="text-xs text-muted">Added {new Date(sub.createdAt).toLocaleDateString()}</p>
                      </div>
                      <button
                        onClick={() => removeSubscription(sub.id)}
                        className="ficus-button ficus-button-danger px-2.5 text-sm py-2 sm:py-1 font-medium"
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Per-user notification preferences (account-wide push + per-event mutes) */}
      <NotificationPreferences />

      {/* Notification Sounds */}
      <div className="ficus-section py-5">
        <h4 data-setting-target="notification-sounds" className="text-md font-medium text-primary mb-4">
          Notification Sounds
        </h4>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <p className="font-medium text-primary">Play sound when done</p>
            <p className="text-sm text-muted">Play a ping sound when an agent or chat finishes responding.</p>
          </div>
          <button
            onClick={() => {
              const wasEnabled = notificationSound.enabled
              notificationSound.toggle()
              if (!wasEnabled) {
                const audio = new AudioContext()
                dependencies.createPingSound(audio)
              }
            }}
            className={clsx(
              'ficus-button px-4 py-2.5 md:py-2 rounded-md text-sm font-medium min-h-[44px] md:min-h-0 shrink-0',
              notificationSound.enabled ? 'ficus-button-secondary' : 'ficus-button-primary'
            )}
          >
            {notificationSound.enabled ? 'Disable' : 'Enable'}
          </button>
        </div>
      </div>
    </div>
  )
}

// =============================================================================
// Appearance Section
// =============================================================================

function AppearanceSection({ dependencies }: { dependencies: SettingsPageDependencies }) {
  const theme = dependencies.useTheme()
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-primary">Appearance</h3>
      </div>
      <ThemeControl value={theme} />
    </div>
  )
}

// =============================================================================
// App Section
// =============================================================================

function AppSection({ dependencies }: { dependencies: SettingsPageDependencies }) {
  const pwa = dependencies.usePWA()
  const { cacheStats, clearCache } = dependencies.useOfflineCache()
  const [isClearing, setIsClearing] = useState(false)

  const handleClearCache = async () => {
    setIsClearing(true)
    await clearCache()
    setIsClearing(false)
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-primary">App</h3>
      </div>

      {/* PWA Installation */}
      <div className="ficus-section py-5">
        <h4 data-setting-target="app-installation" className="text-md font-medium text-primary mb-4">
          App Installation
        </h4>
        <div className="space-y-4">
          {pwa.isStandalone ? (
            <div className="flex items-center gap-3 text-status-success-700 dark:text-status-success-400">
              <CheckIcon />
              <span>Ficus is installed on your device</span>
            </div>
          ) : pwa.canInstall ? (
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <p className="font-medium text-primary">Install Ficus</p>
                <p className="text-sm text-muted">
                  Add Ficus to your home screen for quick access and offline support.
                </p>
              </div>
              <button
                onClick={pwa.promptInstall}
                className="ficus-button ficus-button-primary px-4 py-2.5 md:py-2 rounded-md text-sm font-medium min-h-[44px] md:min-h-0 shrink-0"
              >
                Install
              </button>
            </div>
          ) : pwa.platform === 'ios' && !pwa.isStandalone ? (
            <div>
              <p className="font-medium text-primary mb-2">Install on iOS</p>
              <p className="text-sm text-muted">
                Tap the share button <ShareIcon className="w-4 h-4 inline-block align-text-bottom" /> then "Add to Home
                Screen" to install Ficus.
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted">
              {pwa.isSupported
                ? 'Open this page in Safari (iOS) or Chrome (Android/Desktop) to install.'
                : 'App installation is not supported in this browser.'}
            </p>
          )}

          {pwa.updateAvailable && (
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 bg-accent/10 rounded-md">
              <div>
                <p className="font-medium text-primary">Update Available</p>
                <p className="text-sm text-secondary">A new version of Ficus is ready to install.</p>
              </div>
              <button
                onClick={pwa.applyUpdate}
                className="ficus-button ficus-button-primary px-4 py-2.5 md:py-2 rounded-md text-sm font-medium min-h-[44px] md:min-h-0 shrink-0"
              >
                Update Now
              </button>
            </div>
          )}

          {!pwa.isOnline && (
            <div className="flex items-center gap-3 p-3 bg-status-review-50 dark:bg-status-review-900/20 rounded-md text-status-review-800 dark:text-status-review-200">
              <WifiOffIcon />
              <span>You are currently offline. Some features may be limited.</span>
            </div>
          )}
        </div>
      </div>

      {/* Offline Cache */}
      <div className="ficus-section py-5">
        <h4 data-setting-target="offline-cache" className="text-md font-medium text-primary mb-4">
          Offline Cache
        </h4>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted">Cached API responses</span>
            <span className="text-sm font-medium text-primary">{cacheStats?.entryCount ?? 0} items</span>
          </div>
          {cacheStats?.totalSize != null && cacheStats.totalSize > 0 && (
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted">Cache size</span>
              <span className="text-sm font-medium text-primary">{formatBytes(cacheStats.totalSize)}</span>
            </div>
          )}
          {cacheStats?.newestTimestamp && (
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted">Last updated</span>
              <span className="text-sm font-medium text-primary">{formatRelativeTime(cacheStats.newestTimestamp)}</span>
            </div>
          )}
          <div className="pt-2">
            <button
              onClick={handleClearCache}
              disabled={isClearing || (cacheStats?.entryCount ?? 0) === 0}
              className="ficus-button ficus-button-danger px-4 py-2.5 md:py-2 rounded-md text-sm font-medium min-h-[44px] md:min-h-0 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isClearing ? 'Clearing...' : 'Clear Offline Cache'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// =============================================================================
// Account Section
// =============================================================================

function AccountSection({ dependencies }: { dependencies: SettingsPageDependencies }) {
  const { authRequired, logout, authStatus } = dependencies.useAuth()
  const queryClient = useQueryClient()
  const isPasskeyMode = authStatus?.mode === 'passkey'
  const instance = desktopInstance()
  const remoteInstance = instance?.kind === 'remote' && instance.disconnect ? instance : undefined

  const { data: user } = useQuery({
    ...queries.auth.me(),
    enabled: !!(authRequired && isPasskeyMode),
  }) as { data: AuthUser | undefined }
  const { data: credentials } = useQuery({
    ...queries.auth.myCredentials(),
    enabled: !!(authRequired && isPasskeyMode),
  })

  const [displayName, setDisplayName] = useState(user?.displayName ?? '')
  const [profileError, setProfileError] = useState<string | null>(null)
  const [profileSaved, setProfileSaved] = useState(false)
  const [passkeyName, setPasskeyName] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const [isAdding, setIsAdding] = useState(false)
  // Inline rename, same shape as the peer editor in AmtpSection: one row at a
  // time, held by id, with a draft that never touches the query cache.
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [renameError, setRenameError] = useState<string | null>(null)
  const [disconnectError, setDisconnectError] = useState<string | null>(null)
  const [isDisconnecting, setIsDisconnecting] = useState(false)

  const handleDisconnect = async () => {
    if (!remoteInstance) return
    setDisconnectError(null)
    setIsDisconnecting(true)
    try {
      await remoteInstance.disconnect!()
    } catch (error) {
      setDisconnectError(error instanceof Error ? error.message : 'Failed to disconnect')
    } finally {
      setIsDisconnecting(false)
    }
  }

  useEffect(() => {
    setDisplayName(user?.displayName ?? '')
  }, [user?.displayName])

  const profileMutation = useMutation({
    mutationFn: updateCurrentUser,
    onSuccess: (updatedUser) => {
      setProfileSaved(true)
      setProfileError(null)
      queryClient.setQueryData(queryKeys.auth.me(), updatedUser)
      queryClient.invalidateQueries({ queryKey: queryKeys.auth.me() })
    },
    onError: (err: Error) => {
      setProfileSaved(false)
      setProfileError(err.message || 'Failed to update display name')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: deleteMyCredential,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.auth.myCredentials() })
    },
  })

  const renameMutation = useMutation({
    mutationFn: ({ id, displayName: name }: { id: string; displayName: string }) => renameMyCredential(id, name),
    onSuccess: () => {
      setRenamingId(null)
      setRenameError(null)
      queryClient.invalidateQueries({ queryKey: queryKeys.auth.myCredentials() })
    },
    onError: (err: Error) => setRenameError(err.message || 'Failed to rename passkey'),
  })

  const startRename = (id: string, current: string | null) => {
    setRenamingId(id)
    setRenameDraft(current ?? '')
    setRenameError(null)
  }

  const submitRename = (e: FormEvent, id: string) => {
    e.preventDefault()
    const name = renameDraft.trim()
    if (!name) {
      setRenameError('Passkey name required')
      return
    }
    renameMutation.mutate({ id, displayName: name })
  }

  const handleSaveProfile = async (e: FormEvent) => {
    e.preventDefault()
    setProfileSaved(false)
    setProfileError(null)
    profileMutation.mutate({ displayName })
  }

  const handleAddPasskey = async () => {
    setAddError(null)
    setIsAdding(true)
    try {
      const { options } = await addCredentialOptions()
      const response = await startRegistration({ optionsJSON: options })
      await addCredentialVerify(response, passkeyName || undefined)
      setPasskeyName('')
      queryClient.invalidateQueries({ queryKey: queryKeys.auth.myCredentials() })
    } catch (err: any) {
      if (err.name === 'NotAllowedError') {
        setAddError('Registration was cancelled.')
      } else {
        setAddError(err.message || 'Failed to add passkey')
      }
    } finally {
      setIsAdding(false)
    }
  }

  if (!authRequired) {
    return (
      <div className="space-y-6">
        <div>
          <h3 className="text-lg font-semibold text-primary">Account</h3>
        </div>
        <div className="ficus-section py-5">
          <p className="text-sm text-muted">
            Authentication is not enabled. Configure authentication in your deployment, then sign in to manage your
            account here.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-primary">Account</h3>
      </div>

      {/* User Info */}
      {isPasskeyMode && user && (
        <div className="ficus-section py-5">
          <h4 data-setting-target="profile" className="text-md font-medium text-primary mb-4">
            Profile
          </h4>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted">Email</span>
              <span className="text-sm font-medium text-primary">{accountEmailLabel(user.email)}</span>
            </div>
            <AccountEmailForm
              hasEmail={!isPlaceholderEmail(user.email)}
              onSaved={(updatedUser) => {
                queryClient.setQueryData(queryKeys.auth.me(), updatedUser)
                queryClient.invalidateQueries({ queryKey: queryKeys.auth.me() })
              }}
            />
            <form onSubmit={handleSaveProfile} className="space-y-2">
              <label
                data-setting-target="user-display-name"
                htmlFor="account-display-name"
                className="block text-sm text-muted"
              >
                User display name
              </label>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  id="account-display-name"
                  type="text"
                  value={displayName}
                  onChange={(e) => {
                    setDisplayName(e.target.value)
                    setProfileSaved(false)
                  }}
                  placeholder="User display name (optional)"
                  autoComplete="name"
                  className="ficus-field flex-1 px-3 py-2 text-sm rounded-md border border-input-border bg-input-bg text-primary placeholder:text-placeholder  focus:ring-2 focus:ring-accent/50 min-h-[44px] md:min-h-0"
                />
                <button
                  type="submit"
                  disabled={profileMutation.isPending}
                  className="ficus-button ficus-button-primary px-4 py-2.5 md:py-2 rounded-md text-sm font-medium min-h-[44px] md:min-h-0 shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {profileMutation.isPending ? 'Saving...' : 'Save display name'}
                </button>
              </div>
              {profileSaved && (
                <p className="text-xs text-status-success-600 dark:text-status-success-400">Display name saved.</p>
              )}
              {profileError && (
                <p className="text-xs text-status-danger-600 dark:text-status-danger-400">{profileError}</p>
              )}
            </form>
            {user.createdAt && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted">Member Since</span>
                <span className="text-sm font-medium text-primary">
                  {new Date(user.createdAt).toLocaleDateString()}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {user && <LinkedChatAccounts />}
      {user && <LinkedGitHubAccount />}

      {/* Passkeys */}
      {isPasskeyMode && (
        <div className="ficus-section py-5">
          <h4 data-setting-target="passkeys" className="text-md font-medium text-primary mb-4">
            Passkeys
          </h4>

          {credentials && credentials.length > 0 ? (
            <ul className="divide-y divide-panel-border mb-4">
              {credentials.map((cred) => {
                const credLabel = cred.displayName || 'Unnamed passkey'
                return (
                  <li key={cred.id} className="px-3 md:px-4 py-3">
                    {renamingId === cred.id ? (
                      <form onSubmit={(e) => submitRename(e, cred.id)} className="space-y-2">
                        <label htmlFor={`rename-passkey-${cred.id}`} className="sr-only">
                          Passkey name
                        </label>
                        <input
                          id={`rename-passkey-${cred.id}`}
                          type="text"
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          placeholder="Passkey name"
                          autoFocus
                          className="ficus-field w-full px-3 py-2 text-sm rounded-md border border-input-border bg-input-bg text-primary placeholder:text-placeholder  focus:ring-2 focus:ring-accent/50 min-h-[44px] md:min-h-0"
                        />
                        <div className="flex gap-2">
                          <button
                            type="submit"
                            disabled={renameMutation.isPending}
                            className="ficus-button ficus-button-primary px-3 py-1.5 rounded-md text-xs font-medium disabled:opacity-50"
                          >
                            {renameMutation.isPending ? 'Saving…' : 'Save'}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setRenamingId(null)
                              setRenameError(null)
                            }}
                            className="ficus-button ficus-button-secondary px-3 py-1.5 text-xs"
                          >
                            Cancel
                          </button>
                        </div>
                        {renameError && (
                          <p role="alert" className="text-xs text-status-danger-600 dark:text-status-danger-400">
                            {renameError}
                          </p>
                        )}
                      </form>
                    ) : (
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-primary truncate">{credLabel}</p>
                          <p className="text-xs text-muted">Added {new Date(cred.createdAt).toLocaleDateString()}</p>
                        </div>
                        <button
                          onClick={() => startRename(cred.id, cred.displayName)}
                          aria-label={`Rename passkey ${credLabel}`}
                          className="ficus-button ficus-button-link text-sm font-medium py-2 sm:py-0"
                          title="Rename passkey"
                        >
                          Rename
                        </button>
                        {/* Two-step: the first click arms, the second removes, and
                            the armed state lapses on its own after 5s. Removing a
                            passkey is irreversible, so a stray tap must not do it. */}
                        <ConfirmButton
                          onConfirm={() => deleteMutation.mutate(cred.id)}
                          label="Remove"
                          confirmLabel="Confirm?"
                          timeoutMs={5000}
                          disabled={deleteMutation.isPending || credentials.length <= 1}
                          ariaLabel={`Remove passkey ${credLabel}`}
                          className={clsx(
                            'px-2.5 py-2 text-sm sm:py-1',
                            credentials.length <= 1 && 'cursor-not-allowed'
                          )}
                          title={credentials.length <= 1 ? 'Cannot remove your only passkey' : 'Remove passkey'}
                        />
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="text-sm text-muted mb-4">No passkeys registered.</p>
          )}

          {/* Add passkey */}
          <div className="space-y-3">
            <div className="flex flex-col sm:flex-row gap-2">
              <label htmlFor="new-passkey-name" className="sr-only">
                Passkey name (optional)
              </label>
              <input
                id="new-passkey-name"
                type="text"
                value={passkeyName}
                onChange={(e) => setPasskeyName(e.target.value)}
                placeholder="Passkey name (optional)"
                className="ficus-field flex-1 px-3 py-2 text-sm rounded-md border border-input-border bg-input-bg text-primary placeholder:text-placeholder  focus:ring-2 focus:ring-accent/50 min-h-[44px] md:min-h-0"
              />
              <button
                onClick={handleAddPasskey}
                disabled={isAdding}
                className="ficus-button ficus-button-primary px-4 py-2.5 md:py-2 rounded-md text-sm font-medium min-h-[44px] md:min-h-0 shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isAdding ? 'Adding…' : 'Add Passkey'}
              </button>
            </div>
            {addError && (
              <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
                {addError}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Logout, or Disconnect when this window is a paired remote instance */}
      <div className="ficus-section py-5 space-y-2">
        <div className="flex items-center justify-between">
          {remoteInstance ? (
            <>
              <p className="text-sm text-muted">Disconnect this Mac from {remoteInstance.name}</p>
              <button
                onClick={() => void handleDisconnect()}
                disabled={isDisconnecting}
                className="ficus-button ficus-button-danger px-4 py-2.5 md:py-2 rounded-md text-sm font-medium min-h-[44px] md:min-h-0 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isDisconnecting ? 'Disconnecting…' : 'Disconnect'}
              </button>
            </>
          ) : (
            <>
              <p className="text-sm text-muted">Sign out of this device</p>
              <button
                onClick={logout}
                className="ficus-button ficus-button-danger px-4 py-2.5 md:py-2 rounded-md text-sm font-medium min-h-[44px] md:min-h-0"
              >
                Logout
              </button>
            </>
          )}
        </div>
        {disconnectError && (
          <p role="alert" className="text-sm text-status-danger-600 dark:text-status-danger-400">
            {disconnectError}
          </p>
        )}
      </div>
    </div>
  )
}

// =============================================================================
// System Section
// =============================================================================

type RestartState = 'idle' | 'restarting' | 'waiting-down' | 'waiting-up'

function SystemSection() {
  const { can, isLoading: permissionsLoading } = usePermissions()
  const canReadRuntime = !permissionsLoading && can('system:pause')
  const queryClient = useQueryClient()
  const {
    data: maintenance,
    isPending: maintenanceLoading,
    isError: maintenanceFailed,
  } = useQuery({
    ...queries.system.pauseDetails(),
    enabled: canReadRuntime,
    refetchInterval: 15_000,
  })
  const [pauseError, setPauseError] = useState<string | null>(null)
  const pauseMutation = useMutation({
    mutationFn: (active: boolean) => setAdminPause(active, active ? 'Administrator maintenance' : undefined),
    onSuccess: (snapshot) => {
      setPauseError(null)
      queryClient.setQueryData(queryKeys.system.pause(), snapshot)
    },
    onError: (error) => setPauseError(error instanceof Error ? error.message : String(error)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.system.pause() }),
  })
  const [restartState, setRestartState] = useState<RestartState>('idle')
  useRestartPolling(restartState, setRestartState)

  const restartMutation = useMutation({
    mutationFn: restartSystem,
    onSuccess: () => setRestartState('waiting-down'),
    onError: () => setRestartState('waiting-down'),
  })
  const canRestartSystem = !permissionsLoading && can('system:restart')
  const canPauseSystem = !permissionsLoading && can('system:pause')

  const isRestarting = restartState !== 'idle'

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-primary">System</h3>
      </div>

      {can('settings:read') && <AgentExecutionSection />}
      {canReadRuntime && (
        <div className="ficus-section py-5">
          <h4 data-setting-target="maintenance-pause" className="text-md font-medium text-primary mb-4">
            Maintenance pause
          </h4>
          <div className="space-y-3 text-sm text-muted">
            <p>{maintenanceStatusText(maintenance, maintenanceLoading, maintenanceFailed)}</p>
            <p>Administrator hold: {maintenance ? (maintenance.adminHold.active ? 'On' : 'Off') : 'Unknown'}</p>
            {maintenance?.platformLease.active && (
              <p>
                Platform lease: {maintenance.platformLease.holder ?? 'Active'}
                {maintenance.platformLease.expiresAt
                  ? ` (expires ${new Date(maintenance.platformLease.expiresAt).toLocaleString()})`
                  : ''}
              </p>
            )}
            {pauseError && <p className="text-status-danger-600 dark:text-status-danger-400">{pauseError}</p>}
            {canPauseSystem && (
              <button
                role="switch"
                aria-checked={maintenance?.adminHold.active ?? false}
                disabled={maintenanceControlDisabled(Boolean(maintenance), pauseMutation.isPending)}
                onClick={() => {
                  if (!maintenance) return
                  const active = !maintenance.adminHold.active
                  if (!active || window.confirm('Pause all agent execution and safely requeue active turns?')) {
                    pauseMutation.mutate(active)
                  }
                }}
                className="ficus-button ficus-button-secondary px-4 py-2 rounded-md bg-status-attention-100 text-status-attention-900 hover:bg-status-attention-200 dark:bg-status-attention-900/30 dark:text-status-attention-200 dark:hover:bg-status-attention-900/50 disabled:opacity-50"
              >
                {pauseMutation.isPending
                  ? 'Updating…'
                  : !maintenance
                    ? 'Maintenance state unavailable'
                    : maintenance.adminHold.active
                      ? 'Resume administrator hold'
                      : 'Pause for maintenance'}
              </button>
            )}
          </div>
        </div>
      )}

      <div className="ficus-section py-5">
        <h4 data-setting-target="restart" className="text-md font-medium text-primary mb-4">
          Restart
        </h4>
        <div className="space-y-4">
          <p className="text-sm text-muted">
            Restart the API and worker processes. Active agent executions will be interrupted.
          </p>

          {isRestarting && (
            <div className="flex items-center gap-3 p-3 bg-status-progress-50 dark:bg-status-progress-900/20 border border-status-progress-200 dark:border-status-progress-800 rounded-md">
              <div className="animate-spin h-4 w-4 border-2 border-status-progress-500 border-t-transparent rounded-full shrink-0" />
              <p className="text-sm text-status-progress-800 dark:text-status-progress-200">
                {restartState === 'restarting' && 'Sending restart signal…'}
                {restartState === 'waiting-down' && 'Waiting for server to shut down…'}
                {restartState === 'waiting-up' && 'Waiting for server to come back online…'}
              </p>
            </div>
          )}

          {canRestartSystem && (
            <button
              onClick={() => {
                setRestartState('restarting')
                restartMutation.mutate()
              }}
              disabled={isRestarting}
              className="ficus-button ficus-button-danger px-4 py-2.5 md:py-2 rounded-md text-sm font-medium min-h-[44px] md:min-h-0 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isRestarting ? 'Restarting…' : 'Restart System'}
            </button>
          )}
        </div>
      </div>

      <ViewportDebugSection />
    </div>
  )
}

// =============================================================================
// Helpers
// =============================================================================

function parseUserAgent(ua: string): string {
  if (ua.includes('Chrome')) return 'Chrome'
  if (ua.includes('Firefox')) return 'Firefox'
  if (ua.includes('Safari')) return 'Safari'
  if (ua.includes('Edge')) return 'Edge'
  return 'Browser'
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatRelativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}
