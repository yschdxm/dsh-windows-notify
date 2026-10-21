# dsh-windows-notify toast sender (Windows PowerShell 5.1 + WinRT).
#
# Prints "toast shown" only after ToastNotificationManager.Show() returned, so
# the host can tell a real delivery from a silent no-op. Any failure exits
# non-zero with the reason on stderr.
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads this file without a BOM,
# while the UTF-16 process arguments carry Chinese titles and bodies safely.
param(
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$Body,
  [string]$AppId = 'com.deepseek.dsh',
  [string]$Protocol = 'dshfocus',
  [string]$Url = '',
  [switch]$Silent
)

$ErrorActionPreference = 'Stop'

[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

function New-DshToast([string]$Title, [string]$Body, [bool]$Silent, [string]$Launch) {
  $xml = '<toast'
  if ($Launch -ne '') {
    $xml += ' activationType="protocol" launch="' + $Launch + '" duration="long"'
  }
  $xml += '><visual><binding template="ToastGeneric"><text>' +
    [System.Security.SecurityElement]::Escape($Title) + '</text><text>' +
    [System.Security.SecurityElement]::Escape($Body) + '</text></binding></visual>'
  if ($Silent) {
    $xml += '<audio silent="true"/>'
  } elseif ($Launch -ne '') {
    $xml += '<audio src="ms-winsoundevent:Notification.Default"/>'
  }
  $xml += '</toast>'

  $document = New-Object Windows.Data.Xml.Dom.XmlDocument
  $document.LoadXml($xml)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $document
  # One unique tag per toast keeps every notification in Action Center.
  $toast.Tag = [guid]::NewGuid().ToString('N').Substring(0, 16)
  $toast.Group = 'dsh'
  return $toast
}

# A clickable toast needs a protocol handler owned by this plugin. Registration
# is idempotent and stored under HKCU, so it needs no elevation.
$launch = ''
if ($Url -ne '') {
  try {
    $protocolKey = 'HKCU:\Software\Classes\' + $Protocol
    New-Item -Path $protocolKey -Force | Out-Null
    Set-Item -Path $protocolKey -Value ('URL:' + $Protocol)
    Set-ItemProperty -Path $protocolKey -Name 'URL Protocol' -Value ''
    $commandKey = Join-Path $protocolKey 'shell\open\command'
    New-Item -Path $commandKey -Force | Out-Null
    $launcher = Join-Path $PSScriptRoot 'launcher.ps1'
    Set-Item -Path $commandKey -Value ('"powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launcher + '" "%1"')
    $launch = $Protocol + '://focus?u=' + [uri]::EscapeDataString($Url)
  } catch {
    Write-Warning ('dsh-windows-notify: protocol registration failed: ' + $_.Exception.Message)
    $launch = ''
  }
}

try {
  $toast = New-DshToast -Title $Title -Body $Body -Silent $Silent.IsPresent -Launch $launch
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId).Show($toast)
  Write-Output 'toast shown'
} catch {
  [Console]::Error.WriteLine('toast failed: ' + $_.Exception.Message)
  exit 1
}
