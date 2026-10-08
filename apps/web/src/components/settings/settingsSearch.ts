import { SECRET_REGISTRY } from './secretsRegistry'

/** Search metadata contains labels and aliases only, never user data or secrets.
 * Add a stable data-setting-target to the destination when indexing a new field.
 * Entity-specific editors are indexed under their page; select the entity there.
 */
export interface SettingsSearchEntry {
  section: string
  id: string
  label: string
  keywords: string
}
export const SETTINGS_PAGE_KEYWORDS: Record<string, string> = {
  notifications: 'push notification sounds mute alerts subscriptions',
  appearance: 'theme harbor ember high contrast system dark light mode color scheme custom presets',
  app: 'installation pwa offline cache storage',
  account: 'profile display name email passkeys security sign out logout linked chat accounts discord slack telegram',
  sessions: 'active logins browsers sign out revoke',
  devices: 'pair cli mobile authorization linked devices',
  users: 'invite email display name role assignments squad scope',
  roles: 'permissions grants clone access role slug',
  'system-tokens': 'api token expiration permissions revoke',
  signup: 'registration allowed domains email allowlist',
  providers:
    'ai credentials oauth subscriptions api keys models fallback routing openrouter anthropic claude openai chatgpt gemini copilot ollama local server',
  'decision-providers':
    'decision models classifier yes no jev typesafe clef cloudflare openai decisions firewall prompt injection shell fetches gh curl wget spend cost price',
  git: 'commit author name email github defaults override',
  skills: 'markdown import instructions tools extensions',
  'agent-types':
    'model tiers provider chain reasoning effort system prompt skills tools allow deny extensions agent templates',
  'squad-presets': 'templates manager instructions default agents schedules purpose context',
  workflows: 'flows presets participants handoffs loops parallel branches review solo engineering completion policy',

  mobile: 'mobile app phone tablet device pair qr code download server address free pro widgets live activities push',
  'mobile-pro':
    'public server url address mobile app pro ficus account connect disconnect relay push self-hosted instance pro slots device allowance live activities',
  integrations:
    'bigbrain github linear notion discord slack telegram cloudflare digitalocean netlify railway supabase vercel apple apns p8 web push vapid google cloud openai realtime transcription embeddings speech text-to-speech service account deployment hosting tokens bot channels oauth connections pool assignment authorization',
  'notification-rules': 'outbound alerts delivery channels event rules',
  amtp: 'federation peers identity public key allow rules trust',
  machines: 'register hardware cpu memory capacity ssh sandbox workers exe.dev private key',
  'remote-hosts': 'remote ssh hosts register tunnel endpoint keys',
  system:
    'runtime status worker maintenance pause resume restart reload max concurrent active agents concurrency limit',
  storage: 'disk space usage pressure squad project repository worktree cache files',
  'system-logs': 'logs severity errors diagnostics search',
  'ops-insights': 'recommendations optimization analysis operations',
  updates: 'automatic updates branch remote interval manual rebuild latest run',
  memory: 'assistant realtime voice automatic embeddings memory semantic search openai api setup',
}

export const SETTINGS_SEARCH_ENTRIES: readonly SettingsSearchEntry[] = [
  {
    section: 'mobile-pro',
    id: 'mobile-public-url',
    label: 'Public server URL',
    keywords: 'https public url origin address hostname ip port base path mobile relay',
  },
  {
    section: 'mobile-pro',
    id: 'mobile-pro',
    label: 'Connect Ficus account',
    keywords: 'self-hosted mobile relay push connect disconnect account live activity integrations',
  },
  {
    section: 'mobile-pro',
    id: 'instance-pro',
    label: 'Instance Pro',
    keywords: 'pro slots device allowance coverage subscription manage devices',
  },
  {
    section: 'mobile',
    id: 'pair-mobile-device',
    label: 'Pair a mobile device',
    keywords: 'mobile app phone tablet ipad device qr code pairing server address download',
  },
  {
    section: 'mobile',
    id: 'mobile-free-and-pro',
    label: 'Free and Pro',
    keywords: 'mobile pro features push notifications widgets live activities quiet hours',
  },
  {
    section: 'memory',
    id: 'voice-dictation',
    label: 'Voice dictation',
    keywords: 'dictation transcription microphone whisper voice input',
  },
  {
    section: 'memory',
    id: 'realtime-assistant',
    label: 'Voice assistant',
    keywords: 'voice realtime live microphone OpenAI',
  },
  {
    section: 'memory',
    id: 'automatic-embeddings',
    label: 'Semantic memory search',
    keywords: 'embeddings automatic knowledge memory',
  },
  {
    section: 'memory',
    id: 'openai-services-setup',
    label: 'OpenAI API services setup',
    keywords: 'assistant memory api key credentials',
  },
  ...SECRET_REGISTRY.filter((entry) => !entry.hideIfManaged && !entry.hideWhenHosted).map((entry) => ({
    section: 'git',
    id: `secret-${entry.key.toLowerCase()}`,
    label: entry.name,
    keywords: `${entry.key} ${entry.category} ${entry.description}`,
  })),
  {
    section: 'system',
    id: 'max-concurrent-agents',
    label: 'Max Concurrent Agents',
    keywords: 'execution concurrency limit maximum simultaneous agents',
  },

  {
    section: 'appearance',
    id: 'appearance',
    label: 'Appearance',
    keywords: 'dark light theme color scheme',
  },
  {
    section: 'appearance',
    id: 'dark-mode',
    label: 'Dark Mode',
    keywords: 'appearance light theme',
  },
  {
    section: 'notifications',
    id: 'push-notifications',
    label: 'Push Notifications',
    keywords: 'alerts browser permission subscriptions devices',
  },
  {
    section: 'notifications',
    id: 'notification-sounds',
    label: 'Notification Sounds',
    keywords: 'audio mute ping',
  },
  {
    section: 'app',
    id: 'app-installation',
    label: 'App Installation',
    keywords: 'install pwa home screen standalone',
  },
  {
    section: 'app',
    id: 'offline-cache',
    label: 'Offline Cache',
    keywords: 'storage clear cached data',
  },
  {
    section: 'account',
    id: 'profile',
    label: 'Profile',
    keywords: 'email user display name',
  },
  {
    section: 'account',
    id: 'user-display-name',
    label: 'User display name',
    keywords: 'profile rename name',
  },
  {
    section: 'account',
    id: 'passkeys',
    label: 'Passkeys',
    keywords: 'password authentication security credential biometric touch id face id',
  },
  {
    section: 'system',
    id: 'maintenance-pause',
    label: 'Maintenance pause',
    keywords: 'pause resume worker execution',
  },
  {
    section: 'system',
    id: 'restart',
    label: 'Restart',
    keywords: 'reload core server',
  },
  {
    section: 'memory',
    id: 'memory-embeddings',
    label: 'Assistant & Memory',
    keywords: 'automatic embeddings semantic search vector',
  },
  {
    section: 'system',
    id: 'execution',
    label: 'Execution',
    keywords: 'max concurrent agents concurrency limit',
  },
  {
    section: 'providers',
    id: 'local-openai-compatible',
    label: 'Local / OpenAI-compatible',
    keywords: 'ollama lm studio vllm custom endpoint',
  },
  {
    section: 'providers',
    id: 'server-url',
    label: 'Server URL',
    keywords: 'custom server url endpoint base url',
  },
  {
    section: 'providers',
    id: 'provider-id',
    label: 'Provider ID',
    keywords: 'local provider identifier',
  },
  {
    section: 'providers',
    id: 'model-id',
    label: 'Model ID',
    keywords: 'local model name',
  },
  {
    section: 'providers',
    id: 'api-key-optional',
    label: 'API key (optional)',
    keywords: 'local provider token credentials',
  },
  {
    section: 'providers',
    id: 'add-a-provider',
    label: 'Add a provider',
    keywords: 'anthropic claude openai chatgpt google gemini copilot oauth api key',
  },
  {
    section: 'decision-providers',
    id: 'decision-models',
    label: 'Decision models',
    keywords:
      'classifier yes no choice jev clef cloudflare openai decisions github firewall workflow decision event rules',
  },
  {
    section: 'decision-providers',
    id: 'add-decision-model',
    label: 'Add a decision model',
    keywords: 'jev typesafe clef cloudflare workers ai openai decisions local systemone ollama vllm sglang',
  },
  {
    section: 'amtp',
    id: 'this-instance',
    label: 'This Instance',
    keywords: 'federation identity handle public key',
  },
  {
    section: 'amtp',
    id: 'peers',
    label: 'Peers',
    keywords: 'federation remote instances trust connections',
  },
  {
    section: 'signup',
    id: 'allowed-domains-one-per-line',
    label: 'Allowed domains (one per line)',
    keywords: 'signup email domain allowlist registration access',
  },
  {
    section: 'signup',
    id: 'signup-default-role',
    label: 'Default role for new accounts',
    keywords: 'signup registration default permissions access no role',
  },
  {
    section: 'notification-rules',
    id: 'channels',
    label: 'Channels',
    keywords: 'outbound delivery email slack discord push',
  },
  {
    section: 'notification-rules',
    id: 'rules',
    label: 'Rules',
    keywords: 'events filters trigger notification',
  },
  {
    section: 'updates',
    id: 'auto-update-local-k3d-install',
    label: 'Auto-update this instance',
    keywords: 'automatic upgrades enabled',
  },
  {
    section: 'updates',
    id: 'remote',
    label: 'Remote',
    keywords: 'git origin repository',
  },
  {
    section: 'updates',
    id: 'branch',
    label: 'Branch',
    keywords: 'git main release branch',
  },
  {
    section: 'updates',
    id: 'interval-minutes',
    label: 'Interval minutes',
    keywords: 'automatic update polling frequency',
  },
  {
    section: 'updates',
    id: 'manual-rebuild',
    label: 'Manual rebuild',
    keywords: 'build restart deploy core web cli',
  },
  {
    section: 'updates',
    id: 'latest-run',
    label: 'Latest run',
    keywords: 'update history build logs status',
  },
  {
    section: 'system-tokens',
    id: 'active-tokens',
    label: 'Active tokens',
    keywords: 'api token permissions revoke expires',
  },
  {
    section: 'devices',
    id: 'connect-the-ficus-cli',
    label: 'Connect the Ficus CLI',
    keywords: 'pair command line device authorization',
  },
  {
    section: 'devices',
    id: 'pair-the-ficus-mobile-app',
    label: 'Pair the Ficus mobile app',
    keywords: 'pairing phone device authorization',
  },
]

export function matchesSetting(query: string, ...text: string[]): boolean {
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
  const haystack = normalize(text.join(' '))
  return normalize(query)
    .split(/\s+/)
    .every((word) => haystack.includes(word))
}

/** Exact titles beat partial titles; supporting keywords only determine inclusion. */
export function settingMatchRank(query: string, label: string): number {
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
  const needle = normalize(query)
  const title = normalize(label)
  if (title === needle) return 0
  if (title.startsWith(needle)) return 1
  if (needle.split(/\s+/).every((word) => title.split(/\s+/).includes(word))) return 2
  if (needle.split(/\s+/).every((word) => title.includes(word))) return 3
  return 4
}
