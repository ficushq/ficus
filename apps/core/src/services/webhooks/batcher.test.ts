/**
 * Tests for Webhook Event Batcher
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { WebhookBatcher, resolveTemplate, resolveEnvTemplates, type BatchConfig } from './batcher'

describe('resolveTemplate', () => {
  it('resolves simple paths', () => {
    const ctx = { payload: { review: { id: '123' } } }
    expect(resolveTemplate('{{ payload.review.id }}', ctx)).toBe('123')
  })

  it('resolves nested paths', () => {
    const ctx = { payload: { pull_request: { number: 42 } } }
    expect(resolveTemplate('PR #{{ payload.pull_request.number }}', ctx)).toBe('PR #42')
  })

  it('returns empty string for missing paths', () => {
    const ctx = { payload: {} }
    expect(resolveTemplate('{{ payload.missing.path }}', ctx)).toBe('')
  })

  it('applies tojson filter', () => {
    const ctx = { batch: { collected: [{ a: 1 }, { b: 2 }] } }
    expect(resolveTemplate('{{ batch.collected | tojson }}', ctx)).toBe('[{"a":1},{"b":2}]')
  })

  it('applies length filter', () => {
    const ctx = { batch: { collected: [1, 2, 3] } }
    expect(resolveTemplate('{{ batch.collected | length }}', ctx)).toBe('3')
  })

  it('handles length filter on non-array', () => {
    const ctx = { batch: { collected: null } }
    expect(resolveTemplate('{{ batch.collected | length }}', ctx)).toBe('0')
  })

  it('handles multiple templates in one string', () => {
    const ctx = { a: 'hello', b: 'world' }
    expect(resolveTemplate('{{ a }} {{ b }}!', ctx)).toBe('hello world!')
  })
})

describe('resolveEnvTemplates', () => {
  it('resolves all env vars', () => {
    const env = {
      PR_NUMBER: '{{ batch.primary.pull_request.number }}',
      COUNT: '{{ batch.collected | length }}',
    }
    const ctx = {
      batch: {
        primary: { pull_request: { number: 42 } },
        collected: [1, 2, 3],
      },
    }
    const resolved = resolveEnvTemplates(env, ctx)
    expect(resolved.PR_NUMBER).toBe('42')
    expect(resolved.COUNT).toBe('3')
  })
})

describe('WebhookBatcher', () => {
  let batcher: WebhookBatcher
  let flushedBatches: Array<{ batch: any; config: BatchConfig }>

  const prReviewConfig: BatchConfig = {
    timeout: 100, // Short timeout for tests
    events: {
      pull_request_review: {
        role: 'primary',
        batch_key: '{{ payload.review.id }}',
      },
      pull_request_review_comment: {
        role: 'collect',
        batch_key: '{{ payload.comment.pull_request_review_id }}',
        orphan_timeout: 200,
      },
    },
    env: {
      REVIEW_ID: '{{ batch.key }}',
      HAS_PRIMARY: '{{ batch.primary | tojson }}',
      COMMENT_COUNT: '{{ batch.collected | length }}',
    },
    commands: [{ run: 'echo test' }],
  }

  // Collect-only config: no primary role, just batch events by key
  const issueAssignmentConfig: BatchConfig = {
    timeout: 100,
    events: {
      issues_assigned: {
        role: 'collect',
        batch_key: '{{ payload.repository.full_name }}',
      },
    },
    env: {
      REPO: '{{ batch.key }}',
      ASSIGNMENT_COUNT: '{{ batch.collected | length }}',
      ASSIGNMENTS_JSON: '{{ batch.collected | tojson }}',
    },
    commands: [{ run: 'echo assignments' }],
  }

  beforeEach(() => {
    batcher = new WebhookBatcher()
    flushedBatches = []
    batcher.setFlushHandler(async (batch, config) => {
      flushedBatches.push({ batch: { ...batch }, config })
    })
    batcher.loadConfig('example', {
      batches: {
        pr_review: prReviewConfig,
        issue_assignments: issueAssignmentConfig,
      },
    })
  })

  afterEach(() => {
    batcher.clear()
  })

  describe('findMatchingBatch', () => {
    it('finds matching batch config for event type', () => {
      const match = batcher.findMatchingBatch('example', 'pull_request_review')
      expect(match).not.toBeNull()
      expect(match!.name).toBe('pr_review')
      expect(match!.eventConfig.role).toBe('primary')
    })

    it('returns null for non-batched events', () => {
      const match = batcher.findMatchingBatch('example', 'push')
      expect(match).toBeNull()
    })

    it('returns null for unknown provider', () => {
      const match = batcher.findMatchingBatch('gitlab', 'pull_request_review')
      expect(match).toBeNull()
    })
  })

  describe('handleEvent', () => {
    it('returns true for batched events', () => {
      const result = batcher.handleEvent('example', 'pull_request_review', {
        review: { id: 'rev-123' },
      })
      expect(result).toBe(true)
    })

    it('returns false for non-batched events', () => {
      const result = batcher.handleEvent('example', 'push', { ref: 'main' })
      expect(result).toBe(false)
    })

    it('creates batch on primary event', () => {
      batcher.handleEvent('example', 'pull_request_review', {
        review: { id: 'rev-123', body: 'LGTM' },
      })
      expect(batcher.getPendingCount()).toBe(1)
      const batch = batcher.getPendingBatch('example:pr_review:rev-123')
      expect(batch).not.toBeNull()
      expect(batch!.primary).toEqual({ review: { id: 'rev-123', body: 'LGTM' } })
      expect(batch!.isOrphan).toBe(false)
    })

    it('creates orphan batch on collect event without primary', () => {
      batcher.handleEvent('example', 'pull_request_review_comment', {
        comment: { pull_request_review_id: 'rev-123', body: 'Fix this' },
      })
      expect(batcher.getPendingCount()).toBe(1)
      const batch = batcher.getPendingBatch('example:pr_review:rev-123')
      expect(batch).not.toBeNull()
      expect(batch!.primary).toBeNull()
      expect(batch!.isOrphan).toBe(true)
      expect(batch!.collected).toHaveLength(1)
    })

    it('adds to existing batch on collect event', () => {
      // Primary first
      batcher.handleEvent('example', 'pull_request_review', {
        review: { id: 'rev-123' },
      })
      // Then comments
      batcher.handleEvent('example', 'pull_request_review_comment', {
        comment: { pull_request_review_id: 'rev-123', body: 'Comment 1' },
      })
      batcher.handleEvent('example', 'pull_request_review_comment', {
        comment: { pull_request_review_id: 'rev-123', body: 'Comment 2' },
      })

      const batch = batcher.getPendingBatch('example:pr_review:rev-123')
      expect(batch!.collected).toHaveLength(2)
    })

    it('claims orphan batch when primary arrives', () => {
      // Comments first (orphan)
      batcher.handleEvent('example', 'pull_request_review_comment', {
        comment: { pull_request_review_id: 'rev-123', body: 'Comment 1' },
      })
      batcher.handleEvent('example', 'pull_request_review_comment', {
        comment: { pull_request_review_id: 'rev-123', body: 'Comment 2' },
      })

      let batch = batcher.getPendingBatch('example:pr_review:rev-123')
      expect(batch!.isOrphan).toBe(true)
      expect(batch!.primary).toBeNull()

      // Primary claims orphans
      batcher.handleEvent('example', 'pull_request_review', {
        review: { id: 'rev-123', body: 'Changes requested' },
      })

      batch = batcher.getPendingBatch('example:pr_review:rev-123')
      expect(batch!.isOrphan).toBe(false)
      expect(batch!.primary).toEqual({ review: { id: 'rev-123', body: 'Changes requested' } })
      expect(batch!.collected).toHaveLength(2)
    })
  })

  describe('flush behavior', () => {
    it('flushes after timeout', async () => {
      batcher.handleEvent('example', 'pull_request_review', {
        review: { id: 'rev-123', body: 'LGTM' },
      })

      expect(flushedBatches).toHaveLength(0)

      // Wait for timeout
      await new Promise((r) => setTimeout(r, 150))

      expect(flushedBatches).toHaveLength(1)
      expect(flushedBatches[0].batch.key).toBe('rev-123')
      expect(flushedBatches[0].batch.primary).toEqual({ review: { id: 'rev-123', body: 'LGTM' } })
    })

    it('resets timeout on new events', async () => {
      batcher.handleEvent('example', 'pull_request_review', {
        review: { id: 'rev-123' },
      })

      // Wait 50ms then add comment
      await new Promise((r) => setTimeout(r, 50))
      batcher.handleEvent('example', 'pull_request_review_comment', {
        comment: { pull_request_review_id: 'rev-123', body: 'Comment' },
      })

      // At 100ms from start, should not have flushed yet (timer was reset)
      await new Promise((r) => setTimeout(r, 60))
      expect(flushedBatches).toHaveLength(0)

      // At 160ms from start (110ms from last event), should have flushed
      await new Promise((r) => setTimeout(r, 60))
      expect(flushedBatches).toHaveLength(1)
      expect(flushedBatches[0].batch.collected).toHaveLength(1)
    })

    it('flushes orphan batch with orphan_timeout', async () => {
      batcher.handleEvent('example', 'pull_request_review_comment', {
        comment: { pull_request_review_id: 'rev-123', body: 'Orphan comment' },
      })

      // Normal timeout (100ms) should not flush orphan
      await new Promise((r) => setTimeout(r, 120))
      expect(flushedBatches).toHaveLength(0)

      // Orphan timeout (200ms) should flush
      await new Promise((r) => setTimeout(r, 100))
      expect(flushedBatches).toHaveLength(1)
      expect(flushedBatches[0].batch.primary).toBeNull()
      expect(flushedBatches[0].batch.collected).toHaveLength(1)
    })

    it('flushes with primary after orphan is claimed', async () => {
      // Orphan first
      batcher.handleEvent('example', 'pull_request_review_comment', {
        comment: { pull_request_review_id: 'rev-123', body: 'Comment' },
      })

      // Primary claims it before orphan timeout
      await new Promise((r) => setTimeout(r, 50))
      batcher.handleEvent('example', 'pull_request_review', {
        review: { id: 'rev-123', body: 'LGTM' },
      })

      // Should flush after normal timeout (100ms from primary)
      await new Promise((r) => setTimeout(r, 120))
      expect(flushedBatches).toHaveLength(1)
      expect(flushedBatches[0].batch.primary).not.toBeNull()
      expect(flushedBatches[0].batch.collected).toHaveLength(1)
    })

    it('removes batch after flush', async () => {
      batcher.handleEvent('example', 'pull_request_review', {
        review: { id: 'rev-123' },
      })
      expect(batcher.getPendingCount()).toBe(1)

      await new Promise((r) => setTimeout(r, 150))

      expect(batcher.getPendingCount()).toBe(0)
    })
  })

  describe('flushAll', () => {
    it('flushes all pending batches', async () => {
      batcher.handleEvent('example', 'pull_request_review', {
        review: { id: 'rev-1' },
      })
      batcher.handleEvent('example', 'pull_request_review', {
        review: { id: 'rev-2' },
      })

      expect(batcher.getPendingCount()).toBe(2)

      await batcher.flushAll()

      expect(batcher.getPendingCount()).toBe(0)
      expect(flushedBatches).toHaveLength(2)
    })
  })

  describe('multiple batches', () => {
    it('keeps batches separate by key', async () => {
      batcher.handleEvent('example', 'pull_request_review', {
        review: { id: 'rev-1' },
      })
      batcher.handleEvent('example', 'pull_request_review', {
        review: { id: 'rev-2' },
      })
      batcher.handleEvent('example', 'pull_request_review_comment', {
        comment: { pull_request_review_id: 'rev-1', body: 'For rev 1' },
      })
      batcher.handleEvent('example', 'pull_request_review_comment', {
        comment: { pull_request_review_id: 'rev-2', body: 'For rev 2' },
      })

      expect(batcher.getPendingCount()).toBe(2)

      const batch1 = batcher.getPendingBatch('example:pr_review:rev-1')
      const batch2 = batcher.getPendingBatch('example:pr_review:rev-2')

      expect(batch1!.collected).toHaveLength(1)
      expect(batch2!.collected).toHaveLength(1)
    })
  })

  describe('edge cases', () => {
    it('handles empty batch key gracefully', () => {
      const result = batcher.handleEvent('example', 'pull_request_review', {
        review: { id: '' }, // Empty ID
      })
      // Should return false and not create batch
      expect(result).toBe(false)
      expect(batcher.getPendingCount()).toBe(0)
    })

    it('handles missing batch key path gracefully', () => {
      const result = batcher.handleEvent('example', 'pull_request_review', {
        review: {}, // No id field
      })
      expect(result).toBe(false)
      expect(batcher.getPendingCount()).toBe(0)
    })
  })

  describe('collect-only batches (no primary role)', () => {
    it('creates batch on first collect event', () => {
      batcher.handleEvent('example', 'issues_assigned', {
        repository: { full_name: 'org/repo' },
        issue: { number: 1 },
      })

      expect(batcher.getPendingCount()).toBe(1)
      const batch = batcher.getPendingBatch('example:issue_assignments:org/repo')
      expect(batch).not.toBeNull()
      expect(batch!.primary).toBeNull()
      expect(batch!.isOrphan).toBe(false) // Not orphan - this is collect-only
      expect(batch!.collected).toHaveLength(1)
    })

    it('collects multiple events with same key', () => {
      batcher.handleEvent('example', 'issues_assigned', {
        repository: { full_name: 'org/repo' },
        issue: { number: 1 },
      })
      batcher.handleEvent('example', 'issues_assigned', {
        repository: { full_name: 'org/repo' },
        issue: { number: 2 },
      })
      batcher.handleEvent('example', 'issues_assigned', {
        repository: { full_name: 'org/repo' },
        issue: { number: 3 },
      })

      const batch = batcher.getPendingBatch('example:issue_assignments:org/repo')
      expect(batch!.collected).toHaveLength(3)
    })

    it('uses main timeout (not orphan timeout)', async () => {
      batcher.handleEvent('example', 'issues_assigned', {
        repository: { full_name: 'org/repo' },
        issue: { number: 1 },
      })

      // Should flush after main timeout (100ms), not orphan timeout
      await new Promise((r) => setTimeout(r, 150))

      expect(flushedBatches).toHaveLength(1)
      expect(flushedBatches[0].batch.collected).toHaveLength(1)
      expect(flushedBatches[0].batch.primary).toBeNull()
    })

    it('resets timeout on each new event', async () => {
      batcher.handleEvent('example', 'issues_assigned', {
        repository: { full_name: 'org/repo' },
        issue: { number: 1 },
      })

      await new Promise((r) => setTimeout(r, 50))
      batcher.handleEvent('example', 'issues_assigned', {
        repository: { full_name: 'org/repo' },
        issue: { number: 2 },
      })

      await new Promise((r) => setTimeout(r, 50))
      batcher.handleEvent('example', 'issues_assigned', {
        repository: { full_name: 'org/repo' },
        issue: { number: 3 },
      })

      // At 100ms from start, should not have flushed (timer keeps resetting)
      expect(flushedBatches).toHaveLength(0)

      // Wait for final timeout
      await new Promise((r) => setTimeout(r, 120))

      expect(flushedBatches).toHaveLength(1)
      expect(flushedBatches[0].batch.collected).toHaveLength(3)
    })

    it('keeps separate batches for different keys', () => {
      batcher.handleEvent('example', 'issues_assigned', {
        repository: { full_name: 'org/repo-a' },
        issue: { number: 1 },
      })
      batcher.handleEvent('example', 'issues_assigned', {
        repository: { full_name: 'org/repo-b' },
        issue: { number: 2 },
      })

      expect(batcher.getPendingCount()).toBe(2)

      const batchA = batcher.getPendingBatch('example:issue_assignments:org/repo-a')
      const batchB = batcher.getPendingBatch('example:issue_assignments:org/repo-b')

      expect(batchA!.collected).toHaveLength(1)
      expect(batchB!.collected).toHaveLength(1)
    })
  })
})
