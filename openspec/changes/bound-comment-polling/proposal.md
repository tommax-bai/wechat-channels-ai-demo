## Why

The current comment worker re-fetches the same post page before every individual comment-page read, producing hundreds of redundant WeChat requests and eventually receiving successful-but-empty post lists that permanently stop comment synchronization. The Demo needs a bounded polling contract that reduces request volume and can safely recover affected accounts without treating old comments as new.

## What Changes

- Poll comments on a dedicated 60-second cadence while leaving direct-message polling unchanged.
- Fetch the post list exactly once per comment poll, inspect only the first 3 posts, and fetch exactly one comment page for each selected post.
- Deduplicate repeated reads through the existing stable inbound identity contract and never continue comment or post pagination in the same poll.
- Recover comment sources affected by the superseded post-cursor errors through a fresh historical baseline before new comments become reply-eligible.
- Preserve honest source status when the bounded poll cannot obtain a usable post list.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `wechat-inbound-sync`: Replace cursor-driven whole-account comment traversal with a bounded 60-second scan of one post-list page and one comment page for each of the first 3 posts, including safe recovery semantics.

## Impact

- Comment scheduling and synchronization in `src/service/workers.ts` and `src/wechat/client.ts`.
- Comment cursor/source-state handling and focused platform, worker, and integration tests.
- DEV runtime configuration and retained comment-source recovery; direct messages, login, model selection, Funnel integration, and reply delivery contracts remain unchanged.
