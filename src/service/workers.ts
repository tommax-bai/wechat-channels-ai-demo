import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { SecureStore } from "../crypto.js";
import type { ReplyModel } from "../model/reply-model.js";
import { ModelError } from "../model/reply-model.js";
import type {
  DemoRepository,
  ReplyRow,
  SessionRow,
  SourceRow,
} from "../repository.js";
import type {
  NormalizedInboundItem,
  PlatformSession,
  ReplyModelResult,
} from "../types.js";
import {
  WechatApiError,
} from "../wechat/transport.js";
import type {
  PendingWechatLogin,
  WechatGateway,
  WechatSendResult,
  WechatSyncPage,
} from "../wechat/client.js";
import type { StoredCredential } from "./credentials.js";

export class WorkerCoordinator {
  private timers: NodeJS.Timeout[] = [];
  private readonly activeTasks = new Set<Promise<void>>();
  private readonly platformSessionLocks = new Map<string, Promise<void>>();
  private stopping = false;
  private authRunning = false;
  private syncRunning = false;
  private replyRunning = false;
  private cleanupRunning = false;

  constructor(
    private readonly config: AppConfig,
    private readonly repository: DemoRepository,
    private readonly secureStore: SecureStore,
    private readonly wechat: WechatGateway,
    private readonly model: ReplyModel,
    private readonly log: Pick<Console, "info" | "warn" | "error"> = console,
  ) {}

  start(): void {
    this.stopping = false;
    const recovered = this.repository.recoverInterruptedReplies(Date.now());
    if (
      recovered.submittedUnknown > 0
      || recovered.requeued > 0
      || recovered.failed > 0
    ) {
      this.log.warn(
        `[demo] recovered reply jobs unknown=${recovered.submittedUnknown} requeued=${recovered.requeued} failed=${recovered.failed}`,
      );
    }
    this.schedule(() => this.authTick(), this.config.loginPollMs);
    this.schedule(() => this.syncTick(), this.config.syncPollMs);
    this.schedule(() => this.replyTick(), this.config.workerPollMs);
    this.schedule(() => this.cleanupTick(), this.config.cleanupPollMs);
    this.runBackground(() => this.authTick());
    this.runBackground(() => this.syncTick());
    this.runBackground(() => this.replyTick());
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    await Promise.allSettled([...this.activeTasks]);
  }

  async runOnce(): Promise<void> {
    await this.authTick();
    await this.syncTick();
    await this.replyTick();
    await this.cleanupTick();
  }

  private schedule(work: () => Promise<void>, intervalMs: number): void {
    const timer = setInterval(() => this.runBackground(work), intervalMs);
    timer.unref();
    this.timers.push(timer);
  }

  private runBackground(work: () => Promise<void>): void {
    if (this.stopping) return;
    const task = work()
      .catch((error: unknown) => {
        this.log.error(`[demo] worker tick failed code=${safeErrorCode(error)}`);
      })
      .finally(() => {
        this.activeTasks.delete(task);
      });
    this.activeTasks.add(task);
  }

  private async authTick(): Promise<void> {
    if (this.authRunning) return;
    this.authRunning = true;
    try {
      const sessions = this.repository.listSessionsByAuth(
        ["qr_pending", "scanned", "capturing_context"],
        Date.now(),
      );
      await mapWithConcurrency(
        sessions,
        this.config.workerConcurrency,
        (session) => this.pollAuth(session),
      );
    } finally {
      this.authRunning = false;
    }
  }

  private async pollAuth(session: SessionRow): Promise<void> {
    const stored = this.readCredential(session.id);
    if (stored?.kind === "capturing") {
      try {
        const completed = await this.wechat.completeLoginCapture(stored.value);
        await this.completeAuth(session, completed);
      } catch (error) {
        this.recordAuthFailure(session, error);
      }
      return;
    }
    if (stored?.kind !== "pending") {
      this.repository.setAuthStateIfGeneration(
        session.id,
        session.authGeneration,
        "auth_required",
        "pending_login_missing",
        Date.now(),
      );
      return;
    }
    const pending = stored.value;
    if (pending.expiresAt <= Date.now()) {
      this.repository.setAuthStateIfGeneration(
        session.id,
        session.authGeneration,
        "expired",
        "qr_expired",
        Date.now(),
      );
      return;
    }
    try {
      const result = await this.wechat.pollLogin(pending);
      if (result.state === "confirmed") {
        await this.completeAuth(session, result.session);
        return;
      }
      if (result.state === "capture_required") {
        if (!this.saveCapturingIfCurrent(session, result.session)) return;
        if (!this.repository.setAuthStateIfGeneration(
          session.id,
          session.authGeneration,
          "capturing_context",
          null,
          Date.now(),
        )) return;
        const completed = await this.wechat.completeLoginCapture(result.session);
        await this.completeAuth(session, completed);
        return;
      }
      const next = result.pending;
      this.savePendingIfCurrent(session, next);
      const state = result.state === "waiting" ? "qr_pending" : result.state;
      this.repository.setAuthStateIfGeneration(
        session.id,
        session.authGeneration,
        state,
        result.state === "waiting" || result.state === "scanned" ? null : `qr_${result.state}`,
        Date.now(),
      );
    } catch (error) {
      this.recordAuthFailure(session, error);
    }
  }

  private recordAuthFailure(session: SessionRow, error: unknown): void {
    const code = safeErrorCode(error);
    this.repository.setAuthStateIfGeneration(
      session.id,
      session.authGeneration,
      code.startsWith("schema_changed") ? "schema_changed" : "auth_required",
      code,
      Date.now(),
    );
  }

  private async completeAuth(session: SessionRow, platformSession: PlatformSession): Promise<void> {
    const accountKeyHash = this.secureStore.keyedHash(platformSession.finderUsername, "finder-account");
    const envelope = this.secureStore.encryptJson(
      { kind: "session", value: platformSession } satisfies StoredCredential,
      session.id,
      "credentials",
    );
    try {
      const completed = this.repository.completeAuthentication(
        session.id,
        session.authGeneration,
        accountKeyHash,
        envelope,
        Date.now(),
      );
      if (completed) this.log.info("[demo] platform session validated; baseline pending");
    } catch (error) {
      const duplicate = error instanceof Error
        && error.message.includes("demo_sessions.account_key_hash");
      this.repository.setAuthStateIfGeneration(
        session.id,
        session.authGeneration,
        "auth_required",
        duplicate ? "account_already_connected" : "credential_persist_failed",
        Date.now(),
      );
    }
  }

  private savePendingIfCurrent(session: SessionRow, pending: PendingWechatLogin): void {
    const envelope = this.secureStore.encryptJson(
      { kind: "pending", value: pending } satisfies StoredCredential,
      session.id,
      "credentials",
    );
    this.repository.updateCredentialEnvelopeIfGeneration(
      session.id,
      session.authGeneration,
      envelope,
      Date.now(),
    );
  }

  private saveCapturingIfCurrent(
    session: SessionRow,
    platformSession: PlatformSession,
  ): boolean {
    const envelope = this.secureStore.encryptJson(
      { kind: "capturing", value: platformSession } satisfies StoredCredential,
      session.id,
      "credentials",
    );
    return this.repository.updateCredentialEnvelopeIfGeneration(
      session.id,
      session.authGeneration,
      envelope,
      Date.now(),
    );
  }

  private async syncTick(): Promise<void> {
    if (this.syncRunning) return;
    this.syncRunning = true;
    try {
      const sessions = this.repository.listSessionsByAuth(
        ["baseline_sync", "active", "stopped"],
        Date.now(),
      );
      await mapWithConcurrency(
        sessions,
        this.config.workerConcurrency,
        (session) => this.syncSession(session),
      );
    } finally {
      this.syncRunning = false;
    }
  }

  private async syncSession(session: SessionRow): Promise<void> {
    await this.withPlatformSessionLock(session.id, async () => {
      const current = this.repository.getSession(session.id);
      if (!current || current.authGeneration !== session.authGeneration) return;
      const stored = this.readCredential(session.id);
      if (stored?.kind !== "session") return;
      for (const source of this.repository.getSources(session.id)) {
        if (source.state === "schema_changed" || source.state === "auth_required") continue;
        await this.syncSource(current, stored.value, source);
        const latest = this.repository.getSession(session.id);
        if (
          !latest
          || latest.authGeneration !== session.authGeneration
          || latest.authState === "auth_required"
        ) break;
      }
      this.savePlatformSession(session.id, session.authGeneration, stored.value);
      this.repository.setSessionActiveIfBaselinesComplete(
        session.id,
        session.authGeneration,
        Date.now(),
      );
    });
  }

  private async syncSource(
    session: SessionRow,
    platformSession: PlatformSession,
    source: SourceRow,
  ): Promise<void> {
    try {
      let cursor = source.cursorEnvelope
        ? this.secureStore.decryptJson<string | null>(
            source.cursorEnvelope,
            session.id,
            `cursor:${source.source}`,
          )
        : null;
      let pageCount = 0;
      for (;;) {
        const page = source.source === "dm"
          ? await this.wechat.syncDirectMessages(platformSession, cursor)
          : await this.wechat.syncComments(platformSession, cursor);
        const current = this.repository.getSession(session.id);
        if (!current || current.authGeneration !== session.authGeneration) return;
        this.persistPage(current, source, page);
        cursor = page.cursor;
        const cursorEnvelope = this.secureStore.encryptJson(
          cursor,
          session.id,
          `cursor:${source.source}`,
        );
        this.repository.updateSource(
          session.id,
          session.authGeneration,
          source.source,
          {
            state: source.baselineComplete || !page.hasMore ? "healthy" : "pending",
            baselineComplete: source.baselineComplete || !page.hasMore,
            cursorEnvelope,
            lastSuccessAt: Date.now(),
            lastErrorCode: null,
          },
          Date.now(),
        );
        pageCount += 1;
        if (!page.hasMore || pageCount >= 10) break;
      }
    } catch (error) {
      const current = this.repository.getSession(session.id);
      if (!current || current.authGeneration !== session.authGeneration) return;
      const latestSource = this.repository.getSource(session.id, source.source) ?? source;
      const code = safeErrorCode(error);
      const state = code === "auth_required"
        ? "auth_required"
        : code.startsWith("schema_changed")
          ? "schema_changed"
          : "error";
      this.repository.updateSource(
        session.id,
        session.authGeneration,
        source.source,
        {
          state,
          baselineComplete: latestSource.baselineComplete,
          cursorEnvelope: latestSource.cursorEnvelope,
          lastSuccessAt: latestSource.lastSuccessAt,
          lastErrorCode: code,
        },
        Date.now(),
      );
      if (state === "auth_required") {
        this.repository.setAuthStateIfGeneration(
          session.id,
          session.authGeneration,
          "auth_required",
          code,
          Date.now(),
        );
      }
    }
  }

  private persistPage(session: SessionRow, source: SourceRow, page: WechatSyncPage): void {
    const historical = !source.baselineComplete;
    for (const item of page.items) {
      const id = randomUUID();
      const replyEligible =
        !historical
        && session.automationEnabled
        && session.authState === "active";
      this.repository.insertInbound({
        id,
        sessionId: session.id,
        source: item.source,
        externalIdHash: this.secureStore.keyedHash(
          item.externalId,
          `inbound:${session.id}:${item.source}`,
        ),
        payloadEnvelope: this.secureStore.encryptJson(
          item,
          session.id,
          `inbound:${id}`,
        ),
        occurredAt: item.occurredAt,
        discoveredAt: Date.now(),
        historical,
        replyEligible,
        authGeneration: session.authGeneration,
        runGeneration: session.runGeneration,
        platformClientId: randomUUID(),
      });
    }
  }

  private async replyTick(): Promise<void> {
    if (this.replyRunning || !this.config.autoReplyEnabled) return;
    this.replyRunning = true;
    try {
      const jobs: ReplyRow[] = [];
      for (let index = 0; index < this.config.workerConcurrency; index += 1) {
        const job = this.repository.claimReply(Date.now());
        if (!job) break;
        jobs.push(job);
      }
      await Promise.all(jobs.map((job) => this.processReply(job)));
    } finally {
      this.replyRunning = false;
    }
  }

  private async processReply(job: ReplyRow): Promise<void> {
    const inbound = this.repository.getInbound(job.inboundItemId, job.sessionId);
    const stored = this.readCredential(job.sessionId);
    if (!inbound || stored?.kind !== "session") {
      this.repository.updateReply(
        job.id,
        job.sessionId,
        "failed",
        { errorCode: "reply_context_missing" },
        Date.now(),
      );
      return;
    }
    const item = this.secureStore.decryptJson<NormalizedInboundItem>(
      inbound.payloadEnvelope,
      job.sessionId,
      `inbound:${inbound.id}`,
    );
    let generated: ReplyModelResult;
    try {
      generated = await this.model.generate({
        source: item.source,
        authorName: item.authorName,
        text: item.text,
      });
    } catch (error) {
      this.repository.updateReply(
        job.id,
        job.sessionId,
        "failed",
        { errorCode: error instanceof ModelError ? error.code : "model_error" },
        Date.now(),
      );
      return;
    }
    const outputEnvelope = this.secureStore.encryptJson(
      generated,
      job.sessionId,
      `reply:${job.id}`,
    );
    this.repository.updateReply(
      job.id,
      job.sessionId,
      "generated",
      {
        outputEnvelope,
        model: generated.model,
        providerRequestId: generated.requestId ?? null,
        errorCode: null,
      },
      Date.now(),
    );
    const dispatchSession = this.repository.getSession(job.sessionId);
    if (
      !dispatchSession
      || !this.repository.beginSendReply(
        job.id,
        job.sessionId,
        dispatchSession.authGeneration,
        job.runGeneration,
        Date.now(),
      )
    ) {
      this.repository.updateReply(
        job.id,
        job.sessionId,
        "failed",
        { errorCode: "automation_stopped_before_send" },
        Date.now(),
      );
      return;
    }
    await this.withPlatformSessionLock(job.sessionId, async () => {
      const freshStored = this.readCredential(job.sessionId);
      if (freshStored?.kind !== "session") {
        this.repository.updateReply(
          job.id,
          job.sessionId,
          "failed",
          { errorCode: "reply_context_missing" },
          Date.now(),
        );
        return;
      }
      let result: WechatSendResult;
      try {
        result = await this.wechat.sendReply(
          freshStored.value,
          item.target,
          generated.text,
          job.platformClientId,
          () => this.repository.isSendAuthorized(
            job.id,
            job.sessionId,
            dispatchSession.authGeneration,
            job.runGeneration,
            Date.now(),
          ),
        );
      } catch (error) {
        const ambiguous = error instanceof WechatApiError && error.ambiguous;
        const code = safeErrorCode(error);
        const recorded = this.repository.updateReply(
          job.id,
          job.sessionId,
          ambiguous ? "submitted_unknown" : "failed",
          { errorCode: code },
          Date.now(),
        );
        if (!recorded) {
          this.log.error("[demo] platform send outcome could not be persisted");
          return;
        }
        this.savePlatformSessionSafely(
          job.sessionId,
          dispatchSession.authGeneration,
          freshStored.value,
        );
        if (!ambiguous && code === "auth_required") {
          this.repository.setAuthStateIfGeneration(
            job.sessionId,
            dispatchSession.authGeneration,
            "auth_required",
            code,
            Date.now(),
          );
        }
        return;
      }
      const confirmed = result.accepted && result.externalId;
      try {
        const recorded = this.repository.updateReply(
          job.id,
          job.sessionId,
          confirmed ? "confirmed" : "failed",
          {
            errorCode: confirmed ? null : "platform_ack_missing",
            ...(confirmed ? {
              platformReceiptHash: this.secureStore.keyedHash(
                result.externalId as string,
                `platform-receipt:${job.sessionId}`,
              ),
            } : {}),
          },
          Date.now(),
        );
        if (!recorded) {
          this.log.error("[demo] confirmed platform receipt could not be persisted");
          return;
        }
      } catch {
        this.log.error("[demo] confirmed platform receipt could not be persisted");
        return;
      }
      this.savePlatformSessionSafely(
        job.sessionId,
        dispatchSession.authGeneration,
        freshStored.value,
      );
    });
  }

  private async cleanupTick(): Promise<void> {
    if (this.cleanupRunning) return;
    this.cleanupRunning = true;
    try {
      const count = this.repository.deleteExpired(Date.now());
      if (count > 0) this.log.info(`[demo] expired transient sessions removed count=${count}`);
    } finally {
      this.cleanupRunning = false;
    }
  }

  private readCredential(sessionId: string): StoredCredential | null {
    const envelope = this.repository.getCredentialEnvelope(sessionId);
    return envelope
      ? this.secureStore.decryptJson<StoredCredential>(envelope, sessionId, "credentials")
      : null;
  }

  private savePlatformSession(
    sessionId: string,
    authGeneration: number,
    value: PlatformSession,
  ): boolean {
    const envelope = this.secureStore.encryptJson(
      { kind: "session", value } satisfies StoredCredential,
      sessionId,
      "credentials",
    );
    return this.repository.updateCredentialEnvelopeIfGeneration(
      sessionId,
      authGeneration,
      envelope,
      Date.now(),
    );
  }

  private savePlatformSessionSafely(
    sessionId: string,
    authGeneration: number,
    value: PlatformSession,
  ): void {
    try {
      this.savePlatformSession(sessionId, authGeneration, value);
    } catch {
      this.log.warn("[demo] platform outcome persisted but refreshed credentials were not");
    }
  }

  private async withPlatformSessionLock<T>(
    sessionId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous = this.platformSessionLocks.get(sessionId) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate, () => gate);
    this.platformSessionLocks.set(sessionId, tail);
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
      if (this.platformSessionLocks.get(sessionId) === tail) {
        this.platformSessionLocks.delete(sessionId);
      }
    }
  }
}

function safeErrorCode(error: unknown): string {
  if (error instanceof WechatApiError) return error.code.slice(0, 160);
  if (error instanceof ModelError) return error.code.slice(0, 160);
  return "internal_error";
}

async function mapWithConcurrency<T>(
  values: readonly T[],
  limit: number,
  work: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from(
    { length: Math.min(limit, values.length) },
    async () => {
      for (;;) {
        const index = next;
        next += 1;
        const value = values[index];
        if (value === undefined) return;
        await work(value);
      }
    },
  );
  await Promise.all(runners);
}
