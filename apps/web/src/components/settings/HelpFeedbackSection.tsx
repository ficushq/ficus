import clsx from 'clsx'
import { SendFeedbackButton } from '../ProductFeedbackModal'
import { SETTINGS_BUTTON_SIZE, SETTINGS_HEADING, SettingsRow } from './SettingsRow'

/** Help & feedback: send product feedback to the Ficus team. */
export function HelpFeedbackSection() {
  return (
    <div className="max-w-3xl space-y-6">
      <header>
        <h3 className="text-lg font-semibold text-primary">Help & feedback</h3>
        <p className="mt-1 text-sm text-muted">Tell the Ficus team about a problem or an idea.</p>
      </header>

      <section className="ficus-section py-5">
        <h4 data-setting-target="send-feedback" tabIndex={-1} className={SETTINGS_HEADING}>
          Send feedback to Ficus
        </h4>
        <SettingsRow
          label="Report a problem or share an idea"
          description="Your report goes to the Ficus team and is linked to the Ficus account of this server’s owner."
          control={
            <SendFeedbackButton className={clsx('ficus-button ficus-button-primary', SETTINGS_BUTTON_SIZE)}>
              Send feedback
            </SendFeedbackButton>
          }
        />
      </section>
    </div>
  )
}
