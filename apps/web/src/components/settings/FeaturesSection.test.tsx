import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SettingMetadata } from '../../api/settings'
import { NumberSettingFields } from './FeaturesSection'

const LABEL = 'Max Concurrent Agents'

function capSetting(overrides: Partial<SettingMetadata> = {}): SettingMetadata {
  return {
    key: 'MAX_CONCURRENT_AGENTS',
    value: '20',
    type: 'number',
    default: '20',
    description:
      'Maximum agent executions this instance runs concurrently (1-500). Takes effect without a restart. ' +
      'A value stored here overrides the MAX_CONCURRENT_AGENTS environment variable; clear it to fall back to that variable.',
    isDefault: true,
    updatedAt: null,
    updatedBy: null,
    ...overrides,
  }
}

function render(
  setting: SettingMetadata,
  opts: { canWrite?: boolean; draft?: string; errorMessage?: string; isSaving?: boolean } = {}
): string {
  return renderToStaticMarkup(
    <NumberSettingFields
      setting={setting}
      label={LABEL}
      canWrite={opts.canWrite ?? true}
      draft={opts.draft ?? setting.value}
      onDraftChange={() => {}}
      onSave={() => {}}
      onReset={() => {}}
      isSaving={opts.isSaving ?? false}
      isResetting={false}
      errorMessage={opts.errorMessage}
    />
  )
}

describe('a setting whose default is a word', () => {
  const hostSlots = (overrides: Partial<SettingMetadata> = {}) =>
    capSetting({ key: 'HOST_SLOT_CAPACITY', value: 'auto', default: 'auto', ...overrides })

  // The machine host slot budget is derived per machine until a number is stored.
  test('shows the word as the placeholder of an empty number input, not as a value', () => {
    const html = renderToStaticMarkup(
      <NumberSettingFields
        setting={hostSlots()}
        label="Machine host slot budget"
        canWrite
        min={0}
        draft="auto"
        onDraftChange={() => {}}
        onSave={() => {}}
        onReset={() => {}}
        isSaving={false}
        isResetting={false}
      />
    )
    expect(html).toContain('placeholder="auto"')
    expect(html).toContain('value=""')
    expect(html).toContain('min="0"')
    expect(html).toContain('Default: auto')
    expect(html).not.toContain('Reset to default')
  })

  // "auto" alone does not say what an operator would be overriding.
  test('shows what the automatic value comes to right now', () => {
    const detail = 'Derived from machine size right now: host-1: 3 (15.6 GiB, 4 CPUs).'
    expect(render(hostSlots({ detail }))).toContain(detail)
    expect(render(hostSlots())).not.toContain('Derived from')
  })

  test('a stored number is shown and can be reset', () => {
    const html = render(hostSlots({ value: '2', isDefault: false }))
    expect(html).toContain('value="2"')
    expect(html).toContain('placeholder="auto"')
    expect(html).toContain('Reset to default')
  })
})

describe('concurrency cap settings control', () => {
  // Mutation caught: shipping the backend setting without surfacing an editable
  // control — the operator has no way to reach it, which is the whole request.
  test('renders a number input seeded with the current cap', () => {
    const html = render(capSetting({ value: '20' }))
    expect(html).toContain('type="number"')
    expect(html).toContain('value="20"')
    expect(html).toContain(`aria-label="${LABEL}"`)
    expect(html).toContain('Save')
  })

  // Mutation caught: hardcoding a description instead of showing the server's,
  // which is where the env-var precedence rule is documented for operators.
  test("shows the server's description, including env-var precedence", () => {
    const html = render(capSetting())
    expect(html).toContain('overrides the MAX_CONCURRENT_AGENTS environment variable')
    expect(html).toContain('Default: 20')
  })

  // Mutation caught: rendering an enabled control for read-only operators, who
  // would then get an unexplained 403 from the API.
  test('disables the control without settings:write and says why', () => {
    const html = render(capSetting(), { canWrite: false })
    expect(html).toContain('aria-disabled="true"')
    expect(html).not.toContain('aria-disabled="false"')
    expect(html).toContain('Requires the settings:write permission.')
  })

  test('enables the control with settings:write', () => {
    const html = render(capSetting(), { canWrite: true })
    expect(html).toContain('aria-disabled="false"')
    expect(html).not.toContain('aria-disabled="true"')
    expect(html).not.toContain('Requires the settings:write permission.')
  })

  // Mutation caught: locking the input while a save is in flight but leaving
  // the button live (double-submit), or vice versa.
  test('disables everything while a save is in flight', () => {
    const html = render(capSetting(), { isSaving: true })
    expect(html).toContain('aria-disabled="true"')
    expect(html).toContain('Saving…')
  })

  // Mutation caught: always showing "Reset to default" (a pointless DELETE) or
  // never showing it (stranding operators on a custom cap).
  test('offers a reset only when a custom value is stored', () => {
    const stored = render(
      capSetting({ value: '40', isDefault: false, updatedAt: '2026-01-01T00:00:00Z', updatedBy: 'admin' })
    )
    expect(stored).toContain('Reset to default')
    expect(stored).toContain('by admin')

    expect(render(capSetting({ isDefault: true }))).not.toContain('Reset to default')
  })

  // Mutation caught: swallowing the server's 400 — the operator would see the
  // save do nothing with no explanation of the accepted range.
  test("surfaces the server's rejection message", () => {
    const html = render(capSetting(), {
      draft: '0',
      errorMessage: "MAX_CONCURRENT_AGENTS must be a whole number between 1 and 500 (got '0')",
    })
    expect(html).toContain('role="alert"')
    expect(html).toContain('between 1 and 500')
  })
})
