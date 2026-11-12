import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import realtry, {
	DEFAULT_SETTINGS,
	formatCountLimit,
	formatDurationMs,
	formatRemainingTimeout,
	loadSettings,
	parseCountSetting,
	parseDurationSetting,
	realtryCommandCompletions,
	saveSettings,
} from "../src/index.ts";

describe("settings persistence and parsing", () => {
	it("saves atomically with mode 0600 and reloads cleanly", () => {
		const dir = mkdtempSync(join(tmpdir(), "realtry-settings-"));
		const file = join(dir, "realtry.json");
		try {
			assert.deepEqual(loadSettings(file), DEFAULT_SETTINGS);
			assert.deepEqual(DEFAULT_SETTINGS, {
				enabled: true,
				stallTimeoutMs: 600_000,
				maxRetryDurationMs: 43_200_000,
				maxRetries: 0,
				baseDelayMs: 1_000,
				maxDelayMs: 30_000,
				retryEmpty: true,
				retryIncomplete: true,
			});

			const updated = saveSettings(
				{
					...DEFAULT_SETTINGS,
					stallTimeoutMs: 45_000,
					maxRetryDurationMs: 0,
					maxRetries: 0,
				},
				file,
			);
			assert.equal(updated.stallTimeoutMs, 45_000);
			assert.equal(updated.maxRetryDurationMs, 0);
			assert.equal(statSync(file).mode & 0o777, 0o600);
			assert.deepEqual(loadSettings(file), updated);

			writeFileSync(file, "{broken json");
			const warnings: string[] = [];
			assert.deepEqual(loadSettings(file, (msg) => warnings.push(msg)), DEFAULT_SETTINGS);
			assert.equal(warnings.length, 1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("parses and formats durations and unlimited counts", () => {
		assert.equal(parseDurationSetting("90s"), 90_000);
		assert.equal(parseDurationSetting("10m"), 600_000);
		assert.equal(parseDurationSetting("1500ms"), 1_500);
		assert.equal(parseDurationSetting("1.5h"), 5_400_000);
		assert.equal(parseDurationSetting("45"), 45_000);
		assert.equal(parseDurationSetting("off"), 0);
		assert.equal(parseDurationSetting("unlimited"), 0);
		assert.equal(parseDurationSetting("0"), 0);
		assert.equal(parseDurationSetting("invalid"), undefined);

		assert.equal(parseCountSetting("0"), 0);
		assert.equal(parseCountSetting("unlimited"), 0);
		assert.equal(parseCountSetting("off"), 0);
		assert.equal(parseCountSetting("12"), 12);
		assert.equal(parseCountSetting("-1"), undefined);

		assert.equal(formatDurationMs(0, "off"), "off");
		assert.equal(formatDurationMs(0, "unlimited"), "unlimited");
		assert.equal(formatDurationMs(90_000, "off"), "90s");
		assert.equal(formatDurationMs(600_000, "unlimited"), "10m");
		assert.equal(formatCountLimit(0), "unlimited");
		assert.equal(formatCountLimit(5), "5");

		assert.equal(formatRemainingTimeout(43_200_000), "12h00m00s");
		assert.equal(formatRemainingTimeout(43_198_100), "11h59m59s");
		assert.equal(formatRemainingTimeout(600_000), "10m00s");
		assert.equal(formatRemainingTimeout(545_000), "9m05s");
		assert.equal(formatRemainingTimeout(29_100), "30s");
		assert.equal(formatRemainingTimeout(0), "0s");
	});
});

describe("commands and nested argument completions", () => {
	it("provides full-replacement completions for /realtry subcommands and settings", () => {
		const top = realtryCommandCompletions("");
		assert.ok(top);
		assert.deepEqual(
			top.map((item) => item.value),
			["status", "settings", "reset", "help"],
		);

		const keys = realtryCommandCompletions("settings ");
		assert.ok(keys);
		assert.ok(keys.some((item) => item.value === "settings maxRetryDuration"));
		assert.ok(keys.some((item) => item.value === "settings maxRetries"));
		assert.ok(keys.some((item) => item.value === "settings stallTimeout"));

		const filteredKey = realtryCommandCompletions("settings maxR");
		assert.ok(filteredKey);
		assert.deepEqual(
			filteredKey.map((item) => item.value),
			["settings maxRetryDuration", "settings maxRetries"],
		);

		const values = realtryCommandCompletions("settings maxRetries u");
		assert.deepEqual(values, [{ value: "settings maxRetries unlimited", label: "unlimited" }]);
	});

	it("updates settings via /realtry settings CLI and rejects arguments on /retry", async () => {
		const dir = mkdtempSync(join(tmpdir(), "realtry-cmd-"));
		const settingsFile = join(dir, "realtry.json");
		const prevEnv = process.env.REALTRY_SETTINGS_PATH;
		process.env.REALTRY_SETTINGS_PATH = settingsFile;

		try {
			const commands = new Map<string, Omit<RegisteredCommand, "name">>();
			const mockPi = {
				on() {},
				registerCommand(name: string, options: Omit<RegisteredCommand, "name">) {
					commands.set(name, options);
				},
			} as unknown as ExtensionAPI;

			realtry(mockPi);
			assert.ok(commands.has("realtry"));
			assert.ok(commands.has("retry"));

			const notifications: Array<{ text: string; level?: string }> = [];
			const mockCtx = {
				hasUI: true,
				sessionManager: {},
				ui: {
					notify(text: string, level?: string) {
						notifications.push({ text, level });
					},
				},
			} as unknown as ExtensionCommandContext;

			await commands.get("realtry")!.handler("settings maxRetryDuration unlimited", mockCtx);
			await commands.get("realtry")!.handler("settings maxRetries off", mockCtx);
			await commands.get("realtry")!.handler("settings stallTimeout 45s", mockCtx);

			const saved = loadSettings(settingsFile);
			assert.equal(saved.maxRetryDurationMs, 0);
			assert.equal(saved.maxRetries, 0);
			assert.equal(saved.stallTimeoutMs, 45_000);

			notifications.length = 0;
			await commands.get("retry")!.handler("do something", mockCtx);
			assert.equal(notifications.length, 1);
			assert.equal(notifications[0]?.level, "warning");
			assert.match(notifications[0]!.text, /never injects prompts/);
		} finally {
			if (prevEnv === undefined) delete process.env.REALTRY_SETTINGS_PATH;
			else process.env.REALTRY_SETTINGS_PATH = prevEnv;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
