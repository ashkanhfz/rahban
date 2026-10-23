$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
if (!(Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules'))) {
  npm ci
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
}
npm run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
New-Item -ItemType Directory -Force -Path (Join-Path $projectRoot 'data') | Out-Null
try { $health = Invoke-RestMethod -Uri 'http://127.0.0.1:4310/healthz' -TimeoutSec 2 } catch { $health = $null }
if ($health -and $health.service -ne 'rahban') { throw 'Port 4310 is occupied by another application.' }
if (!$health) {
  $entrypoint = Join-Path $projectRoot 'server/index.js'
  $process = Start-Process -FilePath (Get-Command node).Source -ArgumentList "`"$entrypoint`"" -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $projectRoot 'data/app.log') -RedirectStandardError (Join-Path $projectRoot 'data/app-error.log')
  $process.Id | Set-Content -LiteralPath (Join-Path $projectRoot 'data/app.pid')
  for ($attempt = 0; $attempt -lt 10; $attempt++) {
    Start-Sleep -Seconds 1
    try { $health = Invoke-RestMethod -Uri 'http://127.0.0.1:4310/healthz' -TimeoutSec 2 } catch { $health = $null }
    if ($health -and $health.service -eq 'rahban' -and $health.status -eq 'ok') { break }
  }
}
if (!$health -or $health.service -ne 'rahban' -or $health.status -ne 'ok') { throw 'Application is not ready; inspect data/app-error.log.' }
Write-Output 'Rahban: http://localhost:4310'
