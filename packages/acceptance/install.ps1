param([switch]$Apply, [switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$taskConfig = Get-Content -LiteralPath (Join-Path $taskRoot 'installation.json') -Raw | ConvertFrom-Json
$taskManifest = [IO.Path]::GetFullPath((Join-Path $taskRoot 'native-host.json'))
$taskKeys = @('HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.bili_bill.acceptance', 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.bili_bill.acceptance')
if (-not $Apply) {
  [pscustomobject]@{ mode = 'preview'; action = $(if ($Uninstall) { 'uninstall' } else { 'install' }); registryKeys = $taskKeys; manifest = $taskManifest; ledgerDirectory = $taskConfig.ledgerDirectory; machinePoliciesChanged = $false } | ConvertTo-Json -Depth 4
  exit 0
}
foreach ($taskKey in $taskKeys) {
  if (Test-Path -LiteralPath $taskKey) {
    $taskExisting = (Get-Item -LiteralPath $taskKey).GetValue('')
    if ($taskExisting -ne $taskManifest) { throw 'Another package owns the registration. Keep its ledger and explicitly uninstall that registration first.' }
  }
}
if ($Uninstall) {
  foreach ($taskKey in $taskKeys) { if (Test-Path -LiteralPath $taskKey) { Remove-Item -LiteralPath $taskKey } }
  Write-Output 'Registration removed. Package, reports, extension data and billing ledger retained.'
  exit 0
}
if (-not (Test-Path -LiteralPath $taskConfig.ledgerDirectory)) { New-Item -ItemType Directory -Path $taskConfig.ledgerDirectory | Out-Null }
foreach ($taskKey in $taskKeys) {
  New-Item -Path $taskKey -Force | Out-Null
  Set-Item -LiteralPath $taskKey -Value $taskManifest
}
Write-Output 'Installed for the current Windows user in Chrome and Edge. No machine policy was changed.'
