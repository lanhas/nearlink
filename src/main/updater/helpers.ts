// Helpers run outside the application being replaced. Paths are passed as data,
// never interpolated into a command. They wait for the old app to close first.
export function windowsHelperArguments(script = windowsHelper): string[] {
  // PowerShell's documented UTF-16LE command transport preserves multiline
  // source across Windows argument quoting. No execution policy is changed.
  return [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')
  ]
}

export const macHelper = String.raw`#!/bin/sh
set -u
old_pid="$1"
target="$2"
candidate="$3"
backup="$4"
stage="$5"
job="$6"
id="$7"
moved=0
installed=0
new_pid=""
rollback() {
  if [ -n "$new_pid" ]; then kill "$new_pid" 2>/dev/null || true; sleep 1; fi
  if [ "$moved" = 1 ] && [ -d "$backup" ]; then
    if [ "$installed" = 1 ]; then /bin/rm -rf "$target"; fi
    /bin/mv "$backup" "$target" || exit 3
  fi
  "$target/Contents/MacOS/Nearlink" --nearlink-update-failed >> "$job/relaunch.log" 2>&1 &
  printf '{"status":"failed","pid":%s}' "$!" > "$job/result.json"
  exit 1
}
printf ready > "$job/helper-ready"
count=0
while kill -0 "$old_pid" 2>/dev/null; do
  count=$((count + 1))
  if [ "$count" -ge 300 ]; then exit 2; fi
  sleep 0.2
done
/bin/mv "$target" "$backup" || rollback
moved=1
/bin/mv "$candidate" "$target" || rollback
installed=1
"$target/Contents/MacOS/Nearlink" "--nearlink-update-job=$id" >> "$job/relaunch.log" 2>&1 &
new_pid=$!
count=0
while [ ! -f "$job/healthy.json" ]; do
  count=$((count + 1))
  if [ "$count" -ge 225 ]; then rollback; fi
  if ! kill -0 "$new_pid" 2>/dev/null; then rollback; fi
  sleep 0.2
done
printf '%s' '{"status":"complete"}' > "$job/result.json"
/bin/rm -rf "$stage"
/bin/rm -f "$job/Nearlink-mac-arm64.zip"
`

export const windowsHelper = String.raw`
$ErrorActionPreference = 'Stop'
$job = Get-Content -LiteralPath $env:NEARLINK_UPDATE_JOB_FILE -Raw -Encoding UTF8 | ConvertFrom-Json
$moved = $false
$started = $null
function Log-Update($message) {
  [IO.File]::AppendAllText((Join-Path $job.directory 'helper-trace.log'), ((Get-Date -Format o) + ' ' + $message + [Environment]::NewLine))
}
function Move-WithRetry($from, $to) {
  for ($attempt = 0; $attempt -lt 50; $attempt++) {
    try { Move-Item -LiteralPath $from -Destination $to -ErrorAction Stop; return }
    catch { if ($attempt -eq 49) { throw }; Start-Sleep -Milliseconds 200 }
  }
}
try {
  Log-Update "Helper $PID started; waiting for application $($job.pid)"
  [IO.File]::WriteAllText((Join-Path $job.directory 'helper-ready'), ('{"pid":' + $PID + '}'))
  for ($attempt = 0; Get-Process -Id $job.pid -ErrorAction SilentlyContinue; $attempt++) {
    if ($attempt -ge 300) { throw 'The running application did not exit.' }
    Start-Sleep -Milliseconds 200
  }
  Log-Update 'Application exited'
  if ($job.mode -eq 'portable') {
    Move-WithRetry $job.target $job.backup
    $moved = $true
    Move-WithRetry $job.candidate $job.target
  } else {
    Log-Update 'Starting silent installer'
    $installer = Start-Process -FilePath $job.package -ArgumentList @('/S', '--updated') -PassThru
    if (!$installer.WaitForExit(180000)) { throw 'Installer did not finish in time.' }
    Log-Update "Installer exited with code $($installer.ExitCode)"
    if ($installer.ExitCode -ne 0) { throw "Installer exited with code $($installer.ExitCode)." }
  }
  Remove-Item Env:NEARLINK_UPDATE_JOB_FILE -ErrorAction SilentlyContinue
  $started = Start-Process -FilePath $job.target -ArgumentList "--nearlink-update-job=$($job.id)" -PassThru
  Log-Update "Relaunched application $($started.Id)"
  for ($attempt = 0; !(Test-Path -LiteralPath (Join-Path $job.directory 'healthy.json')); $attempt++) {
    if ($attempt -ge 225) { throw 'The updated application did not start.' }
    Start-Sleep -Milliseconds 200
    $started.Refresh()
  }
  [IO.File]::WriteAllText((Join-Path $job.directory 'result.json'), '{"status":"complete"}')
  Log-Update 'Updated application is healthy'
  if ($moved) { Remove-Item -LiteralPath $job.backup -Force }
  Remove-Item -LiteralPath $job.package -Force
} catch {
  $_ | Out-File -LiteralPath (Join-Path $job.directory 'helper-error.log') -Encoding UTF8
  if ($started -and !$started.HasExited) { Stop-Process -Id $started.Id -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1 }
  if ($moved -and (Test-Path -LiteralPath $job.backup)) {
    Remove-Item -LiteralPath $job.target -Force -ErrorAction SilentlyContinue
    Move-WithRetry $job.backup $job.target
  }
  [IO.File]::WriteAllText((Join-Path $job.directory 'result.json'), '{"status":"failed"}')
  if (Test-Path -LiteralPath $job.target) { Start-Process -FilePath $job.target -ArgumentList '--nearlink-update-failed' }
  exit 1
}
`
