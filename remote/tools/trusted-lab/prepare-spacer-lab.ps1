param(
  [string]$Source = 'G:\AI_GAME\Vplay-Vision-POC\e05\spacer-latest',
  [string]$LabRoot = 'G:\AI_GAME\vplay-labs\b12-spacer',
  [switch]$Approve
)

# B12：复制 Spacer 到独立实验目录（默认 DryRun）。绝不修改官方副本。
$ErrorActionPreference = 'Stop'
$entry = Join-Path $Source 'vector-lander\index.html'
$expected = '4babef022f7ad5fef42a346cb1f0af3dfcbe63d22e895a83eb19192491511064'

if (-not (Test-Path $entry)) { throw "official Spacer entry not found: $entry" }
$sourceHash = (Get-FileHash $entry -Algorithm SHA256).Hash.ToLower()
Write-Output "source = $Source"
Write-Output "entry  = $entry"
Write-Output "sha256 = $sourceHash"
if ($sourceHash -ne $expected) { throw "unexpected official Spacer hash: $sourceHash" }

$target = Join-Path $LabRoot 'vector-lander'
$targetEntry = Join-Path $target 'index.html'
Write-Output "lab    = $LabRoot"

if (-not $Approve) {
  Write-Output ""
  Write-Output "DRY RUN. Planned: robocopy `"$Source`" `"$LabRoot`" /E /XD .git node_modules"
  Write-Output "Then verify $targetEntry hash == $expected"
  Write-Output "Re-run with -Approve after user approval."
  exit 0
}

if (Test-Path $LabRoot) { throw "lab target already exists: $LabRoot" }
New-Item -ItemType Directory -Force -Path $LabRoot | Out-Null
$rc = Start-Process robocopy -ArgumentList @("`"$Source`"", "`"$LabRoot`"", '/E', '/XD', '.git', 'node_modules', '/NP', '/NFL', '/NDL') -Wait -PassThru
if ($rc.ExitCode -ge 8) { throw "robocopy failed: $($rc.ExitCode)" }

$copiedHash = (Get-FileHash $targetEntry -Algorithm SHA256).Hash.ToLower()
if ($copiedHash -ne $expected) { throw "copied hash mismatch: $copiedHash" }
Write-Output "copied OK: $targetEntry"
Write-Output "official Spacer untouched: $sourceHash"
