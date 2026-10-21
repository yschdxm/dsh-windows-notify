# dsh-windows-notify click launcher (Windows PowerShell 5.1).
# Invoked through the plugin's protocol handler as: launcher.ps1 "%1"
# %1 looks like  dshfocus://focus?u=<url-encoded focus url>.
param(
  [Parameter(Mandatory = $true)][string]$ProtocolArgs
)
$ErrorActionPreference = 'Stop'
$logDir = Join-Path $env:TEMP 'dsh-windows-notify'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir 'launcher.log'
function Write-Trace([string]$Message) {
  try {
    Add-Content -Path $logFile -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff') + ' ' + $Message) -Encoding UTF8
  } catch { }
}
try {
  $match = [regex]::Match($ProtocolArgs, '[?&]u=([^&]+)')
  if (-not $match.Success) { throw 'focus url missing from protocol arguments' }
  $target = [System.Uri]::UnescapeDataString($match.Groups[1].Value)
  Write-Trace ('target=' + $target)
  try {
    $response = Invoke-WebRequest -Uri $target -UseBasicParsing -TimeoutSec 3
    Write-Trace ('host-status=' + $response.StatusCode)
  } catch {
    Write-Trace ('host-error=' + $_.Exception.Message)
  }
  $mode = 'none'
  try {
    Start-Process 'dsh://open' -ErrorAction Stop
    $mode = 'app'
  } catch {
    Write-Trace ('app-error=' + $_.Exception.Message)
    try {
      $origin = ([System.Uri]$target).GetLeftPart([System.UriPartial]::Authority)
      Start-Process $origin -ErrorAction Stop
      $mode = 'browser'
    } catch {
      Write-Trace ('browser-error=' + $_.Exception.Message)
    }
  }
  Write-Trace ('focus-mode=' + $mode)
} catch {
  Write-Trace ('fatal=' + $_.Exception.Message)
  exit 1
}