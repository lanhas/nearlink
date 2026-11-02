import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  Copy,
  FolderOpen,
  Hash,
  Info,
  Laptop,
  MessageCircle,
  Monitor,
  Moon,
  Paperclip,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sun,
  Users,
  Wifi,
  X
} from 'lucide-react'
import {
  COLORS,
  type Conversation,
  type DraftFile,
  type Message,
  type Peer,
  type ProfileUpdate,
  type SearchResult,
  type Snapshot,
  type Transfer,
  type UpdateState
} from '../../shared/types'
import { Avatar, bytes, Empty, FileCard, FileIcon, Loading, Mark, Modal } from './components'

const api = window.nearlink
type View = 'chat' | 'devices' | 'transfers'
type Popup = 'profile' | 'connect' | 'group' | 'search' | 'updates' | null
const time = (date: number): string =>
  new Date(date).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
const day = (date: number): string => {
  const d = new Date(date),
    now = new Date()
  if (d.toDateString() === now.toDateString()) return '今天'
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return '昨天'
  return d.toLocaleDateString('zh-CN', {
    month: 'long',
    day: 'numeric',
    ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {})
  })
}
const platformName = (platform: string): string =>
  platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'Linux'

export default function App() {
  const [state, setState] = useState<Snapshot>()
  const [selected, setSelected] = useState('')
  const [view, setView] = useState<View>('chat')
  const [messages, setMessages] = useState<Message[]>([])
  const [popup, setPopup] = useState<Popup>(null)
  const [details, setDetails] = useState(false)
  const [toast, setToast] = useState('')
  const [drafts, setDrafts] = useState<Record<string, { text: string; files: DraftFile[] }>>({})
  const [sending, setSending] = useState('')
  const [dragging, setDragging] = useState(false)
  const [preview, setPreview] = useState<Transfer | null>(null)
  const [theme, setTheme] = useState(() => localStorage.getItem('nearlink-theme') || 'light')
  const [older, setOlder] = useState(false)
  const [history, setHistory] = useState(false)
  const [highlight, setHighlight] = useState('')
  const [transferTab, setTransferTab] = useState('all')
  const current = useRef('')
  const activeView = useRef<View>('chat')
  const historyRef = useRef(false)
  const pendingJump = useRef<SearchResult | null>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const textInput = useRef<HTMLTextAreaElement>(null)
  const bottom = useRef(true)
  const dragDepth = useRef(0)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const showToast = useCallback((message: string) => {
    setToast(message)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 4500)
  }, [])
  const fail = useCallback(
    (error: unknown) =>
      showToast(
        error instanceof Error
          ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
          : String(error)
      ),
    [showToast]
  )
  const close = useCallback(() => setPopup(null), [])

  useEffect(() => api?.onOpenUpdates(() => setPopup('updates')), [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('nearlink-theme', theme)
    void api?.appearance(theme === 'dark' ? 'dark' : 'light').catch(fail)
  }, [theme, fail])
  useEffect(() => {
    activeView.current = view
    if (view === 'chat' && current.current) void api?.read(current.current)
  }, [view])
  useEffect(() => {
    if (!api) return
    let live = true
    let refreshing = false,
      again = false
    const refresh = async () => {
      if (refreshing) {
        again = true
        return
      }
      refreshing = true
      do {
        again = false
        try {
          const snapshot = await api.snapshot()
          if (!live) return
          setState(snapshot)
          if (!current.current) {
            const self = snapshot.conversations.find((c) => c.kind === 'self')
            if (self) setSelected(self.id)
          }
          const id = current.current
          if (id && !historyRef.current) {
            const items = await api.messages(id)
            if (live && current.current === id && !historyRef.current) {
              setMessages((previous) => {
                const early = previous.filter((m) => items.length && m.seq < items[0].seq)
                return [...early, ...items]
              })
              if (document.hasFocus() && activeView.current === 'chat') void api.read(id)
            }
          }
        } catch (error) {
          if (live) fail(error)
        }
      } while (again && live)
      refreshing = false
    }
    void refresh()
    const off = api.onChange(() => {
      void refresh()
    })
    const offOpen = api.onOpenConversation((id) => {
      setSelected(id)
      setView('chat')
    })
    return () => {
      live = false
      off()
      offOpen()
    }
  }, [fail])
  useEffect(() => {
    current.current = selected
    bottom.current = true
    historyRef.current = false
    setHistory(false)
    setMessages([])
    setOlder(false)
    if (!selected) return
    let live = true
    const target = pendingJump.current?.conversationId === selected ? pendingJump.current : null
    pendingJump.current = null
    void api
      .messages(selected, target ? target.seq + 1 : undefined)
      .then((items) => {
        if (!live) return
        setMessages(items)
        setOlder(items.length === 100)
        if (target) {
          historyRef.current = true
          setHistory(true)
          bottom.current = false
          setHighlight(target.id)
        }
        void api.read(selected)
      })
      .catch(fail)
    textInput.current?.focus()
    return () => {
      live = false
    }
  }, [selected, fail])
  useEffect(() => {
    if (bottom.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [messages, state?.transfers])
  useEffect(() => {
    if (!highlight) return
    const timer = setTimeout(
      () =>
        document
          .getElementById(`message-${highlight}`)
          ?.scrollIntoView({ block: 'center', behavior: 'smooth' }),
      80
    )
    return () => clearTimeout(timer)
  }, [highlight, messages])
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPopup('search')
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        setPopup('group')
      }
    }
    const focus = () => {
      if (current.current && view === 'chat') void api?.read(current.current)
    }
    window.addEventListener('keydown', handler)
    window.addEventListener('focus', focus)
    return () => {
      window.removeEventListener('keydown', handler)
      window.removeEventListener('focus', focus)
    }
  }, [view])

  const openConversation = (id: string): void => {
    setSelected(id)
    setView('chat')
    setHighlight('')
  }
  const openPeer = async (peer: Peer): Promise<void> => {
    try {
      openConversation(await api.direct(peer.id))
    } catch (error) {
      fail(error)
    }
  }
  const act = (name: 'receive' | 'pause' | 'cancel' | 'reveal' | 'saveAs', id: string): void => {
    void api[name](id).catch(fail)
  }
  const conversation = state?.conversations.find((c) => c.id === selected)
  const others =
    conversation?.members
      .filter((id) => id !== state?.profile.id)
      .map((id) => state?.peers.find((p) => p.id === id)) || []
  const directPeer = others[0]
  const online = state?.peers.filter((p) => p.online) || []
  const draft = drafts[selected] || { text: '', files: [] }
  const updateDraft = (update: Partial<typeof draft>, id = selected): void =>
    setDrafts((d) => ({ ...d, [id]: { ...(d[id] || { text: '', files: [] }), ...update } }))
  const appendFiles = (files: DraftFile[]): void => {
    setDrafts((previous) => {
      const value = previous[selected] || { text: '', files: [] }
      const combined = [...value.files, ...files]
      if (combined.length > 32) {
        void api.discardFiles(files.map((f) => f.token))
        showToast('每条消息最多 32 个附件。')
        return previous
      }
      return { ...previous, [selected]: { ...value, files: combined } }
    })
    textInput.current?.focus()
  }
  const send = async (): Promise<void> => {
    if ((!draft.text.trim() && !draft.files.length) || sending === selected) return
    const id = selected
    setSending(id)
    try {
      await api.send(
        id,
        draft.text,
        draft.files.map((f) => f.token)
      )
      updateDraft({ text: '', files: [] }, id)
      bottom.current = true
      if (historyRef.current && current.current === id) {
        historyRef.current = false
        setHistory(false)
        setMessages(await api.messages(id))
      }
      textInput.current?.focus()
    } catch (error) {
      fail(error)
    } finally {
      setSending('')
    }
  }
  const loadOlder = async (): Promise<void> => {
    if (!messages.length || !scroll.current) return
    const height = scroll.current.scrollHeight
    const items = await api.messages(selected, messages[0].seq)
    setOlder(items.length === 100)
    bottom.current = false
    setMessages((old) => [...items, ...old])
    requestAnimationFrame(() => {
      if (scroll.current) scroll.current.scrollTop += scroll.current.scrollHeight - height
    })
  }
  const jump = async (result: SearchResult): Promise<void> => {
    setPopup(null)
    setView('chat')
    if (selected !== result.conversationId) {
      pendingJump.current = result
      setSelected(result.conversationId)
    } else await jumpToResult(result)
  }
  const jumpToResult = async (result: SearchResult): Promise<void> => {
    try {
      historyRef.current = true
      setHistory(true)
      bottom.current = false
      const items = await api.messages(result.conversationId, result.seq + 1)
      setMessages(items)
      setOlder(items.length === 100)
      setHighlight(result.id)
    } catch (error) {
      fail(error)
    }
  }

  if (!api)
    return (
      <div className="boot">
        <Mark size={48} />
        <h2>请通过 Nearlink 桌面应用打开</h2>
      </div>
    )
  if (!state)
    return (
      <div className="boot">
        <Mark size={48} />
        <p>正在加载…</p>
        <Loading />
      </div>
    )
  const fileMap = new Map(state.transfers.map((f) => [f.id, f]))
  const activeTransfers = state.transfers.filter((f) => f.state === 'transferring')
  const self = conversation?.kind === 'self'
  const group = conversation?.kind === 'group'
  const shared = messages
    .flatMap((m) => m.attachments.map((a) => fileMap.get(a.id)))
    .filter((f): f is Transfer => Boolean(f))
    .reverse()

  return (
    <div
      className="app-shell"
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes('Files') && view === 'chat') {
          e.preventDefault()
          dragDepth.current++
          setDragging(true)
        }
      }}
      onDragLeave={(e) => {
        e.preventDefault()
        if (--dragDepth.current <= 0) {
          setDragging(false)
          dragDepth.current = 0
        }
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault()
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        dragDepth.current = 0
        if (view === 'chat' && selected && e.dataTransfer.files.length)
          void api.dropFiles(Array.from(e.dataTransfer.files)).then(appendFiles).catch(fail)
      }}
    >
      <header className={'titlebar ' + api.platform}>
        <div className="titlebar-brand">
          <Mark size={18} />
          <strong>Nearlink</strong>
          <span className="titlebar-divider" />
          <span>邻线</span>
        </div>
      </header>
      <div className={'workspace ' + (details && view === 'chat' ? 'with-details' : '')}>
        <nav className="rail" aria-label="主导航">
          <div className="rail-mark">
            <Mark size={27} />
          </div>
          <button
            className={'rail-button ' + (view === 'chat' ? 'active' : '')}
            title="会话"
            aria-label="会话"
            onClick={() => setView('chat')}
          >
            <MessageCircle size={21} />
            {state.conversations.some((c) => c.unread) && <i className="nav-dot" />}
          </button>
          <button
            className={'rail-button ' + (view === 'devices' ? 'active' : '')}
            title="设备"
            aria-label="设备"
            onClick={() => setView('devices')}
          >
            <Monitor size={21} />
          </button>
          <button
            className={'rail-button ' + (view === 'transfers' ? 'active' : '')}
            title="传输"
            aria-label="传输"
            onClick={() => setView('transfers')}
          >
            <ArrowUpDown size={20} />
            {activeTransfers.length > 0 && <i className="nav-dot" />}
          </button>
          <div className="rail-spacer" />
          <button
            className="rail-button subtle"
            title="检查更新"
            aria-label="检查更新"
            onClick={() => {
              setPopup('updates')
              void api.checkUpdate().catch(fail)
            }}
          >
            <RefreshCw size={18} />
          </button>
          <button
            className="rail-button subtle"
            title={theme === 'light' ? '深色外观' : '浅色外观'}
            aria-label="切换外观"
            onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
          >
            {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
          </button>
          <button
            className="rail-profile"
            title="个人资料"
            aria-label="个人资料"
            onClick={() => setPopup('profile')}
          >
            <Avatar profile={state.profile} size={31} />
          </button>
        </nav>
        <aside className="sidebar">
          <div className="workspace-name">
            <h1>会话</h1>
            <button
              className="icon-button"
              title="创建群聊"
              aria-label="创建群聊"
              onClick={() => setPopup('group')}
            >
              <Plus size={18} />
            </button>
          </div>
          <button className="search-trigger" onClick={() => setPopup('search')}>
            <Search size={15} />
            <span>搜索消息与文件</span>
            <kbd>{api.platform === 'darwin' ? '⌘' : 'Ctrl'} K</kbd>
          </button>
          <div className="sidebar-scroll">
            <div className="conversation-list">
              {[...state.conversations]
                .sort((a, b) => (a.kind === 'self' ? -1 : b.kind === 'self' ? 1 : b.updatedAt - a.updatedAt))
                .map((c) => {
                  const peer = state.peers.find((p) => c.members.includes(p.id))
                  return (
                    <button
                      className={
                        'conversation-item ' + (selected === c.id && view === 'chat' ? 'selected' : '')
                      }
                      key={c.id}
                      onClick={() => openConversation(c.id)}
                    >
                      {c.kind === 'direct' ? (
                        <Avatar profile={peer} size={27} online={peer?.online} />
                      ) : (
                        <span className={'conversation-symbol ' + (c.kind === 'self' ? 'self-symbol' : '')}>
                          {c.kind === 'self' ? <Mark size={20} /> : <Hash size={20} />}
                        </span>
                      )}
                      <span className="conversation-name">
                        <span>{c.title}</span>
                        {c.kind === 'self' && <small>仅自己</small>}
                      </span>
                      {c.unread > 0 && <span className="unread">{c.unread > 99 ? '99+' : c.unread}</span>}
                    </button>
                  )
                })}
            </div>
            <div className="section-label devices-label">
              <span>
                附近设备 <span className="section-count">{online.length}</span>
              </span>
              <button
                className="icon-button"
                title="通过地址连接"
                aria-label="通过地址连接"
                onClick={() => setPopup('connect')}
              >
                <Plus size={13} />
              </button>
            </div>
            {state.peers.slice(0, 8).map((peer) => (
              <button
                className="nearby-item"
                key={peer.id}
                onClick={() => {
                  void openPeer(peer)
                }}
              >
                <span className={'device-mini ' + (peer.online ? 'online' : '')}>
                  {peer.platform === 'darwin' ? <Laptop size={16} /> : <Monitor size={16} />}
                </span>
                <span>
                  <strong>{peer.deviceName}</strong>
                  <small>
                    {peer.online ? '在线' : '离线'} · {peer.name}
                  </small>
                </span>
                {peer.online && <span className="tiny-live-dot" />}
              </button>
            ))}
            {!state.peers.length && (
              <div className="sidebar-empty">
                <Wifi size={19} />
                <p>未发现设备</p>
                <span>在同一局域网的其他设备上打开邻线</span>
              </div>
            )}
            <button className="add-device" onClick={() => setPopup('connect')}>
              <Plus size={14} />
              通过地址连接
            </button>
          </div>
        </aside>

        {view === 'chat' && conversation && (
          <main className="chat-main">
            <div className="chat-header">
              <div className="chat-identity">
                {group ? (
                  <span className="header-hash">
                    <Hash size={21} />
                  </span>
                ) : (
                  <Avatar profile={self ? state.profile : directPeer} size={34} self={self} />
                )}
                <div>
                  <h2>{conversation.title}</h2>
                  <p>
                    {self ? (
                      '仅保存在本机'
                    ) : group ? (
                      <>
                        <Users size={11} /> {conversation.members.length} 位成员<span>·</span>
                        {others.filter((p) => p?.online).length + 1} 位在线
                      </>
                    ) : (
                      <>
                        <span className={'tiny-live-dot ' + (!directPeer?.online ? 'offline' : '')} />
                        {directPeer?.online ? '在线' : '离线'}
                      </>
                    )}
                  </p>
                </div>
              </div>
              <div className="header-actions">
                <button
                  className="icon-button"
                  title="搜索"
                  aria-label="搜索"
                  onClick={() => setPopup('search')}
                >
                  <Search size={18} />
                </button>
                <span className="vertical-line" />
                <button
                  className={'icon-button ' + (details ? 'is-on' : '')}
                  title="会话详情"
                  aria-label="会话详情"
                  aria-pressed={details}
                  onClick={() => setDetails((d) => !d)}
                >
                  <Info size={19} />
                </button>
              </div>
            </div>
            <div
              className="chat-scroll"
              ref={scroll}
              onScroll={() => {
                if (scroll.current)
                  bottom.current =
                    scroll.current.scrollHeight - scroll.current.scrollTop - scroll.current.clientHeight < 140
              }}
            >
              {older && (
                <button
                  className="older-button"
                  onClick={() => {
                    void loadOlder().catch(fail)
                  }}
                >
                  加载更早的消息
                </button>
              )}
              {!messages.length ? (
                <div className="chat-empty">
                  <p>暂无消息</p>
                </div>
              ) : (
                <>
                  {messages.map((message, index) => {
                    const previous = messages[index - 1]
                    const newDay = !previous || day(previous.createdAt) !== day(message.createdAt)
                    const same =
                      previous &&
                      !newDay &&
                      previous.senderId === message.senderId &&
                      Math.abs(message.createdAt - previous.createdAt) < 180000
                    const mine = message.senderId === state.profile.id
                    const sender = mine ? state.profile : state.peers.find((p) => p.id === message.senderId)
                    return (
                      <div key={message.id}>
                        {newDay && (
                          <div className="day-divider">
                            <span>{day(message.createdAt)}</span>
                          </div>
                        )}
                        <article
                          id={'message-' + message.id}
                          className={
                            'message-row ' +
                            (same ? 'consecutive ' : '') +
                            (highlight === message.id ? 'highlight' : '')
                          }
                        >
                          <div className="message-avatar">
                            {!same && <Avatar profile={sender} size={33} />}
                            {same && <time className="hover-time">{time(message.createdAt)}</time>}
                          </div>
                          <div className="message-content">
                            {!same && (
                              <div className="message-meta">
                                <strong>{sender?.name || '设备 ' + message.senderId.slice(0, 6)}</strong>
                                {mine && <span className="me-tag">我</span>}
                                <time>{time(message.createdAt)}</time>
                              </div>
                            )}
                            {message.text && <div className="message-text">{message.text}</div>}
                            {message.attachments.length > 0 && (
                              <div className="message-attachments">
                                {message.attachments.map((a) => {
                                  const file = fileMap.get(a.id)
                                  return (
                                    file && (
                                      <FileCard key={a.id} file={file} action={act} preview={setPreview} />
                                    )
                                  )
                                })}
                              </div>
                            )}
                            {mine && message.delivery === 'pending' && (
                              <div className="delivery pending">
                                <Clock3 size={11} />
                                {message.delivered
                                  ? `已送达 ${message.delivered}/${message.recipients} · 其余待上线`
                                  : '等待设备上线后送达'}
                              </div>
                            )}
                            {mine && message.delivery === 'sent' && index === messages.length - 1 && (
                              <div className="delivery">
                                <Check size={11} />
                                {message.recipients > 1 ? `已送达 ${message.delivered} 台设备` : '已送达'}
                              </div>
                            )}
                          </div>
                          {message.text && (
                            <button
                              className="message-copy icon-button"
                              title="复制文本"
                              aria-label="复制文本"
                              onClick={() => {
                                void api
                                  .copy(message.text)
                                  .then(() => showToast('已复制'))
                                  .catch(fail)
                              }}
                            >
                              <Copy size={14} />
                            </button>
                          )}
                        </article>
                      </div>
                    )
                  })}
                </>
              )}
            </div>
            {history && (
              <button
                className="latest-button"
                onClick={() => {
                  historyRef.current = false
                  setHistory(false)
                  bottom.current = true
                  setHighlight('')
                  void api.messages(selected).then(setMessages).catch(fail)
                }}
              >
                <ArrowDown size={14} />
                回到最新消息
              </button>
            )}
            <div className="composer-area">
              <div className={'composer ' + (sending === selected ? 'busy' : '')}>
                {draft.files.length > 0 && (
                  <div className="draft-files">
                    {draft.files.map((file) => (
                      <div className="draft-file" key={file.token}>
                        <FileIcon name={file.name} mime={file.mime} size={18} />
                        <span>
                          <strong>{file.name}</strong>
                          <small>{bytes(file.size)}</small>
                        </span>
                        <button
                          className="icon-button"
                          title="移除附件"
                          aria-label="移除附件"
                          disabled={sending === selected}
                          onClick={() => {
                            updateDraft({ files: draft.files.filter((f) => f.token !== file.token) })
                            void api.discardFiles([file.token])
                          }}
                        >
                          <X size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <textarea
                  ref={textInput}
                  value={draft.text}
                  disabled={sending === selected}
                  maxLength={64000}
                  rows={2}
                  aria-label="消息"
                  placeholder={self ? '输入消息…' : `发送到 ${group ? '# ' : ''}${conversation.title}…`}
                  onChange={(e) => updateDraft({ text: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      void send()
                    }
                  }}
                  onPaste={(e) => {
                    if (Array.from(e.clipboardData.items).some((item) => item.type.startsWith('image/'))) {
                      e.preventDefault()
                      void api
                        .pasteImage()
                        .then((file) => {
                          if (file) appendFiles([file])
                        })
                        .catch(fail)
                    }
                  }}
                />
                <div className="composer-tools">
                  <div>
                    <button
                      className="icon-button"
                      title="添加文件"
                      aria-label="添加文件"
                      disabled={sending === selected}
                      onClick={() => {
                        void api.chooseFiles().then(appendFiles).catch(fail)
                      }}
                    >
                      <Plus size={19} />
                    </button>
                  </div>
                  <button
                    className="send-button"
                    aria-label="发送消息"
                    title="发送消息 (Enter)"
                    disabled={(!draft.text.trim() && !draft.files.length) || sending === selected}
                    onClick={() => {
                      void send()
                    }}
                  >
                    {sending === selected ? <Loading /> : <ArrowUp size={18} />}
                  </button>
                </div>
              </div>
              <div className="composer-foot">
                {sending === selected && <span>正在准备附件…</span>}
                <span>
                  <kbd>Enter</kbd> 发送<span className="foot-divider">·</span>
                  <kbd>Shift Enter</kbd> 换行
                </span>
              </div>
            </div>
          </main>
        )}

        {view === 'chat' && details && conversation && (
          <aside className="details-panel">
            <div className="details-heading">
              <span>会话详情</span>
              <button
                className="icon-button"
                title="关闭详情"
                aria-label="关闭详情"
                onClick={() => setDetails(false)}
              >
                <X size={15} />
              </button>
            </div>
            <div className="details-profile">
              {group ? (
                <span className="detail-group">
                  <Hash size={30} />
                </span>
              ) : (
                <Avatar profile={self ? state.profile : directPeer} size={59} self={self} />
              )}
              <h3>{conversation.title}</h3>
              {group ? (
                <p>{conversation.members.length} 位成员</p>
              ) : !self && directPeer?.status ? (
                <p>{directPeer.status}</p>
              ) : null}
            </div>
            {!self && (
              <div className="detail-section">
                <h4>
                  {group ? '成员' : '设备信息'}
                  <span>{group ? conversation.members.length : ''}</span>
                </h4>
                {group ? (
                  conversation.members.map((id) => {
                    const profile =
                      id === state.profile.id ? state.profile : state.peers.find((p) => p.id === id)
                    const isMe = id === state.profile.id
                    return (
                      <div className="member-row" key={id}>
                        <Avatar profile={profile} size={27} online={isMe || (profile as Peer)?.online} />
                        <div>
                          <strong>
                            {profile?.name || '待发现设备'}
                            {isMe && <small> (你)</small>}
                          </strong>
                          <span>{profile?.deviceName || id.slice(0, 12)}</span>
                        </div>
                        {id === conversation.createdBy && <span className="owner-tag">创建者</span>}
                      </div>
                    )
                  })
                ) : (
                  <dl className="device-facts">
                    <div>
                      <dt>名称</dt>
                      <dd>{directPeer?.deviceName || '待发现'}</dd>
                    </div>
                    <div>
                      <dt>系统</dt>
                      <dd>{platformName(directPeer?.platform || '')}</dd>
                    </div>
                    <div>
                      <dt>地址</dt>
                      <dd>{directPeer?.host || '—'}</dd>
                    </div>
                  </dl>
                )}
              </div>
            )}
            <div className="detail-section">
              <h4>
                共享文件<span>{shared.length}</span>
              </h4>
              {shared.slice(0, 5).map((f) => (
                <button
                  className="shared-file"
                  key={f.id}
                  onClick={() => {
                    if (f.state === 'complete') act('reveal', f.id)
                    else {
                      showToast('请在会话中接收文件')
                      document
                        .getElementById('message-' + f.messageId)
                        ?.scrollIntoView({ behavior: 'smooth' })
                    }
                  }}
                >
                  <span>
                    <FileIcon mime={f.mime} name={f.name} size={18} />
                  </span>
                  <div>
                    <strong>{f.name}</strong>
                    <small>{bytes(f.size)}</small>
                  </div>
                  <ChevronRight size={12} />
                </button>
              ))}
              {!shared.length && (
                <div className="detail-empty">
                  <FolderOpen size={20} />
                  <span>暂无文件</span>
                </div>
              )}
            </div>
            {!self && !group && directPeer && (
              <div className="detail-section fingerprint">
                <h4>
                  设备指纹
                  <ShieldCheck size={13} />
                </h4>
                <button
                  title="复制完整指纹"
                  onClick={() => {
                    void api
                      .copy(directPeer.id)
                      .then(() => showToast('完整设备指纹已复制'))
                      .catch(fail)
                  }}
                >
                  <code>
                    {directPeer.id.slice(0, 8)} {directPeer.id.slice(8, 16)}
                    <br />
                    {directPeer.id.slice(16, 24)} {directPeer.id.slice(24, 32)}…
                  </code>
                  <Copy size={11} />
                </button>
                <p>首次连接自动信任。可在两台设备上核对完整指纹。</p>
              </div>
            )}
          </aside>
        )}

        {view === 'devices' && (
          <main className="page-main">
            <div className="page-top">
              <span>
                <Monitor size={16} />
                设备
              </span>
              <span className="local-tag">
                <span className="live-dot" />
                局域网已就绪
              </span>
            </div>
            <div className="page-content">
              <div className="this-device">
                <div className="this-device-icon">
                  <Laptop size={25} />
                </div>
                <div>
                  <span className="device-label">本机</span>
                  <h3>
                    {state.profile.deviceName}
                    <span>你</span>
                  </h3>
                  <p>
                    {state.profile.name} · {platformName(state.profile.platform)}
                  </p>
                </div>
                <button className="secondary-button" onClick={() => setPopup('profile')}>
                  <Settings2 size={13} />
                  编辑资料
                </button>
              </div>
              <div className="network-addresses">
                <span>本机连接地址</span>
                <div>
                  {state.addresses.length ? (
                    state.addresses.map((address) => (
                      <button
                        key={address}
                        title="复制连接地址"
                        onClick={() => {
                          void api
                            .copy(`${address}:${state.port}`)
                            .then(() => showToast('连接地址已复制'))
                            .catch(fail)
                        }}
                      >
                        <code>
                          {address}:{state.port}
                        </code>
                        <Copy size={12} />
                      </button>
                    ))
                  ) : (
                    <span>暂未检测到网络接口，请连接 Wi-Fi 或网线。</span>
                  )}
                </div>
              </div>
              {state.discoveryError && (
                <div className="notice">
                  <Info size={15} />
                  {state.discoveryError}
                </div>
              )}
              <div className="page-section-title">
                <h3>
                  附近设备 <span>{state.peers.length}</span>
                </h3>
                <button className="text-link" onClick={() => setPopup('connect')}>
                  <Plus size={14} />
                  通过地址连接
                </button>
              </div>
              <div className="device-grid">
                {state.peers.map((peer) => (
                  <button
                    className="device-card"
                    key={peer.id}
                    onClick={() => {
                      void openPeer(peer)
                    }}
                  >
                    <div className="device-card-top">
                      <Avatar profile={peer} size={43} online={peer.online} />
                      <span className={'status-pill ' + (!peer.online ? 'offline' : '')}>
                        {peer.online ? '在线' : '离线'}
                      </span>
                    </div>
                    <h3>{peer.deviceName}</h3>
                    <p>
                      {peer.name}
                      <span>·</span>
                      {platformName(peer.platform)}
                    </p>
                    <div className="device-card-bottom">
                      <code>{peer.host}</code>
                      <span>
                        开始对话 <ArrowRight size={14} />
                      </span>
                    </div>
                  </button>
                ))}
              </div>
              {!state.peers.length && (
                <Empty icon={<Wifi size={32} />} title="未发现设备">
                  在同一局域网的其他设备上打开邻线，或通过地址连接。
                </Empty>
              )}
            </div>
          </main>
        )}

        {view === 'transfers' && (
          <main className="page-main">
            <div className="page-top">
              <span>
                <ArrowUpDown size={16} />
                传输
              </span>
              <button
                className="text-link"
                onClick={() => {
                  void api.openData().catch(fail)
                }}
              >
                <FolderOpen size={13} />
                打开数据目录
              </button>
            </div>
            <div className="page-content">
              <div className="transfer-stats">
                <div>
                  <span>进行中</span>
                  <strong>
                    {activeTransfers.length}
                    <small>个文件</small>
                  </strong>
                </div>
                <div>
                  <span>已接收</span>
                  <strong>
                    {
                      state.transfers.filter((f) => f.direction === 'receive' && f.state === 'complete')
                        .length
                    }
                    <small>个文件</small>
                  </strong>
                </div>
                <div>
                  <span>接收总量</span>
                  <strong>
                    {bytes(
                      state.transfers
                        .filter((f) => f.direction === 'receive' && f.state === 'complete')
                        .reduce((n, f) => n + f.size, 0)
                    )}
                  </strong>
                </div>
              </div>
              <div className="transfer-tabs">
                {[
                  ['all', '全部'],
                  ['active', '待接收与进行中'],
                  ['done', '已完成']
                ].map(([id, title]) => (
                  <button
                    className={transferTab === id ? 'selected' : ''}
                    key={id}
                    onClick={() => setTransferTab(id)}
                  >
                    {title}
                  </button>
                ))}
              </div>
              <div className="transfer-list">
                {state.transfers
                  .filter(
                    (f) =>
                      transferTab === 'all' ||
                      (transferTab === 'done'
                        ? f.state === 'complete'
                        : f.direction === 'receive' && f.state !== 'complete' && f.state !== 'cancelled')
                  )
                  .map((f) => (
                    <div className="transfer-list-item" key={f.id}>
                      <div className="transfer-direction">
                        {f.direction === 'send' ? <ArrowUp size={14} /> : <ArrowDownToLine size={14} />}
                        <span>
                          {f.direction === 'send' ? '发送' : '接收'}
                          <small>
                            {state.peers.find((p) => p.id === f.senderId)?.name ||
                              (f.senderId === state.profile.id ? '此设备' : '设备')}
                          </small>
                        </span>
                      </div>
                      <FileCard file={f} action={act} preview={setPreview} compact />
                    </div>
                  ))}
              </div>
              {!state.transfers.length && (
                <Empty icon={<ArrowUpDown size={32} />} title="暂无传输记录">
                  将文件拖入会话，或点击输入框的加号添加文件。
                </Empty>
              )}
            </div>
          </main>
        )}
      </div>
      {dragging && (
        <div className="drop-overlay">
          <div>
            <Paperclip size={38} />
            <h2>松开以添加文件</h2>
          </div>
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          <Info size={15} />
          <span>{toast}</span>
          <button aria-label="关闭提示" onClick={() => setToast('')}>
            <X size={13} />
          </button>
        </div>
      )}
      {popup === 'profile' && (
        <ProfileModal
          state={state}
          close={close}
          fail={fail}
          done={() => {
            setPopup(null)
            showToast('个人资料已更新')
          }}
        />
      )}
      {popup === 'updates' && <UpdateModal currentVersion={state.version} close={close} fail={fail} />}
      {popup === 'connect' && (
        <ConnectModal
          close={close}
          fail={fail}
          connected={(id) => {
            setPopup(null)
            void api.direct(id).then(openConversation).catch(fail)
            showToast('设备已连接')
          }}
        />
      )}
      {popup === 'group' && (
        <GroupModal
          state={state}
          close={close}
          fail={fail}
          created={(id) => {
            setPopup(null)
            openConversation(id)
          }}
        />
      )}
      {popup === 'search' && (
        <SearchModal
          close={close}
          fail={fail}
          jump={(result) => {
            void jump(result)
          }}
        />
      )}
      {preview && (
        <Modal
          title={preview.name}
          subtitle={bytes(preview.size) + ' · SHA-256 校验完整性'}
          onClose={() => setPreview(null)}
          className="image-modal"
        >
          <img src={`nearlink-media://file/${preview.id}`} alt={preview.name} />
          <div className="modal-footer">
            <button className="secondary-button" onClick={() => act('reveal', preview.id)}>
              <FolderOpen size={14} />
              在文件夹中显示
            </button>
            <button className="primary-button" onClick={() => act('saveAs', preview.id)}>
              另存为
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}

function UpdateModal({
  currentVersion,
  close,
  fail
}: {
  currentVersion: string
  close: () => void
  fail: (error: unknown) => void
}) {
  const [state, setState] = useState<UpdateState>({
    currentVersion,
    status: 'idle',
    progress: 0,
    downloaded: false
  })
  useEffect(() => {
    let live = true
    const unsubscribe = api.onUpdate((next) => {
      if (live) setState(next)
    })
    void api
      .updateState()
      .then((next) => {
        if (live) setState(next)
      })
      .catch(fail)
    return () => {
      live = false
      unsubscribe()
    }
  }, [fail])
  const labels: Record<UpdateState['status'], string> = {
    idle: '检查是否有新版本',
    checking: '正在检查更新…',
    latest: '当前已是最新版本',
    available: '有新版本可用',
    downloading: `正在下载更新 · ${state.progress}%`,
    ready: '更新已下载',
    installing: '正在准备重启…',
    error: '更新未完成'
  }
  const busy = state.status === 'checking' || state.status === 'installing'
  const canDownload = state.latestVersion && state.latestVersion !== state.currentVersion
  return (
    <Modal title="软件更新" onClose={close}>
      <div className="update-content" role="status">
        <p className="update-status">{labels[state.status]}</p>
        <p>
          当前版本 v{state.currentVersion}
          {canDownload && <> · 新版本 v{state.latestVersion}</>}
        </p>
        {state.status === 'downloading' && (
          <progress aria-label="更新下载进度" value={state.progress} max={100} />
        )}
        {state.error && <p className="update-error">{state.error}</p>}
      </div>
      <div className="modal-footer">
        <button className="secondary-button" onClick={close} disabled={state.status === 'installing'}>
          稍后
        </button>
        {state.status === 'downloading' ? (
          <button className="secondary-button" onClick={() => void api.cancelUpdate().catch(fail)}>
            取消下载
          </button>
        ) : state.downloaded ? (
          <button
            className="primary-button"
            disabled={busy}
            onClick={() => void api.installUpdate().catch(fail)}
          >
            {state.status === 'installing' ? <Loading /> : '重启并更新'}
          </button>
        ) : canDownload ? (
          <button className="primary-button" onClick={() => void api.downloadUpdate().catch(fail)}>
            下载更新
          </button>
        ) : (
          <button
            className="primary-button"
            disabled={busy}
            onClick={() => void api.checkUpdate().catch(fail)}
          >
            {busy ? <Loading /> : '检查更新'}
          </button>
        )}
      </div>
    </Modal>
  )
}

function ProfileModal({
  state,
  close,
  fail,
  done
}: {
  state: Snapshot
  close: () => void
  fail: (e: unknown) => void
  done: () => void
}) {
  const [profile, setProfile] = useState<ProfileUpdate>({ ...state.profile })
  const [busy, setBusy] = useState(false)
  return (
    <Modal title="个人资料" onClose={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          setBusy(true)
          void api
            .updateProfile(profile)
            .then(done)
            .catch(fail)
            .finally(() => setBusy(false))
        }}
      >
        <div className="profile-avatar-editor">
          <button
            type="button"
            className="avatar-edit"
            title="更换头像"
            onClick={() => {
              void api
                .chooseAvatar()
                .then((avatar) => {
                  if (avatar) setProfile((p) => ({ ...p, avatar }))
                })
                .catch(fail)
            }}
          >
            <Avatar profile={profile} size={70} />
            <span>更换</span>
          </button>
          <div>
            <strong>{profile.name || '你的名字'}</strong>
            <div className="color-choices">
              {COLORS.map((color) => (
                <button
                  type="button"
                  key={color}
                  aria-label={'头像颜色 ' + color}
                  style={{ background: color } as CSSProperties}
                  className={profile.color === color ? 'selected' : ''}
                  onClick={() => setProfile((p) => ({ ...p, color, avatar: '' }))}
                >
                  {profile.color === color && <Check size={11} />}
                </button>
              ))}
            </div>
          </div>
        </div>
        <label className="field">
          显示名称
          <input
            required
            autoComplete="off"
            maxLength={48}
            value={profile.name}
            onChange={(e) => setProfile((p) => ({ ...p, name: e.target.value }))}
          />
        </label>
        <label className="field">
          设备名称
          <input
            required
            maxLength={64}
            value={profile.deviceName}
            onChange={(e) => setProfile((p) => ({ ...p, deviceName: e.target.value }))}
          />
        </label>
        <label className="field">
          简介
          <input
            maxLength={120}
            placeholder="选填"
            value={profile.status}
            onChange={(e) => setProfile((p) => ({ ...p, status: e.target.value }))}
          />
        </label>
        <div className="profile-fingerprint">
          <span>此设备的完整指纹</span>
          <button
            type="button"
            title="复制指纹"
            onClick={() => {
              void api.copy(state.profile.id).catch(fail)
            }}
          >
            <code>{state.profile.id}</code>
            <Copy size={13} />
          </button>
        </div>
        <div className="modal-footer">
          <button
            className="primary-button"
            disabled={busy || !profile.name.trim() || !profile.deviceName.trim()}
            type="submit"
          >
            {busy ? <Loading /> : '保存资料'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
function ConnectModal({
  close,
  fail,
  connected
}: {
  close: () => void
  fail: (e: unknown) => void
  connected: (id: string) => void
}) {
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Modal title="连接设备" subtitle="在对方的「设备」页面复制连接地址。" onClose={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          setBusy(true)
          void api
            .connect(address)
            .then(connected)
            .catch(fail)
            .finally(() => setBusy(false))
        }}
      >
        <label className="field">
          对方的连接地址
          <input
            autoFocus
            required
            placeholder="192.168.1.8:45876"
            spellCheck={false}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
          <small>省略端口时使用 45876。支持私有网络 IPv4 地址。</small>
        </label>
        <div className="notice">
          <CircleHelp size={17} />
          <span>
            连接失败时，请确认两台设备在同一网络，并允许邻线通过防火墙。访客 Wi-Fi 的设备隔离也会阻止通信。
          </span>
        </div>
        <div className="modal-footer">
          <button type="button" className="secondary-button" onClick={close}>
            取消
          </button>
          <button className="primary-button" type="submit" disabled={busy || !address.trim()}>
            {busy ? (
              <>
                <Loading />
                正在连接
              </>
            ) : (
              <>
                连接设备
                <ArrowRight size={14} />
              </>
            )}
          </button>
        </div>
      </form>
    </Modal>
  )
}
function GroupModal({
  state,
  close,
  fail,
  created
}: {
  state: Snapshot
  close: () => void
  fail: (e: unknown) => void
  created: (id: string) => void
}) {
  const [title, setTitle] = useState('')
  const [chosen, setChosen] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  return (
    <Modal title="创建群聊" onClose={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          setBusy(true)
          void api
            .createGroup(title, chosen)
            .then(created)
            .catch(fail)
            .finally(() => setBusy(false))
        }}
      >
        <label className="field">
          群聊名称
          <div className="input-with-icon">
            <Hash size={16} />
            <input
              required
              maxLength={80}
              placeholder="输入群聊名称"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
        </label>
        <div className="field">
          <span>
            选择成员 <small>已选 {chosen.length} 台设备</small>
          </span>
          <div className="group-choices">
            {state.peers.map((peer) => (
              <label className="group-choice" key={peer.id}>
                <Avatar profile={peer} size={32} online={peer.online} />
                <span>
                  <strong>{peer.name}</strong>
                  <small>{peer.deviceName}</small>
                </span>
                <input
                  type="checkbox"
                  checked={chosen.includes(peer.id)}
                  onChange={(e) =>
                    setChosen((ids) =>
                      e.target.checked ? [...ids, peer.id] : ids.filter((id) => id !== peer.id)
                    )
                  }
                />
              </label>
            ))}
            {state.peers.length < 1 && (
              <p className="group-empty">选择至少一台其他设备即可创建群聊，请先在「设备」中连接。</p>
            )}
          </div>
        </div>
        <p className="form-note">你会自动加入群聊。离线成员将在重新连接后收到邀请。</p>
        <div className="modal-footer">
          <button type="button" className="secondary-button" onClick={close}>
            取消
          </button>
          <button
            className="primary-button"
            type="submit"
            disabled={busy || !title.trim() || chosen.length < 1}
          >
            {busy ? (
              <Loading />
            ) : (
              <>
                <Users size={14} />
                创建群聊
              </>
            )}
          </button>
        </div>
      </form>
    </Modal>
  )
}
function SearchModal({
  close,
  fail,
  jump
}: {
  close: () => void
  fail: (e: unknown) => void
  jump: (result: SearchResult) => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    const timer = setTimeout(() => {
      if (!query.trim()) {
        setResults([])
        setBusy(false)
        return
      }
      setBusy(true)
      void api
        .search(query)
        .then((items) => {
          if (live) setResults(items)
        })
        .catch(fail)
        .finally(() => {
          if (live) setBusy(false)
        })
    }, 180)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [query, fail])
  return (
    <Modal title="搜索消息与文件" onClose={close} className="search-modal">
      <div className="search-field">
        <Search size={18} />
        <input
          autoFocus
          placeholder="输入关键词…"
          maxLength={200}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {busy && <Loading />}
      </div>
      <div className="search-results">
        {results.map((result) => (
          <button key={result.id} className="search-result" onClick={() => jump(result)}>
            <div>
              <span>
                <Hash size={12} />
                {result.conversationTitle}
              </span>
              <time>
                {day(result.createdAt)} {time(result.createdAt)}
              </time>
            </div>
            <p>{result.text || result.attachments.map((a) => a.name).join('、')}</p>
            {result.attachments.length > 0 && (
              <small>
                <Paperclip size={11} />
                {result.attachments.map((a) => a.name).join('、')}
              </small>
            )}
          </button>
        ))}
        {!results.length && (
          <div className="search-empty">
            {query.trim() ? (busy ? '正在搜索…' : '没有找到相关消息') : '输入关键词搜索'}
          </div>
        )}
      </div>
    </Modal>
  )
}
