import { describe, expect, it } from 'bun:test'
import { workStreamPullRequests } from './pullRequests'

describe('workStreamPullRequests', () => {
  it('links the code-host bound pull request', () => {
    const [pr] = workStreamPullRequests({
      codeHost: { integration: 'github', repository: 'acme/widgets', changeRequest: { number: 34 } },
    })
    expect(pr?.number).toBe(34)
    expect(pr?.url).toBe('https://github.com/acme/widgets/pull/34')
  })

  it('has none for a stream without a pull request', () => {
    expect(workStreamPullRequests({})).toEqual([])
    expect(workStreamPullRequests(null)).toEqual([])
  })
})
