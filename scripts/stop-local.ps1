$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $projectRoot 'data/app.pid'
if (!(Test-Path -LiteralPath $pidFile)) { Write-Output 'No managed Rahban process is recorded.'; exit }
$taskProcessId = [int](Get-Content -LiteralPath $pidFile)
$taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$taskProcessId" -ErrorAction SilentlyContinue
$entrypoint = Join-Path $projectRoot 'server/index.js'
if (!$taskProcess) {
  Remove-Item -LiteralPath $pidFile
  Write-Output 'The recorded Rahban process is no longer running.'
} elseif ($taskProcess.Name -eq 'node.exe' -and $taskProcess.CommandLine -and $taskProcess.CommandLine.Contains($entrypoint)) {
  Stop-Process -Id $taskProcessId
  Remove-Item -LiteralPath $pidFile
  Write-Output 'Stopped the recorded Rahban application.'
} else {
  Write-Output 'Process identity did not match; no process was stopped.'
}
