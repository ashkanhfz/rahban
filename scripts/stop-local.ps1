$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $projectRoot 'data/app.pid'
if (Test-Path -LiteralPath $pidFile) {
  $taskProcessId = [int](Get-Content -LiteralPath $pidFile)
  $taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$taskProcessId" -ErrorAction SilentlyContinue
  if ($taskProcess -and $taskProcess.Name -eq 'node.exe' -and $taskProcess.CommandLine -match 'server[/\\]index.js') { Stop-Process -Id $taskProcessId -ErrorAction SilentlyContinue }
}
$observabilityPidFile = Join-Path $projectRoot 'data/observability/pids.json'
if (Test-Path -LiteralPath $observabilityPidFile) {
  $taskProcesses = Get-Content -LiteralPath $observabilityPidFile | ConvertFrom-Json
  foreach ($key in @('grafana','prometheus')) {
    $taskProcessId = $taskProcesses.$key
    if (!$taskProcessId) { continue }
    $taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$taskProcessId" -ErrorAction SilentlyContinue
    if ($taskProcess -and $taskProcess.Name -in @('grafana.exe','grafana-server.exe','prometheus.exe') -and $taskProcess.CommandLine -like "*$projectRoot*") { Stop-Process -Id $taskProcessId -ErrorAction SilentlyContinue }
  }
}
Write-Output 'Stopped locally managed Rahban processes where identity matched.'
