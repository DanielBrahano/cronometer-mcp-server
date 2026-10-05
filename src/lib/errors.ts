import { CronometerApiError } from "./client.js";
import { ValidationError } from "./transforms.js";

/** MCP tool response shape. */
export interface McpToolResponse {
	[x: string]: unknown;
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}

const STATUS_CODE_MESSAGES: Record<number, string> = {
	400: "Invalid request parameters",
	401: "Cronometer authentication failed",
	403: "Forbidden — Cronometer blocked or rate-limited the request",
	404: "Resource not found",
	429: "Rate limit exceeded",
	500: "Cronometer API error",
	502: "Cronometer API returned an unexpected response",
	503: "Cronometer API is temporarily unavailable",
	504: "Cronometer did not respond in time",
};

function getStatusMessage(status: number): string {
	return STATUS_CODE_MESSAGES[status] || `Unexpected error (HTTP ${status})`;
}

/**
 * Machine-readable failure categories.
 *
 * The caller needs to tell these apart to react correctly: a rate limit means
 * wait, an auth failure means check the secrets, and a bad id means the arguments
 * were wrong and retrying unchanged will fail identically. Emitting the category
 * explicitly keeps the client from having to pattern-match on prose.
 */
export type ErrorKind =
	| "rate_limited"
	| "auth_failed"
	| "invalid_reference"
	| "bad_request"
	| "timeout"
	| "upstream_error"
	| "validation_error"
	| "unknown";

/** Detail text naming a specific record, i.e. the arguments were wrong. */
const REFERENCE_PATTERNS = [
	"food",
	"measure",
	"serving",
	"not found",
	"no such",
	"unknown id",
	"invalid id",
];

function classify(error: CronometerApiError): ErrorKind {
	const detail = `${error.message} ${
		typeof error.data === "string"
			? error.data
			: JSON.stringify(error.data ?? {})
	}`.toLowerCase();

	if (error.status === 429) return "rate_limited";
	if (error.status === 401) return "auth_failed";
	if (error.status === 400) return "bad_request";
	if (error.status === 404) return "invalid_reference";
	if (error.status === 504) return "timeout";

	// 403 is ambiguous on this API — it is used both for a blocked session and for
	// throttling, so the body text decides which.
	if (error.status === 403) {
		return detail.includes("rate") || detail.includes("too many")
			? "rate_limited"
			: "auth_failed";
	}

	// A 502 is how a body-level rejection surfaces; those are usually a bad
	// food_id / measure_id rather than a genuine upstream fault.
	if (
		error.status === 502 &&
		REFERENCE_PATTERNS.some((p) => detail.includes(p))
	) {
		return "invalid_reference";
	}

	if (error.status >= 500) return "upstream_error";
	return "unknown";
}

const FIX_HINTS: Record<ErrorKind, string[]> = {
	rate_limited: [
		"  - Cronometer is throttling this account. Wait ~60s before retrying.",
		"  - Do NOT retry immediately: repeated attempts extend the lockout.",
		"  - The cached session is still valid, so no re-login is needed or attempted.",
	],
	auth_failed: [
		"  - Verify the CRONOMETER_EMAIL and CRONOMETER_PASSWORD secrets are correct",
		"  - Reset them with: wrangler secret put CRONOMETER_EMAIL / CRONOMETER_PASSWORD",
		"  - Check /health?verify=1 to confirm the credentials work",
	],
	invalid_reference: [
		"  - Re-run search_food to get a valid food_id AND measure_id pair",
		"  - measure_id must belong to that food; 0 is only valid for custom foods",
		"  - For an existing diary entry, re-read serving_id from get_nutrition_diary",
	],
	bad_request: [
		"  - Check parameter formats (date must be YYYY-MM-DD)",
		"  - Verify all required parameters are provided",
	],
	timeout: [
		"  - Cronometer was slow to respond; the request was aborted, not applied",
		"  - For a write, re-read the diary before retrying to avoid double-logging",
	],
	upstream_error: ["  - Temporary Cronometer issue — try again shortly"],
	validation_error: ["  - Review the message above and correct the input."],
	unknown: ["  - Review the error details above"],
};

/** Format a CronometerApiError into an MCP tool response, preserving API detail. */
export function formatCronometerApiError(
	error: CronometerApiError,
): McpToolResponse {
	const kind = classify(error);
	const parts: string[] = [];
	parts.push(`❌ ${getStatusMessage(error.status)} [error_kind: ${kind}]`);
	parts.push("");
	parts.push("**What went wrong:**");
	parts.push(error.message);

	if (error.data) {
		if (typeof error.data === "string") {
			parts.push("");
			parts.push("**Details:**");
			parts.push(error.data);
		} else if (typeof error.data === "object") {
			const data = error.data as Record<string, unknown>;
			let known = false;
			if (data.error) {
				known = true;
				parts.push("");
				parts.push("**Details:**");
				parts.push(String(data.error));
			}
			if (data.message && data.message !== data.error) {
				known = true;
				parts.push("");
				parts.push("**Message:**");
				parts.push(String(data.message));
			}
			if (!known) {
				parts.push("");
				parts.push("**Raw API Response:**");
				parts.push(JSON.stringify(data, null, 2));
			}
		}
	}

	parts.push("");
	parts.push("**How to fix:**");
	parts.push(...FIX_HINTS[kind]);

	return {
		content: [{ type: "text", text: parts.join("\n") }],
		isError: true,
		errorKind: kind,
		httpStatus: error.status,
	};
}

function formatValidationError(error: ValidationError): McpToolResponse {
	return {
		content: [
			{
				type: "text",
				text: `❌ Validation Error [error_kind: validation_error]\n\n**What went wrong:**\n${error.message}\n\n**How to fix:**\n${FIX_HINTS.validation_error.join("\n")}`,
			},
		],
		isError: true,
		errorKind: "validation_error",
	};
}

/** Central error handler routing errors to the right formatter. */
export function handleError(error: unknown): McpToolResponse {
	if (error instanceof CronometerApiError) {
		return formatCronometerApiError(error);
	}
	if (error instanceof ValidationError) {
		return formatValidationError(error);
	}
	if (error instanceof Error) {
		return {
			content: [
				{
					type: "text",
					text: `❌ Error [error_kind: unknown]: ${error.message}`,
				},
			],
			isError: true,
			errorKind: "unknown",
		};
	}
	return {
		content: [{ type: "text", text: "❌ An unknown error occurred" }],
		isError: true,
		errorKind: "unknown",
	};
}
