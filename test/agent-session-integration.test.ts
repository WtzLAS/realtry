import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type AgentSessionEvent,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS, saveSettings, type RealtrySettings } from "../src/settings.ts";

const EXTENSION_ENTRY = resolve(import.meta.dirname, "../src/index.ts");

const TEST_MODEL: Model<Api> = {
	id: "mock-sonnet",
	name: "Mock Sonnet",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 1_000,
};

function makeUsage(output = 25, input = 100) {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function makeReply(overrides: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Default reply" }],
		api: TEST_MODEL.api,
		provider: TEST_MODEL.provider,
		model: TEST_MODEL.id,
		usage: makeUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

type MockResponder = (
	callIndex: number,
	context: Context,
	options: ModelsSimpleStreamOptions | undefined,
) => AssistantMessageEventStream;

function immediateMessageStream(message: AssistantMessage): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		stream.push({ type: "start", partial: { ...message, content: [] } });
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			stream.push({ type: "error", reason: message.stopReason, error: message });
		} else {
			const doneReason = message.stopReason === "pending" ? "stop" : message.stopReason;
			stream.push({ type: "done", reason: doneReason, message });
		}
		stream.end(message);
	});
	return stream;
}

describe("AgentSession integration with realtry", () => {
	let tempDir: string;
	let settingsFile: string;
	let prevEnv: string | undefined;
	const activeSessions: AgentSession[] = [];

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "realtry-int-"));
		settingsFile = join(tempDir, "realtry.json");
		prevEnv = process.env.REALTRY_SETTINGS_PATH;
		process.env.REALTRY_SETTINGS_PATH = settingsFile;
	});

	afterEach(() => {
		for (const session of activeSessions.splice(0)) {
			session.dispose();
		}
		if (prevEnv === undefined) delete process.env.REALTRY_SETTINGS_PATH;
		else process.env.REALTRY_SETTINGS_PATH = prevEnv;
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function createHarness(
		settingsOverrides: Partial<RealtrySettings>,
		responder: MockResponder,
		customTools?: ToolDefinition[],
	) {
		saveSettings({
			...DEFAULT_SETTINGS,
			baseDelayMs: 10,
			maxDelayMs: 40,
			stallTimeoutMs: 5_000,
			maxRetryDurationMs: 10_000,
			maxRetries: 0,
			...settingsOverrides,
		});

		const settingsManager = SettingsManager.inMemory({
			// Keep Pi's native retry enabled in SettingsManager to prove realtry suppresses and replaces it!
			retry: { enabled: true, maxRetries: 3, baseDelayMs: 10 },
		});
		const sessionManager = SessionManager.inMemory(tempDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir: join(tempDir, "agent"),
			settingsManager,
			additionalExtensionPaths: [EXTENSION_ENTRY],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: join(tempDir, "agent"),
			model: TEST_MODEL,
			noTools: "builtin",
			customTools: customTools ?? [],
			sessionManager,
			settingsManager,
			resourceLoader,
		});
		activeSessions.push(session);

		// Register fake runtime API key so _getRequiredRequestAuth passes without network
		await session.modelRuntime.setRuntimeApiKey(TEST_MODEL.provider, "test-key");

		const seenContexts: Context[] = [];
		const events: AgentSessionEvent[] = [];
		session.subscribe((event) => events.push(event));

		let calls = 0;
		session.agent.streamFunction = (_model, context, options) => {
			const idx = ++calls;
			seenContexts.push(structuredClone(context));
			return responder(idx, context, options);
		};

		const statusUpdates: Array<{ key: string; text: string | undefined }> = [];
		const mockUiContext = {
			notify() {},
			setStatus(key: string, text: string | undefined) {
				statusUpdates.push({ key, text });
			},
		} as never;

		await session.bindExtensions({ uiContext: mockUiContext });
		return { session, sessionManager, seenContexts, events, statusUpdates, getCallCount: () => calls };
	}

	function assertNoInjectedMessages(sessionManager: SessionManager, seenContexts: Context[]) {
		for (const entry of sessionManager.getEntries()) {
			assert.notEqual(entry.type, "custom_message", "realtry must never append custom_message entries");
		}
		for (const ctx of seenContexts) {
			for (const msg of ctx.messages) {
				if (msg.role === "user") {
					const text = JSON.stringify(msg.content);
					assert.doesNotMatch(text, /retry|continue where you left off|previous turn/i);
				}
			}
		}
	}

	it("retries transient network errors without injecting messages and replaces Pi native retry", async () => {
		const { session, sessionManager, seenContexts, events, getCallCount } = await createHarness(
			{},
			(call) => {
				if (call === 1) {
					return immediateMessageStream(
						makeReply({ content: [], stopReason: "error", errorMessage: "fetch failed: ECONNRESET" }),
					);
				}
				if (call === 2) {
					return immediateMessageStream(
						makeReply({ content: [], stopReason: "error", errorMessage: "503 Service Unavailable" }),
					);
				}
				return immediateMessageStream(
					makeReply({ content: [{ type: "text", text: "Recovered cleanly!" }], stopReason: "stop" }),
				);
			},
		);

		await session.prompt("Say hi");

		assert.equal(getCallCount(), 3);
		assertNoInjectedMessages(sessionManager, seenContexts);

		// Every retry attempt sent ONLY the original user message (failed assistant turns omitted!)
		for (const ctx of seenContexts) {
			const nonSystem = ctx.messages.filter((m) => m.role !== "system");
			assert.equal(nonSystem.length, 1);
			assert.equal(nonSystem[0]?.role, "user");
		}

		const retryStarts = events.filter((e) => e.type === "auto_retry_start");
		const retryEnds = events.filter((e) => e.type === "auto_retry_end");
		assert.equal(retryStarts.length, 2);
		assert.equal(retryEnds.length, 1);
		assert.equal(retryEnds[0]?.type === "auto_retry_end" && retryEnds[0].success, true);

		const projected = sessionManager.buildSessionProjection().messages.filter((m) => m.role !== "system");
		assert.deepEqual(
			projected.map((m) => m.role),
			["user", "assistant"],
		);
	});

	it("never retries 5-hour or weekly quota errors", async () => {
		for (const quotaMsg of [
			"429 Too Many Requests: You have exceeded your 5-hour usage limit.",
			"429 Weekly limit exceeded for your plan.",
		]) {
			const { session, events, getCallCount } = await createHarness({}, () =>
				immediateMessageStream(makeReply({ content: [], stopReason: "error", errorMessage: quotaMsg })),
			);

			await session.prompt("Hello");
			assert.equal(getCallCount(), 1, `Should not retry quota error: ${quotaMsg}`);
			assert.equal(events.filter((e) => e.type === "auto_retry_start").length, 0);
		}
	});

	it("aborts and retries stalled streams using configurable stallTimeoutMs", async () => {
		const { session, sessionManager, seenContexts, getCallCount } = await createHarness(
			{ stallTimeoutMs: 60 },
			(call) => {
				if (call === 1) {
					// Hung socket that never emits anything
					return createAssistantMessageEventStream();
				}
				return immediateMessageStream(
					makeReply({ content: [{ type: "text", text: "Unstalled on retry!" }], stopReason: "stop" }),
				);
			},
		);

		await session.prompt("Hello");
		assert.equal(getCallCount(), 2);
		assertNoInjectedMessages(sessionManager, seenContexts);

		const projected = sessionManager.buildSessionProjection().messages.filter((m) => m.role !== "system");
		assert.equal(projected.length, 2);
		assert.equal(projected[1]?.role, "assistant");
	});

	it("retries empty and thinking-only responses by omitting them without nudges", async () => {
		const { session, sessionManager, seenContexts, getCallCount } = await createHarness({}, (call) => {
			if (call === 1) {
				return immediateMessageStream(
					makeReply({
						content: [{ type: "thinking", thinking: "Thinking silently..." }],
						stopReason: "stop",
					}),
				);
			}
			if (call === 2) {
				return immediateMessageStream(makeReply({ content: [], stopReason: "stop" }));
			}
			return immediateMessageStream(
				makeReply({ content: [{ type: "text", text: "Actual visible answer" }], stopReason: "stop" }),
			);
		});

		await session.prompt("Answer please");
		assert.equal(getCallCount(), 3);
		assertNoInjectedMessages(sessionManager, seenContexts);

		const projected = sessionManager.buildSessionProjection().messages.filter((m) => m.role !== "system");
		assert.deepEqual(
			projected.map((m) => m.role),
			["user", "assistant"],
		);
	});

	it("omits truncated tool-call turns (and synthetic error toolResults) and retries cleanly", async () => {
		let toolExecutions = 0;
		const echoTool = {
			name: "echo_tool",
			label: "Echo",
			description: "Echoes text",
			parameters: {
				type: "object",
				properties: { text: { type: "string" } },
				required: ["text"],
			} as never,
			async execute(_id: string, params: { text: string }) {
				toolExecutions++;
				return {
					content: [{ type: "text" as const, text: `ECHO:${params.text}` }],
					details: {},
				};
			},
		};

		const { session, sessionManager, seenContexts, getCallCount } = await createHarness(
			{},
			(call) => {
				if (call === 1) {
					// Truncated tool call at maxTokens -> agent-loop generates synthetic error toolResult,
					// which realtry intercepts, omits completely, and retries!
					return immediateMessageStream(
						makeReply({
							content: [{ type: "toolCall", id: "tc_trunc", name: "echo_tool", arguments: { text: "cut" } }],
							stopReason: "length",
							usage: makeUsage(1_000),
						}),
					);
				}
				if (call === 2) {
					return immediateMessageStream(
						makeReply({
							content: [{ type: "toolCall", id: "tc_ok", name: "echo_tool", arguments: { text: "complete" } }],
							stopReason: "toolUse",
						}),
					);
				}
				return immediateMessageStream(
					makeReply({ content: [{ type: "text", text: "Done after tool" }], stopReason: "stop" }),
				);
			},
			[echoTool],
		);

		await session.prompt("Use echo_tool");
		assert.equal(getCallCount(), 3);
		assert.equal(toolExecutions, 1);
		assertNoInjectedMessages(sessionManager, seenContexts);

		// Call 2 must NOT see the synthetic truncated-tool error message!
		const call2NonSystem = seenContexts[1]!.messages.filter((m) => m.role !== "system");
		assert.deepEqual(
			call2NonSystem.map((m) => m.role),
			["user"],
		);

		const projected = sessionManager.buildSessionProjection().messages.filter((m) => m.role !== "system");
		assert.deepEqual(
			projected.map((m) => m.role),
			["user", "assistant", "toolResult", "assistant"],
		);
	});

	it("retries beyond Pi's 3-attempt cap when maxRetries and maxRetryDurationMs are disabled", async () => {
		const { session, getCallCount } = await createHarness(
			{
				maxRetries: 0,
				maxRetryDurationMs: 0,
				baseDelayMs: 5,
				maxDelayMs: 10,
			},
			(call) => {
				if (call <= 6) {
					return immediateMessageStream(
						makeReply({ content: [], stopReason: "error", errorMessage: "502 Bad Gateway" }),
					);
				}
				return immediateMessageStream(
					makeReply({ content: [{ type: "text", text: "Succeeded on 7th call!" }], stopReason: "stop" }),
				);
			},
		);

		await session.prompt("Keep trying");
		assert.equal(getCallCount(), 7);
	});

	it("supports unconditional /retry after user abort (Operation aborted) during streaming", async () => {
		let shouldHangForUserAbort = true;
		let streamStartedResolve!: () => void;
		const streamStarted = new Promise<void>((resolve) => {
			streamStartedResolve = resolve;
		});

		const { session, sessionManager, seenContexts, getCallCount } = await createHarness({}, (_call, _ctx, options) => {
			if (shouldHangForUserAbort) {
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: makeReply({ content: [] }) });
					streamStartedResolve();
				});
				options?.signal?.addEventListener("abort", () => {
					const aborted = makeReply({
						content: [],
						stopReason: "aborted",
						errorMessage: "Operation aborted",
					});
					stream.push({ type: "error", reason: "aborted", error: aborted });
					stream.end(aborted);
				});
				return stream;
			}
			return immediateMessageStream(
				makeReply({ content: [{ type: "text", text: "Completed via /retry!" }], stopReason: "stop" }),
			);
		});

		const firstPrompt = session.prompt("Explain quantum tunneling");
		await streamStarted;
		await session.abort();
		await firstPrompt;

		const beforeRetry = sessionManager.buildSessionProjection().messages.filter((m) => m.role !== "system");
		assert.equal(beforeRetry.at(-1)?.role, "assistant");
		assert.equal((beforeRetry.at(-1) as AssistantMessage).stopReason, "aborted");
		assert.equal((beforeRetry.at(-1) as AssistantMessage).errorMessage, "Operation aborted");

		shouldHangForUserAbort = false;
		await session.prompt("/retry");

		assert.equal(getCallCount(), 2);
		assertNoInjectedMessages(sessionManager, seenContexts);

		// Second call received ONLY the original user message — zero Operation aborted or retry prompts!
		const secondCallMsgs = seenContexts[1]!.messages.filter((m) => m.role !== "system");
		assert.deepEqual(
			secondCallMsgs.map((m) => m.role),
			["user"],
		);

		const afterRetry = sessionManager.buildSessionProjection().messages.filter((m) => m.role !== "system");
		assert.deepEqual(
			afterRetry.map((m) => m.role),
			["user", "assistant"],
		);
		assert.equal((afterRetry[1] as AssistantMessage).stopReason, "stop");
	});

	it("supports unconditional /retry after user abort during tool execution (Operation aborted)", async () => {
		let abortDuringTool = true;
		let toolStartedResolve!: () => void;
		const toolStarted = new Promise<void>((resolve) => {
			toolStartedResolve = resolve;
		});

		const slowTool = {
			name: "slow_op",
			label: "Slow Op",
			description: "Runs slowly",
			parameters: { type: "object", properties: {} } as never,
			async execute(_id: string, _params: unknown, signal?: AbortSignal) {
				if (!abortDuringTool) {
					return { content: [{ type: "text" as const, text: "tool succeeded" }], details: {} };
				}
				toolStartedResolve();
				return new Promise<never>((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new Error("Operation aborted")), { once: true });
				});
			},
		};

		const { session, sessionManager, seenContexts } = await createHarness(
			{},
			(_call, context, options) => {
				if (options?.signal?.aborted) {
					return immediateMessageStream(
						makeReply({ content: [], stopReason: "aborted", errorMessage: "Operation aborted" }),
					);
				}
				const hasToolResult = context.messages.some((m) => m.role === "toolResult");
				if (!hasToolResult) {
					return immediateMessageStream(
						makeReply({
							content: [
								{ type: "toolCall", id: `tc_${Date.now()}_1`, name: "slow_op", arguments: {} },
								{ type: "toolCall", id: `tc_${Date.now()}_2`, name: "slow_op", arguments: {} },
							],
							stopReason: "toolUse",
						}),
					);
				}
				return immediateMessageStream(
					makeReply({ content: [{ type: "text", text: "All tools completed!" }], stopReason: "stop" }),
				);
			},
			[slowTool],
		);

		const abortedRun = session.prompt("Run slow_op");
		await toolStarted;
		await session.abort();
		await abortedRun;

		abortDuringTool = false;
		await session.prompt("/retry");

		assertNoInjectedMessages(sessionManager, seenContexts);

		const projected = sessionManager.buildSessionProjection().messages.filter((m) => m.role !== "system");
		assert.deepEqual(
			projected.map((m) => m.role),
			["user", "assistant", "toolResult", "toolResult", "assistant"],
		);
		for (const msg of projected) {
			assert.doesNotMatch(JSON.stringify(msg), /Operation aborted/);
		}
	});

	it("supports unconditional /retry on a completed assistant turn and wakes active backoff immediately", async () => {
		let mode: "normal" | "regenerated" | "backoff" = "normal";
		const { session, sessionManager, seenContexts } = await createHarness(
			{ baseDelayMs: 30_000, maxDelayMs: 30_000 },
			(call) => {
				if (mode === "normal") {
					return immediateMessageStream(
						makeReply({ content: [{ type: "text", text: "First answer" }], stopReason: "stop" }),
					);
				}
				if (mode === "regenerated") {
					return immediateMessageStream(
						makeReply({ content: [{ type: "text", text: "Regenerated answer" }], stopReason: "stop" }),
					);
				}
				if (call === 3) {
					return immediateMessageStream(
						makeReply({ content: [], stopReason: "error", errorMessage: "503 Service Unavailable" }),
					);
				}
				return immediateMessageStream(
					makeReply({ content: [{ type: "text", text: "Woken from backoff!" }], stopReason: "stop" }),
				);
			},
		);

		await session.prompt("Give an answer");
		mode = "regenerated";
		await session.prompt("/retry");

		const projectedAfterRegen = sessionManager.buildSessionProjection().messages.filter((m) => m.role !== "system");
		assert.deepEqual(
			projectedAfterRegen.map((m) => m.role),
			["user", "assistant"],
		);
		assert.match(JSON.stringify(projectedAfterRegen[1]), /Regenerated answer/);

		// Now trigger a 30s backoff and wake it immediately with /retry!
		mode = "backoff";
		let retryScheduledResolve!: () => void;
		const retryScheduled = new Promise<void>((resolve) => {
			retryScheduledResolve = resolve;
		});
		const unsub = session.subscribe((e) => {
			if (e.type === "auto_retry_start") retryScheduledResolve();
		});

		const startedAt = Date.now();
		const runPromise = session.prompt("Second question");
		await retryScheduled;
		assert.equal(session.isRetrying, true);

		await session.prompt("/retry");
		await runPromise;
		unsub();

		const elapsed = Date.now() - startedAt;
		assert.ok(elapsed < 5_000, `Expected /retry to wake 30s backoff immediately, took ${elapsed}ms`);
		assertNoInjectedMessages(sessionManager, seenContexts);
	});

	it("retries premature length cutoffs without compaction, while keeping full maxTokens text stops", async () => {
		let phase: "premature" | "full" = "premature";
		const { session, sessionManager, seenContexts, events, getCallCount } = await createHarness({}, (call) => {
			if (phase === "premature" && call === 1) {
				return immediateMessageStream(
					makeReply({
						content: [{ type: "text", text: "Cut off mid-sentence" }],
						stopReason: "length",
						usage: makeUsage(80, 150),
					}),
				);
			}
			if (phase === "premature") {
				return immediateMessageStream(
					makeReply({
						content: [{ type: "text", text: "Complete sentence on retry." }],
						stopReason: "stop",
						usage: makeUsage(40, 150),
					}),
				);
			}
			// Genuine full maxTokens stop (output === TEST_MODEL.maxTokens === 1000)
			return immediateMessageStream(
				makeReply({
					content: [{ type: "text", text: "Full 1000-token answer" }],
					stopReason: "length",
					usage: makeUsage(1_000, 200),
				}),
			);
		});

		await session.prompt("Short answer");
		assert.equal(getCallCount(), 2);
		assert.equal(events.filter((e) => e.type === "compaction_start").length, 0);

		phase = "full";
		await session.prompt("Long answer");
		assert.equal(getCallCount(), 3);
		assertNoInjectedMessages(sessionManager, seenContexts);
	});

	it("cancels active backoff via session.abortRetry() (Escape) and still recovers on later /retry", async () => {
		let failCount = 0;
		let retryStartedResolve!: () => void;
		const retryStarted = new Promise<void>((resolve) => {
			retryStartedResolve = resolve;
		});

		const { session, sessionManager, seenContexts, events } = await createHarness(
			{ baseDelayMs: 30_000, maxDelayMs: 30_000 },
			() => {
				failCount++;
				if (failCount === 1) {
					return immediateMessageStream(
						makeReply({ content: [], stopReason: "error", errorMessage: "ECONNRESET" }),
					);
				}
				return immediateMessageStream(
					makeReply({ content: [{ type: "text", text: "Recovered after Escape + /retry!" }], stopReason: "stop" }),
				);
			},
		);

		session.subscribe((e) => {
			if (e.type === "auto_retry_start") retryStartedResolve();
		});

		const firstRun = session.prompt("Try once");
		await retryStarted;
		session.abortRetry();
		await firstRun;

		const cancelEnd = events.find(
			(e): e is Extract<AgentSessionEvent, { type: "auto_retry_end" }> =>
				e.type === "auto_retry_end" && !e.success,
		);
		assert.ok(cancelEnd);
		assert.equal(cancelEnd.finalError, "Retry cancelled");

		await session.prompt("/retry");
		assertNoInjectedMessages(sessionManager, seenContexts);

		const projected = sessionManager.buildSessionProjection().messages.filter((m) => m.role !== "system");
		assert.deepEqual(
			projected.map((m) => m.role),
			["user", "assistant"],
		);
		assert.match(JSON.stringify(projected[1]), /Recovered after Escape \+ \/retry!/);
	});

	it("shows 🔁 + remaining timeout in the footer while realtry is acting and clears when settled", async () => {
		let failOnce = true;
		const { session, statusUpdates } = await createHarness(
			{
				maxRetryDurationMs: 43_200_000,
				stallTimeoutMs: 600_000,
				baseDelayMs: 25,
				maxDelayMs: 50,
			},
			() => {
				if (failOnce) {
					failOnce = false;
					return immediateMessageStream(
						makeReply({ content: [], stopReason: "error", errorMessage: "503 Service Unavailable" }),
					);
				}
				return immediateMessageStream(
					makeReply({ content: [{ type: "text", text: "Success!" }], stopReason: "stop" }),
				);
			},
		);

		await session.prompt("Test footer during auto retry");

		const realtryStatuses = statusUpdates.filter((s) => s.key === "realtry");
		assert.ok(realtryStatuses.length >= 2, "Expected active footer status followed by clear");
		assert.match(realtryStatuses[0]!.text ?? "", /^🔁 1[12]h\d{2}m\d{2}s$/);
		assert.equal(realtryStatuses.at(-1)!.text, undefined);

		// Also verify footer appears during manual /retry and clears once finished
		statusUpdates.length = 0;
		await session.prompt("/retry");
		const manualStatuses = statusUpdates.filter((s) => s.key === "realtry");
		assert.ok(manualStatuses.some((s) => s.text?.startsWith("🔁 ")));
		assert.equal(manualStatuses.at(-1)?.text, undefined);
	});
});
