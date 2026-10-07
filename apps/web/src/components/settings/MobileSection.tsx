import { getApiUrl } from '../../api/client'
import { usePermissions } from '../../hooks/usePermissions'
import { ActivityIcon, BellIcon, WindowLayoutIcon } from '../icons'
import { Link } from 'react-router-dom'

const features = [
  {
    Icon: WindowLayoutIcon,
    title: 'Pick up the thread',
    description: 'Your Feed, squads and chats in one app. Add a thought or answer a question from your phone.',
  },
  {
    Icon: BellIcon,
    title: 'Catch what needs you',
    description: 'Pro brings push notifications, event filters and quiet hours, so you can choose what reaches you.',
  },
  {
    Icon: ActivityIcon,
    title: 'Follow at a glance',
    description:
      'Pro widgets and Live Activities keep work from your included servers close, even with the app closed.',
  },
]

export function MobileSection() {
  const permissions = usePermissions()
  const canManage = permissions.can('settings:read')
  return (
    <div className="max-w-3xl space-y-6">
      <header>
        <h3 className="text-lg font-semibold text-primary">Mobile</h3>
        <p className="mt-2 text-base font-medium text-primary">Ficus, to go.</p>
        <p className="mt-1 text-sm text-muted">
          Put an idea in motion, answer a question, or see what’s ready for a look. One app for your Ficus servers.
        </p>
        <a
          href="https://ficus.sh/mobile"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-flex text-sm text-accent-light hover:underline"
        >
          Explore Ficus mobile →
        </a>
      </header>
      <div className="grid gap-5 border-b border-th-border pb-6 sm:grid-cols-3">
        {features.map(({ Icon, title, description }) => (
          <div key={title} className="min-w-0">
            <span aria-hidden="true" className="mb-2 inline-flex text-accent-light">
              <Icon className="h-5 w-5" />
            </span>
            <h4 className="text-sm font-medium text-primary">{title}</h4>
            <p className="mt-1 text-sm leading-relaxed text-muted">{description}</p>
          </div>
        ))}
      </div>
      <section className="space-y-3 text-sm text-muted">
        <h4 className="font-medium text-primary">Bring your server along</h4>
        <p>
          Add your server in the Ficus mobile app and sign in to your instance account. Paid Ficus Cloud access includes
          mobile Pro features automatically.
        </p>
        <p>
          For self-hosted relay setup, ask your server administrator. Use your personal Ficus Pro account or an
          available slot from the server’s Instance Pro allowance.
        </p>
        <a
          href={getApiUrl('/docs/connect/mobile/')}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex text-accent-light hover:underline"
        >
          Mobile setup guide →
        </a>
        {canManage && (
          <Link to="/settings?section=mobile-pro" className="inline-flex text-accent-light hover:underline">
            Manage this server’s Mobile & Pro settings →
          </Link>
        )}
      </section>
    </div>
  )
}
