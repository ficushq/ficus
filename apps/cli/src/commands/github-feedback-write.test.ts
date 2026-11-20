import { describe, expect, test } from 'bun:test'
import { githubCommandMayWriteFeedback } from './github-feedback-write'

const gh = (...args: string[]) => githubCommandMayWriteFeedback(['/usr/local/bin/gh', ...args])

describe('githubCommandMayWriteFeedback', () => {
  test('commands that post reviews, review comments or comments are writes', () => {
    expect(gh('pr', 'review', '12', '--approve')).toBe(true)
    expect(gh('pr', 'review', '--comment', '-b', 'Looks good')).toBe(true)
    expect(gh('pr', 'comment', '12', '--body', 'Done')).toBe(true)
    expect(gh('issue', 'comment', '3', '-b', 'Done')).toBe(true)
    expect(gh('pr', 'close', '12', '--comment', 'Superseded')).toBe(true)
    expect(gh('pr', 'close', '12', '-c', 'Superseded')).toBe(true)
    expect(gh('issue', 'reopen', '3', '--comment=Back')).toBe(true)
  })

  test('gh api is a write unless it resolves to GET', () => {
    expect(gh('api', 'repos/acme/app/pulls/1/reviews', '-f', 'event=COMMENT', '-f', 'body=x')).toBe(true)
    expect(gh('api', '-X', 'POST', 'repos/acme/app/pulls/1/comments/5/replies', '-f', 'body=x')).toBe(true)
    expect(gh('api', '--method=PATCH', 'repos/acme/app/pulls/comments/5', '-f', 'body=x')).toBe(true)
    expect(gh('api', 'repos/acme/app/pulls/1/reviews', '--input', 'review.json')).toBe(true)
    expect(gh('api', 'repos/acme/app/pulls/1/reviews')).toBe(false)
    expect(gh('api', '--paginate', 'repos/acme/app/pulls/1/comments', '--jq', '.[].id')).toBe(false)
    // Fields with an explicit GET are query parameters.
    expect(gh('api', '-X', 'GET', 'search/issues', '-f', 'q=repo:acme/app')).toBe(false)
    // A flag value before the endpoint is not the endpoint.
    expect(gh('api', '-H', 'Accept: application/json', 'repos/acme/app/pulls/1')).toBe(false)
  })

  test('GraphQL writes only through a mutation, or a query Ficus cannot read', () => {
    expect(gh('api', 'graphql', '-f', 'query=query { viewer { login } }')).toBe(false)
    expect(gh('api', 'graphql', '-f', 'query=mutation { addPullRequestReview(input: {}) { clientMutationId } }')).toBe(
      true
    )
    expect(gh('api', 'graphql', '-F', 'query=@review.graphql')).toBe(true)
    expect(gh('api', 'graphql', '--input', 'body.json')).toBe(true)
  })

  test('read-only commands and the Git credential helper open no window', () => {
    expect(gh('auth', 'git-credential', 'get')).toBe(false)
    expect(gh('pr', 'view', '12', '--json', 'reviews')).toBe(false)
    expect(gh('pr', 'checks', '12', '--watch')).toBe(false)
    expect(gh('pr', 'create', '--title', 'x', '--body', 'y')).toBe(false)
    expect(gh('pr', 'merge', '12', '--auto', '--squash')).toBe(false)
    expect(gh('pr', 'close', '12')).toBe(false)
    expect(gh('run', 'watch', '42')).toBe(false)
    expect(gh('issue', 'view', '3')).toBe(false)
    expect(gh('--version')).toBe(false)
    expect(gh()).toBe(false)
  })

  test('anything unrecognised counts as a possible write', () => {
    expect(gh('my-extension', 'review')).toBe(true)
    expect(gh('pr', 'some-new-subcommand')).toBe(true)
    expect(gh('extension', 'exec', 'thing')).toBe(true)
    expect(githubCommandMayWriteFeedback(['bash', '-c', 'curl -X POST https://api.github.com/x'])).toBe(true)
    expect(githubCommandMayWriteFeedback([])).toBe(true)
  })
})
