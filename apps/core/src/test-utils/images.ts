import { PhotonImage } from '@silvia-odwyer/photon-node'

/** A 64x32 GIF: red left half, blue right half. */
export const GIF_64x32 =
  'R0lGODlhQAAgAIEAAExpcf8AAAAA/wAAACH5BAUAAAAALAAAAABAACAAAAJkjI+pi+IPo5yQ2Zuo3hF7y4XaR2biWZUqygrq2p5vGcvzV4s3nnO71/P9LsHNkFikHEHJyZLRdD4VUcmUWk1dD1ntNtB9fLlh1xhcPqPD6rJ57G6nz3H6HH7/1vFse5/fJRdWAAA7'

/** A PNG of the given size: flat UI-like panels, or noise (which compresses worst of all). */
export function png(width: number, height: number, kind: 'screenshot' | 'noise'): Uint8Array {
  const pixels = new Uint8Array(width * height * 4)
  let seed = 7
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      if (kind === 'noise') {
        for (let c = 0; c < 3; c++) {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff
          pixels[i + c] = seed & 0xff
        }
      } else {
        const panel = x < width / 5 ? 230 : y < height / 12 ? 40 : 250
        const text = y % 24 < 3 && x % 200 < 150 && x > width / 5 ? 60 : panel
        pixels.set([text, text, Math.min(255, text + 10)], i)
      }
      pixels[i + 3] = 255
    }
  const image = new PhotonImage(pixels, width, height)
  try {
    return image.get_bytes()
  } finally {
    image.free()
  }
}
