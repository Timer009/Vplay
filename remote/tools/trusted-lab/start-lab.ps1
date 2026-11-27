param(
  [string]$LabRoot = "$env:USERPROFILE\vplay-lab",
  [int]$ControlPort = 18787,
  [int]$PreviewPort = 18788,
  [switch]$Approve
)

# B12：默认 DryRun。仅 -Approve 时创建 lab 目录并启动“无任务”的 Runtime。
# 不创建账号、不改 ACL/防火墙、不启用 Serve/Funnel、不调用真实模型。
$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..\..')
$config = @{
  root = $LabRoot
  workspace = Join-Path $LabRoot 'workspace'
  home = Join-Path $LabRoot 'home'
  logs = Join-Path $LabRoot 'logs'
  pidFile = Join-Path $LabRoot 'server.pid'
}

function Require-Env($name, $min) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if (-not $value -or $value.Length -lt $min) {
    throw "$name is required (>= $min chars) for the lab runtime"
  }
  return $value
}

Write-Output "labRoot = $($config.root)"
Write-Output "workspace = $($config.workspace)"
Write-Output "vplayHome = $($config.home)"
Write-Output "control = 127.0.0.1:$ControlPort  preview = 127.0.0.1:$PreviewPort"
Write-Output "mode = REMOTE_AUTORUN=0, no Serve/Funnel, no real model call"

if (-not $Approve) {
  Write-Output ""
  Write-Output "DRY RUN. Re-run with -Approve after user/admin approval."
  Write-Output "Required env for -Approve: REMOTE_TOKEN, PREVIEW_ACCESS_KEY, EVIDENCE_HMAC_KEY (>=16 chars each)."
  exit 0
}

if (Test-Path $config.pidFile) {
  throw "lab already has a PID file: $($config.pidFile). Run stop-lab.ps1 first."
}

$token = Require-Env 'REMOTE_TOKEN' 16
$preview = Require-Env 'PREVIEW_ACCESS_KEY' 16
$hmac = Require-Env 'EVIDENCE_HMAC_KEY' 16

New-Item -ItemType Directory -Force -Path $config.workspace, $config.home, $config.logs | Out-Null

# B14 / C13 L-1：cleanup-lab.ps1 只认「配置 labRoot + marker」；
# marker 记录规范化后的实验根，防止误删其他目录。
$marker = Join-Path $config.root '.vplay-lab-marker'
$markerPayload = @{
  schemaVersion = 1
  labRoot = [System.IO.Path]::GetFullPath($config.root)
  createdAt = (Get-Date).ToUniversalTime().ToString('o')
  createdBy = 'start-lab.ps1'
} | ConvertTo-Json
Set-Content -LiteralPath $marker -Value $markerPayload -Encoding UTF8

$env:VPLAY_HOME = $config.home
$env:OPENGAME_WORKSPACE = $config.workspace
$env:REMOTE_HOST = '127.0.0.1'
$env:REMOTE_PORT = "$ControlPort"
$env:PREVIEW_PORT = "$PreviewPort"
$env:REMOTE_TOKEN = $token
$env:PREVIEW_ACCESS_KEY = $preview
$env:EVIDENCE_HMAC_KEY = $hmac
$env:REMOTE_AUTORUN = '0'
$env:REMOTE_TRUST_PROXY = '0'
# lab 只在本机回环运行，不设置 VPLAY_PUBLIC_MODE；如未来改为 Serve，必须重新通过 fail-closed 门禁。
$env:VPLAY_PUBLIC_MODE = '0'
$env:REMOTE_ALLOWED_HOSTS = 'localhost,127.0.0.1'
Remove-Item Env:REMOTE_ALLOW_TEST_SEAM -ErrorAction SilentlyContinue
Remove-Item Env:REMOTE_EXECUTOR_CMD -ErrorAction SilentlyContinue
Remove-Item Env:VPLAY_ALLOW_YOLO -ErrorAction SilentlyContinue

$stdout = Join-Path $config.logs 'server.out.log'
$stderr = Join-Path $config.logs 'server.err.log'
$proc = Start-Process -FilePath (Get-Command node).Source `
  -ArgumentList @((Join-Path $repo 'remote\server.cjs')) `
  -WorkingDirectory $repo `
  -RedirectStandardOutput $stdout `
  -RedirectStandardError $stderr `
  -PassThru -WindowStyle Hidden

Set-Content -Path $config.pidFile -Value $proc.Id
Write-Output "started pid=$($proc.Id); logs: $stdout / $stderr"
Write-Output "NOTE: LAB runtime is loopback-only and has no tasks; no model call is made."
