import { chromium, expect, type Browser } from '@playwright/test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createReadStream, closeSync, openSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer, get } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createUpdateManifest, writeSignedManifest } from './update-manifest'
import { UPDATE_FILES } from '../src/main/updater/manifest'

if (process.platform !== 'darwin' && process.platform !== 'win32')
  throw new Error('Run on native macOS or Windows.')
if (process.platform === 'win32' && !process.env.CI)
  throw new Error('Windows installer integration test is restricted to disposable CI runners.')

const mac = process.platform === 'darwin'
const { version } = JSON.parse(await readFile('package.json', 'utf8')) as { version: string }
const nextVersion = version.replace(/\d+$/, (value) => String(Number(value) + 1))
const key =
  process.env.NEARLINK_UPDATE_PRIVATE_KEY ||
  (await readFile('.release-secrets/update-private-key.pem', 'utf8'))
await mkdir('.smoke', { recursive: true })
const directory = await mkdtemp(resolve('.smoke/update-'))
const fixture = process.env.NEARLINK_UPDATE_FIXTURE
  ? resolve(process.env.NEARLINK_UPDATE_FIXTURE)
  : join(directory, 'fixture')
const assets = join(directory, 'assets')
await mkdir(assets)
// Build a real future-version package from the same source; it is never published.
if (!process.env.NEARLINK_UPDATE_FIXTURE)
  execFileSync(
    process.execPath,
    [
      'node_modules/electron-builder/out/cli/cli.js',
      ...(mac ? ['--mac', 'zip', '--arm64'] : ['--win', 'nsis', 'portable', '--x64']),
      '--publish',
      'never',
      '-c.compression=store',
      `-c.extraMetadata.version=${nextVersion}`,
      `-c.directories.output=${fixture}`
    ],
    { stdio: 'inherit', env: { ...process.env, NEARLINK_UPDATE_PRIVATE_KEY: undefined } }
  )
for (const [target, filename] of Object.entries(UPDATE_FILES)) {
  if (target.startsWith(mac ? 'mac' : 'win')) await copyFile(join(fixture, filename), join(assets, filename))
  else await writeFile(join(assets, filename), 'Unused platform fixture')
}

const server = createServer((request, response) => {
  const name = request.url?.split('/').pop() || ''
  const allowed = new Set([...Object.values(UPDATE_FILES), 'update.json', 'update.json.sig'])
  if (!allowed.has(name)) return void response.writeHead(404).end()
  const stream = createReadStream(join(assets, name))
  stream.on('error', () => response.destroy())
  stream.pipe(response)
})
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/releases`
await writeSignedManifest(assets, await createUpdateManifest(assets, nextVersion, base), key)
const reports: Record<string, unknown>[] = []

async function unusedPort(): Promise<number> {
  const socket = createNetServer()
  await new Promise<void>((done) => socket.listen(0, '127.0.0.1', done))
  const port = (socket.address() as { port: number }).port
  await new Promise<void>((done) => socket.close(() => done()))
  return port
}
async function connect(port: number): Promise<Browser> {
  // Query loopback directly. Playwright's HTTP endpoint discovery may otherwise
  // use a machine proxy even though the application is running locally.
  const endpoint = await new Promise<string>((resolve, reject) => {
    const request = get(`http://127.0.0.1:${port}/json/version`, (response) => {
      let text = ''
      response.on('data', (data) => {
        text += String(data)
      })
      response.on('end', () => {
        try {
          resolve((JSON.parse(text) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl)
        } catch (error) {
          reject(error)
        }
      })
    })
    request.setTimeout(1500, () => request.destroy(new Error('Waiting for local debugger.')))
    request.on('error', reject)
  })
  return chromium.connectOverCDP(endpoint, { timeout: 2000 })
}
async function waitFor<T>(fn: () => Promise<T>, timeout = 90_000): Promise<T> {
  const deadline = Date.now() + timeout
  let last: unknown
  while (Date.now() < deadline) {
    try {
      return await fn()
    } catch (error) {
      last = error
      await delay(150)
    }
  }
  throw last || new Error('Update integration test timed out.')
}

async function runCase(mode: 'mac' | 'nsis' | 'portable', rollback = false): Promise<void> {
  console.log(`Starting native update case: ${mode}${rollback ? ' rollback' : ''}`)
  const run = join(directory, `${mode}${rollback ? '-rollback' : ''} path with spaces's`)
  const data = join(run, 'desktop')
  await mkdir(run, { recursive: true })
  let executable: string
  if (mode === 'mac') {
    const app = join(run, 'Nearlink.app')
    execFileSync('/usr/bin/ditto', [resolve('release/mac-arm64/Nearlink.app'), app])
    executable = join(app, 'Contents/MacOS/Nearlink')
  } else if (mode === 'nsis') {
    const installed = join(run, 'installed')
    const installation = spawnSync(resolve('release/Nearlink-win-x64-setup.exe'), ['/S', `/D=${installed}`], {
      windowsVerbatimArguments: true,
      stdio: 'inherit',
      timeout: 120_000
    })
    if (installation.error) throw installation.error
    assert.equal(installation.status, 0)
    executable = join(installed, 'Nearlink.exe')
  } else {
    executable = join(run, 'Nearlink.exe')
    await copyFile(resolve('release/Nearlink-win-x64-portable.exe'), executable)
  }
  const port = await unusedPort()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NEARLINK_DATA_DIR: data,
    NEARLINK_NO_DISCOVERY: '1',
    NEARLINK_UPDATE_TESTING: '1',
    NEARLINK_UPDATE_TEST_FEED: base,
    NEARLINK_UPDATE_TEST_DEBUG_PORT: String(port)
  }
  if (rollback) env.NEARLINK_UPDATE_TEST_FAIL_VERSION = nextVersion
  delete env.NEARLINK_UPDATE_PRIVATE_KEY
  delete env.ELECTRON_RUN_AS_NODE
  const fd = openSync(join(run, 'launch.log'), 'a')
  const child = spawn(executable, [], { env, stdio: ['ignore', fd, fd] })
  closeSync(fd)
  let browser: Browser | undefined
  let pid = child.pid
  let jobDirectory = ''
  try {
    browser = await waitFor(() => connect(port))
    let page = await waitFor(async () => {
      const page = browser!.contexts()[0]?.pages()[0]
      if (!page) throw new Error('Waiting for application window.')
      return page
    })
    await page.getByRole('textbox', { name: '消息', exact: true }).waitFor()
    const before = await page.evaluate(() => window.nearlink.snapshot())
    assert.equal(before.version, version)
    const note = `update persistence ${mode} ${rollback}`
    await page.getByRole('textbox', { name: '消息', exact: true }).fill(note)
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(page.locator('.message-text')).toContainText(note)
    await page.getByRole('button', { name: '检查更新', exact: true }).click()
    await expect(page.getByRole('button', { name: '下载更新', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '下载更新', exact: true }).click()
    await expect(page.getByRole('button', { name: '重启并更新', exact: true })).toBeVisible({
      timeout: 60_000
    })
    await page.screenshot({ path: join(run, 'update-ready.png') })
    const pending = JSON.parse(await readFile(join(data, 'updates/pending.json'), 'utf8')) as { id: string }
    jobDirectory = join(data, 'updates', pending.id)
    console.log(
      `PASS: ${mode}${rollback ? ' rollback' : ''} downloaded and verified real v${nextVersion} package`
    )
    await page.getByRole('button', { name: '重启并更新', exact: true }).click()
    const result = await waitFor(async (): Promise<{ status: string; pid?: number; error?: string }> => {
      if (!page.isClosed()) {
        const state = await page.evaluate(() => window.nearlink.updateState()).catch(() => null)
        if (state?.status === 'error') return { status: 'controller-error', error: state.error }
      }
      return JSON.parse(await readFile(join(jobDirectory, 'result.json'), 'utf8')) as {
        status: string
        pid?: number
      }
    }, 150_000)
    assert.equal(result.status, rollback ? 'failed' : 'complete')
    if (result.pid) pid = result.pid
    else {
      const health = JSON.parse(await readFile(join(jobDirectory, 'healthy.json'), 'utf8')) as {
        pid: number
        version: string
        profileId: string
      }
      pid = health.pid
      assert.equal(health.version, nextVersion)
      assert.equal(health.profileId, before.profile.id)
    }
    await browser.close()
    browser = await waitFor(() => connect(port))
    page = await waitFor(async () => {
      const page = browser!.contexts()[0]?.pages()[0]
      if (!page) throw new Error('Waiting for restarted application window.')
      return page
    })
    await page.getByRole('textbox', { name: '消息', exact: true }).waitFor()
    const after = await page.evaluate(() => window.nearlink.snapshot())
    assert.equal(after.version, rollback ? version : nextVersion)
    assert.equal(after.profile.id, before.profile.id)
    const notes = after.conversations.find((conversation) => conversation.kind === 'self')!
    const messages = await page.evaluate((id) => window.nearlink.messages(id), notes.id)
    assert(
      messages.some((message) => message.text === note),
      'SQLite history survives update/restart'
    )
    reports.push({
      mode,
      rollback,
      from: version,
      to: after.version,
      identityPreserved: true,
      historyPreserved: true
    })
    console.log(
      `PASS: ${mode}${rollback ? ' restored old version after failed startup' : ' replaced and restarted to new version'}; identity and SQLite history preserved`
    )
  } catch (error) {
    const debug: Record<string, unknown> = { error: String(error), mode, rollback, originalPid: child.pid }
    if (browser?.isConnected()) {
      const page = browser.contexts()[0]?.pages()[0]
      if (page && !page.isClosed()) {
        debug.state = await page.evaluate(() => window.nearlink.updateState()).catch(() => null)
        await page.screenshot({ path: join(run, 'update-failed.png') }).catch(() => {})
      }
    }
    await writeFile(join(run, 'result.json'), JSON.stringify(debug, null, 2))
    console.log(JSON.stringify(debug))
    throw error
  } finally {
    await browser?.close().catch(() => {})
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {}
    }
    if (child.pid && child.pid !== pid) {
      try {
        process.kill(child.pid, 'SIGTERM')
      } catch {}
    }
    await delay(1200)
    if (mode === 'nsis') {
      execFileSync(join(run, 'installed/Uninstall Nearlink.exe'), ['/S', '--updated'], {
        stdio: 'ignore',
        timeout: 120_000
      })
    }
    if (jobDirectory) console.log(`Update evidence: ${jobDirectory}`)
  }
}

try {
  if (mac) {
    await runCase('mac')
    await runCase('mac', true)
  } else {
    // Run before installer cleanup, which can terminate matching test copies.
    await runCase('portable')
    await runCase('nsis')
  }
  await writeFile(join(directory, 'result.json'), JSON.stringify({ success: true, reports }, null, 2))
  console.log(`All native update checks passed: ${directory}`)
} finally {
  server.closeAllConnections()
  await new Promise<void>((done) => server.close(() => done()))
}
