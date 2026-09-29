import { readFileSync } from 'fs'
import { join } from 'path'

/** The root `package.json` name of a checkout, or null when it is missing, unreadable or not a string. */
export function checkoutPackageName(root: string): string | null {
  try {
    const name = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: unknown }).name
    return typeof name === 'string' ? name : null
  } catch {
    return null
  }
}
