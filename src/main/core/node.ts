import { EventEmitter } from 'node:events'
import https, { type Server } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TLSSocket } from 'node:tls'
import { hostname, userInfo } from 'node:os'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import {
  COLORS,
  IMAGE_TYPES,
  type ConversationInfo,
  type Profile,
  type ProfileUpdate,
  type Snapshot,
  type Transfer
} from '../../shared/types'
import { eventSchema, profileSchema, type WireEvent, type WireMessage } from '../../shared/validation'
import { certificateId, loadIdentity, type Identity } from './identity'
import { Discovery, isLanAddress, localAddresses } from './discovery'
import { describeFile, hashFile, safeName } from './files'
import { directId, Store } from './store'

export const DEFAULT_PORT = 45876
export const CHUNK_SIZE = 4 * 1024 * 1024
const MAX_BODY = 2 * 1024 * 1024
const helloSchema = z.object({
  v: z.literal(1),
  profile: profileSchema,
  port: z.number().int().min(1).max(65535)
})
const receiptSchema = z.object({
  state: z.enum(['transferring', 'paused', 'complete', 'failed', 'cancelled']),
  progress: z.number().int().nonnegative()
})
export interface NodeOptions {
  dataDir: string
  name?: string
  port?: number
  discovery?: boolean
  autoImages?: boolean
}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > MAX_BODY) throw new Error('请求过大。')
    chunks.push(Buffer.from(chunk))
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
function respond(response: ServerResponse, code: number, data: unknown): void {
  response.writeHead(code, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  response.end(JSON.stringify(data))
}
function peerCertificate(request: IncomingMessage): string {
  const raw = (request.socket as TLSSocket).getPeerCertificate().raw
  if (!raw) throw new Error('需要设备证书。')
  return certificateId(raw)
}

export class LanNode extends EventEmitter {
  readonly store: Store
  readonly identity: Identity
  port = 0
  discoveryError = ''
  private server?: Server
  private discovery?: Discovery
  private timer?: ReturnType<typeof setInterval>
  private flushing = new Set<string>()
  private connecting = new Map<string, Promise<string>>()
  private lastAttempt = new Map<string, number>()
  private active = new Map<string, { controller: AbortController; promise: Promise<void> }>()
  private speed = new Map<string, number>()
  private autoImages = new Set<string>()
  private stopping = false
  private receivedRate = new Map<string, { start: number; count: number }>()
  private constructor(
    readonly options: NodeOptions,
    identity: Identity
  ) {
    super()
    this.identity = identity
    this.store = new Store(options.dataDir, {
      id: identity.id,
      name: (options.name || userInfo().username || '我').trim().slice(0, 48) || '我',
      deviceName: hostname().slice(0, 64) || '我的设备',
      status: '在附近，随时连接',
      color: COLORS[0],
      avatar: '',
      platform: ['darwin', 'win32'].includes(process.platform)
        ? (process.platform as 'darwin' | 'win32')
        : 'linux'
    })
    this.store.offlineAll()
  }
  static async create(options: NodeOptions): Promise<LanNode> {
    return new LanNode(options, await loadIdentity(options.dataDir))
  }
  get profile(): Profile {
    return this.store.profile
  }
  snapshot(): Snapshot {
    return {
      profile: this.profile,
      peers: this.store.peers(),
      conversations: this.store.conversations(),
      transfers: this.store.transfers().map((f) => ({ ...f, speed: this.speed.get(f.id) || 0 })),
      addresses: localAddresses(),
      port: this.port,
      dataPath: this.options.dataDir,
      discoveryError: this.discoveryError,
      version: '0.1.0'
    }
  }
  changed(): void {
    if (!this.stopping) this.emit('change')
  }

  async start(): Promise<void> {
    this.server = https.createServer(
      {
        cert: this.identity.cert,
        key: this.identity.key,
        requestCert: true,
        rejectUnauthorized: false,
        minVersion: 'TLSv1.2'
      },
      (req, res) => {
        void this.handle(req, res).catch((error) => {
          if (!res.headersSent && !res.destroyed)
            respond(res, 400, { error: error instanceof Error ? error.message : '请求失败。' })
          else res.destroy()
        })
      }
    )
    this.server.requestTimeout = 30_000
    this.server.headersTimeout = 10_000
    this.server.maxConnections = 96
    this.server.on('tlsClientError', () => {})
    const listen = (port: number): Promise<void> =>
      new Promise((resolve, reject) => {
        this.server!.once('error', reject)
        this.server!.listen(port, '0.0.0.0', () => {
          this.server!.off('error', reject)
          resolve()
        })
      })
    try {
      await listen(this.options.port ?? DEFAULT_PORT)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE' && this.options.port === undefined)
        await listen(0)
      else throw error
    }
    this.port = (this.server.address() as { port: number }).port
    if (this.options.discovery !== false) {
      this.discovery = new Discovery(
        this.profile.id,
        this.port,
        (id, host, port) => {
          if (this.stopping || this.connecting.size >= 16) return
          const last = this.lastAttempt.get(id) || 0
          if (Date.now() - last < 5000) return
          this.lastAttempt.set(id, Date.now())
          if (this.lastAttempt.size > 512) this.lastAttempt.delete(this.lastAttempt.keys().next().value!)
          void this.connect(`${host}:${port}`, id).catch(() => {})
        },
        (error) => {
          this.discoveryError = error
          this.changed()
        }
      )
      this.discovery.start()
    }
    this.timer = setInterval(() => {
      void this.tick()
    }, 5000)
    this.timer.unref()
    this.changed()
    void this.tick()
  }

  private async tick(): Promise<void> {
    if (this.stopping) return
    // Bounded batches prevent a large saved peer list from creating socket bursts.
    const peers = this.store.peers()
    for (let index = 0; index < peers.length; index += 8) {
      if (this.stopping) return
      await Promise.allSettled(
        peers.slice(index, index + 8).map((p) => this.connect(`${p.host}:${p.port}`, p.id))
      )
    }
    this.changed()
  }

  private request(
    host: string,
    port: number,
    path: string,
    method: string,
    payload?: unknown,
    expectedId?: string,
    signal?: AbortSignal,
    headers: Record<string, string> = {}
  ): Promise<{ response: IncomingMessage; peerId: string }> {
    return new Promise((resolve, reject) => {
      if (this.stopping) {
        reject(new Error('应用正在退出。'))
        return
      }
      const body = payload === undefined ? undefined : JSON.stringify(payload)
      const request = https.request({
        host,
        port,
        path,
        method,
        cert: this.identity.cert,
        key: this.identity.key,
        rejectUnauthorized: false,
        agent: false,
        signal,
        minVersion: 'TLSv1.2',
        headers: {
          ...headers,
          ...(body
            ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) }
            : {})
        }
      })
      const connecting = setTimeout(
        () => request.destroy(new Error('连接超时，请检查设备在线状态与防火墙。')),
        8000
      )
      connecting.unref()
      let remoteId = ''
      request.on('socket', (socket) => {
        ;(socket as TLSSocket).once('secureConnect', () => {
          clearTimeout(connecting)
          try {
            const raw = (socket as TLSSocket).getPeerCertificate().raw
            if (!raw) throw new Error('对方没有提供设备证书。')
            remoteId = certificateId(raw)
            if (expectedId && expectedId !== remoteId) throw new Error('对方设备证书已变化，连接已停止。')
            request.end(body)
          } catch (error) {
            request.destroy(error as Error)
          }
        })
      })
      request.setTimeout(20_000, () => request.destroy(new Error('传输超时，可以稍后继续。')))
      request.on('error', (error) => {
        clearTimeout(connecting)
        reject(error)
      })
      request.on('response', (response) => {
        clearTimeout(connecting)
        resolve({ response, peerId: remoteId })
      })
    })
  }
  private async requestJSON(
    host: string,
    port: number,
    path: string,
    payload: unknown,
    expectedId?: string
  ): Promise<{ data: unknown; peerId: string }> {
    const { response, peerId } = await this.request(host, port, path, 'POST', payload, expectedId)
    const data = await jsonBody(response)
    if (response.statusCode !== 200)
      throw new Error((data as { error?: string }).error || `对方返回 ${response.statusCode}`)
    return { data, peerId }
  }

  async connect(address: string, expectedId?: string): Promise<string> {
    const match = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/.exec(address.trim())
    if (!match || !isLanAddress(match[1])) throw new Error('请输入局域网 IPv4 地址，例如 192.168.1.8:45876。')
    const host = match[1],
      port = Number(match[2] || DEFAULT_PORT)
    if (port < 1 || port > 65535) throw new Error('端口应在 1–65535 之间。')
    const key = `${host}:${port}:${expectedId || ''}`
    if (this.connecting.has(key)) return this.connecting.get(key)!
    const task = (async () => {
      const { data, peerId } = await this.requestJSON(
        host,
        port,
        '/v1/hello',
        { v: 1, profile: this.profile, port: this.port },
        expectedId
      )
      const hello = helloSchema.parse(data)
      if (hello.profile.id !== peerId || peerId === this.profile.id)
        throw new Error('设备身份不匹配，或连接到了当前设备。')
      this.store.upsertPeer(hello.profile, host, port)
      this.changed()
      void this.flush(peerId)
      return peerId
    })()
    this.connecting.set(key, task)
    try {
      return await task
    } catch (error) {
      if (expectedId && !this.stopping) {
        this.store.offline(expectedId)
        this.changed()
      }
      throw error
    } finally {
      this.connecting.delete(key)
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.stopping) {
      respond(response, 503, { error: '设备正在退出。' })
      return
    }
    const host = request.socket.remoteAddress?.replace(/^::ffff:/, '') || ''
    if (!isLanAddress(host) || request.headers.origin) {
      respond(response, 403, { error: '仅接受局域网设备请求。' })
      return
    }
    const actor = peerCertificate(request)
    if (actor === this.profile.id) {
      respond(response, 409, { error: '不能连接当前设备。' })
      return
    }
    const rate = this.receivedRate.get(actor)
    if (rate && Date.now() - rate.start < 1000) {
      if (++rate.count > 80) {
        respond(response, 429, { error: '请求过于频繁。' })
        return
      }
    } else this.receivedRate.set(actor, { start: Date.now(), count: 1 })
    if (this.receivedRate.size > 512) this.receivedRate.delete(this.receivedRate.keys().next().value!)
    const path = request.url || ''
    if (path === '/v1/hello' && request.method === 'POST') {
      const hello = helloSchema.parse(await jsonBody(request))
      if (actor !== hello.profile.id) {
        respond(response, 403, { error: '证书与设备身份不一致。' })
        return
      }
      this.store.upsertPeer(hello.profile, host, hello.port)
      respond(response, 200, { v: 1, profile: this.profile, port: this.port })
      this.changed()
      void this.flush(actor)
      return
    }
    if (!this.store.peer(actor)) {
      respond(response, 403, { error: '请先发现并连接设备。' })
      return
    }
    if (path === '/v1/events' && request.method === 'POST') {
      const event = eventSchema.parse(await jsonBody(request))
      this.validateEvent(event, actor)
      const fresh = this.store.receive(event)
      respond(response, 200, { ok: true })
      for (const hint of event.contacts || []) {
        if (
          hint.id !== this.profile.id &&
          hint.id !== actor &&
          event.conversation.members.includes(hint.id) &&
          isLanAddress(hint.host) &&
          !this.store.peer(hint.id)?.online
        ) {
          void this.connect(`${hint.host}:${hint.port}`, hint.id).catch(() => {})
        }
      }
      if (fresh) {
        this.changed()
        if (event.type === 'message') {
          this.emit('message', event.message)
          if (this.options.autoImages !== false)
            for (const file of event.message.attachments) {
              if (IMAGE_TYPES.has(file.mime) && file.size <= 10 * 1024 * 1024) this.autoImages.add(file.id)
            }
          this.pumpAutoImages()
        }
      }
      return
    }
    const receipt = /^\/v1\/files\/([a-f0-9-]{36})\/receipt$/.exec(path)
    if (receipt && request.method === 'POST') {
      const file = this.authorizedFile(receipt[1], actor)
      if (!file) {
        respond(response, 403, { error: '无权访问此文件。' })
        return
      }
      const data = receiptSchema.parse(await jsonBody(request))
      if (data.progress > file.size || (data.state === 'complete' && data.progress !== file.size))
        throw new Error('无效传输进度。')
      this.store.receipt(file.id, actor, data.state, data.progress)
      respond(response, 200, { ok: true })
      this.changed()
      return
    }
    const download = /^\/v1\/files\/([a-f0-9-]{36})$/.exec(path)
    if (download && (request.method === 'GET' || request.method === 'HEAD')) {
      const file = this.authorizedFile(download[1], actor)
      if (!file) {
        respond(response, 403, { error: '无权访问此文件。' })
        return
      }
      let info
      try {
        info = await stat(file.sourcePath)
      } catch {
        respond(response, 410, { error: '发送方原文件已移动或删除。' })
        return
      }
      if (!info.isFile() || info.size !== file.size) {
        respond(response, 410, { error: '发送方原文件已变化，请重新发送。' })
        return
      }
      const range = /^bytes=(\d+)-(\d*)$/.exec(String(request.headers.range || ''))
      if (!range) {
        respond(response, 416, { error: '请使用分段传输。' })
        return
      }
      const start = Number(range[1]),
        end = range[2] ? Number(range[2]) : Math.min(start + CHUNK_SIZE - 1, file.size - 1)
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end < start ||
        start >= file.size ||
        end >= file.size ||
        end - start + 1 > CHUNK_SIZE
      ) {
        respond(response, 416, { error: '无效文件区间。' })
        return
      }
      response.writeHead(206, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${file.size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store'
      })
      if (request.method === 'HEAD') {
        response.end()
        return
      }
      await pipeline(createReadStream(file.sourcePath, { start, end, highWaterMark: 256 * 1024 }), response)
      return
    }
    respond(response, 404, { error: '未知请求。' })
  }

  private validateEvent(event: WireEvent, actor: string): void {
    const c = event.conversation
    const members = [...new Set(c.members)].sort()
    if (
      members.length !== c.members.length ||
      !members.includes(this.profile.id) ||
      !members.includes(actor) ||
      !members.includes(c.createdBy)
    )
      throw new Error('会话成员不合法。')
    if (c.kind === 'direct' && (members.length !== 2 || c.id !== directId(...(members as [string, string]))))
      throw new Error('私聊身份不一致。')
    if (c.kind === 'group' && !c.id.startsWith('group:')) throw new Error('群聊标识不合法。')
    const existing = this.store.conversation(c.id)
    if (existing) {
      if (existing.kind !== c.kind || JSON.stringify(existing.members) !== JSON.stringify(members))
        throw new Error('会话成员不匹配。')
      if (
        c.kind === 'group' &&
        (existing.createdBy !== c.createdBy ||
          existing.title !== c.title ||
          existing.createdAt !== c.createdAt)
      )
        throw new Error('群聊信息不匹配。')
    } else if (c.kind === 'group' && c.createdBy !== actor) throw new Error('等待群主的邀请送达后重试。')
    if (
      event.type === 'message' &&
      (event.message.senderId !== actor || event.message.conversationId !== c.id)
    )
      throw new Error('消息发送者不匹配。')
  }
  private authorizedFile(id: string, actor: string): Transfer | undefined {
    const file = this.store.transfer(id)
    if (!file || file.direction !== 'send') return
    const message = this.store.message(file.messageId)
    const conversation = message && this.store.conversation(message.conversationId)
    return conversation?.members.includes(actor) ? file : undefined
  }

  direct(peerId: string): string {
    const peer = this.store.peer(peerId)
    if (!peer) throw new Error('未找到设备。')
    const id = directId(this.profile.id, peerId)
    this.store.addConversation({
      id,
      kind: 'direct',
      title: peer.name,
      members: [this.profile.id, peerId],
      createdBy: this.profile.id,
      createdAt: Date.now()
    })
    this.changed()
    return id
  }
  createGroup(title: string, peerIds: string[]): string {
    title = z.string().trim().min(1).max(80).parse(title)
    const members = [...new Set([this.profile.id, ...peerIds])].sort()
    if (
      members.length < 3 ||
      members.length > 64 ||
      members.some((id) => id !== this.profile.id && !this.store.peer(id))
    )
      throw new Error('请选择至少两台其他设备，最多 64 个成员。')
    const conversation: ConversationInfo = {
      id: `group:${randomUUID()}`,
      kind: 'group',
      title,
      members,
      createdBy: this.profile.id,
      createdAt: Date.now()
    }
    this.store.queueConversation(conversation)
    this.changed()
    for (const id of peerIds) void this.flush(id)
    return conversation.id
  }
  async send(conversationId: string, text: string, paths: string[] = []): Promise<void> {
    const conversation = this.store.conversation(conversationId)
    if (!conversation || !conversation.members.includes(this.profile.id)) throw new Error('会话不存在。')
    if (text.length > 64_000 || paths.length > 32)
      throw new Error('文本最多 64000 字符，每次最多 32 个文件。')
    if (!text.trim() && !paths.length) return
    const files = []
    const sources = new Map<string, string>()
    // Hash sequentially: memory and disk pressure stay bounded for many large files.
    for (const path of paths) {
      const id = randomUUID()
      files.push(await describeFile(path, id))
      sources.set(id, path)
    }
    if (this.stopping) throw new Error('应用正在退出。')
    const message: WireMessage = {
      id: randomUUID(),
      conversationId,
      senderId: this.profile.id,
      text: text.trim(),
      attachments: files,
      createdAt: Date.now()
    }
    this.store.saveOutgoing(conversation, message, sources)
    this.changed()
    for (const id of conversation.members) if (id !== this.profile.id) void this.flush(id)
  }
  private async flush(peerId: string): Promise<void> {
    if (this.flushing.has(peerId) || this.stopping) return
    const peer = this.store.peer(peerId)
    if (!peer) return
    this.flushing.add(peerId)
    try {
      let pending = this.store.pending(peerId)
      while (pending.length && !this.stopping) {
        for (const delivery of pending) {
          await this.requestJSON(peer.host, peer.port, '/v1/events', delivery.event, peerId)
          if (this.stopping) return
          this.store.delivered(delivery.rowid)
          this.changed()
        }
        pending = this.store.pending(peerId)
      }
    } catch {
      /* Persistent outbox retries after the next successful hello. */
    } finally {
      this.flushing.delete(peerId)
    }
  }
  async updateProfile(update: ProfileUpdate): Promise<void> {
    this.store.setProfile(
      profileSchema.parse({
        ...this.profile,
        ...update,
        id: this.identity.id,
        platform: this.profile.platform
      })
    )
    this.changed()
    this.discovery?.announce()
    void this.tick()
  }

  async receiveFile(id: string): Promise<void> {
    if (this.active.has(id)) return this.active.get(id)!.promise
    if (this.active.size >= 3) throw new Error('同时最多接收 3 个文件，请等待或暂停一个传输。')
    const file = this.store.transfer(id)
    if (!file || file.direction !== 'receive') throw new Error('未找到待接收文件。')
    if (file.state === 'complete') return
    const controller = new AbortController()
    const promise = this.download(file, controller.signal).finally(() => {
      this.active.delete(id)
      this.speed.delete(id)
      this.pumpAutoImages()
    })
    this.active.set(id, { controller, promise })
    return promise
  }
  private pumpAutoImages(): void {
    while (!this.stopping && this.autoImages.size && this.active.size < 3) {
      const id = this.autoImages.values().next().value!
      this.autoImages.delete(id)
      void this.receiveFile(id).catch(() => {})
    }
  }
  private async sendReceipt(file: Transfer, state: string, progress: number): Promise<void> {
    const peer = this.store.peer(file.senderId)
    if (!peer || this.stopping) return
    try {
      await this.requestJSON(
        peer.host,
        peer.port,
        `/v1/files/${file.id}/receipt`,
        { state, progress },
        peer.id
      )
    } catch {
      /* Receipt loss must not interrupt a transfer. */
    }
  }
  private async download(file: Transfer, signal: AbortSignal): Promise<void> {
    const directory = join(this.options.dataDir, 'downloads')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const final = join(directory, `${file.id}-${safeName(file.name)}`),
      partial = final + '.part'
    await writeFile(partial, new Uint8Array(), { flag: 'a', mode: 0o600 })
    let offset = (await stat(partial)).size
    if (offset > file.size) {
      await rm(partial)
      await writeFile(partial, new Uint8Array(), { mode: 0o600 })
      offset = 0
    }
    this.store.updateTransfer(file.id, { state: 'transferring', progress: offset, error: '' })
    this.changed()
    let lastNotice = Date.now(),
      lastBytes = offset
    try {
      while (offset < file.size) {
        signal.throwIfAborted()
        const peer = this.store.peer(file.senderId)
        if (!peer) throw new Error('发送设备暂时不可用。')
        const start = offset,
          end = Math.min(offset + CHUNK_SIZE - 1, file.size - 1)
        const { response } = await this.request(
          peer.host,
          peer.port,
          `/v1/files/${file.id}`,
          'GET',
          undefined,
          peer.id,
          signal,
          { Range: `bytes=${start}-${end}` }
        )
        if (
          response.statusCode !== 206 ||
          response.headers['content-range'] !== `bytes ${start}-${end}/${file.size}` ||
          Number(response.headers['content-length']) !== end - start + 1
        ) {
          response.destroy()
          throw new Error('发送方文件不可用或返回了无效文件区间，请确认原文件仍在。')
        }
        let received = 0
        const meter = new Transform({
          transform: (chunk: Buffer, _encoding, callback) => {
            received += chunk.length
            if (received > end - start + 1) {
              callback(new Error('文件区间大小不符。'))
              return
            }
            const progress = start + received
            if (Date.now() - lastNotice > 250) {
              this.speed.set(file.id, (progress - lastBytes) / ((Date.now() - lastNotice) / 1000))
              this.store.updateTransfer(file.id, { progress })
              lastBytes = progress
              lastNotice = Date.now()
              this.changed()
            }
            callback(null, chunk)
          }
        })
        await pipeline(
          response,
          meter,
          createWriteStream(partial, { flags: 'a', highWaterMark: 256 * 1024 }),
          { signal }
        )
        if (received !== end - start + 1) throw new Error('文件区间未传完整。')
        offset = end + 1
        this.store.updateTransfer(file.id, { progress: offset })
        this.changed()
        void this.sendReceipt(file, 'transferring', offset)
      }
      signal.throwIfAborted()
      this.store.updateTransfer(file.id, { error: '正在校验文件完整性…' })
      this.changed()
      const hash = await hashFile(partial, signal)
      signal.throwIfAborted()
      if (hash !== file.sha256) {
        await rm(partial, { force: true })
        this.store.updateTransfer(file.id, {
          state: 'failed',
          progress: 0,
          error: 'SHA-256 校验失败，请重新接收或让对方重新发送。'
        })
        await this.sendReceipt(file, 'failed', 0)
        this.changed()
        return
      }
      await rename(partial, final)
      this.store.updateTransfer(file.id, {
        state: 'complete',
        progress: file.size,
        localPath: final,
        error: ''
      })
      await this.sendReceipt(file, 'complete', file.size)
    } catch (error) {
      const progress = await stat(partial)
        .then((s) => s.size)
        .catch(() => 0)
      const current = this.store.transfer(file.id)
      const state = current?.state === 'cancelled' ? 'cancelled' : 'paused'
      this.store.updateTransfer(file.id, {
        state,
        progress,
        error: signal.aborted ? '' : error instanceof Error ? error.message : '传输中断，可以继续。'
      })
      await this.sendReceipt(file, state, progress)
    } finally {
      this.speed.delete(file.id)
      this.changed()
    }
  }
  async pauseFile(id: string): Promise<void> {
    const active = this.active.get(id)
    if (active) {
      active.controller.abort()
      await active.promise
    }
  }
  async cancelFile(id: string): Promise<void> {
    const file = this.store.transfer(id)
    if (!file || file.direction !== 'receive' || file.state === 'complete') return
    this.store.updateTransfer(id, { state: 'cancelled' })
    await this.pauseFile(id)
    if (this.store.transfer(id)?.state === 'complete') return
    const partial = join(this.options.dataDir, 'downloads', `${file.id}-${safeName(file.name)}.part`)
    await rm(partial, { force: true })
    this.store.updateTransfer(id, { state: 'cancelled', progress: 0, error: '' })
    this.changed()
  }
  async stop(): Promise<void> {
    this.stopping = true
    clearInterval(this.timer)
    this.discovery?.stop()
    for (const job of this.active.values()) job.controller.abort()
    await Promise.allSettled([...this.active.values()].map((job) => job.promise))
    this.server?.closeAllConnections()
    if (this.server?.listening) await new Promise<void>((resolve) => this.server!.close(() => resolve()))
    await Promise.allSettled([...this.connecting.values()])
    // Flush jobs may finish after sockets close. Let their continuations observe stopping.
    while (this.flushing.size) await new Promise((resolve) => setTimeout(resolve, 5))
    this.store.close()
  }
}
