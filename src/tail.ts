import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText, type AssistantMessage, type ToolResultMessage } from "@earendil-works/pi-ai";
import { convertToLlm, type ProjectedSessionEntry, type SessionEntry, type SessionManager } from "@earendil-works/pi-coding-agent";

export interface TailPreparationResult {
	/** Whether the projected session now has runnable context ending on user or complete toolResult. */
	canContinue: boolean;
	/** Entry IDs omitted via durable `context_edit` (`replacement: null`) in order. */
	omittedEntryIds: string[];
	/** Newly appended `context_edit` entries so callers can notify session listeners. */
	appendedEntries: SessionEntry[];
	/** Human-readable reason when `canContinue` is false. */
	reason?: string;
}

const ABORTED_TOOL_RESULT_PATTERNS: readonly RegExp[] = [
	/^Operation aborted\.?$/i,
	/^Request was aborted\.?$/i,
	/^Aborted\.?$/i,
	/(?:^|\n)Command aborted\.?$/i,
	/^Tool execution was aborted\.?$/i,
];

/**
 * True when a `toolResult` message represents a tool execution cancelled by user/session abort
 * (such as `"Operation aborted"` from agent-core/built-in tools or `"Command aborted"` from bash).
 */
export function isAbortedToolResult(message: ToolResultMessage): boolean {
	if (!message.isError) return false;
	const text = contentText(message.content, "\n").trim();
	if (!text) return false;
	return ABORTED_TOOL_RESULT_PATTERNS.some((pattern) => pattern.test(text));
}

function isSyntheticTruncatedToolResult(message: ToolResultMessage): boolean {
	if (!message.isError) return false;
	const text = contentText(message.content, "\n").trim();
	return /^Tool call ".+" was not executed: the response hit the output token limit/i.test(text);
}

interface ActiveProjectedEntry {
	entryId: string;
	messages: AgentMessage[];
	llmRoles: Array<"user" | "assistant" | "toolResult">;
}

function collectActiveProjectedEntries(entries: readonly ProjectedSessionEntry[]): ActiveProjectedEntry[] {
	const result: ActiveProjectedEntry[] = [];
	for (const entry of entries) {
		if (entry.messages.length === 0) continue;
		const llmMessages = convertToLlm(entry.messages).filter((msg) => msg.role !== "system");
		if (llmMessages.length === 0) continue;
		result.push({
			entryId: entry.sourceEntry.id,
			messages: entry.messages,
			llmRoles: llmMessages.map((msg) => msg.role as "user" | "assistant" | "toolResult"),
		});
	}
	return result;
}

function extractToolCallIds(message: AssistantMessage): string[] {
	const ids: string[] = [];
	for (const block of message.content) {
		if (block.type === "toolCall") {
			ids.push(block.id);
		}
	}
	return ids;
}

/**
 * Inspect the current session projection and compute the exact entry IDs that must be omitted
 * (`context_edit` -> `null`) so `/retry` can send the session unconditionally to the model
 * without injecting any user/custom/error prompt:
 *
 * - If the session already ends on a `user`-role message (user, custom, bashExecution, summary):
 *   nothing is omitted; send as-is.
 * - Any trailing `assistant` entry (`aborted`, `error`, `length`, `stop`, or dangling `toolUse`)
 *   is omitted so `agent.continue()` re-requests that assistant turn cleanly.
 * - After removing any trailing `assistant` entry, if the session ends on `toolResult` entries:
 *   - Keep them as-is when they form a complete, non-aborted, non-truncated tool batch for their
 *     preceding `assistant` message (e.g. tools succeeded and the user aborted during the *next*
 *     assistant stream).
 *   - Roll back the entire `assistant` + `toolResult` batch when any tool call is missing its
 *     result, when any `toolResult` failed with `Operation aborted` / `Command aborted`, when
 *     the issuing `assistant` had `stopReason === "length"`, or when `toolResult`s are orphaned.
 */
export function planUnconditionalRetryOmissions(sessionManager: Pick<SessionManager, "buildSessionProjection">): {
	canContinue: boolean;
	targetEntryIds: string[];
	reason?: string;
} {
	const projection = sessionManager.buildSessionProjection();
	const active = collectActiveProjectedEntries(projection.entries);
	if (active.length === 0) {
		return {
			canContinue: false,
			targetEntryIds: [],
			reason: "Nothing to retry: session has no conversation messages.",
		};
	}

	const toOmit: string[] = [];
	let end = active.length - 1;

	while (end >= 0) {
		const tail = active[end]!;
		const lastRole = tail.llmRoles[tail.llmRoles.length - 1];

		if (lastRole === "user") {
			break;
		}

		if (lastRole === "assistant") {
			toOmit.push(tail.entryId);
			end--;
			continue;
		}

		// lastRole === "toolResult": gather the contiguous trailing toolResult block
		const toolResultStart = (() => {
			let idx = end;
			while (idx >= 0 && active[idx]!.llmRoles.every((role) => role === "toolResult")) {
				idx--;
			}
			return idx + 1;
		})();

		const assistantIdx = toolResultStart - 1;
		const assistantEntry = assistantIdx >= 0 ? active[assistantIdx] : undefined;
		const assistantMsg = assistantEntry?.messages.find(
			(msg): msg is AssistantMessage => msg.role === "assistant",
		);

		if (!assistantEntry || !assistantMsg) {
			// Orphaned toolResult entries without a preceding assistant entry: omit them.
			for (let i = toolResultStart; i <= end; i++) {
				toOmit.push(active[i]!.entryId);
			}
			end = toolResultStart - 1;
			continue;
		}

		const expectedIds = extractToolCallIds(assistantMsg);
		const toolResultMessages: ToolResultMessage[] = [];
		for (let i = toolResultStart; i <= end; i++) {
			for (const msg of active[i]!.messages) {
				if (msg.role === "toolResult") {
					toolResultMessages.push(msg);
				}
			}
		}

		const seenIds = new Set(toolResultMessages.map((msg) => msg.toolCallId));
		const allCallsPaired = expectedIds.length > 0 && expectedIds.every((id) => seenIds.has(id));
		const anyAbortedOrTruncated =
			assistantMsg.stopReason === "length" ||
			assistantMsg.stopReason === "aborted" ||
			assistantMsg.stopReason === "error" ||
			toolResultMessages.some((msg) => isAbortedToolResult(msg) || isSyntheticTruncatedToolResult(msg));

		if (allCallsPaired && !anyAbortedOrTruncated) {
			// Valid completed tool batch — continue directly from these toolResults!
			break;
		}

		// Roll back the interrupted/aborted/incomplete assistant + toolResult batch.
		toOmit.push(assistantEntry.entryId);
		for (let i = toolResultStart; i <= end; i++) {
			toOmit.push(active[i]!.entryId);
		}
		end = assistantIdx - 1;
	}

	if (end < 0) {
		return {
			canContinue: false,
			targetEntryIds: [],
			reason: "Nothing to retry: session has no user message before the omitted turn.",
		};
	}

	return {
		canContinue: true,
		targetEntryIds: toOmit,
	};
}

/**
 * Apply planned `context_edit` (`replacement: null`) omissions durably to `sessionManager`.
 */
export function prepareSessionForUnconditionalRetry(sessionManager: SessionManager): TailPreparationResult {
	const plan = planUnconditionalRetryOmissions(sessionManager);
	if (!plan.canContinue) {
		return {
			canContinue: false,
			omittedEntryIds: [],
			appendedEntries: [],
			reason: plan.reason,
		};
	}

	const appendedEntries: SessionEntry[] = [];
	for (const targetId of plan.targetEntryIds) {
		const editId = sessionManager.appendContextEdit(targetId, null);
		const entry = sessionManager.getEntry(editId);
		if (entry) {
			appendedEntries.push(entry);
		}
	}

	return {
		canContinue: true,
		omittedEntryIds: plan.targetEntryIds,
		appendedEntries,
	};
}
