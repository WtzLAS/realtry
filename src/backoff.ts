import type { RealtrySettings } from "./settings.ts";

export interface BackoffInput {
	/** 1-indexed retry attempt about to be scheduled. */
	attempt: number;
	/** Monotonic or wall timestamp (ms) when the current failure sequence started. */
	firstFailureAt: number;
	/** Current timestamp (ms). */
	now: number;
}

export type BackoffDecision =
	| {
			allow: true;
			attempt: number;
			maxAttempts: number;
			delayMs: number;
	  }
	| {
			allow: false;
			reason: "max_retries_exceeded" | "retry_window_expired";
	  };

export function rawBackoffDelayMs(
	attempt: number,
	settings: Pick<RealtrySettings, "baseDelayMs" | "maxDelayMs">,
): number {
	const exponent = Math.max(0, attempt - 1);
	const raw = settings.baseDelayMs * 2 ** exponent;
	const safe = Number.isFinite(raw) && raw <= Number.MAX_SAFE_INTEGER ? Math.round(raw) : Number.MAX_SAFE_INTEGER;
	return Math.min(safe, settings.maxDelayMs);
}

/**
 * Count how many backoff steps starting at `startAttempt` can still start before `remainingMs`
 * reaches 0 (assuming negligible request flight time), so TUI countdowns display a bounded
 * `(attempt/maxAttempts)` when `maxRetries === 0` and `maxRetryDurationMs > 0`.
 */
function countRemainingWindowSteps(
	startAttempt: number,
	remainingMs: number,
	settings: Pick<RealtrySettings, "baseDelayMs" | "maxDelayMs">,
): number {
	if (remainingMs <= 0) return 0;
	if (settings.baseDelayMs === 0 || settings.maxDelayMs === 0) {
		return Number.POSITIVE_INFINITY;
	}
	let left = remainingMs;
	let steps = 0;
	for (let step = startAttempt; left > 0 && steps < 10_000; step++) {
		const delay = Math.min(rawBackoffDelayMs(step, settings), left);
		if (delay <= 0) return Number.POSITIVE_INFINITY;
		steps++;
		left -= delay;
	}
	return steps;
}

export function computeBackoffDecision(
	input: BackoffInput,
	settings: Pick<RealtrySettings, "maxRetries" | "maxRetryDurationMs" | "baseDelayMs" | "maxDelayMs">,
): BackoffDecision {
	const { attempt, firstFailureAt, now } = input;
	if (settings.maxRetries > 0 && attempt > settings.maxRetries) {
		return { allow: false, reason: "max_retries_exceeded" };
	}

	const elapsedMs = Math.max(0, now - firstFailureAt);
	if (settings.maxRetryDurationMs > 0 && elapsedMs >= settings.maxRetryDurationMs) {
		return { allow: false, reason: "retry_window_expired" };
	}

	const rawDelay = rawBackoffDelayMs(attempt, settings);
	const remainingWindowMs =
		settings.maxRetryDurationMs > 0 ? settings.maxRetryDurationMs - elapsedMs : Number.POSITIVE_INFINITY;
	const delayMs = Number.isFinite(remainingWindowMs) ? Math.min(rawDelay, Math.max(0, remainingWindowMs)) : rawDelay;

	let maxAttempts: number;
	if (settings.maxRetries > 0 && settings.maxRetryDurationMs > 0) {
		const windowMax = attempt - 1 + countRemainingWindowSteps(attempt, remainingWindowMs, settings);
		maxAttempts = Math.min(settings.maxRetries, windowMax);
	} else if (settings.maxRetries > 0) {
		maxAttempts = settings.maxRetries;
	} else if (settings.maxRetryDurationMs > 0) {
		maxAttempts = attempt - 1 + countRemainingWindowSteps(attempt, remainingWindowMs, settings);
	} else {
		maxAttempts = Number.POSITIVE_INFINITY;
	}

	return {
		allow: true,
		attempt,
		maxAttempts: Math.max(attempt, maxAttempts),
		delayMs,
	};
}
