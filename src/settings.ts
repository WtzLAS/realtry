import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface RealtrySettings {
	/** Replace Pi's internal retry with realtry's message-free retry engine. */
	enabled: boolean;
	/** Stream inactivity timeout in milliseconds; 0 disables the stream stall watchdog. */
	stallTimeoutMs: number;
	/** Total retry window per failing turn in milliseconds; 0 disables the time limit. */
	maxRetryDurationMs: number;
	/** Maximum retry attempts per failing turn; 0 disables the attempt limit. */
	maxRetries: number;
	/** Initial backoff delay in milliseconds for attempt 1. */
	baseDelayMs: number;
	/** Maximum backoff delay in milliseconds per attempt. */
	maxDelayMs: number;
	/** Retry empty assistant stops (no visible text and no tool calls, including thinking-only). */
	retryEmpty: boolean;
	/** Retry incomplete responses (dropped streams, truncated tool calls, premature length cutoffs). */
	retryIncomplete: boolean;
}

export const DEFAULT_SETTINGS: RealtrySettings = {
	enabled: true,
	stallTimeoutMs: 600_000,
	maxRetryDurationMs: 43_200_000,
	maxRetries: 0,
	baseDelayMs: 1_000,
	maxDelayMs: 30_000,
	retryEmpty: true,
	retryIncomplete: true,
};

export function settingsPath(): string {
	return process.env.REALTRY_SETTINGS_PATH || join(getAgentDir(), "extensions", "realtry.json");
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && Number.isSafeInteger(value) && value >= 0;
}

export function validateSettings(raw: unknown): RealtrySettings {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new TypeError("Settings must be a JSON object.");
	}
	const candidate = raw as Partial<Record<keyof RealtrySettings, unknown>>;
	const merged: RealtrySettings = {
		enabled: candidate.enabled === undefined ? DEFAULT_SETTINGS.enabled : Boolean(candidate.enabled),
		stallTimeoutMs:
			candidate.stallTimeoutMs === undefined ? DEFAULT_SETTINGS.stallTimeoutMs : (candidate.stallTimeoutMs as number),
		maxRetryDurationMs:
			candidate.maxRetryDurationMs === undefined
				? DEFAULT_SETTINGS.maxRetryDurationMs
				: (candidate.maxRetryDurationMs as number),
		maxRetries: candidate.maxRetries === undefined ? DEFAULT_SETTINGS.maxRetries : (candidate.maxRetries as number),
		baseDelayMs:
			candidate.baseDelayMs === undefined ? DEFAULT_SETTINGS.baseDelayMs : (candidate.baseDelayMs as number),
		maxDelayMs: candidate.maxDelayMs === undefined ? DEFAULT_SETTINGS.maxDelayMs : (candidate.maxDelayMs as number),
		retryEmpty: candidate.retryEmpty === undefined ? DEFAULT_SETTINGS.retryEmpty : Boolean(candidate.retryEmpty),
		retryIncomplete:
			candidate.retryIncomplete === undefined
				? DEFAULT_SETTINGS.retryIncomplete
				: Boolean(candidate.retryIncomplete),
	};

	if (candidate.enabled !== undefined && typeof candidate.enabled !== "boolean") {
		throw new TypeError("enabled must be a boolean.");
	}
	if (candidate.retryEmpty !== undefined && typeof candidate.retryEmpty !== "boolean") {
		throw new TypeError("retryEmpty must be a boolean.");
	}
	if (candidate.retryIncomplete !== undefined && typeof candidate.retryIncomplete !== "boolean") {
		throw new TypeError("retryIncomplete must be a boolean.");
	}
	if (!isNonNegativeInteger(merged.stallTimeoutMs)) {
		throw new TypeError("stallTimeoutMs must be a non-negative integer.");
	}
	if (!isNonNegativeInteger(merged.maxRetryDurationMs)) {
		throw new TypeError("maxRetryDurationMs must be a non-negative integer.");
	}
	if (!isNonNegativeInteger(merged.maxRetries)) {
		throw new TypeError("maxRetries must be a non-negative integer.");
	}
	if (!isNonNegativeInteger(merged.baseDelayMs)) {
		throw new TypeError("baseDelayMs must be a non-negative integer.");
	}
	if (!isNonNegativeInteger(merged.maxDelayMs)) {
		throw new TypeError("maxDelayMs must be a non-negative integer.");
	}
	if (merged.maxDelayMs < merged.baseDelayMs) {
		throw new RangeError("maxDelayMs must be greater than or equal to baseDelayMs.");
	}
	return merged;
}

export function loadSettings(
	path = settingsPath(),
	onWarning: (message: string) => void = console.warn,
): RealtrySettings {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return validateSettings(parsed);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { ...DEFAULT_SETTINGS };
		}
		onWarning(`Cannot read valid realtry settings at ${path}; using defaults until repaired or saved again.`);
		return { ...DEFAULT_SETTINGS };
	}
}

export function saveSettings(settings: RealtrySettings, path = settingsPath()): RealtrySettings {
	const validated = validateSettings(settings);
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	let descriptor: number | undefined;
	try {
		descriptor = openSync(temporary, "wx", 0o600);
		writeFileSync(descriptor, `${JSON.stringify(validated, null, 2)}\n`);
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		renameSync(temporary, path);
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
		rmSync(temporary, { force: true });
	}
	return validated;
}

export function parseBooleanSetting(value: string): boolean | undefined {
	const trimmed = value.trim();
	if (/^(on|true|1|enabled|yes)$/i.test(trimmed)) return true;
	if (/^(off|false|0|disabled|no)$/i.test(trimmed)) return false;
	return undefined;
}

/**
 * Parse a duration string such as `90s`, `10m`, `1500ms`, `2h`, bare seconds (`90`),
 * or `0` / `off` / `none` / `unlimited` when `allowZero` is enabled.
 */
export function parseDurationSetting(
	value: string,
	options: { allowZero?: boolean } = { allowZero: true },
): number | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	if (/^(0|off|false|none|unlimited|infinite|inf)$/i.test(trimmed)) {
		return options.allowZero === false ? undefined : 0;
	}
	const match = /^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|m|min|mins|h|hr|hrs)?$/i.exec(trimmed);
	if (!match) return undefined;
	const amount = Number(match[1]);
	if (!Number.isFinite(amount) || amount < 0) return undefined;
	const unit = (match[2] ?? "s").toLowerCase();
	const multiplier =
		unit === "ms"
			? 1
			: unit === "s" || unit === "sec" || unit === "secs"
				? 1_000
				: unit === "m" || unit === "min" || unit === "mins"
					? 60_000
					: 3_600_000;
	const ms = Math.round(amount * multiplier);
	if (!Number.isSafeInteger(ms)) return undefined;
	if (ms === 0 && options.allowZero === false) return undefined;
	return ms;
}

export function parseCountSetting(value: string): number | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	if (/^(0|off|false|none|unlimited|infinite|inf)$/i.test(trimmed)) return 0;
	if (!/^\d+$/.test(trimmed)) return undefined;
	const parsed = Number(trimmed);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function formatDurationMs(
	ms: number,
	zeroLabel: "off" | "unlimited" | "0ms" = "off",
): string {
	if (ms <= 0) return zeroLabel;
	if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
	if (ms % 60_000 === 0) return `${ms / 60_000}m`;
	if (ms % 1_000 === 0) return `${ms / 1_000}s`;
	return `${ms}ms`;
}

export function formatCountLimit(count: number): string {
	return count <= 0 ? "unlimited" : String(count);
}

/**
 * Format a remaining countdown in milliseconds as a compact jitter-free string
 * (`11h59m58s`, `9m58s`, `29s`, `0s`).
 */
export function formatRemainingTimeout(ms: number): string {
	const totalSeconds = Math.max(0, Math.ceil(ms / 1_000));
	const hours = Math.floor(totalSeconds / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) {
		return `${hours}h${String(minutes).padStart(2, "0")}m${String(seconds).padStart(2, "0")}s`;
	}
	if (minutes > 0) {
		return `${minutes}m${String(seconds).padStart(2, "0")}s`;
	}
	return `${seconds}s`;
}
