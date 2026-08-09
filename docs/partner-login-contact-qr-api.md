# 视频号登录与联系二维码接口

本文面向接入方后端，说明账号容器、视频号扫码登录、登录状态、托管登录过期判断，以及业务联系二维码的配置接口。

## 1. 接入地址与鉴权

DEV Base URL：

```text
https://dev.yytt.com.cn/partner/v1
```

所有接口都需要 Bearer 鉴权：

```http
Authorization: Bearer <PARTNER_API_KEY>
Accept: application/json
```

发送 JSON 时增加：

```http
Content-Type: application/json
```

调用链应为：

```text
业务前端 -> 业务后端 -> Partner API
```

Partner API Key 只能由业务后端持有，不得写入网页、App 包、仓库或日志。Partner API 不开放 CORS，也不依赖 Demo 页面的浏览器 Cookie。

当前服务只有一个共享 Partner API Key，没有调用方或租户隔离。任何持有该 Key 的调用方都能通过 `GET /accounts` 查看并操作服务保留的全部账号；`accountId` 只是账号容器标识，不是权限边界。仅应把 Key 提供给处于同一信任边界的后端服务。

本文 curl 示例使用：

```bash
export PARTNER_API_BASE='https://dev.yytt.com.cn/partner/v1'
export PARTNER_API_KEY='<通过安全渠道取得的 Partner API Key>'
export ACCOUNT_ID='<POST /accounts 返回的 accountId>'
```

失败响应统一为：

```json
{
  "error": "<稳定错误码>"
}
```

## 2. 推荐流程

1. `POST /accounts` 创建账号容器并保存 `accountId`。
2. `POST /accounts/{accountId}/login/qr` 获取登录二维码。
3. 每 2 秒调用 `GET /accounts/{accountId}/login/status`。
4. 只有 `login.succeeded=true` 才认为登录完成。
5. 登录完成后调用 `GET /accounts/{accountId}/hosting`，等待托管初始化完成并持续判断登录是否失效。
6. 需要发送业务联系方式时，调用 `PUT /accounts/{accountId}/wechat-qr` 配置该账号的联系二维码。
7. 服务端长期运行不依赖接入方页面是否打开；后续可通过 `GET /accounts` 找回仍保留的账号。

## 3. 创建账号容器

### POST /accounts

在首次扫码前创建账号容器。请求体为空。

```bash
curl --fail-with-body -X POST \
  -H "Authorization: Bearer ${PARTNER_API_KEY}" \
  "${PARTNER_API_BASE}/accounts"
```

成功返回 HTTP 201 和完整账号投影。接入方必须保存其中的不透明 `accountId`；以下仅展示响应节选：

```json
{
  "accountId": "<opaque-account-id>",
  "accountDisplayName": null,
  "login": {
    "state": "not_requested",
    "scanned": false,
    "succeeded": false,
    "qrDataUrl": null,
    "qrExpiresAt": null,
    "errorCode": null
  }
}
```

`POST /accounts` 没有幂等键。若调用方因网络超时无法确认结果，应先通过 `GET /accounts` 对账，不要盲目重复创建。

## 4. 获取或刷新登录二维码

### POST /accounts/{accountId}/login/qr

请求体为空：

```bash
curl --fail-with-body -X POST \
  -H "Authorization: Bearer ${PARTNER_API_KEY}" \
  "${PARTNER_API_BASE}/accounts/${ACCOUNT_ID}/login/qr"
```

成功返回 HTTP 200 和完整账号投影。二维码字段示例：

```json
{
  "accountId": "<opaque-account-id>",
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

接入要求：

- `qrDataUrl` 是 PNG data URL，可直接赋给前端 `<img src>`。
- 只有 `login.state=waiting_scan` 时，`qrDataUrl` 和 `qrExpiresAt` 才非空。
- 只把 `qrDataUrl` 返回给发起本次登录的受信前端用于临时展示；不要记录、长期持久化或转交第三方，也不要解析其中内容。
- 本接口会创建或刷新一次登录尝试，不是幂等接口。
- 可刷新状态包括 `not_requested`、`waiting_scan`、`qr_expired`、`cancelled`、`no_account`、`login_required` 和 `failed`。
- 已扫码正在初始化时返回 `409 login_in_progress`。
- 已有有效托管登录时返回 `409 account_already_hosted`，不会清除原登录和历史内容。
- 平台暂时无法生成二维码时返回 `502 partner_login_qr_unavailable`，服务不会保存伪登录成功状态。

## 5. 查询扫码和登录状态

### GET /accounts/{accountId}/login/status

```bash
curl --fail-with-body \
  -H "Authorization: Bearer ${PARTNER_API_KEY}" \
  "${PARTNER_API_BASE}/accounts/${ACCOUNT_ID}/login/status"
```

成功返回 HTTP 200：

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

建议每 2 秒轮询一次。状态定义：

| `login.state` | `scanned` | `succeeded` | 是否继续轮询 | 含义 |
| --- | ---: | ---: | ---: | --- |
| `not_requested` | false | false | 否 | 尚未申请二维码 |
| `waiting_scan` | false | false | 是 | 二维码有效，等待扫码 |
| `scanned` | true | false | 是 | 已扫码，但登录尚未完成 |
| `initializing` | true | false | 是 | 正在验证并保存视频号上下文 |
| `succeeded` | true | true | 否 | 登录上下文已验证并保存 |
| `qr_expired` | false | false | 否 | 本次登录二维码过期，可重新生成 |
| `cancelled` | false | false | 否 | 本次登录流程被取消 |
| `no_account` | false | false | 否 | 微信身份下没有可用的视频号身份 |
| `login_required` | false | false | 否 | 原托管登录后来被平台明确判定失效 |
| `failed` | false | false | 否 | 其他初始化失败，查看 `errorCode` |

判断规则：

- `scanned=true` 只表示微信已扫码，不能作为登录成功条件。
- 必须以 `succeeded=true` 判断登录完成。
- `succeeded=true` 只表示登录上下文已保存；评论和私信的首次同步可能仍在初始化，应继续查询托管状态。
- `qr_expired` 只代表本次二维码过期，不代表一个已经托管的账号登录态过期。

## 6. 查询托管状态和登录过期

### GET /accounts/{accountId}/hosting

```bash
curl --fail-with-body \
  -H "Authorization: Bearer ${PARTNER_API_KEY}" \
  "${PARTNER_API_BASE}/accounts/${ACCOUNT_ID}/hosting"
```

成功返回 HTTP 200：

```json
{
  "accountId": "<opaque-account-id>",
  "hosting": {
    "state": "expired",
    "automationEnabled": false,
    "automationEffective": false,
    "loginExpired": true,
    "reloginRequired": true,
    "credentialExpiresAt": null
  },
  "sources": {
    "comments": {
      "state": "auth_required",
      "baselineComplete": true,
      "lastSuccessAt": "2026-08-09T04:19:58.000Z",
      "errorCode": "auth_required"
    },
    "directMessages": {
      "state": "auth_required",
      "baselineComplete": true,
      "lastSuccessAt": "2026-08-09T04:19:59.000Z",
      "errorCode": "auth_required"
    }
  }
}
```

唯一可靠的登录过期判断是：

```javascript
const reloginRequired =
  response.hosting.loginExpired === true &&
  response.hosting.reloginRequired === true;
```

当前两个字段同步变化；为 `true` 时表示平台明确拒绝已持久化的登录态，应重新调用登录二维码接口。

`hosting.state` 定义：

| 状态 | 含义 |
| --- | --- |
| `not_ready` | 尚未完成登录 |
| `initializing` | 登录已完成，评论或私信仍在初始化同步 |
| `active` | 登录、同步和自动回复当前都有效 |
| `paused` | 登录仍有效，但自动回复已暂停或当前不可生效 |
| `degraded` | 登录未被判定过期，但同步、结构或配置存在错误 |
| `expired` | 平台明确要求重新登录 |

重要边界：

- 服务不人为设置固定 8 小时登录有效期。
- `credentialExpiresAt` 当前始终是 `null`，不得使用本地计时推断登录过期。
- `hosting.state=degraded` 不等于登录过期。
- `hosting.state=paused` 不等于登录过期。
- 只有已经建立过有效托管会话、后来被平台明确拒绝时，才投影为 `loginExpired=true`。

## 7. 查询联系二维码配置

联系二维码是业务微信二维码，与登录响应中的 `login.qrDataUrl` 完全不同。

### GET /accounts/{accountId}/wechat-qr

```bash
curl --fail-with-body \
  -H "Authorization: Bearer ${PARTNER_API_KEY}" \
  "${PARTNER_API_BASE}/accounts/${ACCOUNT_ID}/wechat-qr"
```

成功返回 HTTP 200：

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

未配置时：

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

Partner API 只返回联系二维码的配置元数据，不返回图片 data URL 或 Base64 字节。

## 8. 设置或替换联系二维码

### PUT /accounts/{accountId}/wechat-qr

```bash
curl --fail-with-body -X PUT \
  -H "Authorization: Bearer ${PARTNER_API_KEY}" \
  -H 'Content-Type: application/json' \
  --data '{"dataUrl":"data:image/png;base64,<base64-data>"}' \
  "${PARTNER_API_BASE}/accounts/${ACCOUNT_ID}/wechat-qr"
```

请求体：

```json
{
  "dataUrl": "data:image/png;base64,<base64-data>"
}
```

成功返回 HTTP 200 和配置元数据，不回显 `dataUrl`：

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

图片约束：

- 每个 `accountId` 独立保存一张联系二维码。
- 只支持 `image/png` 和 `image/jpeg`。
- 必须传严格、完整的 Base64 data URL，不接受远程图片 URL。
- Base64 解码后的图片必须非空且不超过 512 KiB。
- MIME 声明必须与图片文件头一致。
- 设置成功后原子替换旧图。
- 输入无效或超限时，原二维码保持不变。
- 联系二维码跟随账号容器生命周期；账号被删除或未登录临时账号到期清理时，二维码也会被删除。

调用方如需在自己的页面长期预览联系二维码，应自行保存原始图片；Partner API 当前不提供图片下载接口。

## 9. 删除联系二维码

### DELETE /accounts/{accountId}/wechat-qr

```bash
curl --fail-with-body -X DELETE \
  -H "Authorization: Bearer ${PARTNER_API_KEY}" \
  "${PARTNER_API_BASE}/accounts/${ACCOUNT_ID}/wechat-qr"
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

本接口只删除当前账号的联系二维码，不删除账号、登录态、评论或私信。

## 10. 常用错误码

| HTTP | `error` | 含义 |
| ---: | --- | --- |
| 400 | `invalid_request` | JSON、路径参数或查询参数不符合约束 |
| 400 | `account_wechat_qr_invalid` | 联系二维码不是有效且 MIME 匹配的 PNG/JPEG data URL；原配置不变 |
| 400 | `account_wechat_qr_too_large` | 联系二维码解码后超过 512 KiB；原配置不变 |
| 401 | `partner_api_unauthorized` | Bearer Key 缺失或不匹配 |
| 404 | `partner_account_not_found` | 账号不存在、已删除、已退出或不再保留 |
| 409 | `login_in_progress` | 当前登录已扫码或正在初始化，不能刷新二维码 |
| 409 | `account_already_hosted` | 账号已有有效托管上下文，不能刷新二维码 |
| 502 | `partner_login_qr_unavailable` | 平台二维码创建暂时失败，本次未创建伪登录状态 |
| 503 | `partner_api_unavailable` | 服务端没有配置 Partner API Key |
| 503 | `active_session_limit_reached` | 已达到服务保留账号上限 |

认证失败响应带 `WWW-Authenticate: Bearer`。调用方应根据 HTTP 状态处理错误大类，并根据稳定 `error` 字段展示业务原因，不要依赖服务端错误文案。

## 11. 登录与联系二维码的区别

| 项目 | 登录二维码 | 联系二维码 |
| --- | --- | --- |
| 用途 | 微信扫码授权视频号登录 | Funnel 需要时向私信用户发送业务联系方式 |
| 获取/设置 | 服务生成并由 `POST /login/qr` 返回 | 调用方通过 `PUT /wechat-qr` 上传 |
| 图片返回 | `waiting_scan` 时返回 `login.qrDataUrl` | Partner API 永不返回图片字节，只返回元数据 |
| 过期 | 使用 `login.qrExpiresAt` 判断本次二维码 | 无独立过期时间；账号仍被保留且未替换、删除时持续有效 |
| 是否代表托管登录过期 | 否 | 无关 |

登录凭证是否需要重扫，只能通过 `GET /hosting` 返回的 `loginExpired` 和 `reloginRequired` 判断。

## 12. 完整契约

- 完整 Partner API 文档：[`partner-api.md`](./partner-api.md)
- OpenAPI 3.1 契约：[`partner-api.openapi.yaml`](./partner-api.openapi.yaml)
