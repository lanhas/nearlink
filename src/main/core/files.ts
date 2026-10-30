import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type { Attachment } from '../../shared/types'

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.json': 'application/json'
}
export const mimeType = (name: string): string =>
  MIME[extname(name).toLowerCase()] || 'application/octet-stream'

export function safeName(name: string): string {
  const clean = basename(name.replaceAll('\\', '/'))
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/g, '')
  const safe =
    !clean || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(clean)
      ? `file-${clean || 'attachment'}`
      : clean
  let result = ''
  const extension = extname(safe).slice(0, 24)
  const base = extension ? safe.slice(0, -extname(safe).length) : safe
  for (const character of base) {
    if (Buffer.byteLength(result + character + extension, 'utf8') > 180) break
    result += character
  }
  return result + extension
}

export async function hashFile(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(path, { highWaterMark: 256 * 1024, signal })
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

export async function describeFile(path: string, id: string): Promise<Attachment> {
  const before = await stat(path)
  if (!before.isFile()) throw new Error('目前只能发送文件，请先将文件夹压缩。')
  const sha256 = await hashFile(path)
  const after = await stat(path)
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
    throw new Error('文件在准备时发生变化，请重试。')
  const name = safeName(basename(path))
  return { id, name, size: after.size, mime: mimeType(name), sha256 }
}
