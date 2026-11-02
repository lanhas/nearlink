import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  RELEASE_BASE,
  UPDATE_FILES,
  VERSION,
  type UpdateManifest,
  type UpdateTarget
} from '../src/main/updater/manifest'

export async function createUpdateManifest(
  directory: string,
  version: string,
  base = RELEASE_BASE
): Promise<UpdateManifest> {
  if (!VERSION.test(version)) throw new Error('Invalid update version.')
  const artifacts = {} as UpdateManifest['artifacts']
  for (const target of Object.keys(UPDATE_FILES) as UpdateTarget[]) {
    const name = UPDATE_FILES[target]
    const path = join(directory, name)
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    artifacts[target] = {
      url: `${base}/download/v${version}/${name}`,
      size: (await stat(path)).size,
      sha256: hash.digest('hex')
    }
  }
  return { schema: 1, version, artifacts }
}

export async function writeSignedManifest(
  directory: string,
  manifest: UpdateManifest,
  privateKey: string
): Promise<void> {
  const key = createPrivateKey(privateKey)
  const actual = createPublicKey(key).export({ type: 'spki', format: 'pem' })
  const expected = createPublicKey(await readFile('resources/update-public-key.pem', 'utf8')).export({
    type: 'spki',
    format: 'pem'
  })
  if (actual !== expected)
    throw new Error('Signing key does not match the public key embedded in the application.')
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n')
  await writeFile(join(directory, 'update.json'), bytes)
  await writeFile(join(directory, 'update.json.sig'), sign(null, bytes, key))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2] || 'dist'
  const { version } = JSON.parse(await readFile('package.json', 'utf8')) as { version: string }
  const key = process.env.NEARLINK_UPDATE_PRIVATE_KEY
  if (!key) throw new Error('NEARLINK_UPDATE_PRIVATE_KEY is required to publish updates.')
  await writeSignedManifest(directory, await createUpdateManifest(directory, version), key)
  console.log(`Signed update manifest for v${version}.`)
}
