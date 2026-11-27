param([string]$LabRoot = "$env:USERPROFILE\vplay-lab")

# B12：只停止 lab PID 文件中记录的进程，不按名称杀 node。
$pidFile = Join-Path $LabRoot 'server.pid'
if (-not (Test-Path $pidFile)) {
  Write-Output "no lab pid file: $pidFile"
  exit 0
}
$serverPid = (Get-Content $pidFile -ErrorAction Stop | Select-Object -First 1).Trim()
if (-not $serverPid) {
  Write-Output "empty pid file"
  exit 0
}
$proc = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
if (-not $proc) {
  Write-Output "pid $serverPid not running; removing pid file"
  Remove-Item $pidFile -Force
  exit 0
}
Write-Output "stopping lab pid $serverPid ($($proc.ProcessName))"
Stop-Process -Id $serverPid -Force
Start-Sleep -Milliseconds 500
Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
Write-Output "stopped"
