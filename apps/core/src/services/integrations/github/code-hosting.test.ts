import { expect, spyOn, test } from 'bun:test'
import { resolveBranchChangeRequest } from '@ficus/shared'
import * as githubApi from '../../github/api-client'
import { githubCodeHostingAdapter } from './code-hosting'

test('the head-branch list lookup maps the simple GitHub shape, including merged pull requests', async () => {
  const api = spyOn(githubApi, 'githubApiGet')
  try {
    // The list endpoint (GET /pulls?head=...) returns the simple shape: `merged_at` is present
    // for merged pull requests, and there is no `merged` boolean.
    api.mockImplementation(((path: string) =>
      Promise.resolve(
        path.includes('pulls?head=')
          ? ([
              {
                number: 42,
                state: 'closed',
                merged_at: '2026-09-24T10:00:00Z',
                html_url: 'https://github.com/example/repo/pull/42',
                head: { ref: 'feature', sha: 'a'.repeat(40), repo: { full_name: 'example/repo' } },
                base: { ref: 'main' },
              },
            ] as any)
          : null
      )) as any)
    const reference = { integration: 'github', repository: 'example/repo' }
    const candidates = await githubCodeHostingAdapter.changeRequestsByHead(reference, 'squad', 'feature')
    expect(api.mock.calls.map((call) => call[0])).toContain(
      `/repos/example/repo/pulls?head=${encodeURIComponent('example:feature')}&state=all`
    )
    expect(candidates).toEqual([
      {
        number: 42,
        merged: true,
        state: 'closed',
        headBranch: 'feature',
        baseBranch: 'main',
        url: 'https://github.com/example/repo/pull/42',
        headRepository: 'example/repo',
        headSha: 'a'.repeat(40),
      },
    ])
    // A merged candidate from the list shape resolves as the delivery change request.
    expect(
      resolveBranchChangeRequest({ branch: 'feature', baseBranch: 'main', repository: 'example/repo', candidates })
    ).toEqual({ status: 'chosen', candidate: { number: 42, url: 'https://github.com/example/repo/pull/42' } })
    // An unmerged, closed pull request from the same shape is never chosen.
    expect(
      resolveBranchChangeRequest({
        branch: 'feature',
        baseBranch: 'main',
        repository: 'example/repo',
        candidates: [{ ...candidates![0]!, merged: false }],
      })
    ).toEqual({ status: 'no-candidates' })
  } finally {
    api.mockRestore()
  }
})
