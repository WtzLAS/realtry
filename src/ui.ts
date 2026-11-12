import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Input,
	type SettingItem,
	SettingsList,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import {
	formatCountLimit,
	formatDurationMs,
	parseCountSetting,
	parseDurationSetting,
	settingsPath,
	type RealtrySettings,
} from "./settings.ts";

function setInputValueAtEnd(input: Input, value: string): void {
	input.setValue(value);
	input.handleInput("\x05"); // Ctrl+E: move cursor to end
}

class TextInputSubmenu implements Component {
	private readonly input = new Input();
	private readonly theme: Theme;
	private readonly label: string;
	private readonly help: string;
	private readonly apply: (raw: string) => string | undefined;
	private readonly onClose: (displayValue?: string) => void;
	private error: string | undefined;

	constructor(opts: {
		theme: Theme;
		label: string;
		help: string;
		initialValue: string;
		apply: (raw: string) => { error?: string; displayValue?: string };
		onClose: (displayValue?: string) => void;
	}) {
		this.theme = opts.theme;
		this.label = opts.label;
		this.help = opts.help;
		this.onClose = opts.onClose;
		this.apply = (raw: string) => {
			const result = opts.apply(raw);
			if (result.error) return result.error;
			opts.onClose(result.displayValue);
			return undefined;
		};

		setInputValueAtEnd(this.input, opts.initialValue);
		this.input.focused = true;
		this.input.onSubmit = (raw) => {
			const err = this.apply(raw.trim());
			if (err) {
				this.error = err;
			}
		};
		this.input.onEscape = () => this.onClose();
	}

	render(width: number): string[] {
		const lines = [
			truncateToWidth(this.theme.fg("accent", this.theme.bold(this.label)), width),
			truncateToWidth(this.theme.fg("muted", this.help), width),
			"",
			...this.input.render(width),
		];
		if (this.error) {
			lines.push(truncateToWidth(this.theme.fg("error", this.error), width));
		}
		lines.push("");
		lines.push(truncateToWidth(this.theme.fg("dim", "Enter save · Esc cancel"), width));
		return lines;
	}

	handleInput(data: string): void {
		this.error = undefined;
		this.input.handleInput(data);
	}

	invalidate(): void {
		this.input.invalidate();
	}
}

export async function showSettingsScreen(
	ctx: ExtensionCommandContext,
	current: () => RealtrySettings,
	update: (next: RealtrySettings) => RealtrySettings,
): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		let error: string | undefined;

		const buildItems = (): SettingItem[] => {
			const s = current();
			return [
				{
					id: "enabled",
					label: "Enabled",
					description: "Replace Pi's internal retry with realtry's message-free retry engine.",
					currentValue: s.enabled ? "on" : "off",
					values: ["on", "off"],
				},
				{
					id: "stallTimeout",
					label: "Stream stall timeout",
					description: "Abort and retry stalled model streams after inactivity (e.g. 90s, 2m, off).",
					currentValue: formatDurationMs(s.stallTimeoutMs, "off"),
					submenu: (_val, closeSubmenu) =>
						new TextInputSubmenu({
							theme,
							label: "Stream stall timeout",
							help: "Duration such as 90s, 2m, 1500ms, or off / 0 to disable stream stall detection.",
							initialValue: formatDurationMs(current().stallTimeoutMs, "off"),
							apply: (raw) => {
								const parsed = parseDurationSetting(raw, { allowZero: true });
								if (parsed === undefined) {
									return { error: "Enter a duration like 90s, 2m, 500ms, or off." };
								}
								try {
									const saved = update({ ...current(), stallTimeoutMs: parsed });
									error = undefined;
									return { displayValue: formatDurationMs(saved.stallTimeoutMs, "off") };
								} catch (cause) {
									return { error: cause instanceof Error ? cause.message : String(cause) };
								}
							},
							onClose: (display) => {
								closeSubmenu(display);
								tui.requestRender();
							},
						}),
				},
				{
					id: "maxRetryDuration",
					label: "Max retry window",
					description: "Total time window to keep retrying a failing turn (e.g. 10m, 1h, unlimited).",
					currentValue: formatDurationMs(s.maxRetryDurationMs, "unlimited"),
					submenu: (_val, closeSubmenu) =>
						new TextInputSubmenu({
							theme,
							label: "Max retry window",
							help: "Duration such as 10m, 30m, 1h, or unlimited / 0 / off to disable the time limit.",
							initialValue: formatDurationMs(current().maxRetryDurationMs, "unlimited"),
							apply: (raw) => {
								const parsed = parseDurationSetting(raw, { allowZero: true });
								if (parsed === undefined) {
									return { error: "Enter a duration like 10m, 1h, 120s, or unlimited." };
								}
								try {
									const saved = update({ ...current(), maxRetryDurationMs: parsed });
									error = undefined;
									return { displayValue: formatDurationMs(saved.maxRetryDurationMs, "unlimited") };
								} catch (cause) {
									return { error: cause instanceof Error ? cause.message : String(cause) };
								}
							},
							onClose: (display) => {
								closeSubmenu(display);
								tui.requestRender();
							},
						}),
				},
				{
					id: "maxRetries",
					label: "Max retry attempts",
					description: "Maximum retry attempts per failing turn; unlimited / 0 disables the attempt cap.",
					currentValue: formatCountLimit(s.maxRetries),
					submenu: (_val, closeSubmenu) =>
						new TextInputSubmenu({
							theme,
							label: "Max retry attempts",
							help: "Non-negative integer (e.g. 5, 10) or unlimited / 0 / off to disable the attempt limit.",
							initialValue: formatCountLimit(current().maxRetries),
							apply: (raw) => {
								const parsed = parseCountSetting(raw);
								if (parsed === undefined) {
									return { error: "Enter a non-negative integer or unlimited / 0." };
								}
								try {
									const saved = update({ ...current(), maxRetries: parsed });
									error = undefined;
									return { displayValue: formatCountLimit(saved.maxRetries) };
								} catch (cause) {
									return { error: cause instanceof Error ? cause.message : String(cause) };
								}
							},
							onClose: (display) => {
								closeSubmenu(display);
								tui.requestRender();
							},
						}),
				},
				{
					id: "baseDelay",
					label: "Base backoff delay",
					description: "Initial backoff delay for retry attempt 1 (e.g. 2s, 500ms).",
					currentValue: formatDurationMs(s.baseDelayMs, "0ms"),
					submenu: (_val, closeSubmenu) =>
						new TextInputSubmenu({
							theme,
							label: "Base backoff delay",
							help: "Duration such as 2s, 500ms, 5s, or 0ms.",
							initialValue: formatDurationMs(current().baseDelayMs, "0ms"),
							apply: (raw) => {
								const parsed = parseDurationSetting(raw, { allowZero: true });
								if (parsed === undefined) {
									return { error: "Enter a duration like 2s, 500ms, or 0ms." };
								}
								try {
									const cur = current();
									const nextMax = Math.max(cur.maxDelayMs, parsed);
									const saved = update({ ...cur, baseDelayMs: parsed, maxDelayMs: nextMax });
									error = undefined;
									return { displayValue: formatDurationMs(saved.baseDelayMs, "0ms") };
								} catch (cause) {
									return { error: cause instanceof Error ? cause.message : String(cause) };
								}
							},
							onClose: (display) => {
								closeSubmenu(display);
								tui.requestRender();
							},
						}),
				},
				{
					id: "maxDelay",
					label: "Max backoff delay",
					description: "Upper bound on single-attempt exponential backoff delay (e.g. 60s, 2m).",
					currentValue: formatDurationMs(s.maxDelayMs, "0ms"),
					submenu: (_val, closeSubmenu) =>
						new TextInputSubmenu({
							theme,
							label: "Max backoff delay",
							help: "Duration >= baseDelay (e.g. 60s, 2m, 5000ms).",
							initialValue: formatDurationMs(current().maxDelayMs, "0ms"),
							apply: (raw) => {
								const parsed = parseDurationSetting(raw, { allowZero: true });
								if (parsed === undefined) {
									return { error: "Enter a duration like 60s, 2m, or 5000ms." };
								}
								try {
									const saved = update({ ...current(), maxDelayMs: parsed });
									error = undefined;
									return { displayValue: formatDurationMs(saved.maxDelayMs, "0ms") };
								} catch (cause) {
									return { error: cause instanceof Error ? cause.message : String(cause) };
								}
							},
							onClose: (display) => {
								closeSubmenu(display);
								tui.requestRender();
							},
						}),
				},
				{
					id: "retryEmpty",
					label: "Retry empty responses",
					description: "Omit and retry responses with no visible text and no tool calls (including thinking-only).",
					currentValue: s.retryEmpty ? "on" : "off",
					values: ["on", "off"],
				},
				{
					id: "retryIncomplete",
					label: "Retry incomplete responses",
					description: "Omit and retry dropped streams, truncated tool calls, and premature length cutoffs.",
					currentValue: s.retryIncomplete ? "on" : "off",
					values: ["on", "off"],
				},
			];
		};

		const items = buildItems();
		const list = new SettingsList(
			items,
			Math.min(items.length + 2, 12),
			getSettingsListTheme(),
			(id, value) => {
				try {
					const cur = current();
					if (id === "enabled") {
						update({ ...cur, enabled: value === "on" });
					} else if (id === "retryEmpty") {
						update({ ...cur, retryEmpty: value === "on" });
					} else if (id === "retryIncomplete") {
						update({ ...cur, retryIncomplete: value === "on" });
					}
					error = undefined;
				} catch (cause) {
					error = cause instanceof Error ? cause.message : String(cause);
				}
			},
			() => done(),
		);

		const syncItemDisplays = () => {
			const s = current();
			const map: Record<string, string> = {
				enabled: s.enabled ? "on" : "off",
				stallTimeout: formatDurationMs(s.stallTimeoutMs, "off"),
				maxRetryDuration: formatDurationMs(s.maxRetryDurationMs, "unlimited"),
				maxRetries: formatCountLimit(s.maxRetries),
				baseDelay: formatDurationMs(s.baseDelayMs, "0ms"),
				maxDelay: formatDurationMs(s.maxDelayMs, "0ms"),
				retryEmpty: s.retryEmpty ? "on" : "off",
				retryIncomplete: s.retryIncomplete ? "on" : "off",
			};
			for (const item of items) {
				if (map[item.id] !== undefined) {
					item.currentValue = map[item.id]!;
				}
			}
		};

		return {
			capturesViewportInput: list.capturesViewportInput,
			render(width: number) {
				syncItemDisplays();
				const body = list.render(width);
				if (body.length > 0) {
					body[body.length - 1] = theme.fg("dim", "  Enter/←/→ change · Esc close");
				}
				return [
					truncateToWidth(theme.fg("accent", theme.bold("realtry settings")), width),
					truncateToWidth(theme.fg("dim", `changes save immediately · ${settingsPath()}`), width),
					"",
					...(error ? [truncateToWidth(theme.fg("error", error), width)] : []),
					...body.map((line) => truncateToWidth(line, width)),
				];
			},
			handleInput(data: string) {
				list.handleInput(data);
				tui.requestRender();
			},
			invalidate: () => list.invalidate(),
		};
	});
}
