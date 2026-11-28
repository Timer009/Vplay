param([string]$LabRoot = 'G:\vplay-lab')

# B16：恢复检查（只读 + 打印命令），不自动改写源码或删除数据。
$vplayHome = Join-Path $LabRoot 'home'
Write-Output "vplayHome = $vplayHome"

if (-not (Test-Path $vplayHome)) {
  Write-Output "lab home missing; nothing to recover"
  exit 0
}

Write-Output ""
Write-Output "== rollback journals =="
Get-ChildItem $vplayHome -Recurse -Filter '.rollback-journal.json' -ErrorAction SilentlyContinue |
  Select-Object FullName, LastWriteTime

Write-Output ""
Write-Output "== vision apply journals =="
Get-ChildItem $vplayHome -Recurse -Filter 'apply-journal*.json' -ErrorAction SilentlyContinue |
  Select-Object FullName, LastWriteTime

Write-Output ""
Write-Output "== preview stale markers =="
Get-ChildItem $vplayHome -Recurse -Filter '.preview-stale.json' -ErrorAction SilentlyContinue |
  Select-Object FullName, LastWriteTime

Write-Output ""
Write-Output "== snapshot quota =="
Get-ChildItem $vplayHome -Recurse -Filter '.snapshot-quota.json' -ErrorAction SilentlyContinue |
  ForEach-Object { Get-Content $_.FullName }

Write-Output ""
Write-Output "== event anchor =="
Get-ChildItem $vplayHome -Recurse -Filter 'events.anchor.json' -ErrorAction SilentlyContinue |
  ForEach-Object { Get-Content $_.FullName }

Write-Output ""
Write-Output "Restart the lab Runtime to run built-in recovery (orphan snapshots, rollback journal, vision journal)."
Write-Output "Interrupted tasks are marked 'interrupted' and are never auto-rerun."
