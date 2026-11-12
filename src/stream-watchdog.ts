import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { formatDurationMs } from "./settings.ts";

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export interface StreamWatchdogOptions {
	/** Inactivity timeout in milliseconds; <= 0 disables stall detection. */
	stallTimeoutMs: number;
	/** Suppress built-in provider SDK retry loops so realtry owns backoff and Escape cancellation. */
	suppressProviderRetries?: boolean;
}

function buildStallErrorMessage(
	model: Model<Api>,
	partial: AssistantMessage | undefined,
	stallTimeoutMs: number,
): AssistantMessage {
	const label = formatDurationMs(stallTimeoutMs, "0ms");
	const errorMessage = `Stream stalled: no response activity for ${label} (realtry timeout)`;
	if (partial) {
		return {
			...partial,
			stopReason: "error",
			errorMessage,
		};
	}
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			...EMPTY_USAGE,
			cost: { ...EMPTY_USAGE.cost },
		},
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

/**
 * Wrap a single `streamSimple` invocation with:
 * 1. `maxRetries: 0` (when `suppressProviderRetries !== false`) so provider SDKs do not hide
 *    retries inside unmonitored internal loops.
 * 2. An inactivity stall timer (`stallTimeoutMs`) reset on every HTTP header, raw SSE frame,
 *    and parsed `AssistantMessageEvent`. When it fires while the caller's `signal` has NOT been
 *    aborted by the user, only the child request signal is aborted and the stream resolves
 *    immediately with `stopReason: "error"` so `realtry` can omit and retry cleanly.
 */
export function invokeStreamWithWatchdog(
	invoke: (
		model: Model<Api>,
		context: Context,
		options?: ModelsSimpleStreamOptions,
	) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
	model: Model<Api>,
	context: Context,
	options: ModelsSimpleStreamOptions | undefined,
	watchdog: StreamWatchdogOptions,
): AssistantMessageEventStream {
	const callerSignal = options?.signal;
	const suppressProviderRetries = watchdog.suppressProviderRetries !== false;
	const stallTimeoutMs = watchdog.stallTimeoutMs;

	if (stallTimeoutMs <= 0) {
		const patchedOptions: ModelsSimpleStreamOptions = {
			...options,
			...(suppressProviderRetries ? { maxRetries: 0 } : {}),
		};
		const maybePromise = invoke(model, context, patchedOptions);
		if (!(maybePromise instanceof Promise)) {
			return maybePromise;
		}
		const bridge = createAssistantMessageEventStream();
		void (async () => {
			try {
				const inner = await maybePromise;
				for await (const event of inner) {
					bridge.push(event);
				}
				bridge.end(await inner.result());
			} catch (error) {
				const failed = buildStallErrorMessage(model, undefined, 0);
				failed.stopReason = callerSignal?.aborted ? "aborted" : "error";
				failed.errorMessage = error instanceof Error ? error.message : String(error);
				bridge.push({ type: "error", reason: failed.stopReason, error: failed });
				bridge.end(failed);
			}
		})();
		return bridge;
	}

	const outerStream = createAssistantMessageEventStream();
	const stallController = new AbortController();
	const combinedSignal = callerSignal
		? AbortSignal.any([callerSignal, stallController.signal])
		: stallController.signal;

	let settled = false;
	let stalledOut = false;
	let latestPartial: AssistantMessage | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const clearWatchdog = () => {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
	};

	const finishWithStall = () => {
		if (settled) return;
		if (callerSignal?.aborted) return;
		settled = true;
		stalledOut = true;
		clearWatchdog();
		const errorMsg = buildStallErrorMessage(model, latestPartial, stallTimeoutMs);
		stallController.abort(new Error(errorMsg.errorMessage));
		outerStream.push({
			type: "error",
			reason: "error",
			error: errorMsg,
		});
		outerStream.end(errorMsg);
	};

	const touchActivity = () => {
		if (settled) return;
		clearWatchdog();
		timer = setTimeout(finishWithStall, stallTimeoutMs);
		timer.unref?.();
	};

	const onCallerAbort = () => {
		clearWatchdog();
	};
	callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

	touchActivity();

	const wrappedOptions: ModelsSimpleStreamOptions = {
		...options,
		...(suppressProviderRetries ? { maxRetries: 0 } : {}),
		signal: combinedSignal,
		onResponse: async (response, responseModel) => {
			touchActivity();
			await options?.onResponse?.(response, responseModel);
		},
		onProviderStreamEvent: async (data, eventModel) => {
			touchActivity();
			await options?.onProviderStreamEvent?.(data, eventModel);
		},
	};

	void (async () => {
		try {
			const innerStream = await invoke(model, context, wrappedOptions);
			for await (const event of innerStream) {
				if (settled) break;
				touchActivity();
				if ("partial" in event && event.partial) {
					latestPartial = event.partial;
				}
				if (event.type === "error" && stalledOut && !callerSignal?.aborted) {
					break;
				}
				// Guard against provider adapters marking stall-aborted requests as user-aborted
				if (event.type === "error" && stallController.signal.aborted && !callerSignal?.aborted) {
					const rewritten = buildStallErrorMessage(model, event.error, stallTimeoutMs);
					settled = true;
					clearWatchdog();
					outerStream.push({ type: "error", reason: "error", error: rewritten });
					outerStream.end(rewritten);
					return;
				}
				outerStream.push(event as AssistantMessageEvent);
				if (event.type === "done" || event.type === "error") {
					settled = true;
					clearWatchdog();
					outerStream.end();
					return;
				}
			}
			if (!settled) {
				const finalResult = await innerStream.result();
				if (settled) return;
				settled = true;
				clearWatchdog();
				if (stallController.signal.aborted && !callerSignal?.aborted) {
					const rewritten = buildStallErrorMessage(model, finalResult, stallTimeoutMs);
					outerStream.push({ type: "error", reason: "error", error: rewritten });
					outerStream.end(rewritten);
					return;
				}
				outerStream.end(finalResult);
			}
		} catch (error) {
			if (settled) return;
			settled = true;
			clearWatchdog();
			if (stallController.signal.aborted && !callerSignal?.aborted) {
				const stallError = buildStallErrorMessage(model, latestPartial, stallTimeoutMs);
				outerStream.push({ type: "error", reason: "error", error: stallError });
				outerStream.end(stallError);
				return;
			}
			const fallback = buildStallErrorMessage(model, latestPartial, stallTimeoutMs);
			fallback.stopReason = callerSignal?.aborted ? "aborted" : "error";
			fallback.errorMessage = error instanceof Error ? error.message : String(error);
			outerStream.push({ type: "error", reason: fallback.stopReason, error: fallback });
			outerStream.end(fallback);
		} finally {
			clearWatchdog();
			callerSignal?.removeEventListener("abort", onCallerAbort);
		}
	})();

	return outerStream;
}
