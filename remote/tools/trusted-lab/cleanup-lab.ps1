param(
  [string]$LabRoot = '',
  [string]$Config = (Join-Path $PSScriptRoot 'lab-config.json'),
  [switch]$Approve
)

# B16 / C15 L05：只允许清理「配置中精确声明且被授权的专用 labRoot」。
# 额外要求 .vplay-lab-marker、路径规范化；拒绝正式工程及子目录、用户主目录、
# 磁盘根、路径穿越与任何重解析点（symlink/junction）。默认 DryRun。
$ErrorActionPreference = 'Stop'

function Normalize-Dir([string]$value) {
  if (-not $value) { return '' }
  return [System.IO.Path]::GetFullPath($value).TrimEnd('\', '/')
}

function Assert-NoTraversal([string]$value, [string]$what) {
  if (-not $value) { return }
  $segments = $value -split '[\\/]'
  if ($segments -contains '..') {
    throw "refuse to clean: path traversal segment in $what ($value)"
  }
}

function Assert-Outside([string]$root, [string]$parent, [string]$what) {
  if (-not $parent) { return }
  $p = Normalize-Dir $parent
  if ($root -eq $p) { throw "refuse to clean: labRoot equals $what ($p)" }
  if ($root.StartsWith($p + '\', [System.StringComparison]::OrdinalIgnoreCase) -or
      $root.StartsWith($p + '/', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "refuse to clean: labRoot is inside $what ($p)"
  }
}

if (-not (Test-Path -LiteralPath $Config)) {
  throw "lab config not found: $Config (copy lab-config.example.json to lab-config.json first)"
}
$cfg = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
if (-not $cfg.labRoot) {
  throw "lab config must define labRoot: $Config"
}

Assert-NoTraversal ([string]$cfg.labRoot) 'config.labRoot'
Assert-NoTraversal $LabRoot 'LabRoot'

$configured = Normalize-Dir ([string]$cfg.labRoot)
$requested = if ($LabRoot) { Normalize-Dir $LabRoot } else { $configured }
if (-not [string]::Equals($requested, $configured, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "refuse to clean: LabRoot must exactly equal configured labRoot ($configured)"
}

$root = $requested
$userHome = Normalize-Dir $env:USERPROFILE
$driveRoot = Normalize-Dir ([System.IO.Path]::GetPathRoot($root))
$formalWorkspace = Normalize-Dir (Join-Path $PSScriptRoot '..\..\..')
$formalParent = Normalize-Dir 'G:\AI_GAME'

if ($root -eq $userHome -or $root -eq $driveRoot) {
  throw "refuse to clean broad root: $root"
}
Assert-Outside $root $userHome 'user home'
Assert-Outside $root $formalWorkspace 'formal workspace'
Assert-Outside $root $formalParent 'formal workspace root'

function Assert-NoReparse([string]$target) {
  $item = Get-Item -LiteralPath $target -Force -ErrorAction Stop
  if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
    throw "refuse to clean through reparse point: $target"
  }
}

# 父目录链也必须是普通目录，避免经由 junction 把删除重定向到正式工程。
$parent = Split-Path -Parent $root
while ($parent) {
  Assert-NoReparse $parent
  $next = Split-Path -Parent $parent
  if (-not $next -or $next -eq $parent) { break }
  $parent = $next
}

Write-Output "labRoot = $root"
if (-not (Test-Path -LiteralPath $root)) {
  Write-Output "nothing to clean"
  exit 0
}

Assert-NoReparse $root
$marker = Join-Path $root '.vplay-lab-marker'
if (-not (Test-Path -LiteralPath $marker)) {
  throw "refuse to clean: marker missing ($marker)"
}
$markerInfo = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
if (-not $markerInfo.schemaVersion -or -not $markerInfo.labRoot) {
  throw "refuse to clean: invalid lab marker ($marker)"
}
if (-not [string]::Equals((Normalize-Dir ([string]$markerInfo.labRoot)), $root, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "refuse to clean: marker labRoot does not match ($($markerInfo.labRoot))"
}

# 删除前扫描整棵实验树；任何重解析点都拒绝，不跟随、不删除。
Get-ChildItem -LiteralPath $root -Recurse -Force | ForEach-Object {
  if ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
    throw "refuse to clean: reparse point inside lab tree: $($_.FullName)"
  }
}

Get-ChildItem -LiteralPath $root -Force | Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize

if (-not $Approve) {
  Write-Output "DRY RUN. Re-run with -Approve to remove the configured lab directory."
  exit 0
}

# 先停 lab 进程（如果 PID 文件存在）
$stop = Join-Path $PSScriptRoot 'stop-lab.ps1'
if (Test-Path -LiteralPath $stop) { & $stop -LabRoot $root }

Remove-Item -LiteralPath $root -Recurse -Force
Write-Output "removed $root"
