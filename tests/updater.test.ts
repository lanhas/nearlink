import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { UpdateController } from '../src/main/updater/controller'
import {
  newerVersion,
  UPDATE_FILES,
  verifiedManifest,
  type UpdateManifest
} from '../src/main/updater/manifest'

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'nearlink-updater-'))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const payload = Buffer.alloc(2 * 1024 * 1024, 0x72)
  let corrupt = false
  let tamper = false
  let slow = false
  let metadataRequests = 0
  let downloads = 0
  let manifest: UpdateManifest
  const server = createServer((request, response) => {
    if (request.url?.endsWith('update.json') || request.url?.endsWith('update.json.sig')) {
      metadataRequests++
      const bytes = Buffer.from(JSON.stringify(manifest))
      const data = request.url.endsWith('.sig')
        ? sign(null, bytes, privateKey)
        : tamper
          ? Buffer.concat([bytes, Buffer.from(' ')])
          : bytes
      response.end(data)
      return
    }
    downloads++
    response.writeHead(200, { 'Content-Length': payload.length })
    if (!slow) return void response.end(corrupt ? Buffer.alloc(payload.length, 0x73) : payload)
    let offset = 0
    const timer = setInterval(() => {
      if (offset >= payload.length) {
        clearInterval(timer)
        response.end()
        return
      }
      response.write(payload.subarray(offset, offset + 8192))
      offset += 8192
    }, 5)
    response.on('close', () => clearInterval(timer))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const base = `http://127.0.0.1:${port}/releases`
  const artifact = { size: payload.length, sha256: createHash('sha256').update(payload).digest('hex') }
  manifest = {
    schema: 1,
    version: '0.1.10',
    artifacts: Object.fromEntries(
      Object.entries(UPDATE_FILES).map(([target, filename]) => [
        target,
        { ...artifact, url: `${base}/download/v0.1.10/${filename}` }
      ])
    ) as UpdateManifest['artifacts']
  }
  const operations: string[] = []
  const make = (currentVersion = '0.1.2', fetcher: typeof fetch = fetch) =>
    new UpdateController({
      currentVersion,
      target: 'mac-arm64',
      publicKey: publicPem,
      directory,
      releaseBase: base,
      fetch: fetcher,
      prepare: async () => {
        operations.push('prepare')
        return async () => {
          operations.push('helper')
        }
      },
      shutdown: async () => {
        operations.push('close-database')
      },
      quit: () => {
        operations.push('quit')
      }
    })
  return {
    directory,
    payload,
    manifest,
    publicPem,
    privateKey,
    base,
    operations,
    make,
    metadataRequests: () => metadataRequests,
    downloads: () => downloads,
    tamper: (value: boolean) => {
      tamper = value
    },
    corrupt: (value: boolean) => {
      corrupt = value
    },
    slow: (value: boolean) => {
      slow = value
    },
    cleanup: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    }
  }
}

test('signed manifests reject tampering, unrelated keys, foreign download URLs and version downgrades', () => {
  assert.equal(newerVersion('0.1.10', '0.1.2'), true)
  assert.equal(newerVersion('1.0.0', '0.99.99'), true)
  assert.equal(newerVersion('0.1.2', '0.1.2'), false)
  assert.equal(newerVersion('0.1.1', '0.1.2'), false)
  assert.throws(() => newerVersion('0.1.2-beta', '0.1.1'))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const bytes = Buffer.from('{}')
  assert.throws(() => verifiedManifest(bytes, sign(null, bytes, privateKey), pem), /格式/)
  assert.throws(() => verifiedManifest(Buffer.from('{ }'), sign(null, bytes, privateKey), pem), /签名/)
  const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
  assert.throws(() => verifiedManifest(bytes, sign(null, bytes, privateKey), other), /签名/)
})

test('check/download deduplicate; verified update cache survives restart; closes database before quit', async () => {
  const f = await fixture()
  try {
    const controller = f.make()
    assert.equal(f.metadataRequests(), 0, 'No background request before user checks')
    await Promise.all([controller.check(), controller.check(), controller.check()])
    assert.equal(f.metadataRequests(), 2)
    assert.equal(controller.snapshot().status, 'available')
    await Promise.all([controller.download(), controller.download()])
    assert.equal(f.downloads(), 1)
    assert.equal(controller.snapshot().status, 'ready')
    const restored = f.make()
    await restored.restore()
    assert.equal(restored.snapshot().status, 'ready')
    assert.equal(restored.snapshot().latestVersion, '0.1.10')
    await restored.install()
    assert.deepEqual(f.operations, ['prepare', 'helper', 'close-database', 'quit'])
    const upgraded = f.make('0.1.10')
    await upgraded.restore()
    assert.equal(upgraded.snapshot().downloaded, false)
    await upgraded.check()
    assert.equal(upgraded.snapshot().status, 'latest')
  } finally {
    await f.cleanup()
  }
})

test('invalid update metadata and corrupt payload never reach installer; retry can recover', async () => {
  const f = await fixture()
  try {
    const controller = f.make()
    f.tamper(true)
    await controller.check()
    assert.equal(controller.snapshot().status, 'error')
    assert.match(controller.snapshot().error!, /签名/)
    assert.equal(f.downloads(), 0)
    f.tamper(false)
    const foreign = structuredClone(f.manifest)
    foreign.artifacts['mac-arm64'].url = 'https://example.com/update.zip'
    const bytes = Buffer.from(JSON.stringify(foreign))
    assert.throws(() => verifiedManifest(bytes, sign(null, bytes, f.privateKey), f.publicPem, f.base), /地址/)
    await controller.check()
    f.corrupt(true)
    await controller.download()
    assert.equal(controller.snapshot().downloaded, false)
    assert.match(controller.snapshot().error!, /校验/)
    assert.deepEqual(await readdir(f.directory), [])
    assert.deepEqual(f.operations, [])
    f.corrupt(false)
    await controller.download()
    assert.equal(controller.snapshot().status, 'ready')
    const pending = JSON.parse(await readFile(join(f.directory, 'pending.json'), 'utf8')) as { id: string }
    await writeFile(join(f.directory, pending.id, UPDATE_FILES['mac-arm64']), 'tampered')
    await controller.install()
    assert.equal(controller.snapshot().downloaded, false)
    assert.deepEqual(f.operations, [], 'Recheck payload immediately before any installer/helper')
    await controller.download()
    assert.equal(controller.snapshot().status, 'ready')
  } finally {
    await f.cleanup()
  }
})

test('checking again can replace a cached update with a newer fixed release', async () => {
  const f = await fixture()
  try {
    const controller = f.make()
    await controller.check()
    await controller.download()
    await controller.check()
    assert.equal(controller.snapshot().status, 'ready')
    f.manifest.version = '0.1.11'
    for (const artifact of Object.values(f.manifest.artifacts))
      artifact.url = artifact.url.replace('/v0.1.10/', '/v0.1.11/')
    await controller.check()
    assert.equal(controller.snapshot().status, 'available')
    assert.equal(controller.snapshot().downloaded, false)
    assert.equal(controller.snapshot().latestVersion, '0.1.11')
    await controller.download()
    assert.equal(controller.snapshot().status, 'ready')
  } finally {
    await f.cleanup()
  }
})

test('download can be cancelled; network failures show an error and allow another check', async () => {
  const f = await fixture()
  try {
    let offline = true
    const controller = f.make('0.1.2', (async (...args: Parameters<typeof fetch>) => {
      if (offline) throw new TypeError('fetch failed')
      return fetch(...args)
    }) as typeof fetch)
    await controller.check()
    assert.equal(controller.snapshot().status, 'error')
    assert.match(controller.snapshot().error!, /网络/)
    offline = false
    await controller.check()
    f.slow(true)
    const downloading = controller.download()
    while (controller.snapshot().status !== 'downloading') await delay(5)
    await delay(20)
    controller.cancel()
    await downloading
    assert.equal(controller.snapshot().status, 'available')
    assert.deepEqual(await readdir(f.directory), [])
    f.slow(false)
    await controller.download()
    assert.equal(controller.snapshot().status, 'ready')
  } finally {
    await f.cleanup()
  }
})
