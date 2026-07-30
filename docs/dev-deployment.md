# DEV deployment

The standalone Demo is deployed independently from every AIDCP and isales
runtime.

## Runtime layout

| Path | Purpose |
|---|---|
| `/opt/wechat-channels-ai-demo/current` | committed application source, build output, and production dependencies |
| `/opt/wechat-channels-ai-demo/runtime/node` | isolated verified Node.js 22 runtime |
| `/usr/bin/google-chrome-stable` | Alibaba Cloud mirror Chrome used only for bounded post-scan context capture |
| `/opt/wechat-channels-ai-demo/shared/demo.env` | root-owned `0600` deployment secrets and configuration |
| `/opt/wechat-channels-ai-demo/data` | `wechat-demo`-owned SQLite data |
| `/etc/systemd/system/wechat-channels-ai-demo.service` | independent service unit |
| `/etc/nginx/conf.d/wechat-channels-ai-demo.conf` | fixed HTTPS reverse proxy for `dev.yytt.com.cn` |

The DEV service stays bound to `127.0.0.1:4310`. Nginx redirects HTTP to HTTPS,
terminates TLS for `https://dev.yytt.com.cn`, proxies only this hostname to the
Demo listener, and leaves all AIDCP/isales server blocks unchanged. The public
Demo uses `PUBLIC_ORIGIN=https://dev.yytt.com.cn` and
`SESSION_COOKIE_SECURE=1`. This fixed origin supports the normal same-origin
SSE path; the client retains its five-second polling fallback only for any
future `.trycloudflare.com` fallback.

QR creation and polling remain pure HTTP. After scan confirmation the service
starts an isolated headless Chrome process, imports that login's bounded WeChat
cookies, captures one exact first-party `/auth/auth_data` request, encrypts the
validated request context, and closes Chrome before background synchronization
starts. Install the signed current x86_64 Chrome RPM from Alibaba Cloud's
`https://mirrors.aliyun.com/google-chrome/` mirror and configure
`WECHAT_BROWSER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable`.

Remote dependency installation uses Alibaba Cloud's npm mirror and must replace
every lockfile registry host:

```bash
npm ci --registry=https://registry.npmmirror.com \
  --replace-registry-host=always
```

On a first deployment, install the dedicated port-80 ACME challenge block and
reload Nginx before requesting the certificate with Certbot's webroot mode.
Only after `/etc/letsencrypt/live/dev.yytt.com.cn/` exists may the final
HTTP-redirect plus HTTPS server blocks be installed. Run `nginx -t` before
every reload and leave Certbot's renewal timer enabled.

## Validation

- `systemctl is-active wechat-channels-ai-demo.service`
- `systemctl is-active nginx`
- `curl http://127.0.0.1:4310/healthz`
- `curl http://127.0.0.1:4310/readyz`
- `curl -I http://dev.yytt.com.cn/healthz` and require an HTTPS redirect
- `curl https://dev.yytt.com.cn/healthz`
- verify the certificate hostname and expiry for `dev.yytt.com.cn`
- create one anonymous session and request a QR without scanning it
- scan once and require a non-empty capture-backed post/comment read before
  enabling the live comment reply test
- call the configured Ark model with synthetic text and record only status,
  returned model identity, and request-ID presence
- confirm `aidcp-cloud.service` and all `isales*` services remain active

Never print or copy `demo.env` into logs, OpenSpec evidence, or shell history.

## Rollback

Disable only the dedicated `dev.yytt.com.cn` Nginx server block to remove public
access. For an application rollback, stop `wechat-channels-ai-demo.service`,
restore the previous `current` target, and start the same unit again. Deleting
the isolated data directory is a separate destructive action and is not part
of a normal rollback.
