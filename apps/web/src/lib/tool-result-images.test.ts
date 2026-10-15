import { describe, expect, test } from 'bun:test'
import {
  blocksImages,
  extractResultImages,
  imageSrcsFromContent,
  toolCallImages,
  toolImageAlt,
  withoutImagePlaceholder,
} from './tool-result-images'
import { extractResultText } from './tool-renderers'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const image = (data = PNG, mimeType = 'image/png') => ({ type: 'image', mimeType, data })
const text = (value: string) => ({ type: 'text', text: value })
const result = (...content: unknown[]) => JSON.stringify({ content })

describe('extractResultImages', () => {
  test('a result without image parts has none', () => {
    expect(extractResultImages(result(text('hello')))).toEqual([])
    expect(extractResultImages('')).toEqual([])
    expect(extractResultImages(undefined)).toEqual([])
    expect(extractResultImages('plain text output')).toEqual([])
  })

  test('one image part becomes one data URL thumbnail', () => {
    expect(extractResultImages(result(text('Read image file [image/png]'), image()), { alt: '/tmp/a.png' })).toEqual([
      { id: '0', src: `data:image/png;base64,${PNG}`, alt: '/tmp/a.png' },
    ])
  })

  test('several image parts keep their order and get numbered alt text', () => {
    const images = extractResultImages(
      result(image(PNG, 'image/png'), text('between'), image('R0lGOD==', 'image/gif')),
      {
        alt: 'shot',
        idPrefix: 'tc-1:',
      }
    )
    expect(images.map(({ id, alt }) => ({ id, alt }))).toEqual([
      { id: 'tc-1:0', alt: 'shot (image 1 of 2)' },
      { id: 'tc-1:1', alt: 'shot (image 2 of 2)' },
    ])
    expect(images[1]!.src).toBe('data:image/gif;base64,R0lGOD==')
  })

  test('malformed results and image parts are skipped quietly', () => {
    expect(extractResultImages('{"content":[{"type":"image"')).toEqual([])
    expect(extractResultImages(JSON.stringify({ content: 'nope', type: 'image' }))).toEqual([])
    expect(
      extractResultImages(
        result(
          image(''),
          image('not base64!'),
          image(PNG, 'text/html'),
          image(PNG, 'image/svg+xml'),
          { type: 'image', mimeType: 'image/png' },
          { type: 'image', data: PNG },
          null,
          'image'
        )
      )
    ).toEqual([])
  })

  test('mixed valid and malformed parts keep only the valid images', () => {
    const images = extractResultImages(
      result(image('%%%'), text('note'), image(`${PNG.slice(0, 20)}\n${PNG.slice(20)}`))
    )
    expect(images.map((entry) => entry.src)).toEqual([`data:image/png;base64,${PNG}`])
  })
})

describe('tool call images', () => {
  const read = (id: string, path: string, content: unknown[]) => ({
    toolCallId: id,
    toolName: 'read',
    args: JSON.stringify({ path }),
    result: result(...content),
  })

  test('alt text is the read path, falling back to the tool name', () => {
    expect(toolImageAlt('read', '{"path":"/tmp/shots/after.png"}')).toBe('/tmp/shots/after.png')
    expect(toolImageAlt('browser_screenshot', '{}')).toBe('Image from browser_screenshot')
    expect(toolImageAlt('browser_screenshot', 'not json')).toBe('Image from browser_screenshot')
    expect(toolImageAlt('read')).toBe('Image from read')
  })

  test('a tool call without a result yet has no images', () => {
    expect(toolCallImages({ toolCallId: 'a', toolName: 'read', args: '{}' })).toEqual([])
  })

  test('a group collects every image read by its tool calls, in order', () => {
    const blocks = [
      { type: 'thinking' },
      { type: 'tool_use', toolCall: read('a', '/tmp/one.png', [text('Read image file [image/png]'), image()]) },
      { type: 'tool_use', toolCall: read('b', '/tmp/notes.md', [text('# notes')]) },
      { type: 'tool_use', toolCall: read('c', '/tmp/two.png', [image()]) },
    ]
    expect(blocksImages(blocks).map(({ id, alt }) => ({ id, alt }))).toEqual([
      { id: 'a:0', alt: '/tmp/one.png' },
      { id: 'c:0', alt: '/tmp/two.png' },
    ])
  })
})

describe('placeholder text', () => {
  test('withoutImagePlaceholder drops only the "Read image file" line', () => {
    expect(withoutImagePlaceholder('Read image file [image/png]')).toBe('')
    expect(
      withoutImagePlaceholder('Read image file [image/jpeg]\n[Image: original 2000x1500, displayed at 1000x750.]')
    ).toBe('[Image: original 2000x1500, displayed at 1000x750.]')
    expect(withoutImagePlaceholder('I read image file [x] somewhere')).toBe('I read image file [x] somewhere')
  })

  test('the result text loses the placeholder only when an image is shown in its place', () => {
    expect(extractResultText(result(text('Read image file [image/png]'), image()))).toBe('')
    expect(extractResultText(result(text('Read image file [image/png]\nResized to 1000x750.'), image()))).toBe(
      'Resized to 1000x750.'
    )
    // No (valid) image to show: the text stays as the only sign of what was read.
    expect(extractResultText(result(text('Read image file [image/png]\nCould not decode.')))).toBe(
      'Read image file [image/png]\nCould not decode.'
    )
    expect(extractResultText(result(text('Read image file [image/png]'), image('')))).toBe(
      'Read image file [image/png]'
    )
  })

  test('imageSrcsFromContent ignores anything that is not a content array', () => {
    expect(imageSrcsFromContent(undefined)).toEqual([])
    expect(imageSrcsFromContent({ type: 'image' })).toEqual([])
  })
})
