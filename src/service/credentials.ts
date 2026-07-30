import type { PendingWechatLogin } from "../wechat/client.js";
import type { PlatformSession } from "../types.js";

export type StoredCredential =
  | {
      kind: "pending";
      value: PendingWechatLogin;
    }
  | {
      kind: "session";
      value: PlatformSession;
    };
