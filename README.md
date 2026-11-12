# realtry

Message-free retry extension for [Pi coding agent](https://github.com/badlogic/pi-mono) (`>= 1.5.2`) that replaces Pi's internal retry mechanism without ever injecting synthetic prompts or error messages into the session.

## Features

- **Replaces Pi internal retry** (`AgentSession` + provider SDK internal retry loops) with a single observable retry loop integrated with Pi's native countdown indicator and `Esc` cancellation.
- **Zero session pollution**: Failed, stalled, incomplete, empty, and user-aborted attempts are omitted via durable `context_edit` (`replacement: null`) entries — `realtry` never injects hidden user/custom continuation prompts or synthetic error messages into model context.
- **Retries**:
  - General network, socket, HTTP/2, SSE, and transient upstream/provider errors (`ECONNRESET`, `ETIMEDOUT`, `UND_ERR_SOCKET`, `502`/`503`/`504`/`529`, transient `429` RPM/TPM rate limits, dropped streams).
  - **Stream stall timeouts**: Configurable inactivity watchdog (`stallTimeoutMs`, default `90s`) aborts hung model streams that stop emitting progress and retries them cleanly.
  - **Incomplete responses**: Dropped streams, `toolUse` stops missing tool calls, truncated tool-call turns (`stopReason === "length"` with tool calls — omitting Pi's synthetic truncated-tool error results too), and premature length cutoffs (`output < maxTokens`), while preserving genuine full `maxTokens` text stops and deferring true context-overflow errors to Pi compaction.
  - **Empty responses**: Completely empty stops and thinking-only stops with no visible text or tool calls.
- **Rules out quota & plan exhaustion**: Never retries 5-hour / rolling-hour windows, weekly / daily / monthly caps, billing / credit exhaustion, `insufficient_quota`, `GoUsageLimitError`, `FreeUsageLimitError`, `USER_QUOTA_EXHAUSTED`, or Z.ai `1308` usage limits.
- **Configurable retry window & optional unlimited retries**: Exponential backoff bounded by `maxRetryDurationMs` (default `10m`) and/or `maxRetries` (default `0` = unlimited). Set both to `unlimited` / `0` / `off` to retry indefinitely until recovery or user cancellation.
- **Unconditional `/retry`**:
  - Wakes active retry backoff immediately if a retry countdown is in progress.
  - Sends the current session to the model unconditionally without injecting any message — even if the previous turn was stopped by the user (`Operation aborted` / `Command aborted` during streaming or tool execution) or already ended on a completed assistant message.

## Install / Load

Load directly for a session:

```bash
pi -e /path/to/realtry/src/index.ts
```

Or add `/path/to/realtry` to `~/.pi/agent/settings.json` under `"packages"` (or symlink into `~/.pi/agent/extensions/realtry`).

## Commands

- `/retry` — Send the current session to the model unconditionally (strips any trailing assistant turn and rolls back any tool batch interrupted with `Operation aborted` / `Command aborted`; wakes active backoff immediately).
- `/realtry` or `/realtry status` — Show active session retry state and current configuration.
- `/realtry settings` — Open interactive TUI settings editor (saves atomically to `~/.pi/agent/extensions/realtry.json` with mode `0600`).
- `/realtry settings <key> <value>` — Update a setting from the command line:
  - `enabled` (`on` | `off`, default `on`)
  - `stallTimeout` (e.g. `90s`, `2m`, `off`, default `90s`)
  - `maxRetryDuration` (e.g. `10m`, `1h`, `unlimited`, default `10m`)
  - `maxRetries` (non-negative integer or `unlimited` / `0`, default `unlimited`)
  - `baseDelay` (e.g. `2s`, `500ms`, default `2s`)
  - `maxDelay` (e.g. `60s`, `2m`, default `60s`)
  - `retryEmpty` (`on` | `off`, default `on`)
  - `retryIncomplete` (`on` | `off`, default `on`)
  - `/realtry settings defaults` — Restore defaults.
- `/realtry reset` — Cancel active retry backoff and reset retry counters.

Override the settings path via `REALTRY_SETTINGS_PATH`.

## Verification

```bash
npm run check
```
