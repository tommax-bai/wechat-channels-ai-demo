# DEV deployment

The standalone Demo is deployed independently from every AIDCP and isales
runtime.

## Runtime layout

| Path | Purpose |
|---|---|
| `/opt/wechat-channels-ai-demo/current` | committed application source, build output, and production dependencies |
| `/opt/wechat-channels-ai-demo/runtime/node` | isolated verified Node.js 22 runtime |
| `/opt/wechat-channels-ai-demo/shared/demo.env` | root-owned `0600` deployment secrets and configuration |
| `/opt/wechat-channels-ai-demo/data` | `wechat-demo`-owned SQLite data |
| `/etc/systemd/system/wechat-channels-ai-demo.service` | independent service unit |

The DEV service binds only to `127.0.0.1:4310`. This environment currently has
no suitable HTTPS hostname, so the Demo must not be exposed over public HTTP.
Use an SSH tunnel for operator validation:

```bash
ssh -i ~/codes/dev-0722.pem -N \
  -L 4310:127.0.0.1:4310 root@121.89.85.150
```

Then open `http://localhost:4310`. Public customer access remains blocked until
an HTTPS hostname and reverse-proxy configuration are explicitly assigned.

## Validation

- `systemctl is-active wechat-channels-ai-demo.service`
- `curl http://127.0.0.1:4310/healthz`
- `curl http://127.0.0.1:4310/readyz`
- create one anonymous session and request a QR without scanning it
- call the configured Ark model with synthetic text and record only status,
  returned model identity, and request-ID presence
- confirm `aidcp-cloud.service` and all `isales*` services remain active

Never print or copy `demo.env` into logs, OpenSpec evidence, or shell history.

## Rollback

Stop and disable only `wechat-channels-ai-demo.service`, restore the previous
`current` backup if one exists, and start the same unit again. Deleting the
isolated data directory is a separate destructive action and is not part of a
normal rollback.
