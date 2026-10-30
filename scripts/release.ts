import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { name: string; version: string }
const output = (command: string, args: string[]): string =>
  execFileSync(command, args, { encoding: 'utf8' }).trim()
if (pkg.name !== 'nearlink' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pkg.version))
  throw new Error('Invalid project or version.')
if (output('git', ['branch', '--show-current']) !== 'main') throw new Error('Release from main.')
if (output('git', ['status', '--porcelain'])) throw new Error('Commit all changes before releasing.')
const tag = `v${pkg.version}`
if (output('git', ['tag', '--list', tag])) throw new Error(`${tag} already exists.`)
const repo = output('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
if (repo !== 'lanhas/nearlink') throw new Error('Unexpected release repository.')
execFileSync('git', ['tag', '-a', tag, '-m', `Nearlink ${tag}`], { stdio: 'inherit' })
execFileSync('git', ['push', '--atomic', 'origin', 'main', tag], { stdio: 'inherit' })
console.log(`Release workflow started: https://github.com/${repo}/actions/workflows/release.yml`)
