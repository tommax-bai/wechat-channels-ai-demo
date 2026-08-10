# Partner API 接入文档

Partner API 供其他业务服务接入视频号登录、托管、回复配置、业务微信二维码、评论和私信展示。当前 DEV 地址：

只接入账号创建、扫码登录、登录过期判断和业务联系二维码时，可直接使用聚焦文档 [`partner-login-contact-qr-api.md`](./partner-login-contact-qr-api.md)。

```text
https://dev.yytt.com.cn/partner/v1
```

## 1. 接入边界

这是服务端到服务端接口。调用方后端持有 Partner API Key，再把所需数据提供给自己的前端：

```text
同事的浏览器 -> 同事的后端 -> Partner API
```

- 不要把 Partner API Key 写入网页、App 包、仓库或日志。
- 不支持浏览器直接跨域调用；接口不开放 CORS。
- 不使用 Demo 页面的 Cookie，也不依赖浏览器会话选择。
- 一个 Partner API Key 可以访问这个 Demo 服务保留的全部账号；`accountId` 只是账号容器标识，不是租户权限边界。
- 所有响应都使用 `Cache-Control: no-store`，不会设置浏览器会话 Cookie。
- 接口不会返回视频号 Cookie、Finder 标识、平台目标、具体模型名、上游地址或上游请求 ID。
- 业务微信二维码图片只在 `PUT /accounts/{accountId}/wechat-qr` 请求中进入服务；Partner 响应和账号投影只返回配置元数据，永不返回该图片的 data URL 或 Base64 内容。

## 2. 通用约定

所有接口都需要 Bearer 认证：

```http
Authorization: Bearer <PARTNER_API_KEY>
Accept: application/json
```

发送 JSON 时增加：

```http
Content-Type: application/json
```

本文 curl 示例使用占位符：

```bash
export PARTNER_API_BASE='https://dev.yytt.com.cn/partner/v1'
export PARTNER_API_KEY='<通过安全渠道获取的 Partner API Key>'
```

通用规则：

- 请求和响应字段使用 camelCase。
- 时间均为 RFC 3339 字符串，例如 `2026-08-09T04:20:00.000Z`。
- `accountId`、内容 `id` 和分页 `cursor` 都是不透明字符串；调用方只能原样保存和回传。
- 失败响应为 `{"error":"<稳定错误码>"}`。
- `POST` 接口不提供幂等键；调用方应保存成功响应，避免因网络超时盲目重复创建账号或二维码。

## 3. 推荐接入流程

1. 调用 `GET /capabilities` 获取可用回复方式。
2. 调用 `POST /accounts` 创建账号容器并保存 `accountId`。
3. 调用 `POST /accounts/{accountId}/login/qr` 获取二维码。
4. 每 2 秒调用 `GET /accounts/{accountId}/login/status`，分别判断是否扫码和是否登录完成。
5. 登录完成后读取 `GET /accounts/{accountId}/hosting`。只有 `loginExpired: true` 才表示平台明确要求重新登录。
6. 新账号已经默认使用招聘接口和岗位 ID `4add94fa-0d2d-4cd8-8f1c-deecdb6fb8cb`；如需覆盖默认值，再调用 `PUT /accounts/{accountId}/reply-settings`。
7. 使用招聘接口且需要发送业务微信二维码时，调用 `PUT /accounts/{accountId}/wechat-qr` 配置当前账号的图片。
8. 新账号已经默认开启自动回复；如需暂停或恢复，再调用 `PUT /accounts/{accountId}/hosting`。
9. 分别分页读取 `/comments` 和 `/direct-messages`，按内容 `id` 更新已有记录。

## 4. 公共数据结构

### 4.1 AccountProjection

账号创建、账号详情、托管和回复方式修改接口返回完整账号投影；业务微信二维码专用接口返回更窄的元数据响应：

```json
{
  "accountId": "<opaque-account-id>",
  "accountDisplayName": "tom白",
  "createdAt": "2026-08-09T04:00:00.000Z",
  "updatedAt": "2026-08-09T04:20:00.000Z",
  "login": {
    "state": "succeeded",
    "scanned": true,
    "succeeded": true,
    "qrDataUrl": null,
    "qrExpiresAt": null,
    "errorCode": null
  },
  "hosting": {
    "state": "active",
    "automationEnabled": true,
    "automationEffective": true,
    "loginExpired": false,
    "reloginRequired": false,
    "credentialExpiresAt": null
  },
  "replySettings": {
    "provider": "funnel",
    "providerConfigured": true,
    "jobNumber": "4add94fa-0d2d-4cd8-8f1c-deecdb6fb8cb"
  },
  "wechatQr": {
    "configured": true,
    "mimeType": "image/png",
    "byteLength": 18432,
    "updatedAt": "2026-08-09T04:18:00.000Z"
  },
  "sources": {
    "comments": {
      "state": "healthy",
      "baselineComplete": true,
      "lastSuccessAt": "2026-08-09T04:19:58.000Z",
      "errorCode": null
    },
    "directMessages": {
      "state": "healthy",
      "baselineComplete": true,
      "lastSuccessAt": "2026-08-09T04:19:59.000Z",
      "errorCode": null
    }
  }
}
```

`accountDisplayName` 在登录完成前可以为 `null`。`automationEnabled` 是实际保存的自动回复开关（服务或所选回复方式不可用时不会保存为开启），`automationEffective` 表示服务总开关、登录和所选回复方式当前都可用；界面展示实际托管能力时应以后者为准。

`wechatQr.configured` 表示该账号是否已配置业务微信二维码。未配置时 `mimeType`、`byteLength`、`updatedAt` 都是 `null`；已配置时只返回 MIME、解码后字节数和更新时间。此投影不会返回二维码图片内容，也不要把登录二维码的 `login.qrDataUrl` 当作业务微信二维码。

`sources.comments` 和 `sources.directMessages` 的 `state` 可为：

| 状态 | 含义 |
| --- | --- |
| `pending` | 尚未完成首次同步 |
| `healthy` | 最近一次同步成功 |
| `auth_required` | 平台明确拒绝当前登录态 |
| `schema_changed` | 平台响应结构不再符合当前适配器 |
| `error` | 其他同步错误 |

### 4.2 登录状态

`login.state` 与布尔字段的含义如下：

| `state` | `scanned` | `succeeded` | 是否继续轮询 | 含义 |
| --- | ---: | ---: | ---: | --- |
| `not_requested` | false | false | 否 | 尚未创建二维码 |
| `waiting_scan` | false | false | 是 | 二维码可展示，等待微信扫码 |
| `scanned` | true | false | 是 | 已扫码，但登录尚未完成 |
| `initializing` | true | false | 是 | 正在验证并持久化视频号上下文 |
| `succeeded` | true | true | 否 | 登录上下文已验证并保存 |
| `qr_expired` | false | false | 否 | 本次二维码已过期，可重新生成 |
| `cancelled` | false | false | 否 | 本次登录被取消 |
| `no_account` | false | false | 否 | 已确认微信身份，但没有可用的视频号身份 |
| `login_required` | false | false | 否 | 已托管登录后来被平台明确判定失效 |
| `failed` | false | false | 否 | 登录初始化出现其他错误；查看 `errorCode` |

`scanned: true` 不能当作登录成功；只有 `succeeded: true` 才能进入后续托管流程。二维码过期只代表本次扫码尝试过期，不代表一个既有托管账号的登录凭证过期。

### 4.3 托管状态

| `hosting.state` | 含义 |
| --- | --- |
| `not_ready` | 尚未完成登录 |
| `initializing` | 登录已完成，评论或私信仍在初始化同步 |
| `active` | 登录和同步可用，自动回复有效 |
| `paused` | 登录仍可用，但自动回复已暂停 |
| `degraded` | 登录未被判定过期，但来源同步或配置存在错误 |
| `expired` | 平台明确要求重新登录 |

平台没有可依赖的固定 8 小时有效期，所以 `credentialExpiresAt` 当前始终是 `null`。只有 `loginExpired: true` 和 `reloginRequired: true` 才表示需要重新扫码；不要使用本地计时推断登录过期。

## 5. 能力与回复方式

### GET /capabilities

获取稳定的回复方式 ID 和部署可用性：

```bash
curl --fail-with-body \
  -H "Authorization: Bearer ${PARTNER_API_KEY}" \
  "${PARTNER_API_BASE}/capabilities"
```

```json
{
  "apiVersion": "v1",
  "providers": [
    {
      "id": "chat-llm",
      "displayName": "CHAT回复",
      "configured": true,
      "requiresJobNumber": false
    },
    {
      "id": "funnel",
      "displayName": "招聘接口",
      "configured": true,
      "requiresJobNumber": true
    }
  ],
  "jobSelection": {
    "mode": "known_job_number",
    "catalogueAvailable": false
  }
}
```

`configured: false` 表示 DEV 服务当前没有配置该回复方式。Partner API 不返回具体模型名。

岗位选择仅支持调用方提交已经从业务侧获得的 `jobNumber`。当前 Funnel 契约没有岗位列表或岗位详情接口，因此 Partner API 不提供岗位目录，也不会预先验证岗位是否存在。

## 6. 账号接口

### POST /accounts

创建一个待扫码账号容器。新账号默认开启自动回复，使用招聘接口，并保存岗位 ID `4add94fa-0d2d-4cd8-8f1c-deecdb6fb8cb`。请求体为空，成功返回 HTTP 201 和完整 `AccountProjection`；登录和基线初始化完成前，`automationEffective` 仍为 `false`。

如果服务端没有配置招聘接口，本请求返回 HTTP 503 和 `funnel_provider_unavailable`，且不会创建账号容器。

```bash
curl --fail-with-body -X POST \
  -H "Authorization: Bearer ${PARTNER_API_KEY}" \
  "${PARTNER_API_BASE}/accounts"
```

调用方必须保存返回的 `accountId`。重复调用会创建不同账号。

### GET /accounts

列出全部仍保留的账号，包括尚未扫码、扫码中、已登录、暂停和平台失效状态；已删除账号不会返回。

```bash
curl --fail-with-body \
  -H "Authorization: Bearer ${PARTNER_API_KEY}" \
  "${PARTNER_API_BASE}/accounts"
```

响应为 `{"items":[...]}`，其中每个元素都是 4.1 节定义的完整 `AccountProjection`。

### GET /accounts/{accountId}

获取单个账号的完整投影：

```bash
curl --fail-with-body \
  -H "Authorization: Bearer ${PARTNER_API_KEY}" \
  "${PARTNER_API_BASE}/accounts/<accountId>"
```

### DELETE /accounts/{accountId}

删除账号、持久化登录凭证及其评论和私信数据。成功返回 HTTP 204。删除后无法恢复；如有平台发送正在进行，接口返回冲突且保留账号。

```bash
curl --fail-with-body -X DELETE \
  -H "Authorization: Bearer ${PARTNER_API_KEY}" \
  "${PARTNER_API_BASE}/accounts/<accountId>"
```

## 7. 二维码登录

### POST /accounts/{accountId}/login/qr

创建或刷新二维码，成功返回完整 `AccountProjection`。其中：

```json
{
  "login": {
    "state": "waiting_scan",
    "scanned": false,
    "succeeded": false,
    "qrDataUrl": "data:image/png;base64,<base64-data>",
    "qrExpiresAt": "2026-08-09T04:05:00.000Z",
    "errorCode": null
  }
}
```

将 `qrDataUrl` 直接作为图片 `src` 展示，不要解析或外传其中的数据。只有 `waiting_scan` 状态返回二维码和过期时间；进入其他状态后二者均为 `null`。

如果创建二维码时平台请求失败，接口返回 HTTP 502 和 `partner_login_qr_unavailable`，不会保存一个伪登录尝试。调用方可在网络恢复后明确重试本接口。

```bash
curl --fail-with-body -X POST \
  -H "Authorization: Bearer ${PARTNER_API_KEY}" \
  "${PARTNER_API_BASE}/accounts/<accountId>/login/qr"
```

可刷新状态：`not_requested`、`waiting_scan`、`qr_expired`、`cancelled`、`no_account`、`login_required`、`failed`。如果账号正在初始化或已有有效托管登录，接口返回 HTTP 409，不会清除已有登录和内容。

### GET /accounts/{accountId}/login/status

轮询当前登录状态：

```bash
curl --fail-with-body \
  -H "Authorization: Bearer ${PARTNER_API_KEY}" \
  "${PARTNER_API_BASE}/accounts/<accountId>/login/status"
```

```json
{
  "accountId": "<opaque-account-id>",
  "accountDisplayName": "tom白",
  "login": {
    "state": "scanned",
    "scanned": true,
    "succeeded": false,
    "qrDataUrl": null,
    "qrExpiresAt": null,
    "errorCode": null
  }
}
```

建议每 2 秒轮询一次。进入 `succeeded` 或任一失败/终止状态后停止。页面关闭不会停止服务端托管；下次访问先调用 `GET /accounts` 找回账号。

## 8. 托管与回复配置

### GET /accounts/{accountId}/hosting

读取托管状态：

```bash
curl --fail-with-body \
  -H "Authorization: Bearer ${PARTNER_API_KEY}" \
  "${PARTNER_API_BASE}/accounts/<accountId>/hosting"
```

```json
{
  "accountId": "<opaque-account-id>",
  "hosting": {
    "state": "paused",
    "automationEnabled": false,
    "automationEffective": false,
    "loginExpired": false,
    "reloginRequired": false,
    "credentialExpiresAt": null
  },
  "sources": {
    "comments": {
      "state": "healthy",
      "baselineComplete": true,
      "lastSuccessAt": "2026-08-09T04:19:58.000Z",
      "errorCode": null
    },
    "directMessages": {
      "state": "healthy",
      "baselineComplete": true,
      "lastSuccessAt": "2026-08-09T04:19:59.000Z",
      "errorCode": null
    }
  }
}
```

### PUT /accounts/{accountId}/hosting

开启或暂停自动回复，成功返回完整 `AccountProjection`：

```bash
curl --fail-with-body -X PUT \
  -H "Authorization: Bearer ${PARTNER_API_KEY}" \
  -H 'Content-Type: application/json' \
  --data '{"enabled":true}' \
  "${PARTNER_API_BASE}/accounts/<accountId>/hosting"
```

即使自动回复暂停，服务仍按现有机制同步评论和私信。所选回复方式未配置或登录不可用时，`automationEffective` 为 `false`。

### PUT /accounts/{accountId}/reply-settings

选择 CHAT 回复：

```bash
curl --fail-with-body -X PUT \
  -H "Authorization: Bearer ${PARTNER_API_KEY}" \
  -H 'Content-Type: application/json' \
  --data '{"provider":"chat-llm"}' \
  "${PARTNER_API_BASE}/accounts/<accountId>/reply-settings"
```

选择招聘接口并指定已知岗位号：

```bash
curl --fail-with-body -X PUT \
  -H "Authorization: Bearer ${PARTNER_API_KEY}" \
  -H 'Content-Type: application/json' \
  --data '{"provider":"funnel","jobNumber":"<known-job-number>"}' \
  "${PARTNER_API_BASE}/accounts/<accountId>/reply-settings"
```

成功返回完整 `AccountProjection`。选择 `funnel` 时 `jobNumber` 去除首尾空白后必须非空；缺失时返回 `funnel_job_number_required`，原设置不变。岗位是否真实存在由后续 Funnel 调用结果决定。

## 9. 业务微信二维码

每个账号最多保存一张业务微信二维码。只接受非空 PNG 或 JPEG data URL，Base64 解码后的图片不得超过 512 KiB；声明的 MIME 必须与图片魔数一致。Partner API 不接受远程 URL，也不会在任何响应中回传图片内容。

### GET /accounts/{accountId}/wechat-qr

读取当前账号的配置元数据：

```bash
curl --fail-with-body \
  -H "Authorization: Bearer ${PARTNER_API_KEY}" \
  "${PARTNER_API_BASE}/accounts/<accountId>/wechat-qr"
```

```json
{
  "accountId": "<opaque-account-id>",
  "wechatQr": {
    "configured": true,
    "mimeType": "image/png",
    "byteLength": 18432,
    "updatedAt": "2026-08-09T04:18:00.000Z"
  }
}
```

### PUT /accounts/{accountId}/wechat-qr

配置或原子替换当前账号的二维码。`dataUrl` 只能由调用方后端发送，不要把 Partner API Key 或该请求放到浏览器：

```bash
curl --fail-with-body -X PUT \
  -H "Authorization: Bearer ${PARTNER_API_KEY}" \
  -H 'Content-Type: application/json' \
  --data '{"dataUrl":"data:image/png;base64,<base64-data>"}' \
  "${PARTNER_API_BASE}/accounts/<accountId>/wechat-qr"
```

成功返回与 GET 相同的 `{accountId,wechatQr}` 元数据，不回显 `dataUrl`。输入无效或超过 512 KiB 时原二维码保持不变。

### DELETE /accounts/{accountId}/wechat-qr

只删除当前账号的业务微信二维码，不删除账号、登录态、评论或私信：

```bash
curl --fail-with-body -X DELETE \
  -H "Authorization: Bearer ${PARTNER_API_KEY}" \
  "${PARTNER_API_BASE}/accounts/<accountId>/wechat-qr"
```

成功返回 HTTP 200：

```json
{
  "accountId": "<opaque-account-id>",
  "wechatQr": {
    "configured": false,
    "mimeType": null,
    "byteLength": null,
    "updatedAt": null
  }
}
```

## 10. 评论和私信

### GET /accounts/{accountId}/comments

```bash
curl --fail-with-body \
  -H "Authorization: Bearer ${PARTNER_API_KEY}" \
  "${PARTNER_API_BASE}/accounts/<accountId>/comments?limit=50"
```

### GET /accounts/{accountId}/direct-messages

```bash
curl --fail-with-body \
  -H "Authorization: Bearer ${PARTNER_API_KEY}" \
  "${PARTNER_API_BASE}/accounts/<accountId>/direct-messages?limit=50"
```

两类接口返回相同分页外壳：

```json
{
  "items": [
    {
      "id": "<opaque-content-id>",
      "source": "comment",
      "authorName": "访客A",
      "text": "这个岗位包住吗？",
      "occurredAt": "2026-08-09T04:30:00.000Z",
      "discoveredAt": "2026-08-09T04:30:02.000Z",
      "historical": false,
      "replyEligible": true,
      "reply": {
        "state": "confirmed",
        "text": "提供住宿，具体安排可以继续沟通。",
        "messages": ["提供住宿，具体安排可以继续沟通。"],
        "errorCode": null,
        "updatedAt": "2026-08-09T04:30:05.000Z"
      }
    }
  ],
  "hasMore": true,
  "nextCursor": "<opaque-cursor>"
}
```

`source` 在评论接口中固定为 `comment`，在私信接口中固定为 `dm`。私信回复可能分为多个消息气泡，调用方必须使用 `reply.messages` 保留顺序；`reply.text` 是便于列表展示的单段文本。仅发送业务微信二维码而没有文字气泡时，`reply.text` 为 `""`、`reply.messages` 为 `[]`。尚未产生回复时 `reply` 为 `null`。

`reply.state` 可为：

| 状态 | 含义 |
| --- | --- |
| `queued` | 已进入回复队列 |
| `generating` | 正在生成回复 |
| `generated` | 回复已生成，等待发送 |
| `sending` | 正在发送到平台 |
| `confirmed` | 平台已确认发送 |
| `skipped` | 按规则跳过 |
| `failed` | 处理失败，查看 `errorCode` |
| `submitted_unknown` | 已提交，但无法确认平台最终结果；不能当作成功 |

### 分页规则

- `limit` 默认 50，范围 1 到 100。
- 首次请求不传 `cursor`。
- 返回 `hasMore: true` 时，将 `nextCursor` 原样用于下一页。
- `nextCursor` 绑定账号和内容来源，不能在另一个账号或评论/私信接口间复用。
- 数据按服务发现时间倒序排列；cursor 不是跨账号删除或重新登录的永久书签。

下一页示例：

```bash
curl --fail-with-body \
  -H "Authorization: Bearer ${PARTNER_API_KEY}" \
  "${PARTNER_API_BASE}/accounts/<accountId>/comments?limit=50&cursor=<url-encoded-cursor>"
```

回复状态是异步变化的。同一个内容 `id` 可能先是 `generating`，之后变为 `confirmed` 或 `failed`；调用方轮询第一页时应按 `id` upsert，不要只追加。

## 11. 错误码

所有失败响应都是：

```json
{
  "error": "partner_account_not_found"
}
```

| HTTP | `error` | 含义 |
| ---: | --- | --- |
| 400 | `invalid_request` | JSON、路径参数或查询参数不符合接口约束 |
| 400 | `invalid_cursor` | cursor 损坏，或用于了不同账号/来源 |
| 400 | `funnel_job_number_required` | 选择 `funnel` 时没有提供非空岗位号 |
| 400 | `account_wechat_qr_invalid` | 二维码不是有效且 MIME 匹配的 PNG/JPEG data URL；原配置不变 |
| 400 | `account_wechat_qr_too_large` | 二维码解码后超过 512 KiB；原配置不变 |
| 401 | `partner_api_unauthorized` | Bearer Key 缺失或不匹配 |
| 404 | `partner_account_not_found` | 账号不存在、已删除、已退出或不再保留 |
| 409 | `login_in_progress` | 当前登录正在扫码后初始化，不能刷新二维码 |
| 409 | `account_already_hosted` | 账号已有有效托管上下文，不能刷新二维码 |
| 409 | `platform_send_in_flight` | 删除账号时仍有平台发送正在进行 |
| 502 | `partner_login_qr_unavailable` | 平台二维码创建暂时失败；本次未创建登录尝试，可稍后重试 |
| 503 | `partner_api_unavailable` | DEV 服务没有配置 Partner API Key |
| 503 | `active_session_limit_reached` | 已达到 Demo 保留账号上限 |
| 503 | `funnel_provider_unavailable` | 服务端没有配置 Funnel 回复能力 |

认证失败响应带 `WWW-Authenticate: Bearer`。客户端可以根据 HTTP 状态处理大类、根据稳定 `error` 字段展示业务原因；不要依赖服务端错误文案。

## 12. 已知限制

- 当前只有一个共享 Partner API Key，没有调用方隔离、细粒度权限、限流或 webhook。
- 不提供岗位列表；调用方自行保存并提交已知 `jobNumber`。
- 不提供浏览器直连或 CORS。
- 不暴露评论者到新私信会话的创建能力。
- 内容接口是轮询读取；它不会改变现有的服务端同步和自动回复逻辑。
- 删除账号是不可恢复操作；重新创建账号会得到新的 `accountId`。

机器可读契约见 [`partner-api.openapi.yaml`](./partner-api.openapi.yaml)。
