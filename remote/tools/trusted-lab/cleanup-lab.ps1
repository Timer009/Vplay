param(
  [string]$LabRoot = "$env:USERPROFILE\vplay-lab",
  [switch]$Approve
)

# B12：默认 DryRun；只清理 LabRoot 内部，不触碰用户工程或 VPLAY_HOME 之外的数据。
$root = [System.IO.Path]::GetFullPath($LabRoot)
$userHome = [System.IO.Path]::GetFullPath($env:USERPROFILE)
if (-not $root.StartsWith($userHome, [System.StringComparison]::OrdinalIgnoreCase) -and
    -not $root.StartsWith('G:\AI_GAME\', [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "refuse to clean labRoot outside user profile or G:\AI_GAME: $root"
}
if ($root -eq $userHome -or $root -eq 'G:\AI_GAME') {
  throw "refuse to clean broad root: $root"
}

Write-Output "labRoot = $root"
if (-not (Test-Path $root)) {
  Write-Output "nothing to clean"
  exit 0
}
Get-ChildItem $root -Force | Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize

if (-not $Approve) {
  Write-Output "DRY RUN. Re-run with -Approve to remove the lab directory."
  exit 0
}

# 先停 lab 进程（如果 PID 文件存在）
$stop = Join-Path $PSScriptRoot 'stop-lab.ps1'
if (Test-Path $stop) { & $stop -LabRoot $root }

Remove-Item $root -Recurse -Force
Write-Output "removed $root"
