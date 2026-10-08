import { describe, expect, test } from 'bun:test'
import { PhotonImage } from '@silvia-odwyer/photon-node'
import { DECISION_IMAGE_MAX_SIDE, DECISION_IMAGE_MIN_SIDE, DECISION_IMAGE_TARGET_BYTES } from '@ficus/shared'
import { GIF_64x32, png } from '../../test-utils/images'
import { decisionImageCopy } from './decision-image'

function decoded(base64: string) {
  const image = PhotonImage.new_from_byteslice(Buffer.from(base64, 'base64'))
  try {
    return { width: image.get_width(), height: image.get_height() }
  } finally {
    image.free()
  }
}

describe('the copy a decision model sees', () => {
  test('a large screenshot is scaled to 1024px on its longest side, as a JPEG under 180 KB', async () => {
    const original = png(2880, 1800, 'screenshot')
    const copy = (await decisionImageCopy(original))!
    expect(copy.image.mediaType).toBe('image/jpeg')
    expect(copy).toMatchObject({ width: DECISION_IMAGE_MAX_SIDE, height: 640, quality: 80 })
    expect(copy.bytes).toBeLessThanOrEqual(DECISION_IMAGE_TARGET_BYTES)
    expect(Buffer.from(copy.image.base64, 'base64').byteLength).toBe(copy.bytes)
    expect(decoded(copy.image.base64)).toEqual({ width: 1024, height: 640 })
  })

  test('an image over 4 MB gets a copy, stepping down the quality until it fits', async () => {
    const original = png(2400, 1600, 'noise')
    // More than a decision may carry, so it could never be sent as it is.
    expect(original.byteLength).toBeGreaterThan(4 * 1024 * 1024)
    const copy = (await decisionImageCopy(original))!
    expect(copy).toMatchObject({ width: 1024, height: 683, quality: 70 })
    expect(copy.bytes).toBeLessThanOrEqual(DECISION_IMAGE_TARGET_BYTES)
  })

  test('when no quality fits, the size steps down and the qualities are tried again', async () => {
    const copy = (await decisionImageCopy(png(1000, 700, 'noise')))!
    expect(copy.bytes).toBeLessThanOrEqual(DECISION_IMAGE_TARGET_BYTES)
    expect(copy.width).toBe(800)
    expect(copy.height).toBe(560)
    expect(copy.width).toBeGreaterThanOrEqual(DECISION_IMAGE_MIN_SIDE)
  })

  test('a GIF is shown as a JPEG of its first frame', async () => {
    const copy = (await decisionImageCopy(Buffer.from(GIF_64x32, 'base64')))!
    expect(copy.image.mediaType).toBe('image/jpeg')
    expect(copy).toMatchObject({ width: 64, height: 32 })
    expect(decoded(copy.image.base64)).toEqual({ width: 64, height: 32 })
  })

  test('below the size floor it gives up rather than send an unreadable thumbnail', async () => {
    const copy = await decisionImageCopy(png(1200, 800, 'noise'), {
      targetBytes: 2_000,
      qualities: [50],
      minSide: 400,
    })
    expect(copy).toBeNull()
    // Images smaller than the floor are still judged at their own size.
    expect(await decisionImageCopy(png(200, 100, 'screenshot'))).toMatchObject({ width: 200, height: 100 })
  })

  test('bytes that are not an image get no copy', async () => {
    expect(await decisionImageCopy(new TextEncoder().encode('not an image'))).toBeNull()
  })
})
