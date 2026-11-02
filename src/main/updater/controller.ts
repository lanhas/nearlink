import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { UpdateState } from '../../shared/types'
import {
  newerVersion,
  RELEASE_BASE,
  UPDATE_FILES,
  verifiedManifest,
  type UpdateArtifact,
  type UpdateManifest,
  type UpdateTarget
} from './manifest'

export interface DownloadedUpdate {
  id: string
  directory: string
  path: string
  version: string
  target: UpdateTarget
  artifact: UpdateArtifact
}
interface Options {
  currentVersion: string
  target: UpdateTarget | null
  publicKey: string
  directory: string
  fetch: (url: string, init?: RequestInit) => Promise<Response>
  releaseBase?: string
  prepare: (update: DownloadedUpdate) => Promise<() => Promise<void>>
  shutdown: () => Promise<void>
  quit: () => void
}

export async function verifyDownload(path: string, expected: UpdateArtifact): Promise<void> {
  if ((await stat(path)).size !== expected.size) throw new Error('更新包大小不匹配，请重新下载。')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  if (hash.digest('hex') !== expected.sha256) throw new Error('更新包校验失败，请重新下载。')
}

export class UpdateController extends EventEmitter {
  private state: UpdateState
  private manifest?: UpdateManifest
  private signedBytes?: Uint8Array
  private signature?: Uint8Array
  private downloaded?: DownloadedUpdate
  private abort?: AbortController
  private operation?: Promise<void>
  constructor(private readonly options: Options) {
    super()
    this.state = {
      status: 'idle',
      currentVersion: options.currentVersion,
      progress: 0,
      downloaded: false
    }
  }
  snapshot(): UpdateState {
    return { ...this.state }
  }
  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch }
    this.emit('change', this.snapshot())
  }
  reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.set({
      status: 'error',
      error: message === 'fetch failed' ? '无法连接更新服务器，请检查网络后重试。' : message
    })
  }
  async restore(): Promise<void> {
    const pending = join(this.options.directory, 'pending.json')
    try {
      const { id } = JSON.parse(await readFile(pending, 'utf8')) as { id: string }
      if (!/^[\da-f-]{36}$/i.test(id) || !this.options.target) throw new Error('Invalid cache.')
      const directory = join(this.options.directory, id)
      const bytes = await readFile(join(directory, 'update.json'))
      const signature = await readFile(join(directory, 'update.json.sig'))
      const manifest = verifiedManifest(
        bytes,
        signature,
        this.options.publicKey,
        this.options.releaseBase || RELEASE_BASE
      )
      if (!newerVersion(manifest.version, this.options.currentVersion)) {
        await rm(pending, { force: true })
        return
      }
      const target = this.options.target
      const artifact = manifest.artifacts[target]
      const path = join(directory, UPDATE_FILES[target])
      await verifyDownload(path, artifact)
      this.manifest = manifest
      this.signedBytes = bytes
      this.signature = signature
      this.downloaded = { id, directory, path, version: manifest.version, target, artifact }
      this.set({ status: 'ready', latestVersion: manifest.version, progress: 100, downloaded: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        await rm(pending, { force: true })
        this.reportError(new Error('更新缓存已失效，请重新检查更新。'))
      }
    }
  }
  private run(work: () => Promise<void>): Promise<void> {
    if (this.operation) return this.operation
    this.operation = work()
      .catch((error) => this.reportError(error))
      .finally(() => {
        this.operation = undefined
      })
    return this.operation
  }
  check(): Promise<void> {
    return this.run(async () => {
      if (!this.options.target) throw new Error('请在已安装的 macOS M 系列或 Windows x64 版本中检查更新。')
      this.manifest = undefined
      this.set({ status: 'checking', error: undefined, latestVersion: undefined, progress: 0 })
      const base = this.options.releaseBase || RELEASE_BASE
      const get = async (name: string, limit: number): Promise<Uint8Array> => {
        const response = await this.options.fetch(`${base}/latest/download/${name}`, {
          signal: AbortSignal.timeout(30_000),
          cache: 'no-store'
        })
        if (!response.ok) throw new Error(`无法获取更新信息（HTTP ${response.status}），请稍后重试。`)
        if (!response.body) throw new Error('更新服务器返回了空内容。')
        const reader = response.body.getReader()
        let size = 0
        const chunks: Uint8Array[] = []
        try {
          while (true) {
            const part = await reader.read()
            if (part.done) break
            size += part.value.length
            if (size > limit) throw new Error('更新信息超过允许大小。')
            chunks.push(part.value)
          }
        } finally {
          await reader.cancel().catch(() => {})
        }
        return Buffer.concat(chunks)
      }
      const [bytes, signature] = await Promise.all([
        get('update.json', 64 * 1024),
        get('update.json.sig', 64)
      ])
      const manifest = verifiedManifest(bytes, signature, this.options.publicKey, base)
      const cached = this.downloaded
      const artifact = manifest.artifacts[this.options.target]
      if (
        cached &&
        (cached.version !== manifest.version ||
          cached.artifact.sha256 !== artifact.sha256 ||
          cached.artifact.size !== artifact.size)
      ) {
        this.downloaded = undefined
        await rm(join(this.options.directory, 'pending.json'), { force: true })
        this.set({ downloaded: false, progress: 0 })
      }
      if (!newerVersion(manifest.version, this.options.currentVersion)) {
        this.set({ status: 'latest', latestVersion: this.options.currentVersion })
        return
      }
      this.manifest = manifest
      this.signedBytes = bytes
      this.signature = signature
      this.set({ status: this.downloaded ? 'ready' : 'available', latestVersion: manifest.version })
    })
  }
  download(): Promise<void> {
    return this.run(async () => {
      if (this.downloaded) return this.set({ status: 'ready', error: undefined })
      if (!this.manifest || !this.options.target) throw new Error('请先检查更新。')
      const manifest = this.manifest
      const target = this.options.target
      const artifact = manifest.artifacts[target]
      const id = randomUUID()
      const directory = join(this.options.directory, id)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const path = join(directory, UPDATE_FILES[target])
      await writeFile(join(directory, 'update.json'), this.signedBytes!, { mode: 0o600 })
      await writeFile(join(directory, 'update.json.sig'), this.signature!, { mode: 0o600 })
      const partial = path + '.part'
      const abort = new AbortController()
      this.abort = abort
      this.set({ status: 'downloading', progress: 0, error: undefined })
      let timeout: ReturnType<typeof setTimeout>
      const armTimeout = (): void => {
        clearTimeout(timeout)
        timeout = setTimeout(() => abort.abort(new Error('更新下载超时，请重试。')), 30_000)
      }
      armTimeout()
      try {
        const response = await this.options.fetch(artifact.url, { signal: abort.signal })
        if (!response.ok || !response.body) throw new Error(`更新下载失败（HTTP ${response.status}）。`)
        const hash = createHash('sha256')
        const reader = response.body.getReader()
        let size = 0
        let lastProgress = 0
        const self = this
        await pipeline(
          Readable.from(
            (async function* () {
              try {
                while (true) {
                  const chunk = await reader.read()
                  if (chunk.done) break
                  armTimeout()
                  size += chunk.value.length
                  if (size > artifact.size) throw new Error('更新包超过预期大小，已停止下载。')
                  hash.update(chunk.value)
                  if (Date.now() - lastProgress > 100) {
                    self.set({ progress: Math.min(99, Math.floor((size / artifact.size) * 100)) })
                    lastProgress = Date.now()
                  }
                  yield chunk.value
                }
              } finally {
                await reader.cancel().catch(() => {})
              }
            })()
          ),
          createWriteStream(partial, { flags: 'wx', mode: 0o600 })
        )
        if (size !== artifact.size || hash.digest('hex') !== artifact.sha256)
          throw new Error('更新包校验失败，请重新下载。')
        await rename(partial, path)
        await writeFile(join(this.options.directory, 'pending.json'), JSON.stringify({ id }), { mode: 0o600 })
        this.downloaded = { id, directory, path, version: manifest.version, artifact, target }
        this.set({ status: 'ready', progress: 100, downloaded: true })
      } catch (error) {
        await rm(directory, { recursive: true, force: true })
        if (abort.signal.aborted && abort.signal.reason === 'cancelled') {
          this.set({ status: 'available', progress: 0, error: undefined })
          return
        }
        throw abort.signal.aborted ? abort.signal.reason : error
      } finally {
        clearTimeout(timeout!)
        this.abort = undefined
      }
    })
  }
  cancel(): void {
    this.abort?.abort('cancelled')
  }
  install(): Promise<void> {
    return this.run(async () => {
      if (!this.downloaded) throw new Error('请先下载更新。')
      this.set({ status: 'installing', error: undefined })
      try {
        await verifyDownload(this.downloaded.path, this.downloaded.artifact)
      } catch (error) {
        this.downloaded = undefined
        await rm(join(this.options.directory, 'pending.json'), { force: true })
        this.set({ downloaded: false, progress: 0 })
        throw error
      }
      const launch = await this.options.prepare(this.downloaded)
      await launch()
      await this.options.shutdown()
      this.options.quit()
    })
  }
  async markHealthy(id: string, profileId: string): Promise<void> {
    if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id)) return
    const directory = join(this.options.directory, id)
    try {
      const job = JSON.parse(await readFile(join(directory, 'job.json'), 'utf8')) as { version: string }
      if (job.version !== this.options.currentVersion) return
      await writeFile(
        join(directory, 'healthy.json'),
        JSON.stringify({ version: this.options.currentVersion, profileId, pid: process.pid }),
        { mode: 0o600 }
      )
    } catch {
      // A stale or unrelated launch argument must not affect startup.
    }
  }
}
