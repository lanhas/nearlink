export interface Profile {
  id: string
  name: string
  deviceName: string
  status: string
  color: string
  avatar: string
  platform: 'darwin' | 'win32' | 'linux'
}

export interface Peer extends Profile {
  host: string
  port: number
  lastSeen: number
  online: boolean
}

export interface Conversation {
  id: string
  kind: 'direct' | 'group' | 'self'
  title: string
  members: string[]
  createdBy: string
  createdAt: number
  unread: number
  lastText: string
  updatedAt: number
}

export type ConversationInfo = Pick<
  Conversation,
  'id' | 'kind' | 'title' | 'members' | 'createdBy' | 'createdAt'
>

export interface Attachment {
  id: string
  name: string
  size: number
  mime: string
  sha256: string
}

export interface Message {
  seq: number
  id: string
  conversationId: string
  senderId: string
  text: string
  attachments: Attachment[]
  createdAt: number
  delivery: 'pending' | 'sent' | 'local'
  delivered: number
  recipients: number
}

export interface Transfer extends Attachment {
  messageId: string
  senderId: string
  direction: 'send' | 'receive'
  state: 'offered' | 'transferring' | 'paused' | 'complete' | 'failed' | 'cancelled'
  progress: number
  error: string
  localPath: string
  sourcePath: string
  speed: number
  receipts?: { peerId: string; state: string; progress: number }[]
}

export interface Snapshot {
  profile: Profile
  peers: Peer[]
  conversations: Conversation[]
  transfers: Transfer[]
  addresses: string[]
  port: number
  dataPath: string
  discoveryError: string
  version: string
}

export interface DraftFile {
  token: string
  name: string
  size: number
  mime: string
}
export interface SearchResult extends Message {
  conversationTitle: string
}
export interface ProfileUpdate {
  name: string
  deviceName: string
  status: string
  color: string
  avatar: string
}

export interface NearlinkAPI {
  snapshot(): Promise<Snapshot>
  messages(conversationId: string, before?: number): Promise<Message[]>
  direct(peerId: string): Promise<string>
  createGroup(title: string, peerIds: string[]): Promise<string>
  send(conversationId: string, text: string, tokens: string[]): Promise<void>
  read(conversationId: string): Promise<void>
  updateProfile(profile: ProfileUpdate): Promise<void>
  chooseAvatar(): Promise<string | null>
  chooseFiles(): Promise<DraftFile[]>
  dropFiles(files: File[]): Promise<DraftFile[]>
  pasteImage(): Promise<DraftFile | null>
  discardFiles(tokens: string[]): Promise<void>
  copy(text: string): Promise<void>
  appearance(theme: 'light' | 'dark'): Promise<void>
  connect(address: string): Promise<string>
  receive(id: string): Promise<void>
  pause(id: string): Promise<void>
  cancel(id: string): Promise<void>
  reveal(id: string): Promise<void>
  saveAs(id: string): Promise<void>
  openData(): Promise<void>
  search(query: string): Promise<SearchResult[]>
  onChange(listener: () => void): () => void
  onOpenConversation(listener: (id: string) => void): () => void
  platform: string
}

export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
export const COLORS = ['#b47756', '#6c8d78', '#6f86ad', '#a17c9d', '#b49a57', '#6c9b9e']
