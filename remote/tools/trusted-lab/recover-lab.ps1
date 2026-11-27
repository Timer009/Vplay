param([string]$LabRoot = "$env:USERPROFILE\vplay-lab")

# B12：恢复检查（只读 + 打印命令），不自动改写源码或删除数据。
$home = Join-Path $LabRoot 'home'
Write-Output "vplayHome = $home"

if (-not (Test-Path $home)) {
  Write-Output "lab home missing; nothing to recover"
  exit 0
}

Write-Output ""
Write-Output "== rollback journals =="
Get-ChildItem $home -Recurse -Filter '.rollback-journal.json' -ErrorAction SilentlyContinue |
  Select-Object FullName, LastWriteTime

Write-Output ""
Write-Output "== vision apply journals =="
Get-ChildItem $home -Recurse -Filter 'apply-journal*.json' -ErrorAction SilentlyContinue |
  Select-Object FullName, LastWriteTime

Write-Output ""
Write-Output "== preview stale markers =="
Get-ChildItem $home -Recurse -Filter '.preview-stale.json' -ErrorAction SilentlyContinue |
  Select-Object FullName, LastWriteTime

Write-Output ""
Write-Output "== snapshot quota =="
Get-ChildItem $home -Recurse -Filter '.snapshot-quota.json' -ErrorAction SilentlyContinue |
  ForEach-Object { Get-Content $_.FullName }

Write-Output ""
Write-Output "== event anchor =="
Get-ChildItem $home -Recurse -Filter 'events.anchor.json' -ErrorAction SilentlyContinue |
  ForEach-Object { Get-Content $_.FullName }

Write-Output ""
Write-Output "Restart the lab Runtime to run built-in recovery (orphan snapshots, rollback journal, vision journal)."
Write-Output "Interrupted tasks are marked 'interrupted' and are never auto-rerun."
