$ErrorActionPreference = "Stop"

function New-RandomBytes([int]$Length) {
  $bytes = New-Object byte[] $Length
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
  } finally {
    $rng.Dispose()
  }
  return $bytes
}

function ConvertTo-Base64Url([byte[]]$Bytes) {
  return [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

$dashboardPassword = ConvertTo-Base64Url (New-RandomBytes 96)
$masterKey = [Convert]::ToBase64String((New-RandomBytes 32))
$sessionSecret = ConvertTo-Base64Url (New-RandomBytes 48)
$heliusWebhookAuth = "Bearer " + (ConvertTo-Base64Url (New-RandomBytes 48))

Write-Host ""
Write-Host "Generated secrets. Store these in your password manager immediately."
Write-Host "The dashboard password is intentionally shown only in this output."
Write-Host ""
Write-Host "DASHBOARD_PASSWORD=$dashboardPassword"
Write-Host "MASTER_ENCRYPTION_KEY=$masterKey"
Write-Host "SESSION_SECRET=$sessionSecret"
Write-Host "HELIUS_WEBHOOK_AUTH=$heliusWebhookAuth"
Write-Host ""
Write-Host "Generate DASHBOARD_PASSWORD_HASH after npm install:"
Write-Host "node ./scripts/hash-password.mjs `"$dashboardPassword`""
Write-Host ""
