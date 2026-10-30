import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type {
  Attachment,
  Conversation,
  ConversationInfo,
  Message,
  Peer,
  Profile,
  SearchResult,
  Transfer
} from '../../shared/types'
import type { WireEvent, WireMessage } from '../../shared/validation'

type Row = Record<string, string | number | null>
export interface Delivery {
  rowid: number
  peerId: string
  event: WireEvent
}
export const directId = (a: string, b: string): string =>
  `dm:${createHash('sha256').update([a, b].sort().join(':')).digest('hex')}`

export class Store {
  readonly db: DatabaseSync
  constructor(
    readonly dataDir: string,
    initial: Profile
  ) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(join(dataDir, 'nearlink.sqlite'))
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS peers (id TEXT PRIMARY KEY, profile TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL, last_seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, members TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, read_seq INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, conversation_id TEXT NOT NULL REFERENCES conversations(id), sender_id TEXT NOT NULL, text TEXT NOT NULL, attachments TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, seq DESC);
      CREATE TABLE IF NOT EXISTS deliveries (event_id TEXT NOT NULL, message_id TEXT, peer_id TEXT NOT NULL, payload TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(event_id, peer_id));
      CREATE INDEX IF NOT EXISTS deliveries_pending ON deliveries(peer_id, done);
      CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY, digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS transfers (id TEXT PRIMARY KEY, metadata TEXT NOT NULL, message_id TEXT NOT NULL REFERENCES messages(id), sender_id TEXT NOT NULL, direction TEXT NOT NULL, state TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', local_path TEXT NOT NULL DEFAULT '', source_path TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS receipts (file_id TEXT NOT NULL, peer_id TEXT NOT NULL, state TEXT NOT NULL, progress INTEGER NOT NULL, PRIMARY KEY(file_id,peer_id));
      PRAGMA user_version=1;
      UPDATE transfers SET state='paused', error='上次传输尚未完成，点击继续接收。' WHERE state='transferring';
    `)
    if (!this.db.prepare('SELECT key FROM meta WHERE key=?').get('profile')) this.setProfile(initial)
    if (this.profile.id !== initial.id) throw new Error('数据库和设备身份不匹配。请恢复完整的数据目录。')
    this.addConversation({
      id: `self:${initial.id}`,
      kind: 'self',
      title: '随手记',
      members: [initial.id],
      createdBy: initial.id,
      createdAt: Date.now()
    })
  }

  get profile(): Profile {
    return JSON.parse(
      (this.db.prepare('SELECT value FROM meta WHERE key=?').get('profile') as Row).value as string
    )
  }
  setProfile(profile: Profile): void {
    this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('profile', JSON.stringify(profile))
  }

  upsertPeer(profile: Profile, host: string, port: number): void {
    this.db
      .prepare(
        `INSERT INTO peers VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET profile=excluded.profile,host=excluded.host,port=excluded.port,last_seen=excluded.last_seen`
      )
      .run(profile.id, JSON.stringify(profile), host, port, Date.now())
  }
  peers(): Peer[] {
    return (this.db.prepare('SELECT * FROM peers ORDER BY last_seen DESC').all() as Row[]).map((row) => ({
      ...JSON.parse(row.profile as string),
      host: row.host as string,
      port: row.port as number,
      lastSeen: row.last_seen as number,
      online: Date.now() - Number(row.last_seen) < 16_000
    }))
  }
  peer(id: string): Peer | undefined {
    return this.peers().find((p) => p.id === id)
  }
  offline(id: string): void {
    this.db.prepare('UPDATE peers SET last_seen=MIN(last_seen,?) WHERE id=?').run(Date.now() - 17_000, id)
  }
  offlineAll(): void {
    this.db.prepare('UPDATE peers SET last_seen=MIN(last_seen,?)').run(Date.now() - 17_000)
  }

  addConversation(info: ConversationInfo): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO conversations(id,kind,title,members,created_by,created_at) VALUES (?,?,?,?,?,?)'
      )
      .run(
        info.id,
        info.kind,
        info.title,
        JSON.stringify([...info.members].sort()),
        info.createdBy,
        info.createdAt
      )
  }
  conversation(id: string): ConversationInfo | undefined {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as Row | undefined
    return row
      ? {
          id: row.id as string,
          kind: row.kind as Conversation['kind'],
          title: row.title as string,
          members: JSON.parse(row.members as string),
          createdBy: row.created_by as string,
          createdAt: row.created_at as number
        }
      : undefined
  }
  conversations(): Conversation[] {
    const rows = this.db
      .prepare(
        `SELECT c.*,
      (SELECT count(*) FROM messages m WHERE m.conversation_id=c.id AND m.seq>c.read_seq AND m.sender_id!=?) AS unread,
      (SELECT text FROM messages m WHERE m.conversation_id=c.id ORDER BY seq DESC LIMIT 1) AS last_text,
      (SELECT attachments FROM messages m WHERE m.conversation_id=c.id ORDER BY seq DESC LIMIT 1) AS last_attachments,
      COALESCE((SELECT created_at FROM messages m WHERE m.conversation_id=c.id ORDER BY seq DESC LIMIT 1),c.created_at) AS updated_at
      FROM conversations c ORDER BY updated_at DESC`
      )
      .all(this.profile.id) as Row[]
    const peers = this.peers()
    return rows.map((r) => ({
      id: r.id as string,
      kind: r.kind as Conversation['kind'],
      title:
        r.kind === 'direct'
          ? peers.find((p) => JSON.parse(r.members as string).includes(p.id))?.name || (r.title as string)
          : (r.title as string),
      members: JSON.parse(r.members as string),
      createdBy: r.created_by as string,
      createdAt: r.created_at as number,
      unread: r.unread as number,
      lastText:
        (r.last_text as string) ||
        (r.last_attachments && JSON.parse(r.last_attachments as string).length
          ? '[文件] ' + JSON.parse(r.last_attachments as string)[0].name
          : ''),
      updatedAt: r.updated_at as number
    }))
  }
  read(id: string): boolean {
    return (
      Number(
        this.db
          .prepare(
            'UPDATE conversations SET read_seq=COALESCE((SELECT max(seq) FROM messages WHERE conversation_id=?),0) WHERE id=? AND read_seq<COALESCE((SELECT max(seq) FROM messages WHERE conversation_id=?),0)'
          )
          .run(id, id, id).changes
      ) > 0
    )
  }

  private mapMessage(r: Row): Message {
    const recipients = Number(r.recipients || 0),
      delivered = Number(r.delivered || 0)
    return {
      seq: Number(r.seq),
      id: r.id as string,
      conversationId: r.conversation_id as string,
      senderId: r.sender_id as string,
      text: r.text as string,
      attachments: JSON.parse(r.attachments as string),
      createdAt: Number(r.created_at),
      delivery: recipients ? (delivered < recipients ? 'pending' : 'sent') : 'local',
      delivered,
      recipients
    }
  }
  private readonly messageSelect = `SELECT m.*,(SELECT count(*) FROM deliveries d WHERE d.message_id=m.id) AS recipients,(SELECT count(*) FROM deliveries d WHERE d.message_id=m.id AND d.done=1) AS delivered FROM messages m`
  messages(id: string, before = Number.MAX_SAFE_INTEGER, limit = 100): Message[] {
    return (
      this.db
        .prepare(`${this.messageSelect} WHERE conversation_id=? AND seq<? ORDER BY seq DESC LIMIT ?`)
        .all(id, before, limit) as Row[]
    )
      .reverse()
      .map((r) => this.mapMessage(r))
  }
  message(id: string): Message | undefined {
    const row = this.db.prepare(`${this.messageSelect} WHERE m.id=?`).get(id) as Row | undefined
    return row ? this.mapMessage(row) : undefined
  }
  search(query: string): SearchResult[] {
    const q = query.trim().toLowerCase().slice(0, 200)
    if (!q) return []
    const titles = new Map(this.conversations().map((c) => [c.id, c.title]))
    return (
      this.db
        .prepare(
          `${this.messageSelect} WHERE instr(lower(m.text),?)>0 OR instr(lower(m.attachments),?)>0 ORDER BY seq DESC LIMIT 60`
        )
        .all(q, q) as Row[]
    ).map((r) => ({
      ...this.mapMessage(r),
      conversationTitle: titles.get(r.conversation_id as string) || '会话'
    }))
  }
  private insertMessage(message: WireMessage): void {
    this.db
      .prepare(
        'INSERT INTO messages(id,conversation_id,sender_id,text,attachments,created_at) VALUES (?,?,?,?,?,?)'
      )
      .run(
        message.id,
        message.conversationId,
        message.senderId,
        message.text,
        JSON.stringify(message.attachments),
        message.createdAt
      )
  }
  private queue(event: WireEvent, peers: string[]): void {
    const payload = {
      ...event,
      contacts: this.peers()
        .filter((p) => event.conversation.members.includes(p.id))
        .map((p) => ({ id: p.id, host: p.host, port: p.port }))
    }
    for (const peer of peers)
      this.db
        .prepare('INSERT OR IGNORE INTO deliveries(event_id,message_id,peer_id,payload) VALUES (?,?,?,?)')
        .run(event.id, event.type === 'message' ? event.message.id : null, peer, JSON.stringify(payload))
  }
  queueConversation(conversation: ConversationInfo): void {
    if (conversation.kind !== 'group') return
    this.transaction(() => {
      this.addConversation(conversation)
      this.queue(
        { type: 'conversation', id: randomUUID(), conversation: { ...conversation, kind: 'group' } },
        conversation.members.filter((id) => id !== this.profile.id)
      )
    })
  }
  saveOutgoing(conversation: ConversationInfo, message: WireMessage, paths: Map<string, string>): void {
    this.transaction(() => {
      this.insertMessage(message)
      for (const file of message.attachments)
        this.db
          .prepare(
            `INSERT INTO transfers(id,metadata,message_id,sender_id,direction,state,progress,source_path) VALUES (?,?,?,?,?,?,?,?)`
          )
          .run(
            file.id,
            JSON.stringify(file),
            message.id,
            message.senderId,
            'send',
            'complete',
            file.size,
            paths.get(file.id) || ''
          )
      if (conversation.kind !== 'self')
        this.queue(
          {
            type: 'message',
            id: message.id,
            conversation: { ...conversation, kind: conversation.kind },
            message
          },
          conversation.members.filter((id) => id !== this.profile.id)
        )
      this.read(conversation.id)
    })
  }
  receive(event: WireEvent): boolean {
    const digest = createHash('sha256').update(JSON.stringify(event)).digest('hex')
    const duplicate = this.db.prepare('SELECT digest FROM inbox WHERE id=?').get(event.id) as Row | undefined
    if (duplicate) {
      if (duplicate.digest !== digest) throw new Error('事件标识冲突。')
      return false
    }
    this.transaction(() => {
      this.addConversation(event.conversation)
      if (event.type === 'message') {
        if (this.message(event.message.id)) throw new Error('消息标识冲突。')
        this.insertMessage(event.message)
        for (const file of event.message.attachments)
          this.db
            .prepare(
              `INSERT INTO transfers(id,metadata,message_id,sender_id,direction,state) VALUES (?,?,?,?,?,?)`
            )
            .run(
              file.id,
              JSON.stringify(file),
              event.message.id,
              event.message.senderId,
              'receive',
              'offered'
            )
      }
      this.db.prepare('INSERT INTO inbox VALUES (?,?)').run(event.id, digest)
    })
    return true
  }
  pending(peer: string): Delivery[] {
    return (
      this.db
        .prepare(
          'SELECT rowid,peer_id,payload FROM deliveries WHERE peer_id=? AND done=0 ORDER BY rowid LIMIT 100'
        )
        .all(peer) as Row[]
    ).map((r) => ({
      rowid: Number(r.rowid),
      peerId: r.peer_id as string,
      event: JSON.parse(r.payload as string)
    }))
  }
  delivered(rowid: number): void {
    this.db.prepare('UPDATE deliveries SET done=1 WHERE rowid=?').run(rowid)
  }

  transfers(): Transfer[] {
    const receipts = new Map<string, Row[]>()
    for (const row of this.db.prepare('SELECT * FROM receipts').all() as Row[]) {
      const id = row.file_id as string
      const list = receipts.get(id) || []
      list.push(row)
      receipts.set(id, list)
    }
    return (this.db.prepare('SELECT * FROM transfers ORDER BY rowid DESC').all() as Row[]).map((r) =>
      this.mapTransfer(r, receipts.get(r.id as string) || [])
    )
  }
  private mapTransfer(r: Row, receipts: Row[]): Transfer {
    return {
      ...JSON.parse(r.metadata as string),
      messageId: r.message_id as string,
      senderId: r.sender_id as string,
      direction: r.direction as Transfer['direction'],
      state: r.state as Transfer['state'],
      progress: Number(r.progress),
      error: r.error as string,
      localPath: r.local_path as string,
      sourcePath: r.source_path as string,
      speed: 0,
      receipts: receipts.map((p) => ({
        peerId: p.peer_id as string,
        state: p.state as string,
        progress: Number(p.progress)
      }))
    }
  }
  receipt(fileId: string, peerId: string, state: string, progress: number): void {
    this.db
      .prepare(
        "INSERT INTO receipts VALUES (?,?,?,?) ON CONFLICT(file_id,peer_id) DO UPDATE SET state=excluded.state,progress=excluded.progress WHERE receipts.state!='complete' OR excluded.state='complete'"
      )
      .run(fileId, peerId, state, progress)
  }
  transfer(id: string): Transfer | undefined {
    const row = this.db.prepare('SELECT * FROM transfers WHERE id=?').get(id) as Row | undefined
    return row
      ? this.mapTransfer(row, this.db.prepare('SELECT * FROM receipts WHERE file_id=?').all(id) as Row[])
      : undefined
  }
  updateTransfer(
    id: string,
    values: Partial<Pick<Transfer, 'state' | 'progress' | 'error' | 'localPath'>>
  ): void {
    const map = { state: 'state', progress: 'progress', error: 'error', localPath: 'local_path' } as const
    const entries = Object.entries(values).filter(([k]) => k in map)
    if (!entries.length) return
    this.db
      .prepare(
        `UPDATE transfers SET ${entries.map(([k]) => `${map[k as keyof typeof map]}=?`).join(',')} WHERE id=?`
      )
      .run(...entries.map(([, v]) => v as string | number), id)
  }
  transaction(fn: () => void): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      fn()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  close(): void {
    this.db.close()
  }
}
