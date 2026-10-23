param([string]$RuntimeRoot)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
if (!(Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules'))) { npm ci; if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' } }
npm run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
New-Item -ItemType Directory -Force -Path (Join-Path $projectRoot 'data') | Out-Null
$nodePath = (Get-Command node).Source
try { $health = Invoke-RestMethod -Uri 'http://127.0.0.1:4310/healthz' -TimeoutSec 2 } catch { $health = $null }
if (!$health) {
  $process = Start-Process -FilePath $nodePath -ArgumentList 'server/index.js' -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $projectRoot 'data/app.log') -RedirectStandardError (Join-Path $projectRoot 'data/app-error.log')
  $process.Id | Set-Content -LiteralPath (Join-Path $projectRoot 'data/app.pid')
}
if ($RuntimeRoot) { node scripts/start-observability.js $RuntimeRoot } else { node scripts/start-observability.js }
Write-Output 'Rahban: http://localhost:4310'
