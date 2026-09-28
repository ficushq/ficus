import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { buildPlatformUrlsPrompt } from './platform-urls-prompt'

describe('buildPlatformUrlsPrompt', () => {
  const originalAppUrl = process.env.APP_URL
  const originalAppBasePath = process.env.APP_BASE_PATH

  beforeEach(() => {
    delete process.env.APP_URL
    delete process.env.APP_BASE_PATH
  })

  afterEach(() => {
    if (originalAppUrl === undefined) {
      delete process.env.APP_URL
    } else {
      process.env.APP_URL = originalAppUrl
    }

    if (originalAppBasePath === undefined) {
      delete process.env.APP_BASE_PATH
    } else {
      process.env.APP_BASE_PATH = originalAppBasePath
    }
  })

  test('returns an empty string when APP_URL is not configured', () => {
    expect(buildPlatformUrlsPrompt()).toBe('')
  })

  test('hiretau.ai tenant URLs are same-origin — the retired api- prefix must NOT come back', () => {
    // The old `<name>.hiretau.ai` → `api-<name>.hiretau.ai` sniffing told
    // every hosted tenant's agents an API URL that does not resolve.
    process.env.APP_URL = 'https://demo.hiretau.ai'

    const prompt = buildPlatformUrlsPrompt()

    expect(prompt).toContain('- **Web UI:** https://demo.hiretau.ai')
    expect(prompt).toContain('- **API:** https://demo.hiretau.ai/api')
    expect(prompt).toContain('https://demo.hiretau.ai/api/webhooks/github')
    expect(prompt).not.toContain('api-noah')
  })

  test('FICUS_PUBLIC_API_URL overrides the same-origin default for split-domain deployments', () => {
    process.env.APP_URL = 'https://tau.example.com'
    process.env.FICUS_PUBLIC_API_URL = 'https://api.example.com'
    try {
      const prompt = buildPlatformUrlsPrompt()
      expect(prompt).toContain('- **API:** https://api.example.com')
      expect(prompt).toContain('https://api.example.com/api/webhooks/github')
    } finally {
      delete process.env.FICUS_PUBLIC_API_URL
    }
  })

  test('uses the normal host plus /api for non-hiretau app URLs', () => {
    process.env.APP_URL = 'https://tau.example.com'

    const prompt = buildPlatformUrlsPrompt()

    expect(prompt).toContain('- **Web UI:** https://tau.example.com')
    expect(prompt).toContain('- **API:** https://tau.example.com/api')
    expect(prompt).toContain('https://tau.example.com/api/webhooks/github')
    expect(prompt).not.toContain('api-tau.example.com')
  })

  test('includes the path from APP_URL in non-hiretau API URLs', () => {
    process.env.APP_URL = 'https://home.example.com/tau'

    const prompt = buildPlatformUrlsPrompt()

    expect(prompt).toContain('- **Web UI:** https://home.example.com/tau')
    expect(prompt).toContain('- **API:** https://home.example.com/tau/api')
    expect(prompt).toContain('https://home.example.com/tau/api/webhooks/github')
  })

  test('uses APP_BASE_PATH in non-hiretau API URLs when APP_URL has no path', () => {
    process.env.APP_URL = 'https://home.example.com'
    process.env.APP_BASE_PATH = '/tau'

    const prompt = buildPlatformUrlsPrompt()

    expect(prompt).toContain('- **Web UI:** https://home.example.com')
    expect(prompt).toContain('- **API:** https://home.example.com/tau/api')
    expect(prompt).toContain('https://home.example.com/tau/api/webhooks/github')
  })
})
