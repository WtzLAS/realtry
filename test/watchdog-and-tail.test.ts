import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type Model,
} from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { invokeStreamWithWatchdog } from "../src/stream-watchdog.ts";
import { prepareSessionForUnconditionalRetry } from "../src/tail.ts";

const TEST_MODEL: Model<Api> = {
	id: "test-model",
	name: "Test Model",
	api: "anthropic-messages",
	provider: "test",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 4_096,
};

const ZERO_USAGE = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeAssistantMessage(overrides: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: TEST_MODEL.api,
		provider: TEST_MODEL.provider,
		model: TEST_MODEL.id,
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

describe("stream stall watchdog", () => {
	it("forces maxRetries=0 and terminates hung streams with retryable stall timeout error", async () => {
		let capturedMaxRetries: number | undefined;
		let innerAborted = false;

		const stream = invokeStreamWithWatchdog(
			(_model, _context, options) => {
				capturedMaxRetries = options?.maxRetries;
				const hung = createAssistantMessageEventStream();
				options?.signal?.addEventListener("abort", () => {
					innerAborted = true;
				});
				// Intentionally never push or end `hung`!
				return hung;
			},
			TEST_MODEL,
			{ messages: [] },
			undefined,
			{ stallTimeoutMs: 50 },
		);

		const result = await stream.result();
		assert.equal(capturedMaxRetries, 0);
		assert.equal(innerAborted, true);
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /Stream stalled: no response activity for 50ms \(realtry timeout\)/);
	});

	it("resets inactivity timer on streaming events so active slow streams succeed", async () => {
		const stream = invokeStreamWithWatchdog(
			() => {
				const inner = createAssistantMessageEventStream();
				const partial = makeAssistantMessage({ content: [{ type: "text", text: "he" }] });
				setTimeout(() => {
					inner.push({ type: "start", partial });
				}, 30);
				setTimeout(() => {
					inner.push({
						type: "text_delta",
						contentIndex: 0,
						delta: "llo",
						partial: makeAssistantMessage({ content: [{ type: "text", text: "hello" }] }),
					});
				}, 65);
				setTimeout(() => {
					const done = makeAssistantMessage({ content: [{ type: "text", text: "hello" }], stopReason: "stop" });
					inner.push({ type: "done", reason: "stop", message: done });
					inner.end(done);
				}, 100);
				return inner;
			},
			TEST_MODEL,
			{ messages: [] },
			undefined,
			{ stallTimeoutMs: 60 },
		);

		const result = await stream.result();
		assert.equal(result.stopReason, "stop");
	});

	it("preserves stopReason=aborted when caller signal aborts", async () => {
		const userAbort = new AbortController();
		const stream = invokeStreamWithWatchdog(
			(_model, _context, options) => {
				const inner = createAssistantMessageEventStream();
				options?.signal?.addEventListener("abort", () => {
					const aborted = makeAssistantMessage({
						content: [],
						stopReason: "aborted",
						errorMessage: "Operation aborted",
					});
					inner.push({ type: "error", reason: "aborted", error: aborted });
					inner.end(aborted);
				});
				return inner;
			},
			TEST_MODEL,
			{ messages: [] },
			{ signal: userAbort.signal },
			{ stallTimeoutMs: 500 },
		);

		setTimeout(() => userAbort.abort(), 15);
		const result = await stream.result();
		assert.equal(result.stopReason, "aborted");
		assert.equal(result.errorMessage, "Operation aborted");
	});
});

describe("session tail preparation for unconditional /retry", () => {
	it("leaves session untouched when ending on user message", () => {
		const sm = SessionManager.inMemory();
		sm.appendMessage({ role: "user", content: [{ type: "text", text: "Fix bug" }], timestamp: Date.now() });

		const prep = prepareSessionForUnconditionalRetry(sm);
		assert.equal(prep.canContinue, true);
		assert.deepEqual(prep.omittedEntryIds, []);
		assert.equal(sm.buildSessionProjection().messages.length, 1);
	});

	it("omits trailing Operation aborted assistant while preserving completed prior tool batch", () => {
		const sm = SessionManager.inMemory();
		sm.appendMessage({ role: "user", content: [{ type: "text", text: "Run pwd" }], timestamp: Date.now() });
		sm.appendMessage(
			makeAssistantMessage({
				content: [{ type: "toolCall", id: "tc_1", name: "bash", arguments: { command: "pwd" } }],
				stopReason: "toolUse",
			}),
		);
		sm.appendMessage({
			role: "toolResult",
			toolCallId: "tc_1",
			toolName: "bash",
			content: [{ type: "text", text: "/tmp\n" }],
			isError: false,
			timestamp: Date.now(),
		});
		const abortedId = sm.appendMessage(
			makeAssistantMessage({
				content: [],
				stopReason: "aborted",
				errorMessage: "Operation aborted",
			}),
		);

		const prep = prepareSessionForUnconditionalRetry(sm);
		assert.equal(prep.canContinue, true);
		assert.deepEqual(prep.omittedEntryIds, [abortedId]);

		const projected = sm.buildSessionProjection().messages;
		assert.deepEqual(
			projected.map((m) => m.role),
			["user", "assistant", "toolResult"],
		);
	});

	it("rolls back entire tool turn when aborted mid-tool (Operation aborted / missing sibling toolResult)", () => {
		const sm = SessionManager.inMemory();
		sm.appendMessage({ role: "user", content: [{ type: "text", text: "Build and test" }], timestamp: Date.now() });
		const assistantToolId = sm.appendMessage(
			makeAssistantMessage({
				content: [
					{ type: "toolCall", id: "tc_1", name: "bash", arguments: { command: "sleep 10" } },
					{ type: "toolCall", id: "tc_2", name: "bash", arguments: { command: "npm test" } },
				],
				stopReason: "toolUse",
			}),
		);
		const abortedToolResultId = sm.appendMessage({
			role: "toolResult",
			toolCallId: "tc_1",
			toolName: "bash",
			content: [{ type: "text", text: "partial output\n\nCommand aborted" }],
			isError: true,
			timestamp: Date.now(),
		});
		// tc_2 was skipped by sequential break on signal.aborted, followed by trailing aborted assistant:
		const trailingAbortedId = sm.appendMessage(
			makeAssistantMessage({
				content: [],
				stopReason: "aborted",
				errorMessage: "Operation aborted",
			}),
		);

		const prep = prepareSessionForUnconditionalRetry(sm);
		assert.equal(prep.canContinue, true);
		assert.deepEqual(prep.omittedEntryIds, [trailingAbortedId, assistantToolId, abortedToolResultId]);

		const projected = sm.buildSessionProjection().messages;
		assert.equal(projected.length, 1);
		assert.equal(projected[0]?.role, "user");
	});
});
