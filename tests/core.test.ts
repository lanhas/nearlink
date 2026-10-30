import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, open, readFile, rm, stat, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import https from 'node:https'
import { randomUUID } from 'node:crypto'
import { LanNode, CHUNK_SIZE } from '../src/main/core/node'
import { hashFile, safeName } from '../src/main/core/files'
import type { WireEvent } from '../src/shared/validation'
import type { Transfer } from '../src/shared/types'

let directory: string, a: LanNode, b: LanNode, c: LanNode
let direct = ''
async function eventually(check: () => boolean, message = 'condition', timeout = 12_000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error(`Timed out: ${message}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
async function create(name: string): Promise<LanNode> {
  const n = await LanNode.create({
    dataDir: join(directory, name),
    name,
    port: 0,
    discovery: false,
    autoImages: false
  })
  await n.start()
  return n
}
async function raw(
  source: LanNode,
  target: LanNode,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body)
    const req = https.request(
      {
        host: '127.0.0.1',
        port: target.port,
        path,
        method: data ? 'POST' : 'GET',
        cert: source.identity.cert,
        key: source.identity.key,
        rejectUnauthorized: false,
        agent: false,
        headers: {
          ...headers,
          ...(data
            ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(data)) }
            : {})
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }))
      }
    )
    req.on('error', reject)
    req.end(data)
  })
}
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'nearlink-test-'))
  ;[a, b, c] = await Promise.all(['Alice', 'Bob', 'Carol'].map(create))
  await a.connect(`127.0.0.1:${b.port}`)
  await a.connect(`127.0.0.1:${c.port}`)
  direct = a.direct(b.profile.id)
})
after(async () => {
  await Promise.allSettled([a, b, c].map((n) => n?.stop()))
  if (directory) await rm(directory, { recursive: true, force: true })
})

test('mutual TLS hello discovers actual devices and pins certificate identities', async () => {
  assert.equal(a.store.peers().length, 2)
  assert.equal(b.store.peer(a.profile.id)?.name, 'Alice')
  assert.equal(a.profile.id.length, 64)
  await assert.rejects(a.connect(`127.0.0.1:${b.port}`, c.profile.id), /证书/)
  const forged = await raw(c, b, '/v1/hello', { v: 1, profile: a.profile, port: c.port })
  assert.equal(forged.status, 403)
  await assert.rejects(a.connect('8.8.8.8:443'), /局域网/)
})

test('text delivery, local unread state, idempotency and literal text storage', async () => {
  const text = '你好 Mac & Windows <script>alert(1)</script>\n第二行 ✅'
  await a.send(direct, text)
  await eventually(() => b.store.messages(direct).length === 1, 'direct message delivered')
  assert.equal(b.store.messages(direct)[0].text, text)
  await eventually(() => a.store.messages(direct)[0].delivery === 'sent', 'delivery acknowledged')
  assert.equal(b.store.conversations().find((v) => v.id === direct)?.unread, 1)
  assert.equal(b.store.read(direct), true)
  assert.equal(b.store.read(direct), false)
  const stored = a.store.db
    .prepare('SELECT payload FROM deliveries WHERE message_id=?')
    .get(a.store.messages(direct)[0].id) as { payload: string }
  assert.equal((await raw(a, b, '/v1/events', JSON.parse(stored.payload))).status, 200)
  assert.equal(b.store.messages(direct).length, 1)
  const changed = JSON.parse(stored.payload) as Extract<WireEvent, { type: 'message' }>
  changed.message.text = 'changed'
  assert.equal((await raw(a, b, '/v1/events', changed)).status, 400)
  assert.equal(b.store.messages(direct)[0].text, text)
  assert.equal(b.store.search('第二行').length, 1)
})

test('group creation and any member can message every member', async () => {
  const id = a.createGroup('我的设备', [b.profile.id, c.profile.id])
  await eventually(() => !!b.store.conversation(id) && !!c.store.conversation(id), 'group invitations')
  await eventually(
    () => !!b.store.peer(c.profile.id) && !!c.store.peer(b.profile.id),
    'authenticated group contact exchange'
  )
  await b.send(id, '群内的 Windows 已就绪')
  await eventually(
    () => a.store.messages(id).length === 1 && c.store.messages(id).length === 1,
    'group fan-out'
  )
  assert.equal(c.store.messages(id)[0].senderId, b.profile.id)
  assert.deepEqual(a.store.conversation(id)?.members, b.store.conversation(id)?.members)
  assert.throws(() => a.createGroup('bad', []), /至少/)
})

test('rejects forged senders, group mutation and events from a new unintroduced device', async () => {
  const stored = a.store.db
    .prepare('SELECT payload FROM deliveries WHERE message_id IS NOT NULL LIMIT 1')
    .get() as { payload: string }
  const event = JSON.parse(stored.payload) as Extract<WireEvent, { type: 'message' }>
  event.id = randomUUID()
  event.message.id = event.id
  assert.equal((await raw(c, b, '/v1/events', event)).status, 400)
  const stranger = await create('Stranger')
  try {
    assert.equal((await raw(stranger, b, '/v1/events', event)).status, 403)
  } finally {
    await stranger.stop()
  }
  const group = a.store.conversations().find((v) => v.kind === 'group')!
  const mutate = { type: 'conversation', id: randomUUID(), conversation: { ...group, title: 'altered' } }
  assert.equal((await raw(a, b, '/v1/events', mutate)).status, 400)
})

test('two devices can create a named group for a shared topic', async () => {
  const id = a.createGroup('Mac 与 Windows', [b.profile.id])
  await eventually(() => !!b.store.conversation(id), 'two-device group invitation')
  await b.send(id, '两台设备也可以按主题分组。')
  await eventually(() => a.store.messages(id).length === 1, 'two-device group reply')
  assert.equal(a.store.conversation(id)?.members.length, 2)
})

test('offline outbox and device identity survive a full restart', async () => {
  const id = b.profile.id
  await b.stop()
  await a.send(direct, '离线期间的消息')
  assert.equal(a.store.messages(direct).at(-1)?.delivery, 'pending')
  b = await create('Bob')
  assert.equal(b.profile.id, id)
  await b.connect(`127.0.0.1:${a.port}`)
  await eventually(() => b.store.messages(direct).some((m) => m.text === '离线期间的消息'), 'offline retry')
  await eventually(() => a.store.messages(direct).at(-1)?.delivery === 'sent', 'outbox ack')
})

test('streamed large file pauses, resumes after restart and verifies SHA-256', async () => {
  const source = join(directory, 'large-file.bin')
  await writeFile(source, new Uint8Array())
  const chunk = Buffer.alloc(256 * 1024, 0x5a)
  for (let i = 0; i < 192; i++) await appendFile(source, chunk)
  await a.send(direct, '这是一个 48 MB 的流式传输测试。', [source])
  await eventually(() => b.store.transfers().some((f) => f.name === 'large-file.bin'), 'file offer')
  const file = b.store.transfers().find((f) => f.name === 'large-file.bin')!
  let paused = false
  const changed = () => {
    const f = b.store.transfer(file.id)
    if (!paused && f?.state === 'transferring' && f.progress >= CHUNK_SIZE) {
      paused = true
      void b.pauseFile(file.id)
    }
  }
  b.on('change', changed)
  await b.receiveFile(file.id)
  b.off('change', changed)
  assert.equal(paused, true)
  assert.equal(b.store.transfer(file.id)?.state, 'paused')
  const progress = b.store.transfer(file.id)!.progress
  assert.ok(progress >= CHUNK_SIZE && progress < file.size)
  await b.stop()
  b = await create('Bob')
  assert.equal(b.store.transfer(file.id)?.progress, progress)
  await b.connect(`127.0.0.1:${a.port}`)
  await b.receiveFile(file.id)
  const completed = b.store.transfer(file.id)!
  assert.equal(completed.state, 'complete')
  assert.equal((await stat(completed.localPath)).size, file.size)
  assert.equal(await hashFile(completed.localPath), await hashFile(source))
  await eventually(
    () =>
      a.store
        .transfer(file.id)
        ?.receipts?.some((r) => r.peerId === b.profile.id && r.state === 'complete') === true,
    'receipt'
  )
  assert.equal((await raw(c, a, `/v1/files/${file.id}`, undefined, { Range: 'bytes=0-1023' })).status, 403)
  assert.equal(
    (await raw(b, a, `/v1/files/${file.id}`, undefined, { Range: `bytes=0-${CHUNK_SIZE}` })).status,
    416
  )
  const valid = await raw(b, a, `/v1/files/${file.id}`, undefined, { Range: 'bytes=0-1023' })
  assert.equal(valid.status, 206)
  assert.equal(valid.body.length, 1024)
})

test('empty files, safe Windows filenames, multibyte names and hash mismatch', async () => {
  assert.equal(safeName('../../hello.txt'), 'hello.txt')
  assert.equal(safeName('..\\..\\CON.txt'), 'file-CON.txt')
  assert.ok(Buffer.byteLength(safeName('中文'.repeat(200) + '.zip')) <= 180)
  const path = join(directory, 'empty.txt')
  await writeFile(path, '')
  await a.send(direct, '', [path])
  await eventually(() => b.store.transfers().some((f) => f.name === 'empty.txt'))
  const empty = b.store.transfers().find((f) => f.name === 'empty.txt')!
  await b.receiveFile(empty.id)
  assert.equal(b.store.transfer(empty.id)?.state, 'complete')
  assert.equal((await readFile(b.store.transfer(empty.id)!.localPath)).length, 0)
  const corrupt = join(directory, 'corrupt.txt')
  await writeFile(corrupt, 'original')
  await a.send(direct, '', [corrupt])
  await eventually(() => b.store.transfers().some((f) => f.name === 'corrupt.txt'))
  await writeFile(corrupt, 'modified') // Same byte size: the digest must still reject this.
  const offer = b.store.transfers().find((f) => f.name === 'corrupt.txt')!
  await b.receiveFile(offer.id)
  assert.equal(b.store.transfer(offer.id)?.state, 'failed')
  assert.equal(b.store.transfer(offer.id)?.progress, 0)
})

test('byte ranges preserve offsets beyond 4 GiB', { skip: process.platform === 'win32' }, async () => {
  const source = join(directory, 'sparse-4GiB.bin')
  const handle = await open(source, 'w')
  const offset = 2 ** 32,
    marker = Buffer.from('nearlink-64-bit-range')
  try {
    await handle.truncate(offset + marker.length)
    await handle.write(marker, 0, marker.length, offset)
  } finally {
    await handle.close()
  }
  const conversation = a.store.conversation(direct)!
  const attachment = {
    id: randomUUID(),
    name: 'sparse-4GiB.bin',
    size: offset + marker.length,
    mime: 'application/octet-stream',
    sha256: '0'.repeat(64)
  }
  // This fixture tests the HTTP/SQLite 64-bit boundary, not a full sparse-file hash transfer.
  a.store.saveOutgoing(
    conversation,
    {
      id: randomUUID(),
      conversationId: direct,
      senderId: a.profile.id,
      text: '',
      attachments: [attachment],
      createdAt: Date.now()
    },
    new Map([[attachment.id, source]])
  )
  const response = await raw(b, a, `/v1/files/${attachment.id}`, undefined, {
    Range: `bytes=${offset}-${offset + marker.length - 1}`
  })
  assert.equal(response.status, 206)
  assert.equal(response.body, marker.toString())
})

test('editable profile, local notes and paginated history persist in SQLite', async () => {
  const d = await create('Persistent')
  const id = d.profile.id,
    note = `self:${id}`
  await d.updateProfile({
    ...d.profile,
    name: '小林',
    deviceName: '随行 MacBook',
    status: '在书房',
    color: '#6c8d78',
    avatar: ''
  })
  for (let i = 0; i < 105; i++) await d.send(note, `记录 ${i}`)
  const latest = d.store.messages(note)
  assert.equal(latest.length, 100)
  assert.equal(d.store.messages(note, latest[0].seq).length, 5)
  await d.stop()
  const restarted = await create('Persistent')
  try {
    assert.equal(restarted.profile.id, id)
    assert.equal(restarted.profile.name, '小林')
    assert.equal(restarted.store.messages(note).at(-1)?.text, '记录 104')
    assert.equal(restarted.store.search('记录 104').length, 1)
    assert.equal(restarted.store.db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok')
  } finally {
    await restarted.stop()
  }
})
