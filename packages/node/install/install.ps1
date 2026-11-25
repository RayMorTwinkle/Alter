# Alter node installer for Windows. The web app's "add computer" command sets ALTER_SERVER, ALTER_TOKEN and ALTER_NAME, then pipes this script into iex.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$server = $env:ALTER_SERVER; $token = $env:ALTER_TOKEN; $name = $env:ALTER_NAME
if (-not $server -or -not $token) { throw '請在 Alter 網頁「我的電腦 → 添加電腦」複製完整命令再運行。' }

function Find-Node {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { return $null }
  $version = (& $cmd.Source -v) -replace '^v', ''
  if ([version]$version -ge [version]'22.13.0') { return $cmd.Source }
  return $null
}

Write-Host '[1/5] 檢查 Node.js'
$node = Find-Node
if (-not $node) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw '需要 Node.js 22.13 或更新版本。請到 https://nodejs.org 安裝 LTS 版後重新運行這條命令。' }
  Write-Host '      沒有找到合適的 Node.js，用 winget 安裝 LTS 版（可能彈出管理員確認）'
  winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  $node = Find-Node
  if (-not $node) { throw 'Node.js 裝好了但還找不到。請關掉 PowerShell，重新打開後再運行一次這條命令。' }
}

Write-Host '[2/5] 下載節點'
$dir = Join-Path $env:LOCALAPPDATA 'alter-node'
New-Item -ItemType Directory -Force $dir | Out-Null
$cli = Join-Path $dir 'alter-node.mjs'
# A node from an earlier install would keep the old token and file open.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*alter-node.mjs*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Invoke-WebRequest -UseBasicParsing "$server/node/alter-node.mjs" -OutFile $cli

Write-Host '[3/5] 配對'
$root = Read-Host "      允許 Alter 在哪個目錄裡工作？直接回車表示整個用戶目錄 $env:USERPROFILE"
if (-not $root) { $root = $env:USERPROFILE }
$pair = @($cli, 'pair', '--server', $server, '--token', $token, '--root', $root)
if ($name) { $pair += @('--name', $name) }
& $node @pair
if ($LASTEXITCODE) { throw '配對失敗。令牌可能已失效，請在網頁移除這台電腦後重新添加。' }

Write-Host '[4/5] 設為登入後自動運行'
& $node $cli install-service
if ($LASTEXITCODE) { throw '設置自動運行失敗。' }

Write-Host '[5/5] 啟動'
Start-Process -FilePath $node -ArgumentList "`"$cli`"", 'run' -WindowStyle Hidden
Start-Sleep -Seconds 5
& $node $cli status
Write-Host ''
Write-Host '完成。回到 Alter 網頁的「我的電腦」，這台電腦應該顯示在線。以後開機登入會自動運行，不用再管它。'
