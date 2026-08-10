## Context

`WorkerSet.syncSession` resolves a source row, and before this change it handled a `schema_changed` state as follows: comments were offered one narrow recovery for the superseded post-cursor error, and direct messages were dropped with `source = null` followed by an immediate return. Nothing ever cleared that state, so the direct-message lane stayed dead for the lifetime of the credential.

`syncDirectMessages` reads its next cursor at three points: the continuation of a history page, the handoff from history to incremental, and the incremental page itself. All three used `requiredString`, which rejects an absent key and a blank string identically and reports both as `schema_changed:data.cookie`.

The observed incident combined both: a freshly scanned account reached the history-to-incremental handoff before the platform had issued the short-lived login cookie, the blank value was read as a missing field, and the terminal branch made it permanent.

## Goals / Non-Goals

Goals:
- No source is abandoned because of a failure that a later identical attempt could survive.
- A retry schedule that is bounded in rate, so a genuinely broken endpoint is not polled every fifteen seconds forever.
- Failures are visible in the service log with enough shape information to identify the field without recording any value.
- Customer-facing wording that does not assert a platform contract change when the service is simply retrying.

Non-Goals:
- Recognizing additional cursor field names. The probe showed `cookie` is still correct; alias widening would be speculative.
- Changing the comment polling cadence or the bounded comment scan contract.
- Introducing a terminal "give up" state. A structural change on a private platform interface is only knowable by observation, so the honest end state is "still failing, retrying slowly", not "confirmed impossible".

## Decisions

**Blank cursor is a distinct, retryable condition.** `requiredCursor` throws `dm_cursor_unavailable` rather than `schema_changed:*`. The worker already maps any code outside the `schema_changed` prefix to the retryable `error` state, so the reclassification alone restores retries for this failure. The thrown message names the observed top-level keys, which is what a human needs to tell "not ready yet" from "renamed field" on the next occurrence.

**Retry pacing is persisted, not in-memory.** `source_states` gains `consecutive_failures` and `next_attempt_at`. A process restart must not reset a slow backoff into a fast one, and the previous incident showed that source state is the only durable record of what the lane is doing. Success clears both fields.

**Two floors, one cap.** A transient failure starts at the lane's normal cadence — the configured direct-message interval, or sixty seconds for comments — and a `schema_changed` failure starts at five minutes, because a shape mismatch is unlikely to resolve within one tick. Both double per consecutive failure and stop at thirty minutes. The cap keeps a broken account cheap without ever declaring it finished.

**Direct-message `schema_changed` loses its terminal branch, and comments keep their recovery.** The superseded comment cursor recovery still runs first and still resets the baseline, because that path must re-read history rather than resume. Every other `schema_changed`, on either source, now falls through to the ordinary paced retry.

**Retry gating is separate from the comment due-check.** The sixty-second comment gate stays as the bounded-scan contract defines it; `next_attempt_at` is an additional gate that only a failing source carries. A recovery that resets the baseline bypasses the retry gate, since it is a deliberate re-baseline rather than a repeat of the failed attempt.

## Risks / Trade-offs

- A genuine platform rename now retries forever at thirty-minute intervals instead of stopping. That is one request per source per half hour, and the alternative — a terminal state — is what caused this incident. The source stays visibly degraded and creates no reply jobs, so nothing downstream reads it as success.
- Refetching the first history page after a failed handoff repeats work. Inbound identity is deduplicated by the existing unique external-ID hash, so a repeated page cannot create duplicate items or duplicate reply jobs.
- Two new columns must be added to a live database. The migration follows the existing additive `ALTER TABLE ... ADD COLUMN` pattern with an idempotent column check, defaults to zero and null, and needs no backfill: an existing failing source simply starts its backoff at its next tick.

## Migration Plan

Additive columns with defaults, applied at process start by the same idempotent bootstrap that added `last_attempt_at`. Rolling back the application is safe: the previous build ignores both columns.
