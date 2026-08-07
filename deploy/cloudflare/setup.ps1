<#
  Wires payai.lanvar.ai to the local PayAI server.

  Run `cloudflared tunnel login` first — that opens a browser and is the one
  step that needs you. Everything after it is here.

  Safe to re-run: it reuses an existing tunnel and rewrites the config.
#>

param(
  [string]$Hostname = "payai.lanvar.ai",
  [string]$TunnelName = "payai",
  [int]$Port = 4020
)

$ErrorActionPreference = "Stop"

$cf = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
if (-not (Test-Path $cf)) {
  $cf = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
}
if (-not $cf) { throw "cloudflared not found. Install: winget install Cloudflare.cloudflared" }

$cfDir = Join-Path $env:USERPROFILE ".cloudflared"

if (-not (Test-Path (Join-Path $cfDir "cert.pem"))) {
  Write-Host "Not authorized yet. Run this first, pick lanvar.ai in the browser:" -ForegroundColor Yellow
  Write-Host "  & `"$cf`" tunnel login" -ForegroundColor Cyan
  exit 1
}

# ── Tunnel ────────────────────────────────────────────────────
# `tunnel create` fails if the name is taken, so reuse it when it already
# exists — that makes this script safe to run twice.
$existing = & $cf tunnel list --output json | ConvertFrom-Json | Where-Object { $_.name -eq $TunnelName }

if ($existing) {
  $uuid = $existing.id
  Write-Host "Reusing tunnel '$TunnelName' ($uuid)"
} else {
  Write-Host "Creating tunnel '$TunnelName'…"
  & $cf tunnel create $TunnelName | Out-Host
  $uuid = (& $cf tunnel list --output json | ConvertFrom-Json | Where-Object { $_.name -eq $TunnelName }).id
  if (-not $uuid) { throw "Tunnel created but no id came back — check `cloudflared tunnel list`" }
}

$credentials = Join-Path $cfDir "$uuid.json"
if (-not (Test-Path $credentials)) { throw "Credentials file missing: $credentials" }

# ── Config ────────────────────────────────────────────────────
# http2 rather than the default: QUIC's control stream fails continuously on
# some networks and the tunnel serves 530 while it retries.
$config = @"
tunnel: $uuid
credentials-file: $credentials
protocol: http2

originRequest:
  connectTimeout: 30s

ingress:
  - hostname: $Hostname
    service: http://127.0.0.1:$Port
  - service: http_status:404
"@

$configPath = Join-Path $cfDir "config.yml"
Set-Content -Path $configPath -Value $config -Encoding utf8
Write-Host "Wrote $configPath"

# ── DNS ───────────────────────────────────────────────────────
Write-Host "Routing $Hostname -> $TunnelName…"
try {
  & $cf tunnel route dns $TunnelName $Hostname | Out-Host
} catch {
  # Already-exists is fine; anything else is not.
  Write-Host "  (record may already exist — continuing)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Done. Start it with:" -ForegroundColor Green
Write-Host "  cd $PSScriptRoot\..\..; npm start"
Write-Host "  & `"$cf`" tunnel run $TunnelName"
Write-Host ""
Write-Host "Then: https://$Hostname"
Write-Host ""
Write-Host "To survive a closed terminal and reboots:" -ForegroundColor Green
Write-Host "  & `"$cf`" service install; Start-Service cloudflared"
