import { _electron as electron, expect } from '@playwright/test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
import { LanNode } from '../src/main/core/node'
import sharp from 'sharp'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
await mkdir('.smoke', { recursive: true })
const directory = await mkdtemp(resolve('.smoke/run-'))
const packaged = process.env.NEARLINK_EXECUTABLE
const env: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined)
)
delete env.ELECTRON_RUN_AS_NODE
env.NEARLINK_DATA_DIR = join(directory, 'desktop')
env.NEARLINK_NO_DISCOVERY = '1'
const application = await electron.launch({
  executablePath: packaged || require('electron'),
  args: packaged ? [] : ['.'],
  cwd: process.cwd(),
  env,
  timeout: 30_000
})
const errors: string[] = []
application.process().stderr?.on('data', (data) => {
  void writeFile(join(directory, 'electron.log'), String(data), { flag: 'a' })
})
const clients: LanNode[] = []
try {
  const page = await application.firstWindow({ timeout: 20_000 })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.getByRole('textbox', { name: '消息', exact: true }).waitFor()
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(1440, 980)
  })
  assert.equal(
    await page.evaluate(() => typeof (window as unknown as { require: unknown }).require),
    'undefined'
  )
  console.log('PASS: sandboxed Electron window and production custom protocol')

  await page.getByRole('button', { name: '个人资料', exact: true }).click()
  await page.getByLabel('显示名称', { exact: true }).fill('小林')
  await page.getByRole('textbox', { name: /设备名称/ }).fill('随行 MacBook')
  await page.getByRole('button', { name: '保存资料', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  if (await page.getByRole('button', { name: '关闭提示', exact: true }).isVisible())
    await page.getByRole('button', { name: '关闭提示', exact: true }).click()
  assert.equal((await page.evaluate(() => window.nearlink.snapshot())).profile.name, '小林')
  await page
    .getByRole('textbox', { name: '消息', exact: true })
    .fill('一条只保存在本机的记录。<script>window.__xss=1</script>')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.locator('.message-text')).toContainText('只保存在本机')
  assert.equal(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss), undefined)
  console.log('PASS: profile editing, local note and literal untrusted text rendering')

  const desktop = await page.evaluate(() => window.nearlink.snapshot())
  for (const [key, name, deviceName, color] of [
    ['windows', '书房工作站', '书房工作站', '#6c8d78'],
    ['mini', '灵感收集站', 'Mac mini', '#6f86ad']
  ]) {
    const client = await LanNode.create({
      dataDir: join(directory, key),
      name,
      port: 0,
      discovery: false,
      autoImages: false
    })
    clients.push(client)
    await client.start()
    await client.updateProfile({ ...client.profile, name, deviceName, color, status: '同一片网络，随时相连' })
    await client.connect(`127.0.0.1:${desktop.port}`)
  }
  await clients[0].connect(`127.0.0.1:${clients[1].port}`)
  await expect.poll(async () => (await page.evaluate(() => window.nearlink.snapshot())).peers.length).toBe(2)
  await page.getByRole('button', { name: '创建群聊', exact: true }).click()
  await page.getByLabel('群聊名称', { exact: true }).fill('我的设备')
  await page.locator('.group-choice').filter({ hasText: '书房工作站' }).getByRole('checkbox').check()
  await page.locator('.group-choice').filter({ hasText: 'Mac mini' }).getByRole('checkbox').check()
  await page.getByRole('dialog').getByRole('button', { name: '创建群聊', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const group = (await page.evaluate(() => window.nearlink.snapshot())).conversations.find(
    (c) => c.kind === 'group'
  )!
  await expect.poll(() => clients.every((c) => Boolean(c.store.conversation(group.id)))).toBe(true)
  await clients[0].send(group.id, '文件整理好了，Mac 上直接接收就好。👋')
  await expect(page.locator('.message-text').filter({ hasText: '文件整理好了' })).toBeVisible()
  console.log('PASS: real group creation and TLS fan-out across three independent profiles')

  const image = join(directory, '午后的灵感.png')
  await sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="420" viewBox="0 0 960 420"><rect width="960" height="420" fill="#e8e8dd"/><circle cx="731" cy="105" r="45" fill="#c8a17c"/><path d="M0 292Q140 156 310 238T680 235T960 257V420H0Z" fill="#b6bf9e"/><path d="M0 349Q170 217 390 309T750 286T960 342V420H0Z" fill="#7f9475"/><path d="M0 400Q200 305 407 371T760 346T960 370V420H0Z" fill="#4f6956"/><path d="M365 420Q410 360 488 334Q550 312 529 287Q507 267 557 247" fill="none" stroke="#e0d6ba" stroke-width="11"/><text x="38" y="47" font-family="sans-serif" font-size="13" letter-spacing="4" fill="#68705c">A LITTLE CLOSER.</text></svg>'
    )
  )
    .png()
    .toFile(image)
  await clients[1].send(group.id, '今天的灵感，先放在这里。', [image])
  await expect(page.locator('.image-preview img')).toBeVisible({ timeout: 15_000 })
  await page.locator('.image-preview').click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  console.log('PASS: image auto-receive, hash verification and full-size preview')

  const source = join(directory, '项目资料.bin')
  await writeFile(source, Buffer.alloc(8 * 1024 * 1024, 0x34))
  await clients[0].send(group.id, '还有这份项目资料，随时取用。', [source])
  await page.getByRole('button', { name: '接收文件', exact: true }).click()
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.nearlink.snapshot())).transfers.find(
          (f) => f.name === '项目资料.bin'
        )?.state,
      { timeout: 15_000 }
    )
    .toBe('complete')
  await page
    .getByRole('textbox', { name: '消息', exact: true })
    .fill('收到，图片和文件都到了。设备之间，直接相连。')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.locator('.message-text').filter({ hasText: '收到，图片和文件都到了' })).toBeVisible()
  console.log('PASS: file receive controls, verified completion and outgoing text')

  await mkdir('docs/assets', { recursive: true })
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: join(directory, 'chat.png') })
  if (!packaged) await page.screenshot({ path: 'docs/assets/chat.png' })
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await page.getByPlaceholder('输入关键词…').fill('项目资料')
  await expect(page.locator('.search-result')).toHaveCount(1)
  await page.locator('.search-result').click()
  await expect(page.locator('.message-row.highlight')).toBeVisible()
  await page.getByRole('button', { name: '回到最新消息', exact: true }).click()
  console.log('PASS: SQLite global search and jumping to matching history')

  await page.getByRole('button', { name: '设备', exact: true }).click()
  await expect(page.locator('.device-card')).toHaveCount(2)
  if (!packaged) await page.screenshot({ path: 'docs/assets/devices.png' })
  await page.getByRole('button', { name: '传输', exact: true }).click()
  await expect(page.locator('.transfer-list-item')).toHaveCount(2)
  await page.getByRole('button', { name: '会话', exact: true }).click()
  await page.getByRole('button', { name: '切换外观', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  if (!packaged) await page.screenshot({ path: 'docs/assets/dark.png' })
  await page.getByRole('button', { name: '切换外观', exact: true }).click()
  console.log('PASS: device inventory, transfer history and dark appearance')

  const note = join(directory, '附件测试.md')
  await writeFile(note, '# Nearlink\nA real file selected through the native dialog adapter.\n')
  await application.evaluate(({ dialog }, path) => {
    const original = dialog.showOpenDialog
    dialog.showOpenDialog = async () => {
      dialog.showOpenDialog = original
      return { canceled: false, filePaths: [path] }
    }
  }, note)
  await page.getByRole('button', { name: '添加文件', exact: true }).click()
  await expect(page.locator('.draft-file')).toContainText('附件测试.md')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.nearlink.snapshot())).transfers.some(
        (f) => f.name === '附件测试.md' && f.direction === 'send'
      )
    )
    .toBe(true)
  console.log('PASS: native file selection, capability tokens and file send UI')

  // Keep the user's previous clipboard in process memory and restore it immediately.
  await application.evaluate(
    async ({ clipboard, ClipboardItem }, png) => {
      const previous = await Promise.all(
        (await clipboard.read())
          .filter((item) => item.types.length > 0)
          .map(
            async (item) =>
              new ClipboardItem(
                Object.fromEntries(
                  await Promise.all(item.types.map(async (type) => [type, await item.getType(type)]))
                )
              )
          )
      )
      ;(globalThis as unknown as { restoreClipboard: () => Promise<void> }).restoreClipboard = () =>
        previous.length ? clipboard.write(previous) : Promise.resolve(clipboard.clear())
      await clipboard.write([
        new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })
      ])
    },
    Array.from(await readFile(image))
  )
  await page.getByRole('textbox', { name: '消息', exact: true }).focus()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V')
  await expect(page.locator('.draft-file')).toHaveCount(1)
  await expect(page.locator('.draft-file')).toContainText('.png')
  await page.getByRole('button', { name: '移除附件', exact: true }).click()
  await application.evaluate(async () => {
    const scope = globalThis as unknown as { restoreClipboard?: () => Promise<void> }
    await scope.restoreClipboard?.()
    delete scope.restoreClipboard
  })
  console.log('PASS: native clipboard image paste; original clipboard restored')

  assert.deepEqual(errors, [], 'No renderer exceptions')
  await writeFile(
    join(directory, 'result.json'),
    JSON.stringify(
      {
        packaged: Boolean(packaged),
        success: true,
        rendererErrors: errors,
        screenshots: ['chat.png'],
        profile: desktop.profile.id
      },
      null,
      2
    )
  )
  console.log(`All Electron smoke checks passed. Evidence: ${directory}`)
} finally {
  await application
    .evaluate(async () => {
      const scope = globalThis as unknown as { restoreClipboard?: () => Promise<void> }
      await scope.restoreClipboard?.()
      delete scope.restoreClipboard
    })
    .catch(() => {})
  await application.close()
  await Promise.allSettled(clients.map((c) => c.stop()))
}
