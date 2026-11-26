<#
.SYNOPSIS
  Build the WebCrawler Electron desktop package (Windows zip).

.DESCRIPTION
  Prerequisites: pnpm install && pnpm build.
  The server code is NOT modified: Electron main process starts server/dist as a
  child Node process and proxies /api + /resources to it while serving web/dist.

  Output: artifacts/electron/WebCrawler-<version>-win-x64.zip
#>
param(
  [string]$Version,
  [switch]$KeepStage
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path (Join-Path $PSScriptRoot '..') '..'))
$outRoot = Join-Path $repoRoot 'artifacts'
$workDir = Join-Path $outRoot '_electron'
$appDir = Join-Path $workDir 'app'
$deployDir = Join-Path $workDir 'deploy'
$builderDir = [System.IO.Path]::GetFullPath($PSScriptRoot)
if (-not $builderDir) { throw 'PSScriptRoot is empty' }

if (-not $Version) {
  $rootPackage = Get-Content -Raw -Encoding UTF8 (Join-Path $repoRoot 'package.json') | ConvertFrom-Json
  $Version = $rootPackage.version
}
$safeVersion = $Version -replace '[^0-9A-Za-z._-]', '-'

function Assert-File([string]$path) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Missing file: $path (run pnpm install && pnpm build first)"
  }
}

Assert-File (Join-Path $repoRoot 'apps/server/dist/server/index.js')
Assert-File (Join-Path $repoRoot 'apps/web/dist/index.html')
Assert-File (Join-Path $builderDir 'main.cjs')
Assert-File (Join-Path $builderDir 'electron-builder.yml')

Write-Host "[1/6] Clean work dir: $workDir"
Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $workDir, $appDir | Out-Null

Write-Host "[2/6] pnpm deploy --prod"
& pnpm --dir $repoRoot --filter '@webcrawler/server' deploy --prod --ignore-scripts --config.node-linker=hoisted $deployDir
if ($LASTEXITCODE -ne 0) { throw "pnpm deploy failed with exit code $LASTEXITCODE" }
Assert-File (Join-Path $deployDir 'package.json')

Write-Host "[3/6] Assemble Electron app directory"
New-Item -ItemType Directory -Force -Path (Join-Path $appDir 'app/server'),
  (Join-Path $appDir 'app/web'),
  (Join-Path $appDir 'app/resources') | Out-Null
Copy-Item -LiteralPath (Join-Path $builderDir 'main.cjs') -Destination (Join-Path $appDir 'main.cjs') -Force
Copy-Item -LiteralPath (Join-Path $deployDir 'package.json') -Destination (Join-Path $appDir 'app/server/package.json') -Force
# electron-builder only keeps node_modules declared in the app's root package.json.
Copy-Item -LiteralPath (Join-Path $deployDir 'node_modules') -Destination (Join-Path $appDir 'node_modules') -Recurse -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'apps/server/dist') -Destination (Join-Path $appDir 'app/server/dist') -Recurse -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'apps/web/dist') -Destination (Join-Path $appDir 'app/web/dist') -Recurse -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'resources/.gitkeep') -Destination (Join-Path $appDir 'app/resources/.gitkeep') -Force

$serverPackage = Get-Content -Raw -Encoding UTF8 (Join-Path $deployDir 'package.json') | ConvertFrom-Json
$electronPackage = [ordered]@{
  name = 'webcrawler-desktop'
  version = $Version
  private = $true
  description = 'WebCrawler desktop application'
  main = 'main.cjs'
  dependencies = $serverPackage.dependencies
}
$packageJson = $electronPackage | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText((Join-Path $appDir 'package.json'), $packageJson, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "[4/6] Ensure electron-builder and Electron binary are installed"
if (-not (Test-Path -LiteralPath (Join-Path $builderDir 'node_modules/electron-builder/package.json') -PathType Leaf)) {
  & npm --prefix $builderDir install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
}
# Some environments skip Electron postinstall; download the binary explicitly.
$electronExe = [System.IO.Path]::Combine($builderDir, 'node_modules', 'electron', 'dist', 'electron.exe')
if (-not (Test-Path -LiteralPath $electronExe -PathType Leaf)) {
  & node (Join-Path $builderDir 'node_modules/electron/install.js')
  if ($LASTEXITCODE -ne 0) { throw "Electron binary download failed with exit code $LASTEXITCODE" }
}
Assert-File $electronExe

Write-Host "[5/6] electron-builder --win zip"
# Use a fresh output dir each run: electron-builder removes win-unpacked internally,
# which can be blocked by sandboxed delete policies.
$buildOut = Join-Path $outRoot ('_eb-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $buildOut | Out-Null
$configSource = Join-Path $builderDir 'electron-builder.yml'
$configTemp = Join-Path $buildOut 'electron-builder.yml'
$configText = Get-Content -Raw -Encoding UTF8 $configSource
$outputLine = '  output: ' + $buildOut.Replace('\', '/')
$configText = $configText -replace '(?m)^\s*output:.*$', $outputLine
[System.IO.File]::WriteAllText($configTemp, $configText, (New-Object System.Text.UTF8Encoding($false)))

Push-Location $builderDir
try {
  & npx --no-install electron-builder --config $configTemp --win zip
  if ($LASTEXITCODE -ne 0) { throw "electron-builder failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

$builtZip = Get-ChildItem -LiteralPath $buildOut -Filter '*.zip' -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $builtZip) { throw 'No Electron zip was produced' }
$stableDir = Join-Path $outRoot 'electron'
New-Item -ItemType Directory -Force -Path $stableDir | Out-Null
$zip = Join-Path $stableDir $builtZip.Name
Copy-Item -LiteralPath $builtZip.FullName -Destination $zip -Force

if (-not $KeepStage) {
  Write-Host "[6/6] Clean intermediate files"
  Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
} else {
  Write-Host "[6/6] Keep stage at: $workDir"
}

$sizeMB = [math]::Round((Get-Item -LiteralPath $zip).Length / 1MB, 1)
Write-Host "PACKAGE=$zip"
Write-Host "SIZE=$sizeMB MB"
