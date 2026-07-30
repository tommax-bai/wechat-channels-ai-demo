import "dotenv/config";
import { loadConfig, safeStartupSummary } from "./config.js";
import { SecureStore } from "./crypto.js";
import { openDatabase } from "./database.js";
import { ArkReplyModel } from "./model/ark.js";
import type { ReplyModel } from "./model/reply-model.js";
import { UnavailableReplyModel } from "./model/unavailable.js";
import { DemoRepository } from "./repository.js";
import { buildServer } from "./server.js";
import { SessionService } from "./service/session-service.js";
import { WorkerCoordinator } from "./service/workers.js";
import { PrivateWechatGateway } from "./wechat/client.js";
import { PlaywrightWechatSessionCapturer } from "./wechat/browser-capture.js";
import { WechatTransport } from "./wechat/transport.js";

const config = loadConfig();
const database = openDatabase(config.databasePath);
const repository = new DemoRepository(database);
const secureStore = new SecureStore(config.encryptionKey);
const transport = new WechatTransport({
  baseUrl: config.wechatBaseUrl,
  timeoutMs: config.wechatTimeoutMs,
  maxResponseBytes: config.maxResponseBytes,
});
const sessionCapturer = config.wechatBrowserExecutablePath
  ? new PlaywrightWechatSessionCapturer({
      baseUrl: config.wechatBaseUrl,
      executablePath: config.wechatBrowserExecutablePath,
      timeoutMs: config.wechatBrowserCaptureTimeoutMs,
      headless: config.wechatBrowserHeadless,
    })
  : undefined;
const wechat = new PrivateWechatGateway(transport, sessionCapturer);
const model: ReplyModel = config.arkApiKey
  ? new ArkReplyModel({
      apiKey: config.arkApiKey,
      baseUrl: config.arkBaseUrl,
      model: config.arkModel,
      timeoutMs: config.arkTimeoutMs,
    })
  : new UnavailableReplyModel();
const sessions = new SessionService(config, repository, secureStore, wechat);
const workers = new WorkerCoordinator(
  config,
  repository,
  secureStore,
  wechat,
  model,
);
const app = await buildServer({ config, repository, sessions });

app.log.info(safeStartupSummary(config), "starting standalone WeChat Channels AI demo");
await app.listen({ host: config.host, port: config.port });
workers.start();

let stopping = false;
const stop = async (signal: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, "stopping");
  await workers.stop();
  await app.close();
  database.close();
};
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void stop(signal)
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
}
