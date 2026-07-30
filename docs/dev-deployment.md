# DEV deployment

The standalone Demo is deployed independently from every AIDCP and isales
runtime.

## Runtime layout

| Path | Purpose |
|---|---|
| `/opt/wechat-channels-ai-demo/current` | committed application source, build output, and production dependencies |
| `/opt/wechat-channels-ai-demo/runtime/node` | isolated verified Node.js 22 runtime |
| `/opt/wechat-channels-ai-demo/runtime/cloudflared-2026.7.3` | checksum-verified Quick Tunnel client |
| `/opt/wechat-channels-ai-demo/shared/demo.env` | root-owned `0600` deployment secrets and configuration |
| `/opt/wechat-channels-ai-demo/data` | `wechat-demo`-owned SQLite data |
| `/etc/systemd/system/wechat-channels-ai-demo.service` | independent service unit |
| `/etc/systemd/system/wechat-channels-ai-demo-tunnel.service` | independent public HTTPS tunnel unit |

The DEV service stays bound to `127.0.0.1:4310`. A Cloudflare Quick Tunnel
publishes that loopback listener at an ephemeral `https://*.trycloudflare.com`
URL without changing the application listener or any AIDCP/isales service.
The public Demo intentionally has no additional access-control layer and uses
`SESSION_COOKIE_SECURE=1`. Retrieve the current URL from the tunnel metrics API:

```bash
curl -fsS http://127.0.0.1:4311/quicktunnel
```

The hostname changes whenever the tunnel process is recreated. Quick Tunnel
does not carry the page's SSE stream, so the public client uses bounded
five-second snapshot polling while keeping SSE for direct/local access.

Remote dependency installation uses Alibaba Cloud's npm mirror and must replace
every lockfile registry host:

```bash
npm ci --registry=https://registry.npmmirror.com \
  --replace-registry-host=always
```

## Validation

- `systemctl is-active wechat-channels-ai-demo.service`
- `systemctl is-active wechat-channels-ai-demo-tunnel.service`
- `curl http://127.0.0.1:4310/healthz`
- `curl http://127.0.0.1:4310/readyz`
- `curl http://127.0.0.1:4311/ready`
- open the current Quick Tunnel URL and verify its `/healthz`
- create one anonymous session and request a QR without scanning it
- call the configured Ark model with synthetic text and record only status,
  returned model identity, and request-ID presence
- confirm `aidcp-cloud.service` and all `isales*` services remain active

Never print or copy `demo.env` into logs, OpenSpec evidence, or shell history.

## Rollback

Stop only `wechat-channels-ai-demo-tunnel.service` to remove public access.
For an application rollback, stop `wechat-channels-ai-demo.service`, restore
the previous `current` target, and start the same unit again. Deleting the
isolated data directory is a separate destructive action and is not part of a
normal rollback.
