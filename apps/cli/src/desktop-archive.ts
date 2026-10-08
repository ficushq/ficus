import { open } from 'node:fs/promises'
import { posix } from 'node:path'
import { inflateRawSync } from 'node:zlib'

const eocd = 0x06054b50
const central = 0x02014b50
const local = 0x04034b50
const maxCentralBytes = 32 * 1024 * 1024

async function readExact(file: Awaited<ReturnType<typeof open>>, buffer: Buffer, position: number): Promise<void> {
  let offset = 0
  while (offset < buffer.length) {
    const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, position + offset)
    if (!bytesRead) throw new Error('Truncated Desktop ZIP')
    offset += bytesRead
  }
}

function safeMember(name: string): boolean {
  if (!name || name.includes('\\') || name.includes('\0') || name.startsWith('/')) return false
  const parts = (name.endsWith('/') ? name.slice(0, -1) : name).split('/')
  if (parts.some((part) => part === '.' || part === '..' || part === '')) return false
  return (
    name === 'Ficus.app/' ||
    name.startsWith('Ficus.app/') ||
    name === '__MACOSX/' ||
    name.startsWith('__MACOSX/Ficus.app/')
  )
}

/** Refuse ZIP traversal, absolute/escaping symlinks, encryption and ZIP64 before ditto sees the archive. */
export async function verifyDesktopArchive(path: string): Promise<void> {
  const file = await open(path, 'r')
  try {
    const size = (await file.stat()).size
    const tail = Buffer.alloc(Math.min(size, 65_557))
    await readExact(file, tail, size - tail.length)
    let end = -1
    for (let at = tail.length - 22; at >= 0; at--) {
      if (tail.readUInt32LE(at) === eocd && at + 22 + tail.readUInt16LE(at + 20) === tail.length) {
        end = at
        break
      }
    }
    if (end < 0) throw new Error('Invalid Desktop ZIP directory')
    const count = tail.readUInt16LE(end + 10)
    const bytes = tail.readUInt32LE(end + 12)
    const offset = tail.readUInt32LE(end + 16)
    if (
      tail.readUInt16LE(end + 4) !== 0 ||
      tail.readUInt16LE(end + 6) !== 0 ||
      tail.readUInt16LE(end + 8) !== count ||
      !count ||
      count === 0xffff ||
      bytes === 0xffffffff ||
      offset === 0xffffffff ||
      bytes > maxCentralBytes ||
      offset + bytes > size
    )
      throw new Error('Unsupported Desktop ZIP directory')
    const directory = Buffer.alloc(bytes)
    await readExact(file, directory, offset)
    let cursor = 0
    let appFound = false
    let expandedTotal = 0
    for (let i = 0; i < count; i++) {
      if (cursor + 46 > bytes || directory.readUInt32LE(cursor) !== central)
        throw new Error('Invalid Desktop ZIP member')
      const flags = directory.readUInt16LE(cursor + 8)
      const method = directory.readUInt16LE(cursor + 10)
      const compressed = directory.readUInt32LE(cursor + 20)
      const expanded = directory.readUInt32LE(cursor + 24)
      const nameLength = directory.readUInt16LE(cursor + 28)
      const extraLength = directory.readUInt16LE(cursor + 30)
      const commentLength = directory.readUInt16LE(cursor + 32)
      const attributes = directory.readUInt32LE(cursor + 38)
      const headerAt = directory.readUInt32LE(cursor + 42)
      const next = cursor + 46 + nameLength + extraLength + commentLength
      if (
        next > bytes ||
        flags & 1 ||
        ![0, 8].includes(method) ||
        compressed === 0xffffffff ||
        expanded === 0xffffffff ||
        headerAt === 0xffffffff
      )
        throw new Error('Unsupported Desktop ZIP member')
      expandedTotal += expanded
      if (expandedTotal > 8 * 1024 * 1024 * 1024) throw new Error('Desktop ZIP expands beyond the allowed size')
      const name = directory.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
      if (!safeMember(name)) throw new Error('Desktop ZIP contains an unsafe path')
      if (name === 'Ficus.app/' || name.startsWith('Ficus.app/')) appFound = true
      const mode = (attributes >>> 16) & 0xffff
      const kind = mode & 0o170000
      if (kind && ![0o100000, 0o040000, 0o120000].includes(kind))
        throw new Error('Desktop ZIP contains an unsupported file type')
      const header = Buffer.alloc(30)
      await readExact(file, header, headerAt)
      if (header.readUInt32LE(0) !== local || header.readUInt16LE(8) !== method || header.readUInt16LE(6) !== flags)
        throw new Error('Invalid Desktop ZIP local header')
      const localNameLength = header.readUInt16LE(26)
      const localExtraLength = header.readUInt16LE(28)
      const localName = Buffer.alloc(localNameLength)
      await readExact(file, localName, headerAt + 30)
      if (localName.toString('utf8') !== name) throw new Error('Desktop ZIP member name mismatch')
      if (kind === 0o120000) {
        if (expanded > 4096 || compressed > 4096) throw new Error('Desktop ZIP symlink is too large')
        const payload = Buffer.alloc(compressed)
        await readExact(file, payload, headerAt + 30 + localNameLength + localExtraLength)
        const target = (method === 8 ? inflateRawSync(payload) : payload).toString('utf8')
        const parent = posix.dirname(name)
        const resolved = posix.normalize(posix.join(parent, target))
        if (
          !target ||
          target.startsWith('/') ||
          target.includes('\\') ||
          target.includes('\0') ||
          !(resolved === 'Ficus.app' || resolved.startsWith('Ficus.app/'))
        )
          throw new Error('Desktop ZIP symlink escapes the app')
      }
      cursor = next
    }
    if (cursor !== bytes || !appFound) throw new Error('Desktop ZIP does not contain Ficus.app')
  } finally {
    await file.close()
  }
}
