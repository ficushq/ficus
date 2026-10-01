import { describe, expect, it } from 'bun:test'
// @ts-expect-error Plain JavaScript machine asset, tested without Playwright installed.
import { assertSandboxStatus, verifySandbox } from '../../../../../scripts/machine/browser/verify-sandbox.js'
// @ts-expect-error Plain JavaScript machine asset.
import { CHROMIUM_LAUNCH_OPTIONS } from '../../../../../scripts/machine/browser/ficus-browser.js'

const positive = `Sandbox Status
Layer 1 Sandbox\tNamespace
PID namespaces\tYes
Network namespaces\tYes
Seccomp-BPF sandbox\tYes
Seccomp-BPF sandbox supports TSYNC\tYes
Ptrace Protection with Yama LSM (Non-broker)\tNo

You are adequately sandboxed.`

function fixture(options: { text?: string; gotoError?: boolean; readError?: boolean; launchError?: boolean } = {}) {
  const calls: { launch?: unknown; urls: string[]; closed: number } = { urls: [], closed: 0 }
  const chromium = {
    async launch(opts: unknown) {
      calls.launch = opts
      if (options.launchError) throw new Error('sandbox launch denied')
      return {
        async newPage() {
          return {
            async goto(url: string) {
              calls.urls.push(url)
              if (options.gotoError) throw new Error('navigation denied')
            },
            async innerText() {
              if (options.readError) throw new Error('body unavailable')
              return options.text ?? positive
            },
          }
        },
        async close() {
          calls.closed++
        },
      }
    },
  }
  return { chromium, calls }
}

describe('machine Chromium sandbox gate', () => {
  it('uses the same explicit sandbox-required full Chromium options as the service', async () => {
    const f = fixture()
    await verifySandbox(f.chromium)
    expect(f.calls.launch).toBe(CHROMIUM_LAUNCH_OPTIONS)
    expect(f.calls.launch).toEqual({ headless: true, channel: 'chromium', chromiumSandbox: true })
    expect(Object.isFrozen(CHROMIUM_LAUNCH_OPTIONS)).toBe(true)
    expect(f.calls.urls).toEqual(['chrome://sandbox'])
    expect(f.calls.closed).toBe(1)
  })

  it('requires every affirmative namespace and seccomp status, not merely a working renderer', () => {
    expect(() => assertSandboxStatus(positive)).not.toThrow()
    for (const absent of [
      'Layer 1 Sandbox\tNamespace',
      'PID namespaces\tYes',
      'Network namespaces\tYes',
      'Seccomp-BPF sandbox\tYes',
      'You are adequately sandboxed.',
    ]) {
      expect(() => assertSandboxStatus(positive.replace(absent, ''))).toThrow()
    }
    for (const text of [
      '',
      'about:blank',
      'You are adequately sandboxed.',
      positive.replace('Layer 1 Sandbox\tNamespace', 'Layer 1 Sandbox\tNone'),
      positive.replace('Seccomp-BPF sandbox\tYes', 'Seccomp-BPF sandbox\tNo'),
    ])
      expect(() => assertSandboxStatus(text)).toThrow()
  })

  for (const failure of ['gotoError', 'readError'] as const) {
    it(`fails closed and closes the browser on ${failure}`, async () => {
      const f = fixture({ [failure]: true })
      await expect(verifySandbox(f.chromium)).rejects.toThrow()
      expect(f.calls.closed).toBe(1)
    })
  }

  it('fails closed and closes the browser on blank diagnostics', async () => {
    const f = fixture({ text: '' })
    await expect(verifySandbox(f.chromium)).rejects.toThrow()
    expect(f.calls.closed).toBe(1)
  })

  it('propagates denied sandbox launch without retrying an unsafe launcher', async () => {
    const f = fixture({ launchError: true })
    await expect(verifySandbox(f.chromium)).rejects.toThrow('sandbox launch denied')
    expect(f.calls.launch).toEqual(CHROMIUM_LAUNCH_OPTIONS)
    expect(f.calls.closed).toBe(0)
  })
})
