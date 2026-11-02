import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  Notification,
  protocol,
  shell,
  Tray,
  type IpcMainInvokeEvent
} from 'electron'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { IMAGE_TYPES, type DraftFile, type ProfileUpdate } from '../shared/types'
import { idSchema } from '../shared/validation'
import { LanNode } from './core/node'
import { mimeType } from './core/files'
import type { WireMessage } from '../shared/validation'
import { UpdateController } from './updater/controller'
import { prepareUpdate } from './updater/platform'
import type { UpdateTarget } from './updater/manifest'

const here = dirname(fileURLToPath(import.meta.url))
const rendererRoot = resolve(here, '../renderer')
if (process.env.NEARLINK_DATA_DIR) app.setPath('userData', resolve(process.env.NEARLINK_DATA_DIR))
app.setName('Nearlink')
if (
  process.env.NEARLINK_UPDATE_TESTING === '1' &&
  process.env.NEARLINK_DATA_DIR &&
  /^\d{2,5}$/.test(process.env.NEARLINK_UPDATE_TEST_DEBUG_PORT || '')
) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.NEARLINK_UPDATE_TEST_DEBUG_PORT)
}
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'nearlink',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
  },
  {
    scheme: 'nearlink-media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
  }
])
let window: BrowserWindow | null = null
let node: LanNode | undefined
let tray: Tray | undefined
let updater: UpdateController
let quitting = false
let stopped = false
let updateTimer: ReturnType<typeof setTimeout> | undefined
const drafts = new Map<string, string>()
const iconPath = app.isPackaged
  ? join(process.resourcesPath, 'icon.png')
  : resolve(here, '../../resources/icon.png')

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => showWindow())
  app.on('activate', () => showWindow())
  app.on('window-all-closed', () => {
    /* Keep LAN receiving alive in the tray. */
  })
  app.on('before-quit', (event) => {
    quitting = true
    if (!stopped && node) {
      event.preventDefault()
      void node.stop().finally(() => {
        stopped = true
        app.quit()
      })
    }
  })
  void app
    .whenReady()
    .then(start)
    .catch((error) => {
      dialog.showErrorBox('Nearlink 无法启动', error instanceof Error ? error.message : String(error))
      stopped = true
      app.quit()
    })
}

function showWindow(): void {
  if (!window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

function showUpdates(check = true): void {
  showWindow()
  window?.webContents.send('nearlink:open-updates')
  if (check) void updater.check()
}

function trusted(event: IpcMainInvokeEvent): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
    throw new Error('无效窗口。')
  const url = event.senderFrame.url
  const dev = process.env.ELECTRON_RENDERER_URL
  if (dev ? !url.startsWith(new URL(dev).origin + '/') : !url.startsWith('nearlink://app/'))
    throw new Error('无效页面。')
}
function handle(channel: string, fn: (...args: never[]) => unknown): void {
  ipcMain.handle(`nearlink:${channel}`, (event, ...args) => {
    trusted(event)
    return fn(...(args as never[]))
  })
}
async function registerFiles(paths: string[]): Promise<DraftFile[]> {
  if (paths.length > 32 || drafts.size + paths.length > 128) throw new Error('一次最多添加 32 个文件。')
  const result: DraftFile[] = []
  for (const path of paths) {
    const info = await stat(path)
    if (!info.isFile()) throw new Error('请将文件夹压缩后发送。')
    const token = randomUUID()
    drafts.set(token, path)
    result.push({ token, name: path.split(/[\\/]/).pop()!, size: info.size, mime: mimeType(path) })
  }
  return result
}

async function start(): Promise<void> {
  if (process.platform === 'win32') app.setAppUserModelId('io.nearlink.desktop')
  node = await LanNode.create({
    dataDir: app.getPath('userData'),
    discovery: process.env.NEARLINK_NO_DISCOVERY !== '1'
  })
  await node.start()
  const testing = process.env.NEARLINK_UPDATE_TESTING === '1' && Boolean(process.env.NEARLINK_DATA_DIR)
  if (testing && process.env.NEARLINK_UPDATE_TEST_FAIL_VERSION === app.getVersion()) {
    app.exit(1)
    return
  }
  let releaseBase: string | undefined
  if (testing && process.env.NEARLINK_UPDATE_TEST_FEED) {
    const url = new URL(process.env.NEARLINK_UPDATE_TEST_FEED)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/releases')
      throw new Error('无效的本地更新测试地址。')
    releaseBase = url.href.replace(/\/$/, '')
  }
  const target: UpdateTarget | null = !(app.isPackaged || testing)
    ? null
    : process.platform === 'darwin' && process.arch === 'arm64'
      ? 'mac-arm64'
      : process.platform === 'win32' && process.arch === 'x64'
        ? process.env.PORTABLE_EXECUTABLE_FILE
          ? 'win-x64-portable'
          : 'win-x64'
        : null
  updater = new UpdateController({
    currentVersion: app.getVersion(),
    target,
    directory: join(app.getPath('userData'), 'updates'),
    publicKey: await readFile(
      app.isPackaged
        ? join(process.resourcesPath, 'update-public-key.pem')
        : resolve(here, '../../resources/update-public-key.pem'),
      'utf8'
    ),
    fetch: (url, init) => net.fetch(url, init),
    releaseBase,
    prepare: (update) =>
      prepareUpdate(update, {
        executable: process.execPath,
        portableExecutable: process.env.PORTABLE_EXECUTABLE_FILE,
        pid: process.pid
      }),
    shutdown: async () => {
      await node!.stop()
      stopped = true
      quitting = true
    },
    quit: () => app.quit()
  })
  updater.on('change', (state) => {
    if (window && !window.isDestroyed()) window.webContents.send('nearlink:update-state', state)
  })
  await updater.restore()
  protocol.handle('nearlink', (request) => {
    const url = new URL(request.url)
    if (url.host !== 'app') return new Response('Not found', { status: 404 })
    const target = resolve(
      rendererRoot,
      '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
    )
    if (!target.startsWith(rendererRoot + sep)) return new Response('Forbidden', { status: 403 })
    return net.fetch(pathToFileURL(target).toString())
  })
  protocol.handle('nearlink-media', (request) => {
    const url = new URL(request.url)
    const id = url.pathname.slice(1)
    const file = node!.store.transfer(id)
    if (url.host !== 'file' || !file || !IMAGE_TYPES.has(file.mime) || file.size > 50 * 1024 * 1024)
      return new Response('Not found', { status: 404 })
    const path = file.direction === 'send' ? file.sourcePath : file.state === 'complete' ? file.localPath : ''
    return path ? net.fetch(pathToFileURL(path).toString()) : new Response('Pending', { status: 404 })
  })
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin'
        ? [
            {
              label: 'Nearlink',
              submenu: [
                { role: 'about' as const },
                { id: 'check-updates', label: '检查更新…', click: () => showUpdates() },
                { type: 'separator' as const },
                { role: 'hide' as const },
                { role: 'quit' as const }
              ]
            }
          ]
        : []),
      {
        label: '编辑',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' }
        ]
      },
      { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'togglefullscreen' }] },
      ...(process.platform === 'darwin'
        ? []
        : [
            {
              label: '帮助',
              submenu: [{ id: 'check-updates', label: '检查更新…', click: () => showUpdates() }]
            }
          ])
    ])
  )
  window = new BrowserWindow({
    title: 'Nearlink · 邻线',
    width: 1340,
    height: 900,
    minWidth: 920,
    minHeight: 640,
    backgroundColor: '#fafaf8',
    icon: iconPath,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 20, y: 20 },
    ...(process.platform === 'win32'
      ? { titleBarOverlay: { color: '#f4f4f0', symbolColor: '#565650', height: 44 } }
      : {}),
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  })
  const dev = process.env.ELECTRON_RENDERER_URL
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  window.webContents.session.setPermissionCheckHandler(() => false)
  window.webContents.session.webRequest.onHeadersReceived((details, callback) =>
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          dev
            ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: nearlink-media:; connect-src 'self' ws://localhost:* http://localhost:* http://127.0.0.1:* ws://127.0.0.1:*"
            : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: nearlink-media:; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"
        ]
      }
    })
  )
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      window?.hide()
    }
  })
  window.once('ready-to-show', () => window?.show())
  wireIPC()
  node.on('change', () => {
    if (updateTimer) return
    updateTimer = setTimeout(() => {
      updateTimer = undefined
      if (window && !window.isDestroyed()) window.webContents.send('nearlink:changed')
      const unread = node!.store.conversations().reduce((n, c) => n + c.unread, 0)
      if (process.platform === 'darwin') app.dock?.setBadge(unread ? String(unread) : '')
    }, 100)
  })
  node.on('message', (message: WireMessage) => {
    if (window?.isFocused() || !Notification.isSupported()) return
    const peer = node!.store.peer(message.senderId)
    const conversation = node!.store.conversation(message.conversationId)
    const notification = new Notification({
      title:
        conversation?.kind === 'group'
          ? `${conversation.title} · ${peer?.name || '设备'}`
          : peer?.name || '新消息',
      body: message.text.slice(0, 150) || `收到 ${message.attachments.length} 个文件`,
      icon: iconPath,
      silent: true
    })
    notification.on('click', () => {
      showWindow()
      window?.webContents.send('nearlink:open-conversation', message.conversationId)
    })
    notification.show()
  })
  tray = new Tray(
    nativeImage.createFromPath(iconPath).resize({
      width: process.platform === 'darwin' ? 18 : 32,
      height: process.platform === 'darwin' ? 18 : 32
    })
  )
  tray.setToolTip('Nearlink · 邻线')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开邻线', click: showWindow },
      { label: '检查更新…', click: () => showUpdates() },
      { type: 'separator' },
      { label: '退出邻线', click: () => app.quit() }
    ])
  )
  tray.on('click', showWindow)
  if (dev) await window.loadURL(dev)
  else await window.loadURL('nearlink://app/index.html')
  const jobArgument = process.argv.find((arg) => arg.startsWith('--nearlink-update-job='))
  if (jobArgument) await updater.markHealthy(jobArgument.split('=')[1], node.profile.id)
  if (process.argv.includes('--nearlink-update-failed')) {
    updater.reportError(new Error('更新未完成，已重新打开应用。请重试或查看更新日志。'))
    setTimeout(() => showUpdates(false), 500)
  }
}

function wireIPC(): void {
  handle('update-state', () => updater.snapshot())
  handle('update-check', () => updater.check())
  handle('update-download', () => updater.download())
  handle('update-cancel', () => updater.cancel())
  handle('update-install', () => updater.install())
  handle('appearance', (value: string) => {
    const theme = z.enum(['light', 'dark']).parse(value)
    nativeTheme.themeSource = theme
    window?.setBackgroundColor(theme === 'dark' ? '#20221e' : '#fafaf8')
    if (process.platform === 'win32')
      window?.setTitleBarOverlay({
        color: theme === 'dark' ? '#252720' : '#f4f4f0',
        symbolColor: theme === 'dark' ? '#dddcd3' : '#565650'
      })
  })
  handle('snapshot', () => ({ ...node!.snapshot(), version: app.getVersion() }))
  handle('messages', (id: string, before?: number) =>
    node!.store.messages(
      idSchema.parse(id),
      before === undefined ? undefined : z.number().int().positive().parse(before)
    )
  )
  handle('direct', (id: string) => node!.direct(idSchema.parse(id)))
  handle('group', (title: string, ids: string[]) =>
    node!.createGroup(title, z.array(idSchema).max(63).parse(ids))
  )
  handle('send', async (id: string, text: string, tokens: string[]) => {
    const approved = z
      .array(z.uuid())
      .max(32)
      .parse(tokens)
      .map((token) => {
        const path = drafts.get(token)
        if (!path) throw new Error('附件已失效，请重新选择。')
        return path
      })
    await node!.send(idSchema.parse(id), z.string().max(64_000).parse(text), approved)
    for (const token of tokens) drafts.delete(token)
  })
  handle('read', (id: string) => {
    if (node!.store.read(idSchema.parse(id))) node!.changed()
  })
  handle('profile', (update: ProfileUpdate) => node!.updateProfile(update))
  handle('avatar', async () => {
    const result = await dialog.showOpenDialog(window!, {
      title: '选择头像',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    const info = await stat(result.filePaths[0])
    if (info.size > 20 * 1024 * 1024) throw new Error('头像图片请控制在 20 MB 内。')
    const image = nativeImage
      .createFromPath(result.filePaths[0])
      .resize({ width: 128, height: 128, quality: 'best' })
    if (image.isEmpty()) throw new Error('无法读取这张图片。')
    return image.toDataURL()
  })
  handle('choose-files', async () => {
    const result = await dialog.showOpenDialog(window!, {
      title: '发送文件',
      properties: ['openFile', 'multiSelections']
    })
    return result.canceled ? [] : registerFiles(result.filePaths)
  })
  handle('drop-files', (paths: string[]) =>
    registerFiles(z.array(z.string().min(1).max(32_000)).max(32).parse(paths))
  )
  handle('paste-image', async () => {
    const items = await clipboard.read()
    const item = items.find((value) => value.types.includes('image/png'))
    if (!item) return null
    const blob = await item.getType('image/png')
    if (blob.size > 30 * 1024 * 1024) throw new Error('粘贴的图片过大，请通过文件发送。')
    const png = Buffer.from(await blob.arrayBuffer())
    if (png.length > 30 * 1024 * 1024) throw new Error('粘贴的图片过大，请通过文件发送。')
    const directory = join(app.getPath('userData'), 'clipboard')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, `图片-${Date.now()}-${randomUUID().slice(0, 6)}.png`)
    await writeFile(path, png, { mode: 0o600 })
    return (await registerFiles([path]))[0]
  })
  handle('connect', (address: string) => node!.connect(z.string().max(100).parse(address)))
  handle('discard-files', (tokens: string[]) => {
    for (const token of z.array(z.uuid()).max(128).parse(tokens)) drafts.delete(token)
  })
  handle('copy', (text: string) => clipboard.writeText(z.string().max(100_000).parse(text)))
  // Return immediately for downloads; progress and completion arrive through snapshots.
  handle('receive', (id: string) => {
    void node!.receiveFile(z.uuid().parse(id)).catch((error) => {
      node!.store.updateTransfer(id, { state: 'failed', error: error.message })
      node!.changed()
    })
  })
  handle('pause', (id: string) => node!.pauseFile(z.uuid().parse(id)))
  handle('cancel', (id: string) => node!.cancelFile(z.uuid().parse(id)))
  handle('reveal', (id: string) => {
    const file = node!.store.transfer(z.uuid().parse(id))
    const path =
      file?.direction === 'send' ? file.sourcePath : file?.state === 'complete' ? file.localPath : ''
    if (!path) throw new Error('文件尚未接收完成。')
    shell.showItemInFolder(path)
  })
  handle('save-as', async (id: string) => {
    const file = node!.store.transfer(z.uuid().parse(id))
    const path =
      file?.direction === 'send' ? file.sourcePath : file?.state === 'complete' ? file.localPath : ''
    if (!file || !path) throw new Error('文件尚未接收完成。')
    const result = await dialog.showSaveDialog(window!, { title: '另存文件', defaultPath: file.name })
    if (!result.canceled && result.filePath && resolve(result.filePath) !== resolve(path))
      await copyFile(path, result.filePath)
  })
  handle('open-data', () => {
    void shell.openPath(app.getPath('userData'))
  })
  handle('search', (query: string) => node!.store.search(z.string().max(200).parse(query)))
}
