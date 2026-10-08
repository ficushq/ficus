import {
  DECISION_IMAGE_MAX_SIDE,
  DECISION_IMAGE_MIN_SIDE,
  DECISION_IMAGE_QUALITIES,
  DECISION_IMAGE_SIDE_STEP,
  DECISION_IMAGE_TARGET_BYTES,
  type DecisionImage,
} from '@ficus/shared'

type Photon = typeof import('@silvia-odwyer/photon-node')

let photon: Promise<Photon> | null = null

/** Photon (Rust/WASM), the decoder the agent runtime already ships; loaded on first use. */
function loadPhoton(): Promise<Photon> {
  photon ??= import('@silvia-odwyer/photon-node').then((module) => (module as { default?: Photon }).default ?? module)
  return photon
}

export interface DecisionImageOptions {
  maxSide?: number
  targetBytes?: number
  qualities?: readonly number[]
  sideStep?: number
  minSide?: number
}

export interface DecisionImageCopy {
  image: DecisionImage
  width: number
  height: number
  bytes: number
  quality: number
}

/**
 * A small JPEG copy of an image for a decision model (see `DECISION_IMAGE_MAX_SIDE` in shared): the
 * longest side at most 1024px, the first quality that fits 180 KB, stepping the size down to a
 * 320px floor. PNG, JPEG, WebP and GIF (its first frame) are read. Null when it can't be decoded or
 * doesn't fit even at the floor.
 */
export async function decisionImageCopy(
  bytes: Uint8Array,
  options: DecisionImageOptions = {}
): Promise<DecisionImageCopy | null> {
  const maxSide = options.maxSide ?? DECISION_IMAGE_MAX_SIDE
  const targetBytes = options.targetBytes ?? DECISION_IMAGE_TARGET_BYTES
  const qualities = options.qualities ?? DECISION_IMAGE_QUALITIES
  const sideStep = options.sideStep ?? DECISION_IMAGE_SIDE_STEP
  const minSide = options.minSide ?? DECISION_IMAGE_MIN_SIDE
  const { PhotonImage, SamplingFilter, resize } = await loadPhoton()
  let source: InstanceType<Photon['PhotonImage']>
  try {
    source = PhotonImage.new_from_byteslice(bytes)
  } catch {
    return null
  }
  try {
    const width = source.get_width()
    const height = source.get_height()
    const longest = Math.max(width, height)
    if (!longest) return null
    let side = Math.min(maxSide, longest)
    // An image already under the floor is judged at its own size.
    const floor = Math.min(minSide, longest)
    while (side >= floor) {
      const scale = side / longest
      const targetWidth = Math.max(1, Math.round(width * scale))
      const targetHeight = Math.max(1, Math.round(height * scale))
      // Triangle (bilinear) keeps the WASM resize quick; screenshots stay legible at these sizes.
      const sized =
        targetWidth === width && targetHeight === height
          ? null
          : resize(source, targetWidth, targetHeight, SamplingFilter.Triangle)
      try {
        for (const quality of qualities) {
          const jpeg = (sized ?? source).get_bytes_jpeg(quality)
          if (jpeg.byteLength <= targetBytes)
            return {
              image: { mediaType: 'image/jpeg', base64: Buffer.from(jpeg).toString('base64') },
              width: targetWidth,
              height: targetHeight,
              bytes: jpeg.byteLength,
              quality,
            }
        }
      } finally {
        sized?.free()
      }
      if (side === floor) break
      side = Math.max(floor, Math.floor(side * sideStep))
    }
    return null
  } finally {
    source.free()
  }
}
