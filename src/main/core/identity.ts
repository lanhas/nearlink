import { X509Certificate } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { generate } from 'selfsigned'

export interface Identity {
  cert: string
  key: string
  id: string
}

export function certificateId(raw: Buffer | string): string {
  return new X509Certificate(raw).fingerprint256.replaceAll(':', '').toLowerCase()
}

export async function loadIdentity(dataDir: string): Promise<Identity> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  const path = join(dataDir, 'identity.json')
  try {
    const saved = JSON.parse(await readFile(path, 'utf8')) as { cert: string; key: string }
    return { ...saved, id: certificateId(saved.cert) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error('设备身份文件损坏，请从备份恢复 identity.json。', { cause: error })
  }
  const end = new Date()
  end.setFullYear(end.getFullYear() + 10)
  const keys = await generate([{ name: 'commonName', value: 'Nearlink local device' }], {
    keySize: 2048,
    algorithm: 'sha256',
    notAfterDate: end,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true, clientAuth: true }
    ]
  })
  const saved = { cert: keys.cert, key: keys.private }
  await writeFile(path, JSON.stringify(saved), { mode: 0o600, flag: 'wx' })
  return { ...saved, id: certificateId(saved.cert) }
}
