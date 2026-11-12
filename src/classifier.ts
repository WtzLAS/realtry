import { isContextOverflow, isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";
import type { RealtrySettings } from "./settings.ts";

export interface ModelLimits {
	maxTokens?: number;
	contextWindow?: number;
	reserveTokens?: number;
}

export type RetryFailureKind = "network_or_provider" | "stream_timeout" | "incomplete" | "empty";

export type RetryClassification =
	| {
			retryable: true;
			kind: RetryFailureKind;
			description: string;
	  }
	| {
			retryable: false;
			reason:
				| "ok"
				| "disabled"
				| "aborted"
				| "context_overflow"
				| "quota_exceeded"
				| "non_retryable";
	  };

/**
 * Short-term rate-limit markers (RPM / TPM / RPS / per-minute / per-second).
 * Used so transient per-minute rate limits like Gemini's
 * "Quota exceeded for quota metric '... requests per minute'" are still retried,
 * while genuine quota/plan/rolling-window/billing exhaustion is never retried.
 */
const SHORT_TERM_RATE_LIMIT_PATTERN =
	/\b(?:per[\s_-]*(?:minute|min|second|sec)|requests?\s+per\s+(?:minute|second)|tokens?\s+per\s+(?:minute|second)|RPM|TPM|RPS|TPS|QPM|QPS)\b/i;

/**
 * Explicit rolling-window (5-hour / N-hour), daily, weekly, monthly, plan, subscription,
 * or billing exhaustion patterns. These always rule out automatic retry even when returned
 * as HTTP 429 or `RESOURCE_EXHAUSTED`.
 */
const HARD_QUOTA_OR_PLAN_PATTERNS: readonly RegExp[] = [
	// 5-hour and generic N-hour rolling usage windows (Claude Pro/Max, Codex/ChatGPT, agy, gateways)
	/\b(?:5|five)[\s_-]*(?:hour|hr|h)\b[^.\n]{0,60}\b(?:limit|quota|cap|window|usage|allowance|exceeded|reached|exhausted)\b/i,
	/\b\d+[\s_-]*(?:hour|hr|h)\s+(?:[a-z_-]+\s+){0,3}(?:limit|quota|cap|window|allowance)\b/i,
	/\b(?:limit|quota|cap|allowance)\s+(?:has\s+been\s+|is\s+|was\s+)?(?:reached|exceeded|exhausted|hit)[^.\n]{0,60}\b(?:\d+[\s_-]*(?:hour|hr|h)|five[\s_-]*hour|weekly|daily|monthly)\b/i,
	// Weekly / daily / monthly usage caps
	/\b(?:weekly|7[\s_-]*day|daily|24[\s_-]*(?:hour|hr|h)|monthly|30[\s_-]*day)\s+(?:[a-z_-]+\s+){0,3}(?:limit|quota|cap|allowance|budget|spend|spending|window|usage)\b/i,
	/\b(?:exceeded|reached|hit|exhausted)\s+(?:your\s+|the\s+)?(?:[a-z0-9_-]+\s+){0,3}(?:weekly|7[\s_-]*day|daily|monthly|5[\s_-]*hour|five[\s_-]*hour)\b/i,
	/\b(?:requests?|tokens?|messages?|prompts?|queries|generations?)\s+per\s+(?:day|week|month)\b/i,
	/\bRPD\b.*\b(?:limit|quota|exceeded|exhausted)\b/i,
	// Multi-hour / multi-day reset notices (e.g. "resets in 4 hours", "try again in 2 days")
	/\b(?:resets?|try\s+again|available\s+again)\s+(?:in|after)\s+\d+(?:\.\d+)?\s*(?:hours?|hrs?|h|days?|d|weeks?|w)\b/i,
	// Provider-specific subscription, usage, and billing exhaustion
	/\bGoUsageLimitError\b/i,
	/\bFreeUsageLimitError\b/i,
	/\bMonthly usage limit reached\b/i,
	/\bavailable balance\b/i,
	/\binsufficient_quota\b/i,
	/\bbilling_hard_limit_reached\b/i,
	/\bbilling_not_active\b/i,
	/\busage_limit_reached\b/i,
	/\bsubscription_sharing_usage_limit_exceeded\b/i,
	/\bsubscription_sharing_workplace_individual_usage_limit_exceeded\b/i,
	/\bUSER_QUOTA_EXHAUSTED\b/i,
	/\bTERMINAL_QUOTA_ERROR\b/i,
	/"code"\s*:\s*"?1308(?![0-9])/i,
	/\bout of (?:budget|credits?)\b/i,
	/\bcredit balance is too low\b/i,
	/\binsufficient (?:credits?|balance|funds)\b/i,
	/\bpayment required\b/i,
	/(?<![a-z0-9])402(?![a-z0-9])/,
	/\bbilling\b/i,
	/\b(?:upgrade|update)\s+your\s+(?:plan|subscription)\b/i,
	/\bpurchase\s+more\s+credits\b/i,
	/\b(?:hit|reached|exceeded|exhausted)\s+(?:your\s+|the\s+)?(?:current\s+|plan\s+|account\s+|workspace\s+|session\s+|organization\s+|pro\s+|max\s+|plus\s+|free\s+){0,2}(?:usage|spending|spend|plan|credit|subscription)\s+(?:limit|quota|cap)\b/i,
	/\bplan\s+(?:usage\s+)?(?:limit|quota)\s+(?:reached|exceeded|exhausted)\b/i,
];

const GENERIC_QUOTA_EXCEEDED_PATTERN = /\bquota[\s_-]*(?:exceeded|exhausted|reached)\b/i;

const PERMANENT_CLIENT_ERROR_PATTERNS: readonly RegExp[] = [
	/(?<![a-z0-9])(?:401|403|404|422)(?![a-z0-9])/,
	/\bunauthorized\b/i,
	/\binvalid[\s_-]*(?:x[\s_-]*)?api[\s_-]*key\b/i,
	/\bauthentication[\s_-]*(?:error|failed)\b/i,
	/\bpermission[\s_-]*denied\b/i,
	/\bforbidden\b/i,
	/\binvalid_grant\b/i,
	/\bcredentials may have expired\b/i,
	/\bno api key\b/i,
	/\bmodel_not_found\b/i,
	/\bnot_found_error\b/i,
	/\binvalid_request_error\b/i,
	/\bunsupported (?:parameter|model|feature)\b/i,
	/\bSELF_SIGNED_CERT_IN_CHAIN\b/i,
	/\bUNABLE_TO_VERIFY_LEAF_SIGNATURE\b/i,
	/\bCERT_HAS_EXPIRED\b/i,
];

const STREAM_TIMEOUT_ERROR_PATTERN =
	/\b(?:realtry timeout|stream stalled|stream timed out|headers timeout|body timeout|idle timeout|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|UND_ERR_CONNECT_TIMEOUT)\b/i;

const EXTRA_NETWORK_OR_INCOMPLETE_ERROR_PATTERNS: readonly RegExp[] = [
	/\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EPROTO)\b/i,
	/\b(?:UND_ERR_SOCKET|UND_ERR_ABORTED|ERR_HTTP2_STREAM_CANCEL|ERR_HTTP2_GOAWAY_SESSION|ERR_HTTP2_ERROR|ERR_STREAM_PREMATURE_CLOSE)\b/i,
	/\b(?:fetch failed|network[\s_-]*error|connection[\s_-]*(?:error|refused|reset|closed|lost|terminated|aborted)|socket hang up|socket[\s_-]*closed|other side closed|premature[\s_-]*close)\b/i,
	/\b(?:unexpected end of (?:file|json|input)|unexpected EOF|incomplete[\s_-]*(?:response|stream|chunk)|stream[\s_-]*(?:ended|closed|aborted|reset|interrupted|disconnected)|ended without a (?:stop|finish) reason|cut short)\b/i,
	/\b(?:timed?[\s_-]*out|timeout|deadline[\s_-]*exceeded)\b/i,
	/\b(?:MODEL_CAPACITY_EXHAUSTED|overloaded|server_busy|temporarily unavailable|service unavailable|bad gateway|gateway timeout|throttl(?:e|ed|ing)|api_error|upstream[\s_-]*(?:error|connect|request failed)|provider returned (?:an )?error)\b/i,
	/(?<![a-z0-9])(?:408|425|429|500|502|503|504|520|521|522|523|524|529)(?![a-z0-9])/,
	// Stream ended in `pending` state in pi-ai adapters without any specific provider text
	/^An unknown error occurred$/i,
];

/**
 * Check whether an error message represents a quota, usage-window (5h / daily / weekly / monthly),
 * plan, or billing limit that cannot succeed by retrying right away.
 */
export function isQuotaOrPlanLimitError(errorMessage: string): boolean {
	if (!errorMessage) return false;
	if (HARD_QUOTA_OR_PLAN_PATTERNS.some((pattern) => pattern.test(errorMessage))) {
		return true;
	}
	if (GENERIC_QUOTA_EXCEEDED_PATTERN.test(errorMessage) && !SHORT_TERM_RATE_LIMIT_PATTERN.test(errorMessage)) {
		return true;
	}
	return false;
}

/**
 * True when an assistant response stopped normally (or with `toolUse`) without any visible
 * non-whitespace text or tool calls — including completely empty `content: []` and thinking-only turns.
 */
export function isEmptyAssistantResponse(message: AssistantMessage): boolean {
	if (message.stopReason !== "stop") return false;
	for (const block of message.content) {
		if (block.type === "toolCall") return false;
		if (block.type === "text" && block.text.trim().length > 0) return false;
	}
	return true;
}

function hasToolCalls(message: AssistantMessage): boolean {
	return message.content.some((block) => block.type === "toolCall");
}

/**
 * True when a `length` stop was clamped by the remaining context window rather than cut off early
 * by the provider, so Pi's native context compaction should handle it instead of blind retry.
 */
function isContextClampedLength(message: AssistantMessage, limits?: ModelLimits): boolean {
	const contextWindow = limits?.contextWindow ?? 0;
	const maxTokens = limits?.maxTokens ?? 0;
	if (contextWindow <= 0 || maxTokens <= 0) return false;
	const reserve = limits?.reserveTokens ?? 0;
	const inputTokens = (message.usage?.input ?? 0) + (message.usage?.cacheRead ?? 0);
	const outputTokens = message.usage?.output ?? 0;
	const ceiling = Math.max(0, contextWindow - reserve);
	return inputTokens + maxTokens >= ceiling && inputTokens + outputTokens >= ceiling * 0.95;
}

/**
 * True when an assistant response is structurally incomplete:
 * 1. `stopReason === "length"` with `toolCall` blocks (truncated tool arguments).
 * 2. `stopReason === "toolUse"` with zero `toolCall` blocks (dropped tool call payload).
 * 3. Premature `stopReason === "length"` (`usage.output < maxTokens`) that is neither a context
 *    overflow nor clamped by the context window. Genuine full `maxTokens` text stops are kept.
 */
export function isIncompleteAssistantResponse(
	message: AssistantMessage,
	limits?: ModelLimits,
): { incomplete: boolean; description?: string } {
	if (message.stopReason === "toolUse" && !hasToolCalls(message)) {
		return {
			incomplete: true,
			description: "Incomplete response: stopReason toolUse without tool calls",
		};
	}
	if (message.stopReason !== "length") {
		return { incomplete: false };
	}
	if (hasToolCalls(message)) {
		return {
			incomplete: true,
			description: "Incomplete response: tool call truncated at token limit",
		};
	}
	const contextWindow = limits?.contextWindow ?? 0;
	if (isContextOverflow(message, contextWindow)) {
		return { incomplete: false };
	}
	const maxTokens = limits?.maxTokens ?? 0;
	const outputTokens = message.usage?.output ?? 0;
	if (maxTokens > 0 && outputTokens < maxTokens && !isContextClampedLength(message, limits)) {
		return {
			incomplete: true,
			description: `Incomplete response: premature length stop (${outputTokens}/${maxTokens} output tokens)`,
		};
	}
	return { incomplete: false };
}

/**
 * Classify a finalized `AssistantMessage` for automatic retry by `realtry`.
 */
export function classifyAssistantOutcome(
	message: AssistantMessage,
	settings: Pick<RealtrySettings, "enabled" | "retryEmpty" | "retryIncomplete">,
	limits?: ModelLimits,
): RetryClassification {
	if (!settings.enabled) {
		return { retryable: false, reason: "disabled" };
	}
	if (message.stopReason === "aborted") {
		return { retryable: false, reason: "aborted" };
	}

	const contextWindow = limits?.contextWindow ?? 0;
	if (isContextOverflow(message, contextWindow)) {
		return { retryable: false, reason: "context_overflow" };
	}

	if (message.stopReason === "error") {
		const errorText = (message.errorMessage ?? "").trim();
		if (isQuotaOrPlanLimitError(errorText)) {
			return { retryable: false, reason: "quota_exceeded" };
		}
		if (PERMANENT_CLIENT_ERROR_PATTERNS.some((pattern) => pattern.test(errorText))) {
			return { retryable: false, reason: "non_retryable" };
		}
		if (STREAM_TIMEOUT_ERROR_PATTERN.test(errorText)) {
			return {
				retryable: true,
				kind: "stream_timeout",
				description: errorText || "Stream timed out",
			};
		}
		if (
			isRetryableAssistantError(message) ||
			EXTRA_NETWORK_OR_INCOMPLETE_ERROR_PATTERNS.some((pattern) => pattern.test(errorText))
		) {
			return {
				retryable: true,
				kind: "network_or_provider",
				description: errorText || "Transient network or provider error",
			};
		}
		return { retryable: false, reason: "non_retryable" };
	}

	if (settings.retryIncomplete) {
		const incompleteCheck = isIncompleteAssistantResponse(message, limits);
		if (incompleteCheck.incomplete) {
			return {
				retryable: true,
				kind: "incomplete",
				description: incompleteCheck.description ?? "Incomplete response",
			};
		}
	}

	if (settings.retryEmpty && isEmptyAssistantResponse(message)) {
		const hasThinking = message.content.some((block) => block.type === "thinking");
		return {
			retryable: true,
			kind: "empty",
			description: hasThinking ? "Empty response (thinking only)" : "Empty response",
		};
	}

	return { retryable: false, reason: "ok" };
}
