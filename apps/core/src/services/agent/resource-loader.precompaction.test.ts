import { describe, it, expect } from 'bun:test'
import { FicusResourceLoader } from './resource-loader'

describe('FicusResourceLoader pre-compaction extension', () => {
  it('includes a session_before_compact handler in getExtensions()', async () => {
    const loader = await FicusResourceLoader.create('system prompt')
    const ext = loader.getExtensions()
    const hasHandler = ext.extensions.some((e) => e.handlers.get('session_before_compact')?.length)
    expect(hasHandler).toBe(true)
  })
})
