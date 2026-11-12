import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { computeBackoffDecision, rawBackoffDelayMs } from "../src/backoff.ts";
import { classifyAssistantOutcome, isQuotaOrPlanLimitError } from "../src/classifier.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";

function makeAssistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Hello world" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 100,
			output: 25,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 125,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

describe("classifier", () => {
	it("retries general network, transport, and transient provider errors", () => {
		const retryableErrors = [
			"fetch failed: ECONNRESET",
			"connect ETIMEDOUT 1.2.3.4:443",
			"TypeError: terminated (UND_ERR_SOCKET: other side closed)",
			"socket hang up",
			"HTTP 502 Bad Gateway",
			"503 Service Unavailable: servers are currently busy",
			"529 Overloaded",
			"Anthropic stream ended without a stop reason",
			"Codex stream ended without a stop reason",
			"Google stream ended without a finish reason",
			"Response cut short after the reply had begun",
			"ERR_HTTP2_GOAWAY_SESSION",
			"An unknown error occurred",
			"429 Too Many Requests: Rate limit reached for requests per minute (RPM)",
			"429 Quota exceeded for quota metric 'Generate Content API requests per minute'",
			"429 MODEL_CAPACITY_EXHAUSTED: No capacity available for model",
		];

		for (const errorMessage of retryableErrors) {
			const result = classifyAssistantOutcome(
				makeAssistant({ content: [], stopReason: "error", errorMessage }),
				DEFAULT_SETTINGS,
				{ maxTokens: 4096, contextWindow: 200_000 },
			);
			assert.equal(result.retryable, true, `Expected retryable for: ${errorMessage}`);
		}
	});

	it("classifies realtry stall timeouts as stream_timeout", () => {
		const result = classifyAssistantOutcome(
			makeAssistant({
				content: [],
				stopReason: "error",
				errorMessage: "Stream stalled: no response activity for 90s (realtry timeout)",
			}),
			DEFAULT_SETTINGS,
		);
		assert.deepEqual(result, {
			retryable: true,
			kind: "stream_timeout",
			description: "Stream stalled: no response activity for 90s (realtry timeout)",
		});
	});

	it("rules out 5-hour, weekly, daily, monthly, and billing quota errors", () => {
		const quotaErrors = [
			"429 Too Many Requests: You have exceeded your 5-hour usage limit. Resets at 19:00 UTC.",
			"Error: 5h limit reached for Claude Pro.",
			"Five-hour quota exhausted; please wait before sending more messages.",
			"429 You've hit your weekly usage limit.",
			"Weekly limit exceeded for this model. Try again in 2 days.",
			"7-day quota reached on your subscription.",
			"429 Quota exceeded for quota metric 'Generate Content API requests per day'",
			"Daily usage limit reached (RPD limit exceeded).",
			"Monthly usage limit reached.",
			"You exceeded your current quota, please check your plan and billing details.",
			'{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}',
			'{"error":{"code":1308,"message":"Usage limit reached"}}',
			"Your credit balance is too low to access the Anthropic API.",
			"402 Payment Required: out of credits",
			"FreeUsageLimitError: free tier exhausted",
			"GoUsageLimitError",
			"USER_QUOTA_EXHAUSTED: quota resets in 4 hours",
			"subscription_sharing_usage_limit_exceeded",
		];

		for (const errorMessage of quotaErrors) {
			assert.equal(isQuotaOrPlanLimitError(errorMessage), true, `Expected quota detection for: ${errorMessage}`);
			const result = classifyAssistantOutcome(
				makeAssistant({ content: [], stopReason: "error", errorMessage }),
				DEFAULT_SETTINGS,
				{ maxTokens: 4096, contextWindow: 200_000 },
			);
			assert.deepEqual(
				result,
				{ retryable: false, reason: "quota_exceeded" },
				`Expected quota_exceeded for: ${errorMessage}`,
			);
		}
	});

	it("does not retry auth, validation, context overflow, or user-aborted messages", () => {
		assert.deepEqual(
			classifyAssistantOutcome(
				makeAssistant({ content: [], stopReason: "aborted", errorMessage: "Operation aborted" }),
				DEFAULT_SETTINGS,
			),
			{ retryable: false, reason: "aborted" },
		);

		assert.deepEqual(
			classifyAssistantOutcome(
				makeAssistant({ content: [], stopReason: "error", errorMessage: "401 Unauthorized: invalid x-api-key" }),
				DEFAULT_SETTINGS,
			),
			{ retryable: false, reason: "non_retryable" },
		);

		assert.deepEqual(
			classifyAssistantOutcome(
				makeAssistant({
					content: [],
					stopReason: "error",
					errorMessage: "400 Bad Request: prompt is too long: 210000 tokens > 200000 maximum",
				}),
				DEFAULT_SETTINGS,
				{ maxTokens: 8192, contextWindow: 200_000 },
			),
			{ retryable: false, reason: "context_overflow" },
		);
	});

	it("retries empty responses including thinking-only stops, but keeps visible text or tool calls", () => {
		const empty = classifyAssistantOutcome(
			makeAssistant({ content: [], stopReason: "stop" }),
			DEFAULT_SETTINGS,
		);
		assert.equal(empty.retryable, true);
		if (empty.retryable) assert.equal(empty.kind, "empty");

		const thinkingOnly = classifyAssistantOutcome(
			makeAssistant({
				content: [{ type: "thinking", thinking: "Let me inspect the files..." }],
				stopReason: "stop",
			}),
			DEFAULT_SETTINGS,
		);
		assert.deepEqual(thinkingOnly, {
			retryable: true,
			kind: "empty",
			description: "Empty response (thinking only)",
		});

		const whitespaceOnly = classifyAssistantOutcome(
			makeAssistant({
				content: [{ type: "text", text: "  \n\t  " }],
				stopReason: "stop",
			}),
			DEFAULT_SETTINGS,
		);
		assert.equal(whitespaceOnly.retryable, true);

		const normalToolCall = classifyAssistantOutcome(
			makeAssistant({
				content: [{ type: "toolCall", id: "tc_1", name: "bash", arguments: { command: "pwd" } }],
				stopReason: "toolUse",
			}),
			DEFAULT_SETTINGS,
		);
		assert.deepEqual(normalToolCall, { retryable: false, reason: "ok" });
	});

	it("retries truncated tool calls and premature length cutoffs, while keeping full maxTokens text stops", () => {
		const truncatedTool = classifyAssistantOutcome(
			makeAssistant({
				content: [{ type: "toolCall", id: "tc_1", name: "write", arguments: { path: "a.ts" } }],
				stopReason: "length",
				usage: {
					input: 500,
					output: 4096,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 4596,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			}),
			DEFAULT_SETTINGS,
			{ maxTokens: 4096, contextWindow: 200_000 },
		);
		assert.equal(truncatedTool.retryable, true);
		if (truncatedTool.retryable) assert.equal(truncatedTool.kind, "incomplete");

		const earlyCutoff = classifyAssistantOutcome(
			makeAssistant({
				content: [{ type: "text", text: "Partial sentence cut off by gateway" }],
				stopReason: "length",
				usage: {
					input: 1_000,
					output: 120,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1_120,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			}),
			DEFAULT_SETTINGS,
			{ maxTokens: 4096, contextWindow: 200_000, reserveTokens: 16_384 },
		);
		assert.equal(earlyCutoff.retryable, true);
		if (earlyCutoff.retryable) assert.equal(earlyCutoff.kind, "incomplete");

		const fullMaxTokensStop = classifyAssistantOutcome(
			makeAssistant({
				content: [{ type: "text", text: "Long complete essay hitting exact output limit..." }],
				stopReason: "length",
				usage: {
					input: 1_000,
					output: 4096,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 5_096,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			}),
			DEFAULT_SETTINGS,
			{ maxTokens: 4096, contextWindow: 200_000, reserveTokens: 16_384 },
		);
		assert.deepEqual(fullMaxTokensStop, { retryable: false, reason: "ok" });

		const emptyToolUse = classifyAssistantOutcome(
			makeAssistant({
				content: [],
				stopReason: "toolUse",
			}),
			DEFAULT_SETTINGS,
		);
		assert.equal(emptyToolUse.retryable, true);
		if (emptyToolUse.retryable) assert.equal(emptyToolUse.kind, "incomplete");
	});
});

describe("backoff", () => {
	it("computes capped exponential backoff and clamps to maxRetryDurationMs window", () => {
		const settings = {
			baseDelayMs: 2_000,
			maxDelayMs: 10_000,
			maxRetries: 0,
			maxRetryDurationMs: 5_000,
		};

		assert.equal(rawBackoffDelayMs(1, settings), 2_000);
		assert.equal(rawBackoffDelayMs(2, settings), 4_000);
		assert.equal(rawBackoffDelayMs(4, settings), 10_000);

		const d1 = computeBackoffDecision({ attempt: 1, firstFailureAt: 1_000, now: 1_000 }, settings);
		assert.deepEqual(d1, { allow: true, attempt: 1, maxAttempts: 2, delayMs: 2_000 });

		const d2 = computeBackoffDecision({ attempt: 2, firstFailureAt: 1_000, now: 3_000 }, settings);
		assert.deepEqual(d2, { allow: true, attempt: 2, maxAttempts: 2, delayMs: 3_000 });

		const d3 = computeBackoffDecision({ attempt: 3, firstFailureAt: 1_000, now: 6_000 }, settings);
		assert.deepEqual(d3, { allow: false, reason: "retry_window_expired" });
	});

	it("supports disabling max retry limits completely (maxRetries=0 and maxRetryDurationMs=0)", () => {
		const unlimitedSettings = {
			baseDelayMs: 1_000,
			maxDelayMs: 8_000,
			maxRetries: 0,
			maxRetryDurationMs: 0,
		};

		const d50 = computeBackoffDecision(
			{ attempt: 50, firstFailureAt: 0, now: 3_600_000 },
			unlimitedSettings,
		);
		assert.deepEqual(d50, {
			allow: true,
			attempt: 50,
			maxAttempts: Number.POSITIVE_INFINITY,
			delayMs: 8_000,
		});
	});

	it("enforces maxRetries when configured", () => {
		const settings = {
			baseDelayMs: 500,
			maxDelayMs: 5_000,
			maxRetries: 3,
			maxRetryDurationMs: 0,
		};

		const d3 = computeBackoffDecision({ attempt: 3, firstFailureAt: 0, now: 1_500 }, settings);
		assert.equal(d3.allow, true);

		const d4 = computeBackoffDecision({ attempt: 4, firstFailureAt: 0, now: 3_500 }, settings);
		assert.deepEqual(d4, { allow: false, reason: "max_retries_exceeded" });
	});
});
