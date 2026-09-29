import { instanceBasePath, webAppUrl } from '../../api/base'
import { appBrowserUrl, type FarmApp } from '../apps'
import { useFarmCard } from './context'

/** Opens an app in a new tab: a remote one at its URL, a local one through Core with its access token. */
function openApp(app: FarmApp) {
  window.open(appBrowserUrl(app.url, instanceBasePath(), window.location.origin), '_blank', 'noopener,noreferrer')
}

/** A squad's server rack: its apps (deployed somewhere, or running in its sandbox), each a click from a new tab. */
export function RackCard({ squadId }: { squadId: string }) {
  const env = useFarmCard()
  const yard = env.layout.yards.find((y) => y.squad.id === squadId)
  const apps = yard?.rack?.apps ?? []
  if (!yard) return <p className="g-card-text">This rack is gone.</p>
  return (
    <>
      <p className="g-eyebrow">{yard.squad.name} · server rack</p>
      <h2 className="g-card-title">
        {apps.length ? `${apps.length} app${apps.length === 1 ? '' : 's'} to open` : 'No apps running'}
      </h2>
      <p className="g-card-text">
        Apps this squad deployed, and the ones running in its sandbox (they open with a private access link).
      </p>
      {apps.length > 0 && (
        <ul className="g-rack-apps">
          {apps.map((app) => (
            <li key={app.id} className="g-rack-app">
              <span className="g-rack-app-text">
                <span className="g-rack-app-name">{app.name}</span>
                <span className="g-rack-app-meta">
                  {app.kind === 'local' ? 'Local' : 'Remote'} · {app.where} · {app.status}
                </span>
              </span>
              <button
                type="button"
                className="g-button g-button-primary g-rack-open"
                aria-label={`Open ${app.name} in a new tab`}
                onClick={() => openApp(app)}
              >
                Open
              </button>
            </li>
          ))}
        </ul>
      )}
      <a
        className="g-link"
        href={webAppUrl(`/squads/${encodeURIComponent(squadId)}/apps`)}
        target="_blank"
        rel="noopener noreferrer"
      >
        Manage apps in Ficus
      </a>
    </>
  )
}
