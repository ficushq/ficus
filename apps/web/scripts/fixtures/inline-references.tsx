import { createRoot } from 'react-dom/client'
import { MarkdownContent } from '../../src/components/MarkdownContent'
import { ActivityPreview } from '../../src/components/squads/ActivityPreview'
import '../../src/index.css'

const label = 'Review the changes to the activity preview and conversation message'
const id = 'fa27abb6-4c92-4cc6-aff9-a8da616346c1'
const file = 'activity-preview-and-conversation-message-regression-report.pdf'
createRoot(document.getElementById('root')!).render(
  <main className="p-4">
    {['ficus:ws:241', `ficus:agent:${id}`].map((href) => (
      <section key={href}>
        <article>
          <MarkdownContent>{`queued [${label}](${href}). Next step.`}</MarkdownContent>
        </article>
        <article>
          <ActivityPreview spans={[{ text: 'queued ' }, { text: label, href }, { text: '. Next step.' }]} />
        </article>
      </section>
    ))}
    <article>
      <MarkdownContent agentId={id}>{`queued @/private/chat-attachments/${id}/${file}. Next step.`}</MarkdownContent>
    </article>
  </main>
)
