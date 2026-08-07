# Wires payai.lanvar.ai to the local PayAI server.
#
# Run `cloudflared tunnel login` first - that opens a browser and is the one
# step that needs the account owner. Everything after it is here.
#
# Safe to re-run: reuses an existing tunnel and rewrites the config.
#
# ASCII only, on purpose. Windows PowerShell 5.1 reads .ps1 as ANSI unless the
# file carries a UTF-8 BOM, so a stray em-dash or curly quote becomes mojibake
# and takes the parser down with it.

param(
  [string]$HostName = "payai.lanvar.ai",
  [string]$TunnelName = "payai",
  [int]$Port = 4020
)

$ErrorActionPreference = "Stop"

$exe = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
if (-not (Test-Path $exe)) {
  $found = Get-Command cloudflared -ErrorAction SilentlyContinue
  if ($found) { $exe = $found.Source } else {
    throw "cloudflared not found. Install with: winget install Cloudflare.cloudflared"
  }
}

$cfDir = Join-Path $env:USERPROFILE ".cloudflared"

if (-not (Test-Path (Join-Path $cfDir "cert.pem"))) {
  Write-Host "Not authorized yet. Run this first and pick lanvar.ai in the browser:" -ForegroundColor Yellow
  Write-Host ('  & "' + $exe + '" tunnel login') -ForegroundColor Cyan
  exit 1
}

# --- Tunnel ---------------------------------------------------
# `tunnel create` errors if the name is taken, so reuse it when present. That
# is what makes this script safe to run more than once.
$tunnels = & $exe tunnel list --output json 2>$null | ConvertFrom-Json
$existing = $tunnels | Where-Object { $_.name -eq $TunnelName }

if ($existing) {
  $uuid = $existing.id
  Write-Host "Reusing tunnel '$TunnelName' ($uuid)"
} else {
  Write-Host "Creating tunnel '$TunnelName'..."
  # No 2>&1 here: cloudflared logs to stderr, and redirecting a native exe's
  # stderr in PS 5.1 wraps each line in an ErrorRecord, which throws under
  # ErrorActionPreference=Stop even when the command succeeded.
  & $exe tunnel create $TunnelName
  $tunnels = & $exe tunnel list --output json 2>$null | ConvertFrom-Json
  $uuid = ($tunnels | Where-Object { $_.name -eq $TunnelName }).id
  if (-not $uuid) { throw "Tunnel created but no id returned. Check: cloudflared tunnel list" }
}

$credentials = Join-Path $cfDir ($uuid + ".json")
if (-not (Test-Path $credentials)) { throw "Credentials file missing: $credentials" }

# --- Config ---------------------------------------------------
# http2 rather than the default: QUIC's control stream fails continuously on
# some networks, and the tunnel serves 530 the whole time it retries.
$config = @"
tunnel: $uuid
credentials-file: $credentials
protocol: http2

originRequest:
  connectTimeout: 30s

ingress:
  - hostname: $HostName
    service: http://127.0.0.1:$Port
  - service: http_status:404
"@

$configPath = Join-Path $cfDir "config.yml"
Set-Content -Path $configPath -Value $config -Encoding utf8
Write-Host "Wrote $configPath"

# --- DNS ------------------------------------------------------
# Same stderr caveat as above. An already-routed hostname is reported here as a
# normal info line, not a failure, so nothing needs special-casing.
Write-Host "Routing $HostName to tunnel $TunnelName..."
& $exe tunnel route dns $TunnelName $HostName

Write-Host ""
Write-Host "Done. Start both halves:" -ForegroundColor Green
Write-Host "  npm start"
Write-Host ('  & "' + $exe + '" tunnel run ' + $TunnelName)
Write-Host ""
Write-Host ("Then open https://" + $HostName)
Write-Host ""
Write-Host "To survive a closed terminal and reboots (needs an admin shell):" -ForegroundColor Green
Write-Host ('  & "' + $exe + '" service install')
Write-Host "  Start-Service cloudflared"
