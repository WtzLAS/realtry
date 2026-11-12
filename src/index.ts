import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
	ensureHostAgentSessionPatched,
	REALTRY_BRIDGE_SYMBOL,
	RealtryBridge,
	type RealtrySessionSnapshot,
} from "./runtime.ts";
import {
	DEFAULT_SETTINGS,
	formatCountLimit,
	formatDurationMs,
	loadSettings,
	parseBooleanSetting,
	parseCountSetting,
	parseDurationSetting,
	saveSettings,
	settingsPath,
	type RealtrySettings,
} from "./settings.ts";
import { prepareSessionForUnconditionalRetry } from "./tail.ts";
import { showSettingsScreen } from "./ui.ts";

const SUBCOMMANDS: readonly { name: string; description: string }[] = [
	{ name: "status", description: "Show realtry status, active retry state, and configuration" },
	{ name: "settings", description: "Open interactive settings panel or update a setting" },
	{ name: "reset", description: "Cancel active backoff and reset retry counters" },
	{ name: "help", description: "Show realtry command usage" },
];

const SETTING_KEYS: readonly {
	key: string;
	description: string;
	completions?: readonly string[];
}[] = [
	{ key: "enabled", description: "Enable or disable realtry (on|off)", completions: ["on", "off"] },
	{ key: "stallTimeout", description: "Stream inactivity timeout (e.g. 10m, 2m, off)", completions: ["10m", "5m", "2m", "off"] },
	{ key: "maxRetryDuration", description: "Max retry window per turn (e.g. 12h, 1h, unlimited)", completions: ["12h", "6h", "1h", "unlimited"] },
	{ key: "maxRetries", description: "Max retry attempts per turn (e.g. 5, 10, unlimited)", completions: ["unlimited", "5", "10", "20"] },
	{ key: "baseDelay", description: "Initial backoff delay (e.g. 1s, 500ms)", completions: ["1s", "2s", "5s"] },
	{ key: "maxDelay", description: "Max single backoff delay (e.g. 30s, 60s)", completions: ["30s", "60s", "2m"] },
	{ key: "retryEmpty", description: "Retry empty / thinking-only responses (on|off)", completions: ["on", "off"] },
	{ key: "retryIncomplete", description: "Retry incomplete responses & truncated tool calls (on|off)", completions: ["on", "off"] },
	{ key: "defaults", description: "Reset all realtry settings to defaults" },
];

const HELP_TEXT = [
	"/retry — send the current session to the model unconditionally (wakes active backoff, strips trailing/aborted turn, injects nothing)",
	"/realtry status — show active retry state and current settings",
	"/realtry settings — open interactive settings screen (or print settings without UI)",
	"/realtry settings <key> <value> — update a setting (enabled, stallTimeout, maxRetryDuration, maxRetries, baseDelay, maxDelay, retryEmpty, retryIncomplete)",
	"/realtry settings defaults — restore default settings",
	"/realtry reset — cancel active retry backoff and reset counters",
	"/realtry help — show this help",
].join("\n");

function notify(ctx: Pick<ExtensionContext, "hasUI" | "ui">, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, level);
		return;
	}
	if (level === "error") {
		console.error(message);
	} else {
		console.log(message);
	}
}

export function formatSettingsSummary(
	settings: RealtrySettings,
	snapshot?: RealtrySessionSnapshot,
): string {
	const lines = [
		`realtry (${settings.enabled ? "enabled — replacing Pi internal retry" : "disabled — Pi internal retry active"})`,
		`  settings file:      ${settingsPath()}`,
		`  stallTimeout:       ${formatDurationMs(settings.stallTimeoutMs, "off")}`,
		`  maxRetryDuration:   ${formatDurationMs(settings.maxRetryDurationMs, "unlimited")}`,
		`  maxRetries:         ${formatCountLimit(settings.maxRetries)}`,
		`  backoff:            ${formatDurationMs(settings.baseDelayMs, "0ms")} .. ${formatDurationMs(settings.maxDelayMs, "0ms")}`,
		`  retryEmpty:         ${settings.retryEmpty ? "on" : "off"}`,
		`  retryIncomplete:    ${settings.retryIncomplete ? "on" : "off"}`,
	];
	if (snapshot) {
		lines.push(
			`  session state:      ${snapshot.isRetrying ? `retrying (attempt ${snapshot.attempt})` : "idle"} · ${snapshot.totalRetriesInSession} retries this session`,
		);
		if (snapshot.lastError) {
			lines.push(`  last retry reason:  ${snapshot.lastError}`);
		}
	}
	return lines.join("\n");
}

/**
 * Nested argument completions for `/realtry`.
 * Remember Pi 1.5.2 passes the full argument text to `getArgumentCompletions`, and returned
 * `value` strings replace the entire argument string.
 */
export function realtryCommandCompletions(argumentText: string): AutocompleteItem[] | null {
	const trimmedStart = argumentText.replace(/^\s+/, "");
	if (!trimmedStart.includes(" ")) {
		const prefix = trimmedStart.toLowerCase();
		const matches = SUBCOMMANDS.filter((sub) => sub.name.startsWith(prefix)).map((sub) => ({
			value: sub.name,
			label: sub.name,
			description: sub.description,
		}));
		return matches.length > 0 ? matches : null;
	}

	const parts = trimmedStart.split(/\s+/).filter(Boolean);
	const subcommand = parts[0]!.toLowerCase();
	if (subcommand !== "settings") {
		return null;
	}

	const trailingSpace = /\s$/.test(trimmedStart);
	if (parts.length === 1 && trailingSpace) {
		return SETTING_KEYS.map((entry) => ({
			value: `settings ${entry.key}`,
			label: entry.key,
			description: entry.description,
		}));
	}

	if (parts.length === 2 && !trailingSpace) {
		const keyPrefix = parts[1]!.toLowerCase();
		const matches = SETTING_KEYS.filter((entry) => entry.key.toLowerCase().startsWith(keyPrefix)).map((entry) => ({
			value: `settings ${entry.key}`,
			label: entry.key,
			description: entry.description,
		}));
		return matches.length > 0 ? matches : null;
	}

	const keyMatch = SETTING_KEYS.find((entry) => entry.key.toLowerCase() === parts[1]!.toLowerCase());
	if (!keyMatch || !keyMatch.completions) {
		return null;
	}

	if ((parts.length === 2 && trailingSpace) || (parts.length === 3 && !trailingSpace)) {
		const valPrefix = parts.length === 3 ? parts[2]!.toLowerCase() : "";
		const matches = keyMatch.completions
			.filter((val) => val.toLowerCase().startsWith(valPrefix))
			.map((val) => ({
				value: `settings ${keyMatch.key} ${val}`,
				label: val,
			}));
		return matches.length > 0 ? matches : null;
	}

	return null;
}

function applyCliSettingMutation(
	current: RealtrySettings,
	rawKey: string,
	rawValue: string | undefined,
): { next?: RealtrySettings; error?: string } {
	const key = rawKey.toLowerCase();
	if (key === "defaults") {
		if (rawValue !== undefined) {
			return { error: "Usage: /realtry settings defaults" };
		}
		return { next: { ...DEFAULT_SETTINGS } };
	}
	if (rawValue === undefined || !rawValue.trim()) {
		return { error: `Missing value for ${rawKey}. Example: /realtry settings ${rawKey} ...` };
	}

	switch (key) {
		case "enabled": {
			const parsed = parseBooleanSetting(rawValue);
			if (parsed === undefined) return { error: "enabled expects on or off." };
			return { next: { ...current, enabled: parsed } };
		}
		case "retryempty":
		case "retry_empty": {
			const parsed = parseBooleanSetting(rawValue);
			if (parsed === undefined) return { error: "retryEmpty expects on or off." };
			return { next: { ...current, retryEmpty: parsed } };
		}
		case "retryincomplete":
		case "retry_incomplete": {
			const parsed = parseBooleanSetting(rawValue);
			if (parsed === undefined) return { error: "retryIncomplete expects on or off." };
			return { next: { ...current, retryIncomplete: parsed } };
		}
		case "stalltimeout":
		case "stalltimeoutms":
		case "stall_timeout": {
			const parsed = parseDurationSetting(rawValue, { allowZero: true });
			if (parsed === undefined) {
				return { error: "stallTimeout expects a duration like 90s, 2m, 1500ms, or off." };
			}
			return { next: { ...current, stallTimeoutMs: parsed } };
		}
		case "maxretryduration":
		case "maxretrydurationms":
		case "max_retry_duration":
		case "timeout": {
			const parsed = parseDurationSetting(rawValue, { allowZero: true });
			if (parsed === undefined) {
				return { error: "maxRetryDuration expects a duration like 10m, 1h, 120s, or unlimited / off." };
			}
			return { next: { ...current, maxRetryDurationMs: parsed } };
		}
		case "maxretries":
		case "max_retries": {
			const parsed = parseCountSetting(rawValue);
			if (parsed === undefined) {
				return { error: "maxRetries expects a non-negative integer or unlimited / 0 / off." };
			}
			return { next: { ...current, maxRetries: parsed } };
		}
		case "basedelay":
		case "basedelayms":
		case "base_delay": {
			const parsed = parseDurationSetting(rawValue, { allowZero: true });
			if (parsed === undefined) {
				return { error: "baseDelay expects a duration like 2s, 500ms, or 0ms." };
			}
			return {
				next: {
					...current,
					baseDelayMs: parsed,
					maxDelayMs: Math.max(current.maxDelayMs, parsed),
				},
			};
		}
		case "maxdelay":
		case "maxdelayms":
		case "max_delay": {
			const parsed = parseDurationSetting(rawValue, { allowZero: true });
			if (parsed === undefined) {
				return { error: "maxDelay expects a duration like 60s, 2m, or 5000ms." };
			}
			return { next: { ...current, maxDelayMs: parsed } };
		}
		default:
			return {
				error: `Unknown setting "${rawKey}". Valid keys: enabled, stallTimeout, maxRetryDuration, maxRetries, baseDelay, maxDelay, retryEmpty, retryIncomplete, defaults.`,
			};
	}
}

export default function realtry(pi: ExtensionAPI): Promise<void> {
	const callerStack = new Error().stack;
	const startupWarnings: string[] = [];
	let settings = loadSettings(undefined, (warning) => startupWarnings.push(warning));

	const bridge = new RealtryBridge(() => settings);

	const updateSettings = (next: RealtrySettings): RealtrySettings => {
		const saved = saveSettings(next);
		settings = saved;
		bridge.refreshFooters();
		return saved;
	};

	pi.on("session_start", async (_event, ctx) => {
		bridge.controllerForContext(ctx);
		while (startupWarnings.length > 0) {
			const warning = startupWarnings.shift()!;
			if (ctx.hasUI) ctx.ui.notify(warning, "warning");
		}
	});

	pi.on("agent_start", async (_event, ctx) => {
		bridge.controllerForContext(ctx)?.rebindHooks();
	});

	pi.on("message_end", async (event, ctx) => {
		bridge.controllerForContext(ctx)?.onMessageEnd(event.message);
	});

	pi.on("agent_end", async (event, ctx) => {
		bridge.controllerForContext(ctx)?.onAgentEnd(event.messages);
	});

	pi.on("input", async (event, ctx) => {
		if (event.source !== "extension") {
			bridge.controllerForContext(ctx)?.onFreshUserInput();
		}
	});

	pi.on("session_shutdown", async () => {
		bridge.shutdownAll();
	});

	const realtryHandler = Object.assign(
		async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			settings = loadSettings(undefined, (warning) => notify(ctx, warning, "warning"));
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const subcommand = (tokens[0] ?? "status").toLowerCase();

			switch (subcommand) {
				case "help":
					notify(ctx, HELP_TEXT, "info");
					return;

				case "status": {
					if (tokens.length > 1) {
						notify(ctx, "Usage: /realtry status", "warning");
						return;
					}
					const snapshot = bridge.controllerForContext(ctx)?.snapshot();
					notify(ctx, formatSettingsSummary(settings, snapshot), "info");
					return;
				}

				case "reset": {
					if (tokens.length > 1) {
						notify(ctx, "Usage: /realtry reset", "warning");
						return;
					}
					bridge.controllerForContext(ctx)?.reset();
					notify(ctx, "realtry: retry state and active backoff reset.", "info");
					return;
				}

				case "settings": {
					if (tokens.length === 1) {
						if (ctx.hasUI && typeof ctx.ui?.custom === "function") {
							await showSettingsScreen(ctx, () => settings, updateSettings);
							return;
						}
						notify(ctx, formatSettingsSummary(settings, bridge.controllerForContext(ctx)?.snapshot()), "info");
						return;
					}
					if (tokens.length > 3) {
						notify(ctx, "Usage: /realtry settings [<key> <value> | defaults]", "warning");
						return;
					}
					const [, rawKey, rawValue] = tokens;
					const mutation = applyCliSettingMutation(settings, rawKey!, rawValue);
					if (mutation.error || !mutation.next) {
						notify(ctx, mutation.error ?? "Invalid setting value.", "error");
						return;
					}
					try {
						const saved = updateSettings(mutation.next);
						notify(ctx, formatSettingsSummary(saved, bridge.controllerForContext(ctx)?.snapshot()), "info");
					} catch (error) {
						notify(ctx, error instanceof Error ? error.message : String(error), "error");
					}
					return;
				}

				default:
					notify(ctx, `Unknown subcommand "${tokens[0]}".\n${HELP_TEXT}`, "warning");
			}
		},
		{ [REALTRY_BRIDGE_SYMBOL]: bridge },
	);

	pi.registerCommand("realtry", {
		description: "Inspect and configure realtry message-free retry settings",
		getArgumentCompletions: realtryCommandCompletions,
		handler: realtryHandler,
	});

	pi.registerCommand("retry", {
		description: "Send the current session to the model unconditionally without injecting messages",
		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			if (args.trim().length > 0) {
				notify(
					ctx,
					"/retry takes no arguments (it never injects prompts into the session). Use /realtry for status and settings.",
					"warning",
				);
				return;
			}
			settings = loadSettings(undefined, (warning) => notify(ctx, warning, "warning"));
			const controller = bridge.controllerForContext(ctx);
			if (controller) {
				await controller.retryNow(ctx);
				return;
			}
			// Fallback when invoked against a standalone mock context without an AgentSession instance
			if (
				ctx.sessionManager &&
				typeof (ctx.sessionManager as unknown as { appendContextEdit?: unknown }).appendContextEdit === "function"
			) {
				const prep = prepareSessionForUnconditionalRetry(ctx.sessionManager as never);
				if (!prep.canContinue) {
					notify(ctx, prep.reason ?? "Nothing to retry.", "warning");
					return;
				}
			}
			notify(ctx, "realtry: no active AgentSession attached to continue.", "error");
		},
	});

	return ensureHostAgentSessionPatched(callerStack);
}

export {
	classifyAssistantOutcome,
	isEmptyAssistantResponse,
	isIncompleteAssistantResponse,
	isQuotaOrPlanLimitError,
} from "./classifier.ts";
export { computeBackoffDecision, rawBackoffDelayMs } from "./backoff.ts";
export {
	DEFAULT_SETTINGS,
	formatCountLimit,
	formatDurationMs,
	formatRemainingTimeout,
	loadSettings,
	parseBooleanSetting,
	parseCountSetting,
	parseDurationSetting,
	saveSettings,
	settingsPath,
	validateSettings,
	type RealtrySettings,
} from "./settings.ts";
export { invokeStreamWithWatchdog } from "./stream-watchdog.ts";
export { isAbortedToolResult, planUnconditionalRetryOmissions, prepareSessionForUnconditionalRetry } from "./tail.ts";
