import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
	getCurrentTools,
	getToolStateChanges,
	toToolDeclaration,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type ModelsSimpleStreamOptions,
	type SystemMessage,
} from "@earendil-works/pi-ai";
import {
	AgentSession,
	type AgentSessionEvent,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ModelRuntime,
	type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { computeBackoffDecision } from "./backoff.ts";
import { classifyAssistantOutcome, type ModelLimits } from "./classifier.ts";
import type { RealtrySettings } from "./settings.ts";
import { invokeStreamWithWatchdog } from "./stream-watchdog.ts";
import { prepareSessionForUnconditionalRetry } from "./tail.ts";

export const REALTRY_BRIDGE_SYMBOL = Symbol.for("realtry.bridge.v1");
const GLOBAL_STATE_SYMBOL = Symbol.for("realtry.globalState.v1");
const PROTOTYPE_PATCHED_SYMBOL = Symbol.for("realtry.agentSessionPatched.v1");
const WATCHDOG_APPLIED_SYMBOL = Symbol.for("realtry.watchdogApplied.v1");
const FINISH_TURN_PATCHED_SYMBOL = Symbol.for("realtry.finishTurnPatched.v1");
/** Internal shape of Pi 1.5.x `AgentSession` accessed by `realtry`. */
interface InternalAgentSession {
	agent: {
		state: {
			model: Model<Api> | undefined;
			thinkingLevel: string;
			tools: Parameters<typeof toToolDeclaration>[0][];
			messages: AssistantMessage[] | unknown[];
		};
		streamFunction: (
			model: Model<Api>,
			context: Context,
			options?: ModelsSimpleStreamOptions,
		) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
		finishTurn?: (
			turn: {
				message: AssistantMessage;
				toolResults: unknown[];
				context: unknown;
				newMessages: unknown[];
			},
			signal?: AbortSignal,
		) => Promise<{ action: "continue" | "end" } | undefined>;
		hasQueuedMessages(): boolean;
		continue(): Promise<void>;
		abort(): void;
	};
	sessionManager: SessionManager;
	settingsManager: {
		getCompactionSettings(model?: Model<Api>): {
			enabled: boolean;
			reserveTokens: number;
			keepRecentTokens: number;
		};
	};
	modelRuntime: ModelRuntime;
	model: Model<Api> | undefined;
	sessionId: string;
	isStreaming: boolean;
	isCompacting: boolean;
	isIdle: boolean;
	refreshContext(): void;
	abort(): Promise<void>;
	waitForIdle(): Promise<void>;
	getActiveToolNames(): string[];

	_extensionRunner?: {
		getCommand(name: string): { handler?: unknown } | undefined;
	};
	_isAgentRunActive: boolean;
	_agentRunAbortRequested: boolean;
	_isEmittingAgentSettled: boolean;
	_deferredSettledActions: Array<() => Promise<void>>;
	_lastAssistantMessage: AssistantMessage | undefined;
	_failedResponse: AssistantMessage | undefined;
	_baseSystemPromptOptions: Record<string, unknown>;
	_runSystemPromptOptions: Record<string, unknown> | undefined;
	_pendingToolNames: Set<string>;
	_compactionAbortController: AbortController | undefined;
	_branchSummaryAbortController: AbortController | undefined;

	_emit(event: AgentSessionEvent | Record<string, unknown>): void;
	_omitRecoveryAttempt(message: AssistantMessage): void;
	_checkCompaction(message: AssistantMessage, skipAbortedCheck?: boolean): Promise<boolean>;
	_runBeforeSettleBoundary(): Promise<boolean>;
	_emitAgentSettled(): Promise<void>;
	_flushPendingBashMessages(): void;
	_flushPendingCustomMessages(): void;
	_recordSelection(): void;
	_resolveIdleWaitIfIdle(): void;
	_modelForMessage?(message: AssistantMessage): Model<Api> | undefined;
	_getRequiredRequestAuth?(model: Model<Api>, signal?: AbortSignal): Promise<unknown>;
	_preparePromptAndToolLoadout?(
		options: Record<string, unknown>,
		messages?: readonly unknown[],
	): SystemMessage | undefined;
	_getSummarizationRequestAuth?(
		selectedModel: Model<Api>,
		signal?: AbortSignal,
	): Promise<unknown>;
}

export interface RealtrySessionSnapshot {
	attempt: number;
	isRetrying: boolean;
	firstFailureAt: number | undefined;
	lastError: string | undefined;
	totalRetriesInSession: number;
}

type BackoffWaitOutcome = "ready" | "woken" | "cancelled";

interface GlobalRealtryState {
	sessionControllers: WeakMap<object, RealtrySessionController>;
	sessionByManager: WeakMap<object, AgentSession>;
}

const globalHolder = globalThis as unknown as Record<symbol, GlobalRealtryState | undefined>;
const globalState: GlobalRealtryState =
	globalHolder[GLOBAL_STATE_SYMBOL] ??
	(globalHolder[GLOBAL_STATE_SYMBOL] = {
		sessionControllers: new WeakMap<object, RealtrySessionController>(),
		sessionByManager: new WeakMap<object, AgentSession>(),
	});
const { sessionControllers, sessionByManager } = globalState;
export class RealtryBridge {
	private readonly getSettingsFn: () => RealtrySettings;
	private readonly controllers = new Set<RealtrySessionController>();

	constructor(getSettings: () => RealtrySettings) {
		this.getSettingsFn = getSettings;
		ensureAgentSessionPrototypePatched();
	}

	getSettings(): RealtrySettings {
		return this.getSettingsFn();
	}

	attachSession(session: AgentSession): RealtrySessionController {
		sessionByManager.set(session.sessionManager, session);
		const existing = sessionControllers.get(session);
		if (existing && existing.bridge === this && !existing.isDisposed()) {
			existing.rebindHooks();
			return existing;
		}
		existing?.dispose();
		const controller = new RealtrySessionController(session, this);
		sessionControllers.set(session, controller);
		this.controllers.add(controller);
		return controller;
	}

	controllerForContext(ctx: Pick<ExtensionContext, "sessionManager">): RealtrySessionController | undefined {
		const session = sessionByManager.get(ctx.sessionManager);
		if (!session) return undefined;
		const existing = sessionControllers.get(session);
		if (existing && existing.bridge === this && !existing.isDisposed()) {
			return existing;
		}
		return this.attachSession(session);
	}

	removeController(controller: RealtrySessionController): void {
		this.controllers.delete(controller);
	}

	shutdownAll(): void {
		for (const controller of [...this.controllers]) {
			controller.dispose();
		}
		this.controllers.clear();
	}
}

export class RealtrySessionController {
	readonly session: AgentSession;
	readonly bridge: RealtryBridge;

	private attempt = 0;
	private firstFailureAt: number | undefined;
	private lastError: string | undefined;
	private totalRetriesInSession = 0;
	private disposed = false;

	private activeBackoff:
		| {
				cancel: () => void;
				wake: () => void;
		  }
		| undefined;

	private rawAgentStreamFn: InternalAgentSession["agent"]["streamFunction"] | undefined;
	private wrappedAgentStreamFn: InternalAgentSession["agent"]["streamFunction"] | undefined;

	constructor(session: AgentSession, bridge: RealtryBridge) {
		this.session = session;
		this.bridge = bridge;
		this.rebindHooks();
	}

	isDisposed(): boolean {
		return this.disposed;
	}

	get isRetrying(): boolean {
		return this.activeBackoff !== undefined;
	}

	get retryAttempt(): number {
		return this.attempt;
	}

	snapshot(): RealtrySessionSnapshot {
		return {
			attempt: this.attempt,
			isRetrying: this.isRetrying,
			firstFailureAt: this.firstFailureAt,
			lastError: this.lastError,
			totalRetriesInSession: this.totalRetriesInSession,
		};
	}

	rebindHooks(): void {
		if (this.disposed) return;
		const internal = this.session as unknown as InternalAgentSession;
		this.ensureAgentFinishTurnPatched(internal);
		this.ensureAgentStreamFnPatched(internal);
	}

	private ensureAgentFinishTurnPatched(internal: InternalAgentSession): void {
		const currentFinishTurn = internal.agent.finishTurn as
			| (InternalAgentSession["agent"]["finishTurn"] & { [FINISH_TURN_PATCHED_SYMBOL]?: boolean })
			| undefined;
		if (currentFinishTurn?.[FINISH_TURN_PATCHED_SYMBOL]) {
			return;
		}
		const previousFinishTurn = internal.agent.finishTurn;
		const wrapped = Object.assign(
			async (
				turn: {
					message: AssistantMessage;
					toolResults: unknown[];
					context: unknown;
					newMessages: unknown[];
				},
				signal?: AbortSignal,
			): Promise<{ action: "continue" | "end" } | undefined> => {
				const previousDecision = await previousFinishTurn?.(turn, signal);
				if (this.disposed) return previousDecision;
				const settings = this.bridge.getSettings();
				if (
					settings.enabled &&
					settings.retryIncomplete &&
					!signal?.aborted &&
					turn.message.role === "assistant" &&
					turn.message.stopReason === "length" &&
					turn.message.content.some((block) => block.type === "toolCall")
				) {
					// Stop agent-loop from sending synthetic truncated-tool error messages to the model;
					// _handlePostAgentRun will omit both the assistant turn and synthetic toolResults and retry.
					return { action: "end" };
				}
				return previousDecision;
			},
			{ [FINISH_TURN_PATCHED_SYMBOL]: true },
		);
		internal.agent.finishTurn = wrapped;
	}

	private ensureAgentStreamFnPatched(internal: InternalAgentSession): void {
		if (internal.agent.streamFunction === this.wrappedAgentStreamFn) {
			return;
		}
		const baseStreamFn = internal.agent.streamFunction;
		this.rawAgentStreamFn = baseStreamFn;
		const wrapped: InternalAgentSession["agent"]["streamFunction"] = (model, context, options) => {
			if (this.disposed) {
				return baseStreamFn(model, context, options);
			}
			const settings = this.bridge.getSettings();
			if (!settings.enabled || (options && (options as Record<symbol, unknown>)[WATCHDOG_APPLIED_SYMBOL])) {
				return baseStreamFn(model, context, options);
			}
			// Only apply watchdog to session turns (or direct agent runs without a foreign sessionId)
			if (options?.sessionId !== undefined && options.sessionId !== internal.sessionId) {
				return baseStreamFn(model, context, options);
			}
			const markedOptions = {
				...options,
				[WATCHDOG_APPLIED_SYMBOL]: true,
			} as ModelsSimpleStreamOptions;
			return invokeStreamWithWatchdog(baseStreamFn, model, context, markedOptions, {
				stallTimeoutMs: settings.stallTimeoutMs,
				suppressProviderRetries: true,
			});
		};
		this.wrappedAgentStreamFn = wrapped;
		internal.agent.streamFunction = wrapped;
	}

	withUnwrappedStreamFn<T>(fn: () => Promise<T>): Promise<T> {
		const internal = this.session as unknown as InternalAgentSession;
		if (internal.agent.streamFunction !== this.wrappedAgentStreamFn || !this.rawAgentStreamFn) {
			return fn();
		}
		internal.agent.streamFunction = this.rawAgentStreamFn;
		return fn().finally(() => {
			if (!this.disposed && internal.agent.streamFunction === this.rawAgentStreamFn && this.wrappedAgentStreamFn) {
				internal.agent.streamFunction = this.wrappedAgentStreamFn;
			}
		});
	}

	getModelLimits(message: AssistantMessage): ModelLimits {
		const internal = this.session as unknown as InternalAgentSession;
		const resolvedModel = internal._modelForMessage?.(message) ?? internal.model;
		const reserveTokens = internal.settingsManager?.getCompactionSettings?.(internal.model)?.reserveTokens ?? 0;
		return {
			maxTokens: resolvedModel?.maxTokens,
			contextWindow: resolvedModel?.contextWindow,
			reserveTokens,
		};
	}

	onMessageEnd(message: unknown): void {
		if (this.disposed) return;
		const msg = message as Partial<AssistantMessage> | undefined;
		if (!msg || msg.role !== "assistant") return;
		const settings = this.bridge.getSettings();
		if (!settings.enabled) return;

		if (this.attempt > 0) {
			const classification = classifyAssistantOutcome(
				msg as AssistantMessage,
				settings,
				this.getModelLimits(msg as AssistantMessage),
			);
			if (!classification.retryable && classification.reason === "ok") {
				const completedAttempt = this.attempt;
				this.attempt = 0;
				this.firstFailureAt = undefined;
				const internal = this.session as unknown as InternalAgentSession;
				internal._emit({
					type: "auto_retry_end",
					success: true,
					attempt: completedAttempt,
				});
			}
		}
	}

	onFreshUserInput(): void {
		if (this.disposed) return;
		if (this.isRetrying) {
			this.abortRetry();
		}
		this.attempt = 0;
		this.firstFailureAt = undefined;
	}

	willRetryAfterAgentEnd(messages: readonly unknown[]): boolean {
		if (this.disposed) return false;
		const internal = this.session as unknown as InternalAgentSession;
		if (internal._agentRunAbortRequested) return false;
		const settings = this.bridge.getSettings();
		if (!settings.enabled) return false;

		for (let i = messages.length - 1; i >= 0; i--) {
			const candidate = messages[i] as Partial<AssistantMessage> | undefined;
			if (candidate?.role !== "assistant") continue;
			const classification = classifyAssistantOutcome(
				candidate as AssistantMessage,
				settings,
				this.getModelLimits(candidate as AssistantMessage),
			);
			if (!classification.retryable) return false;
			const now = Date.now();
			const decision = computeBackoffDecision(
				{
					attempt: this.attempt + 1,
					firstFailureAt: this.firstFailureAt ?? now,
					now,
				},
				settings,
			);
			return decision.allow;
		}
		return false;
	}

	async handlePostAgentRun(originalHandlePostAgentRun: () => Promise<boolean>): Promise<boolean> {
		const settings = this.bridge.getSettings();
		if (!settings.enabled || this.disposed) {
			return originalHandlePostAgentRun();
		}

		const internal = this.session as unknown as InternalAgentSession;
		const message = internal._lastAssistantMessage;
		internal._lastAssistantMessage = undefined;

		if (internal._agentRunAbortRequested) {
			this.finishCancelledRetry();
			return false;
		}
		if (!message) {
			return internal.agent.hasQueuedMessages();
		}

		const limits = this.getModelLimits(message);
		const classification = classifyAssistantOutcome(message, settings, limits);

		if (classification.retryable) {
			const now = Date.now();
			if (this.firstFailureAt === undefined) {
				this.firstFailureAt = now;
			}
			const nextAttempt = this.attempt + 1;
			const decision = computeBackoffDecision(
				{
					attempt: nextAttempt,
					firstFailureAt: this.firstFailureAt,
					now,
				},
				settings,
			);

			if (decision.allow) {
				this.attempt = nextAttempt;
				this.totalRetriesInSession++;
				this.lastError = classification.description;

				internal._emit({
					type: "auto_retry_start",
					attempt: decision.attempt,
					maxAttempts: decision.maxAttempts,
					delayMs: decision.delayMs,
					errorMessage: classification.description,
				});

				this.omitAttempt(internal, message);

				const waitOutcome = await this.waitForBackoff(decision.delayMs);
				if (waitOutcome === "cancelled" || internal._agentRunAbortRequested || this.disposed) {
					this.finishCancelledRetry();
					return false;
				}
				if (waitOutcome === "woken") {
					// Manual `/retry` woke the active backoff: clear the retry indicator and reset budget.
					const previousAttempt = this.attempt;
					this.attempt = 0;
					this.firstFailureAt = undefined;
					if (previousAttempt > 0) {
						internal._emit({
							type: "auto_retry_end",
							success: true,
							attempt: previousAttempt,
						});
					}
				}

				internal._failedResponse = message;
				return !internal._agentRunAbortRequested;
			}

			// Retry budget (maxRetries or maxRetryDurationMs) exhausted.
			const exhaustedAttempts = this.attempt;
			this.attempt = 0;
			this.firstFailureAt = undefined;
			if (exhaustedAttempts > 0) {
				internal._emit({
					type: "auto_retry_end",
					success: false,
					attempt: exhaustedAttempts,
					finalError: classification.description,
				});
			}
		} else if (this.attempt > 0) {
			const finishedAttempt = this.attempt;
			this.attempt = 0;
			this.firstFailureAt = undefined;
			internal._emit({
				type: "auto_retry_end",
				success: classification.reason === "ok",
				attempt: finishedAttempt,
				...(classification.reason === "ok"
					? {}
					: { finalError: message.errorMessage || classification.reason }),
			});
		}

		// Preserve Pi's native context-overflow & threshold auto-compaction!
		// Note: If realtry explicitly disabled incomplete-response retries, skip recoverable-length compaction
		// only when it is not an actual context overflow.
		if (
			classification.retryable ||
			(message.stopReason === "length" && !settings.retryIncomplete && classification.reason !== "context_overflow")
		) {
			return !internal._agentRunAbortRequested && internal.agent.hasQueuedMessages();
		}

		if (await internal._checkCompaction(message)) {
			return !internal._agentRunAbortRequested;
		}

		return !internal._agentRunAbortRequested && internal.agent.hasQueuedMessages();
	}

	private omitAttempt(internal: InternalAgentSession, message: AssistantMessage): void {
		if (typeof internal._omitRecoveryAttempt === "function") {
			internal._omitRecoveryAttempt(message);
			return;
		}
		const prep = prepareSessionForUnconditionalRetry(internal.sessionManager);
		for (const entry of prep.appendedEntries) {
			internal._emit({ type: "entry_appended", entry });
		}
		internal.refreshContext();
	}

	private waitForBackoff(delayMs: number): Promise<BackoffWaitOutcome> {
		if (delayMs <= 0) {
			return Promise.resolve("ready");
		}
		return new Promise<BackoffWaitOutcome>((resolve) => {
			let settled = false;
			const finish = (outcome: BackoffWaitOutcome) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.activeBackoff = undefined;
				resolve(outcome);
			};
			const timer = setTimeout(() => finish("ready"), delayMs);
			timer.unref?.();
			this.activeBackoff = {
				cancel: () => finish("cancelled"),
				wake: () => finish("woken"),
			};
		});
	}

	private finishCancelledRetry(): void {
		if (this.attempt === 0) return;
		const cancelledAttempt = this.attempt;
		this.attempt = 0;
		this.firstFailureAt = undefined;
		const internal = this.session as unknown as InternalAgentSession;
		internal._emit({
			type: "auto_retry_end",
			success: false,
			attempt: cancelledAttempt,
			finalError: "Retry cancelled",
		});
	}

	abortRetry(): void {
		this.activeBackoff?.cancel();
	}

	reset(): void {
		const hadActiveBackoff = this.isRetrying;
		this.activeBackoff?.cancel();
		if (!hadActiveBackoff && this.attempt > 0) {
			this.finishCancelledRetry();
		}
		this.attempt = 0;
		this.firstFailureAt = undefined;
		this.lastError = undefined;
	}

	/**
	 * Execute an unconditional message-free `/retry`:
	 * - If currently waiting in retry backoff, skip the wait and fire immediately with a fresh budget.
	 * - If currently streaming or running tools, abort the active run first and wait for idle.
	 * - Clean any trailing assistant turn or `Operation aborted` tool batch via `context_edit(null)`.
	 * - Run `agent.continue()` inside `AgentSession`'s full run lifecycle without injecting any prompt.
	 */
	async retryNow(ctx: ExtensionCommandContext): Promise<void> {
		if (this.disposed) return;

		if (this.activeBackoff) {
			this.activeBackoff.wake();
			return;
		}

		const internal = this.session as unknown as InternalAgentSession;
		if (internal._isEmittingAgentSettled) {
			internal._deferredSettledActions.push(async () => {
				await this.retryNow(ctx);
			});
			return;
		}

		if (internal.isCompacting) {
			if (ctx.hasUI) {
				ctx.ui.notify("Cannot /retry while compaction is in progress. Wait for compaction to finish.", "warning");
			}
			return;
		}

		if (internal.isStreaming) {
			await internal.abort();
		}

		this.attempt = 0;
		this.firstFailureAt = undefined;

		const model = internal.model;
		if (!model) {
			const msg = "No model selected. Select a model with /model before retrying.";
			if (ctx.hasUI) ctx.ui.notify(msg, "error");
			else throw new Error(msg);
			return;
		}

		if (typeof internal._getRequiredRequestAuth === "function") {
			try {
				await internal._getRequiredRequestAuth(model);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				if (ctx.hasUI) ctx.ui.notify(msg, "error");
				else throw error;
				return;
			}
		}

		const prep = prepareSessionForUnconditionalRetry(internal.sessionManager);
		if (!prep.canContinue) {
			const msg = prep.reason ?? "Nothing to retry.";
			if (ctx.hasUI) ctx.ui.notify(msg, "warning");
			return;
		}

		for (const entry of prep.appendedEntries) {
			internal._emit({ type: "entry_appended", entry });
		}
		internal.refreshContext();

		await this.runContinuationLoop(internal);
	}

	private reconcileSystemAndToolDeclarations(internal: InternalAgentSession): void {
		const options = {
			...internal._baseSystemPromptOptions,
			selectedTools: internal.getActiveToolNames(),
		};
		const currentMessages = internal.agent.state.messages as Parameters<typeof getCurrentTools>[0];
		const sectionPatch = internal._preparePromptAndToolLoadout?.(options, currentMessages);
		internal._runSystemPromptOptions = options;

		const toolDelta = getToolStateChanges(
			getCurrentTools(currentMessages),
			internal.agent.state.tools.map(toToolDeclaration),
		);
		const hasToolDelta = toolDelta.toolsAdded.length > 0 || toolDelta.toolsRemoved.length > 0;

		if (!sectionPatch && !hasToolDelta) {
			return;
		}

		const systemUpdate: SystemMessage = {
			role: "system",
			content: sectionPatch?.content ?? "",
			...(sectionPatch?.sections ? { sections: sectionPatch.sections } : {}),
			...(toolDelta.toolsAdded.length > 0 ? { toolsAdded: toolDelta.toolsAdded } : {}),
			...(toolDelta.toolsRemoved.length > 0 ? { toolsRemoved: toolDelta.toolsRemoved } : {}),
			timestamp: Date.now(),
		};
		internal.sessionManager.appendMessage(systemUpdate);
		internal.refreshContext();
	}

	private async runContinuationLoop(internal: InternalAgentSession): Promise<void> {
		this.rebindHooks();
		internal._isAgentRunActive = true;
		internal._agentRunAbortRequested = false;
		internal._flushPendingBashMessages();
		internal._flushPendingCustomMessages();
		this.reconcileSystemAndToolDeclarations(internal);
		internal._failedResponse = undefined;
		internal._recordSelection();
		internal._pendingToolNames.clear();

		try {
			await internal.agent.continue();
			while (!internal._agentRunAbortRequested) {
				if (await (this.session as unknown as { _handlePostAgentRun(): Promise<boolean> })._handlePostAgentRun()) {
					if (internal._agentRunAbortRequested) break;
					await internal.agent.continue();
					continue;
				}
				if (internal._agentRunAbortRequested || !(await internal._runBeforeSettleBoundary())) {
					break;
				}
				if (internal._agentRunAbortRequested) break;
				await internal.agent.continue();
			}
		} finally {
			if (internal._agentRunAbortRequested) {
				this.finishCancelledRetry();
			}
			internal._failedResponse = undefined;
			internal._runSystemPromptOptions = undefined;
			internal._flushPendingBashMessages();
			internal._flushPendingCustomMessages();
			await internal._emitAgentSettled();
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.activeBackoff?.cancel();

		const internal = this.session as unknown as InternalAgentSession;
		if (this.rawAgentStreamFn && internal.agent.streamFunction === this.wrappedAgentStreamFn) {
			internal.agent.streamFunction = this.rawAgentStreamFn;
		}
		this.bridge.removeController(this);
	}
}

function isRealtryBridge(value: unknown): value is RealtryBridge {
	return Boolean(
		value &&
			typeof value === "object" &&
			typeof (value as RealtryBridge).attachSession === "function" &&
			typeof (value as RealtryBridge).getSettings === "function",
	);
}

function resolveBridgeFromSession(session: AgentSession): RealtryBridge | undefined {
	const internal = session as unknown as InternalAgentSession;
	const command = internal._extensionRunner?.getCommand?.("realtry");
	const handler = command?.handler as Record<symbol, unknown> | undefined;
	const candidate = handler?.[REALTRY_BRIDGE_SYMBOL];
	return isRealtryBridge(candidate) ? candidate : undefined;
}

function syncSessionController(session: AgentSession): RealtrySessionController | undefined {
	const bridge = resolveBridgeFromSession(session);
	if (!bridge) {
		const previous = sessionControllers.get(session);
		if (previous) {
			previous.dispose();
			sessionControllers.delete(session);
		}
		return undefined;
	}
	return bridge.attachSession(session);
}

export function patchAgentSessionPrototype(targetPrototype: unknown): void {
	if (!targetPrototype || typeof targetPrototype !== "object") {
		return;
	}
	const proto = targetPrototype as Record<string | symbol, unknown>;
	if (proto[PROTOTYPE_PATCHED_SYMBOL]) {
		return;
	}
	proto[PROTOTYPE_PATCHED_SYMBOL] = true;

	const origBuildRuntime = proto._buildRuntime as ((options: unknown) => void) | undefined;
	if (typeof origBuildRuntime === "function") {
		proto._buildRuntime = function patchedBuildRuntime(this: AgentSession, options: unknown): void {
			origBuildRuntime.call(this, options);
			syncSessionController(this);
		};
	}

	const origBindExtensions = proto.bindExtensions as ((bindings: unknown) => Promise<void>) | undefined;
	if (typeof origBindExtensions === "function") {
		proto.bindExtensions = async function patchedBindExtensions(
			this: AgentSession,
			bindings: unknown,
		): Promise<void> {
			syncSessionController(this);
			await origBindExtensions.call(this, bindings);
		};
	}

	const origPrepareRetry = proto._prepareRetry as ((message: AssistantMessage) => Promise<boolean>) | undefined;
	if (typeof origPrepareRetry === "function") {
		proto._prepareRetry = async function patchedPrepareRetry(
			this: AgentSession,
			message: AssistantMessage,
		): Promise<boolean> {
			const controller = sessionControllers.get(this) ?? syncSessionController(this);
			if (controller && !controller.isDisposed() && controller.bridge.getSettings().enabled) {
				// Native Pi retry is replaced by realtry's handlePostAgentRun.
				return false;
			}
			return origPrepareRetry.call(this, message);
		};
	}

	const origWillRetry = proto._willRetryAfterAgentEnd as
		| ((event: { messages: unknown[] }) => boolean)
		| undefined;
	if (typeof origWillRetry === "function") {
		proto._willRetryAfterAgentEnd = function patchedWillRetryAfterAgentEnd(
			this: AgentSession,
			event: { messages: unknown[] },
		): boolean {
			const controller = sessionControllers.get(this) ?? syncSessionController(this);
			if (controller && !controller.isDisposed() && controller.bridge.getSettings().enabled) {
				return controller.willRetryAfterAgentEnd(event.messages);
			}
			return origWillRetry.call(this, event);
		};
	}

	const origHandlePostAgentRun = proto._handlePostAgentRun as (() => Promise<boolean>) | undefined;
	if (typeof origHandlePostAgentRun === "function") {
		proto._handlePostAgentRun = async function patchedHandlePostAgentRun(this: AgentSession): Promise<boolean> {
			const controller = sessionControllers.get(this) ?? syncSessionController(this);
			if (controller && !controller.isDisposed()) {
				return controller.handlePostAgentRun(() => origHandlePostAgentRun.call(this));
			}
			return origHandlePostAgentRun.call(this);
		};
	}

	const origAbortRetry = proto.abortRetry as (() => void) | undefined;
	if (typeof origAbortRetry === "function") {
		proto.abortRetry = function patchedAbortRetry(this: AgentSession): void {
			origAbortRetry.call(this);
			sessionControllers.get(this)?.abortRetry();
		};
	}

	const origSummarizationAuth = proto._getSummarizationRequestAuth as
		| ((selectedModel: Model<Api>, signal?: AbortSignal) => Promise<unknown>)
		| undefined;
	if (typeof origSummarizationAuth === "function") {
		proto._getSummarizationRequestAuth = function patchedSummarizationAuth(
			this: AgentSession,
			selectedModel: Model<Api>,
			signal?: AbortSignal,
		): Promise<unknown> {
			const controller = sessionControllers.get(this);
			if (controller && !controller.isDisposed()) {
				return controller.withUnwrappedStreamFn(() =>
					origSummarizationAuth.call(this, selectedModel, signal),
				);
			}
			return origSummarizationAuth.call(this, selectedModel, signal);
		};
	}

	const origIsRetrying = Object.getOwnPropertyDescriptor(proto, "isRetrying");
	if (origIsRetrying?.get) {
		Object.defineProperty(proto, "isRetrying", {
			...origIsRetrying,
			get(this: AgentSession): boolean {
				const controller = sessionControllers.get(this);
				if (controller && !controller.isDisposed() && controller.isRetrying) {
					return true;
				}
				return Boolean(origIsRetrying.get!.call(this));
			},
		});
	}

	const origRetryAttempt = Object.getOwnPropertyDescriptor(proto, "retryAttempt");
	if (origRetryAttempt?.get) {
		Object.defineProperty(proto, "retryAttempt", {
			...origRetryAttempt,
			get(this: AgentSession): number {
				const controller = sessionControllers.get(this);
				if (controller && !controller.isDisposed() && controller.bridge.getSettings().enabled) {
					return controller.retryAttempt;
				}
				return Number(origRetryAttempt.get!.call(this));
			},
		});
	}

	const origDispose = proto.dispose as (() => void) | undefined;
	if (typeof origDispose === "function") {
		proto.dispose = function patchedDispose(this: AgentSession): void {
			const controller = sessionControllers.get(this);
			controller?.dispose();
			sessionControllers.delete(this);
			origDispose.call(this);
		};
	}
}

export function ensureAgentSessionPrototypePatched(): void {
	patchAgentSessionPrototype(AgentSession.prototype);
}

const nativeDynamicImport = new Function("specifier", "return import(specifier);") as (
	specifier: string,
) => Promise<{ AgentSession?: { prototype?: unknown } }>;

/**
 * When Pi loads extensions via jiti in unbundled Node ESM (such as SDK `createAgentSession` or
 * `node dist/cli.js`), jiti's CommonJS module cache may hold a separate `AgentSession` class from
 * Node's native ESM module cache. Resolve and patch the host ESM `AgentSession.prototype` as well
 * so both bundled/virtual-module and unbundled ESM runtimes are covered.
 */
export async function ensureHostAgentSessionPatched(callerStack?: string): Promise<void> {
	ensureAgentSessionPrototypePatched();

	const candidateUrls = new Set<string>();
	if (callerStack) {
		const loaderMatch = /(file:\/\/[^\s)]+\/core\/extensions\/loader\.js)/.exec(callerStack);
		if (loaderMatch?.[1]) {
			candidateUrls.add(loaderMatch[1].replace(/\/core\/extensions\/loader\.js$/, "/index.js"));
		}
	}
	try {
		const req = createRequire(import.meta.url);
		const resolvedPath = req.resolve("@earendil-works/pi-coding-agent");
		candidateUrls.add(pathToFileURL(resolvedPath).href);
	} catch {
		// Extension may live outside a node_modules tree (e.g. ~/.pi/agent/extensions/); stack URL handles it.
	}

	for (const url of candidateUrls) {
		try {
			const mod = await nativeDynamicImport(url);
			if (mod?.AgentSession?.prototype) {
				patchAgentSessionPrototype(mod.AgentSession.prototype);
			}
		} catch {
			// Ignore unreachable candidate URL; already-patched prototype remains active.
		}
	}
}
