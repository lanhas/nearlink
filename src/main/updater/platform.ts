import { spawn, execFile } from 'node:child_process'
import { constants, closeSync, openSync } from 'node:fs'
import { access, copyFile, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { type DownloadedUpdate, verifyDownload } from './controller'
import { macHelper, windowsHelper } from './helpers'

const execute = promisify(execFile)

interface PlatformOptions {
  executable: string
  portableExecutable?: string
  pid: number
}
export async function prepareUpdate(
  update: DownloadedUpdate,
  options: PlatformOptions
): Promise<() => Promise<void>> {
  const executable = await realpath(options.executable)
  const job = {
    id: update.id,
    directory: update.directory,
    package: update.path,
    version: update.version,
    pid: options.pid,
    mode: update.target === 'mac-arm64' ? 'mac' : update.target === 'win-x64' ? 'nsis' : 'portable',
    target: executable,
    candidate: '',
    backup: '',
    stage: ''
  }
  const jobFile = join(update.directory, 'job.json')
  await mkdir(update.directory, { recursive: true, mode: 0o700 })
  await rm(join(update.directory, 'healthy.json'), { force: true })
  await rm(join(update.directory, 'helper-ready'), { force: true })
  try {
    if (update.target === 'mac-arm64') {
      job.target = dirname(dirname(dirname(executable)))
      if (!job.target.endsWith('.app')) throw new Error('请使用已安装的 Nearlink 应用检查更新。')
      const parent = dirname(job.target)
      try {
        await access(parent, constants.W_OK)
        job.stage = await mkdtemp(join(parent, '.Nearlink-update-'))
      } catch {
        throw new Error('应用目录不可写。请将 Nearlink 移到可写的应用程序目录后重试。')
      }
      job.candidate = join(job.stage, 'Nearlink.app')
      job.backup = join(job.stage, 'Previous.app')
      await execute('/usr/bin/ditto', ['-x', '-k', update.path, job.stage], { timeout: 120_000 })
      const info = await lstat(job.candidate)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('更新包中没有有效的 Nearlink 应用。')
      const plist = join(job.candidate, 'Contents/Info.plist')
      const identifier = await execute('/usr/bin/plutil', [
        '-extract',
        'CFBundleIdentifier',
        'raw',
        '-o',
        '-',
        plist
      ])
      const version = await execute('/usr/bin/plutil', [
        '-extract',
        'CFBundleShortVersionString',
        'raw',
        '-o',
        '-',
        plist
      ])
      if (identifier.stdout.trim() !== 'io.nearlink.desktop' || version.stdout.trim() !== update.version)
        throw new Error('更新应用的标识或版本不匹配。')
      await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', job.candidate], {
        timeout: 60_000
      })
      await writeFile(join(update.directory, 'helper.sh'), macHelper, { mode: 0o700 })
    } else {
      if (update.target === 'win-x64-portable') {
        if (!options.portableExecutable) throw new Error('无法定位便携版应用。')
        job.target = await realpath(options.portableExecutable)
        job.candidate = join(dirname(job.target), `.Nearlink-update-${update.id}.exe`)
        job.backup = join(dirname(job.target), `.Nearlink-previous-${update.id}.exe`)
        await copyFile(update.path, job.candidate)
        await verifyDownload(job.candidate, update.artifact)
      }
      if (basename(job.target).toLowerCase().endsWith('.exe') === false)
        throw new Error('无法定位 Windows 应用。')
      await access(dirname(job.target), constants.W_OK)
    }
    await writeFile(jobFile, JSON.stringify(job), { mode: 0o600 })
  } catch (error) {
    if (job.stage) await rm(job.stage, { recursive: true, force: true })
    if (job.candidate && job.mode === 'portable') await rm(job.candidate, { force: true })
    throw error
  }
  return async () => {
    const fd = openSync(join(update.directory, 'helper.log'), 'a', 0o600)
    const env: NodeJS.ProcessEnv = { ...process.env, NEARLINK_UPDATE_JOB_FILE: jobFile }
    // Signing credentials are only used by the release/test process, never the app helper.
    delete env.NEARLINK_UPDATE_PRIVATE_KEY
    delete env.ELECTRON_RUN_AS_NODE
    const command = job.mode === 'mac' ? '/bin/sh' : 'powershell.exe'
    const args =
      job.mode === 'mac'
        ? [
            join(update.directory, 'helper.sh'),
            String(job.pid),
            job.target,
            job.candidate,
            job.backup,
            job.stage,
            job.directory,
            job.id
          ]
        : ['-NoProfile', '-NonInteractive', '-Command', windowsHelper]
    const child = spawn(command, args, {
      cwd: update.directory,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
      env
    })
    closeSync(fd)
    let launchError: Error | undefined
    let exited = false
    child.on('error', (error) => {
      launchError = error
    })
    child.on('exit', () => {
      exited = true
    })
    for (let attempt = 0; attempt < 250; attempt++) {
      if (launchError || exited) throw launchError || new Error('更新辅助程序无法启动，请查看更新日志。')
      try {
        await access(join(update.directory, 'helper-ready'))
        child.unref()
        return
      } catch {
        await delay(20)
      }
    }
    child.kill()
    throw new Error('更新辅助程序启动超时。')
  }
}
