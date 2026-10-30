import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import {
  ArrowDown,
  Check,
  Download,
  FileArchive,
  FileImage,
  FileText,
  FolderOpen,
  LoaderCircle,
  Pause,
  RotateCcw,
  Save,
  Video,
  X
} from 'lucide-react'
import { IMAGE_TYPES, type Profile, type Transfer } from '../../shared/types'

export function Mark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path
        d="M7.8 22.5V12c0-2.2 2.7-3.3 4.2-1.7l8 8.4c1.5 1.6 4.2.5 4.2-1.7V6.5"
        stroke="currentColor"
        strokeWidth="2.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="7.8" cy="27" r="1.1" fill="currentColor" />
      <circle cx="24.2" cy="2" r="1.1" fill="currentColor" />
    </svg>
  )
}
export function Avatar({
  profile,
  size = 34,
  online,
  self = false
}: {
  profile?: Pick<Profile, 'name' | 'avatar' | 'color'>
  size?: number
  online?: boolean
  self?: boolean
}) {
  return (
    <span
      className={'avatar' + (self ? ' avatar-self' : '')}
      style={
        {
          width: size,
          height: size,
          '--avatar-color': profile?.color || '#818b75',
          fontSize: size * 0.37
        } as CSSProperties
      }
    >
      {profile?.avatar ? (
        <img src={profile.avatar} alt="" />
      ) : self ? (
        <Mark size={size * 0.64} />
      ) : (
        <span>{profile?.name?.slice(0, 1).toUpperCase() || '?'}</span>
      )}
      {online !== undefined && <i className={'presence' + (online ? ' online' : '')} />}
    </span>
  )
}
export const bytes = (n: number): string => {
  if (!n) return '0 B'
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), 4)
  return `${(n / 1024 ** i).toFixed(i > 0 && n / 1024 ** i < 100 ? 1 : 0)} ${['B', 'KB', 'MB', 'GB', 'TB'][i]}`
}
export function FileIcon({ mime, name, size = 21 }: { mime: string; name: string; size?: number }) {
  const Icon = IMAGE_TYPES.has(mime)
    ? FileImage
    : mime.startsWith('video/')
      ? Video
      : /\.(zip|rar|7z|tar|gz)$/i.test(name)
        ? FileArchive
        : FileText
  return <Icon size={size} strokeWidth={1.6} />
}
export function Modal({
  title,
  subtitle,
  children,
  onClose,
  className = ''
}: {
  title: string
  subtitle?: string
  children: ReactNode
  onClose: () => void
  className?: string
}) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const focus =
      box.current?.querySelector<HTMLElement>('input,textarea') ||
      box.current?.querySelector<HTMLElement>('button')
    focus?.focus()
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
      if (e.key === 'Tab') {
        const items = Array.from(
          box.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),[tabindex="0"]'
          ) || []
        )
        const first = items[0],
          last = items.at(-1)
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last?.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first?.focus()
        }
      }
    }
    document.addEventListener('keydown', handle)
    return () => {
      document.removeEventListener('keydown', handle)
      previous?.focus()
    }
  }, [onClose])
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div ref={box} className={'modal ' + className} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-button" aria-label="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
export function FileCard({
  file,
  action,
  preview,
  compact = false
}: {
  file: Transfer
  action: (name: 'receive' | 'pause' | 'cancel' | 'reveal' | 'saveAs', id: string) => void
  preview: (file: Transfer) => void
  compact?: boolean
}) {
  const incoming = file.direction === 'receive'
  const done = file.state === 'complete'
  const active = file.state === 'transferring'
  const image = IMAGE_TYPES.has(file.mime) && done && file.size <= 50 * 1024 * 1024
  const receipt = file.receipts || []
  const receiving = !incoming && receipt.some((r) => r.state === 'transferring')
  const percent = file.size ? Math.min(100, (file.progress / file.size) * 100) : done ? 100 : 0
  const receiptPercent =
    receipt.length && file.size
      ? receipt.reduce((n, r) => n + (r.progress / file.size) * 100, 0) / receipt.length
      : 0
  let caption = bytes(file.size)
  if (incoming) {
    if (active)
      caption =
        file.error ||
        `${bytes(file.progress)} / ${bytes(file.size)}${file.speed ? ' · ' + bytes(file.speed) + '/s' : ''}`
    else if (done) caption += ' · 已接收，校验通过'
    else if (file.state === 'paused') caption = `${bytes(file.progress)} / ${bytes(file.size)} · 已暂停`
    else if (file.state === 'failed') caption += ' · 接收失败'
    else if (file.state === 'cancelled') caption += ' · 已取消'
    else caption += ' · 等待接收'
  } else if (receipt.some((r) => r.state === 'complete'))
    caption += ` · ${receipt.filter((r) => r.state === 'complete').length} 台设备已接收`
  else if (receiving) caption += ' · 对方正在接收'
  else caption += ' · 原文件在此设备'
  return (
    <div className={'attachment ' + (compact ? 'compact ' : '') + (image ? 'has-image' : '')}>
      {image && !compact && (
        <button className="image-preview" aria-label={'预览 ' + file.name} onClick={() => preview(file)}>
          <img
            src={`nearlink-media://file/${file.id}`}
            alt={file.name}
            loading="lazy"
            onError={(e) => {
              e.currentTarget.style.display = 'none'
            }}
          />
          <span>查看原图 ↗</span>
        </button>
      )}
      <div className="file-card">
        <span className={'file-icon ' + (file.mime === 'application/pdf' ? 'pdf' : '')}>
          <FileIcon mime={file.mime} name={file.name} />
        </span>
        <div className="file-info">
          <strong title={file.name}>{file.name}</strong>
          <span className={file.state === 'failed' ? 'text-error' : ''}>{caption}</span>
        </div>
        <div className="file-actions">
          {incoming && !done && !active && (
            <button
              className="icon-button"
              title={file.progress ? '继续接收' : '接收文件'}
              aria-label={file.progress ? '继续接收' : '接收文件'}
              onClick={() => action('receive', file.id)}
            >
              {file.state === 'offered' ? <ArrowDown size={17} /> : <RotateCcw size={16} />}
            </button>
          )}
          {active && (
            <button
              className="icon-button"
              title="暂停"
              aria-label="暂停传输"
              onClick={() => action('pause', file.id)}
            >
              <Pause size={16} />
            </button>
          )}
          {(done || !incoming) && (
            <button
              className="icon-button"
              title="在文件夹中显示"
              aria-label="在文件夹中显示"
              onClick={() => action('reveal', file.id)}
            >
              <FolderOpen size={16} />
            </button>
          )}
          {done && (
            <button
              className="icon-button save-action"
              title="另存为"
              aria-label="另存为"
              onClick={() => action('saveAs', file.id)}
            >
              <Save size={15} />
            </button>
          )}
          {incoming && !done && file.state !== 'cancelled' && (
            <button
              className="icon-button cancel-action"
              title="取消接收"
              aria-label="取消接收"
              onClick={() => action('cancel', file.id)}
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>
      {(active || (incoming && file.state === 'paused') || receiving) && (
        <div className="progress-track">
          <span style={{ width: (receiving ? receiptPercent : percent) + '%' }} />
        </div>
      )}
      {file.error && !active && <div className="file-error">{file.error}</div>}
    </div>
  )
}
export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  )
}
export const Loading = () => <LoaderCircle className="spin" size={16} />
export const Complete = () => <Check size={14} />
export const DownloadIcon = Download
