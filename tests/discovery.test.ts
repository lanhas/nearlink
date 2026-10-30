import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LanNode } from '../src/main/core/node'
import { localAddresses } from '../src/main/core/discovery'

test(
  'UDP announcement automatically connects two real TLS endpoints',
  { skip: process.env.CI === 'true' || !localAddresses().length },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'nearlink-discovery-'))
    const a = await LanNode.create({ dataDir: join(root, 'a'), name: 'Discovery A', port: 0 })
    const b = await LanNode.create({ dataDir: join(root, 'b'), name: 'Discovery B', port: 0 })
    try {
      await a.start()
      await b.start()
      const start = Date.now()
      while (!a.store.peer(b.profile.id) || !b.store.peer(a.profile.id)) {
        if (Date.now() - start > 12_000)
          throw new Error(`Discovery timeout: ${a.discoveryError} ${b.discoveryError}`)
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      assert.equal(a.store.peer(b.profile.id)?.online, true)
      assert.equal(b.store.peer(a.profile.id)?.online, true)
    } finally {
      await Promise.allSettled([a.stop(), b.stop()])
      await rm(root, { recursive: true, force: true })
    }
  }
)
