import { verify } from 'node:crypto'
import { z } from 'zod'

export const RELEASE_BASE = 'https://github.com/lanhas/nearlink/releases'
export const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
export const UPDATE_FILES = {
  'mac-arm64': 'Nearlink-mac-arm64.zip',
  'win-x64': 'Nearlink-win-x64-setup.exe',
  'win-x64-portable': 'Nearlink-win-x64-portable.exe'
} as const
export type UpdateTarget = keyof typeof UPDATE_FILES
const artifact = z.object({
  url: z.string().url(),
  size: z
    .number()
    .int()
    .positive()
    .max(4 * 1024 ** 3),
  sha256: z.string().regex(/^[a-f0-9]{64}$/)
})
export const manifestSchema = z.object({
  schema: z.literal(1),
  version: z.string().max(32).regex(VERSION),
  artifacts: z.object({
    'mac-arm64': artifact,
    'win-x64': artifact,
    'win-x64-portable': artifact
  })
})
export type UpdateManifest = z.infer<typeof manifestSchema>
export type UpdateArtifact = z.infer<typeof artifact>

export function newerVersion(candidate: string, installed: string): boolean {
  if (![candidate, installed].every((v) => VERSION.test(v))) throw new Error('无效的更新版本号。')
  const a = candidate.split('.').map(BigInt)
  const b = installed.split('.').map(BigInt)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

export function verifiedManifest(
  bytes: Uint8Array,
  signature: Uint8Array,
  publicKey: string,
  releaseBase = RELEASE_BASE
): UpdateManifest {
  if (bytes.length > 64 * 1024 || signature.length !== 64 || !verify(null, bytes, publicKey, signature))
    throw new Error('更新信息签名校验失败，已停止更新。')
  let manifest: UpdateManifest
  try {
    manifest = manifestSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')))
  } catch {
    throw new Error('更新信息格式无效，已停止更新。')
  }
  for (const target of Object.keys(UPDATE_FILES) as UpdateTarget[]) {
    const expected = `${releaseBase}/download/v${manifest.version}/${UPDATE_FILES[target]}`
    if (manifest.artifacts[target].url !== expected) throw new Error('更新包地址不匹配，已停止更新。')
  }
  return manifest
}
