# Publishing PayAI at payai.lanvar.ai

PayAI is a stateful Node server with a SQLite ledger and long-lived SSE streams,
so it does not run on Workers. A Cloudflare Tunnel publishes it on the subdomain
instead: `cloudflared` dials out to Cloudflare and Cloudflare terminates TLS, so
nothing needs a public IP, an open port, or a certificate.

`cloudflared` is already installed (`winget install Cloudflare.cloudflared`,
v2026.7.3, at `C:\Program Files (x86)\cloudflared\cloudflared.exe`).

## One-time setup

The first step opens a browser to pick the `lanvar.ai` zone — it authorizes your
Cloudflare account, so it has to be you.

```powershell
$cf = "C:\Program Files (x86)\cloudflared\cloudflared.exe"

# 1. Authorize (browser opens — choose lanvar.ai). Writes ~/.cloudflared/cert.pem
& $cf tunnel login

# 2. Create the tunnel. Prints a UUID and writes <UUID>.json beside cert.pem
& $cf tunnel create payai

# 3. Point the subdomain at it — this creates the DNS record for you
& $cf tunnel route dns payai payai.lanvar.ai
```

Then copy `config.yml` from this folder to `~\.cloudflared\config.yml` and
replace both `<TUNNEL-UUID>` placeholders with the UUID from step 2.

## Running it

Two processes: the app, and the tunnel.

```powershell
# App
cd C:\Users\athav\Documents\PayAI
npm start

# Tunnel (separate terminal)
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel run payai
```

`payai.lanvar.ai` is live while both are running.

## Keeping it up during the demo

The tunnel dies with the terminal. To survive a closed window and a reboot,
install it as a Windows service:

```powershell
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" service install
Start-Service cloudflared
```

The app itself still needs a supervisor — `pm2 start src/server.js --name payai`
or a Task Scheduler entry at logon. Whatever runs it, **the laptop has to stay
awake**: a tunnel is a reverse proxy to this machine, not a copy of it. Disable
sleep before you present.

## Configuration that matters

**`PAYAI_PUBLIC_URL` must equal the public origin** — it is set to
`https://payai.lanvar.ai` in `.env`. This is not cosmetic. x402 payment
requirements embed the resource URL, and a client signs against the URL the
server advertised. If they disagree, `findMatchingRequirements` rejects every
payment and top-ups fail with "does not match any accepted requirement". The
discovery manifest at `/.well-known/x402` publishes the same value, so a wrong
one also hands agents endpoints they cannot reach.

## Two transport gotchas

**QUIC.** The default transport failed continuously on this network — the
control stream dropped and retried with backoff while the tunnel returned HTTP
530. `protocol: http2` in `config.yml` fixes it. If you run the tunnel by hand,
pass `--protocol http2`.

**SSE.** The live balance feed holds a response open indefinitely. The server
already sets `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`
and sends a keepalive every 15s, which is what keeps Cloudflare from buffering
or closing it. The dashboard also polls every 1.5s, so the meter keeps moving
even if a proxy does buffer the stream.

## Throwaway URL for a quick check

No account or DNS needed — prints a random `trycloudflare.com` hostname:

```powershell
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://127.0.0.1:4020 --protocol http2
```

Useful for testing from a phone. It changes every run, so it is not the demo URL.
