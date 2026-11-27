param(
  [string]$LabRoot = "$env:USERPROFILE\vplay-lab",
  [string]$AgentUser = ""
)

# B12：只读隔离检查。不得创建账号、修改 ACL/防火墙或安装组件。
$ErrorActionPreference = 'Continue'

function Section($name) { Write-Output ""; Write-Output "== $name ==" }

Section "identity"
whoami
whoami /groups | Select-String -Pattern 'S-1-5-32-544|Mandatory Label' | Select-Object -First 5

Section "os"
Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber | Format-List

Section "local users"
Get-LocalUser -ErrorAction SilentlyContinue |
  Select-Object Name, Enabled, Description | Format-Table -AutoSize

Section "optional features (read-only; elevation may be required)"
foreach ($feature in @('Containers-DisposableClientVM', 'Microsoft-Hyper-V-All', 'Containers', 'Microsoft-Windows-Subsystem-Linux')) {
  try {
    Get-WindowsOptionalFeature -Online -FeatureName $feature -ErrorAction Stop |
      Select-Object FeatureName, State | Format-List
  } catch {
    Write-Output "$feature : ERR $($_.Exception.Message)"
  }
}
Write-Output ("WindowsSandbox.exe present: " + (Test-Path "$env:WINDIR\System32\WindowsSandbox.exe"))

Section "container runtimes"
try { docker version --format '{{.Server.Version}}' 2>&1 | Select-Object -First 2 } catch { Write-Output 'docker unavailable' }
try { wsl --status 2>&1 | Select-Object -First 4 } catch { Write-Output 'wsl unavailable' }

Section "lab root acl"
if (Test-Path $LabRoot) { icacls $LabRoot } else { Write-Output "lab root missing: $LabRoot" }

Section "vplay home acl"
$home = Join-Path $env:USERPROFILE '.vplay'
if (Test-Path $home) { icacls $home } else { Write-Output "vplay home missing: $home" }

if ($AgentUser) {
  Section "agent user groups"
  try { Get-LocalGroupMember -Member $AgentUser -ErrorAction Stop | Select-Object Name, ObjectClass } catch { Write-Output "agent user check failed: $($_.Exception.Message)" }
}

Section "listeners (8787/8788)"
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -in 8787, 8788 } |
  Select-Object LocalAddress, LocalPort, OwningProcess

Section "node firewall inbound rules (count only)"
$rules = Get-NetFirewallRule -Direction Inbound -Enabled True -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -match 'node' }
Write-Output ("node inbound enabled rules: " + @($rules).Count)

Section "tailscale"
$ts = 'C:\Program Files\Tailscale\tailscale.exe'
if (Test-Path $ts) {
  & $ts status
  & $ts serve status
  & $ts funnel status
} else {
  Write-Output 'tailscale not installed'
}

Write-Output ""
Write-Output "NOTE: this script is read-only. Isolation remains NOT_IMPLEMENTED until account/ACL/network controls are approved and verified."
