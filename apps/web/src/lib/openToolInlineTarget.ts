import type { LocalDeployment } from '@ficus/shared'
import { getPublicAppUrl } from '../api/publicUrl'
import { getLocalDeployment } from '../api/workspace'
import { getLocalDeploymentBrowserUrl } from './localDeploymentBrowserUrl'

type OpenWindow = (url?: string, target?: string, features?: string) => Window | null

/** Open an outside page (a pull request) in a new tab, without giving it a handle on this window. */
export function openExternalUrl(url: string, open: OpenWindow = window.open.bind(window)): void {
  open(url, '_blank', 'noopener,noreferrer')
}

export interface OpenLocalAppDependencies {
  open?: OpenWindow
  getLocalDeployment?: (localDeploymentId: string) => Promise<LocalDeployment>
  getPublicAppUrl?: () => Promise<{ url: string | null }>
}

/**
 * Open a local app in a new tab the way the Apps tab does: its browser URL under the server's public address.
 * The tab opens during the click, while the browser still allows it, and goes to the app once its address is
 * resolved; it closes again when the app can't be opened (gone or archived).
 */
export async function openLocalApp(
  localDeploymentId: string,
  dependencies: OpenLocalAppDependencies = {}
): Promise<void> {
  const open = dependencies.open ?? window.open.bind(window)
  const tab = open('', '_blank')
  if (tab) tab.opener = null
  try {
    const [localDeployment, publicAppUrl] = await Promise.all([
      (dependencies.getLocalDeployment ?? getLocalDeployment)(localDeploymentId),
      (dependencies.getPublicAppUrl ?? getPublicAppUrl)().then(
        (runtime) => runtime.url,
        () => null
      ),
    ])
    if (localDeployment.archivedAt) throw new Error('Local app is archived')
    const url = getLocalDeploymentBrowserUrl(localDeployment.urlPathOrHost, publicAppUrl)
    if (tab) tab.location.href = url
    else open(url, '_blank', 'noopener,noreferrer')
  } catch (error) {
    tab?.close()
    console.warn('Could not open local app', { localDeploymentId, error })
  }
}
