/**
 * Cronometer mobile API client.
 *
 * Cronometer has no official public API for individuals. This client talks to
 * the same JSON REST API that the Cronometer Android/Flutter app uses
 * (mobile.cronometer.com/api/v2/*). Authentication is a plain email + password
 * login that returns a long-lived session key; the key is cached in memory and
 * the client re-authenticates automatically whenever a request is rejected.
 *
 * Verified server-to-server reachable (no Cloudflare bot-block): the /api/v2/login
 * endpoint returns clean JSON. The endpoint paths and request shapes below are
 * reverse-engineered from the mobile app and parsed defensively; every tool
 * returns the raw API JSON so the data is usable even if a field name differs.
 */

const DEFAULT_BASE_URL = "https://mobile.cronometer.com";

// Auth metadata block the mobile app sends with every authenticated request.
const APP_AUTH_META = {
	api: 3,
	os: "Android",
	build: "2807",
	flavour: "free",
} as const;

// App identification sent on login (mimics a recent Android build).
const APP_BUILD = "4.48.2 b2807-a";
const APP_DEVICE = "Android 14 (SDK 34), Google Pixel 6 Pro";
const USER_AGENT = "Dart/3.9 (dart:io)";

/** Abort an upstream call that has not responded within this many ms. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Retry attempts after the initial try, for transient failures only. */
const MAX_RETRIES = 3;

/** Base for exponential backoff: 300ms, 600ms, 1200ms (plus jitter). */
const BASE_BACKOFF_MS = 300;

/** Never wait longer than this between attempts, whatever Retry-After says. */
const MAX_BACKOFF_MS = 5_000;

/**
 * v2 endpoints that only read. Everything on the mobile API is a POST, so the
 * HTTP method says nothing about whether replaying is safe — retrying
 * add_serving would double-log a food. Only endpoints listed here are retried
 * after a 5xx; writes fail fast and let the caller decide.
 */
const READ_ONLY_ENDPOINTS = new Set([
	"/api/v2/find_food",
	"/api/v2/get_food",
	"/api/v2/get_diary",
	"/api/v2/get_nutrition_scores",
	"/api/v2/get_fasting_with_date_range",
	"/api/v2/get_fasting_stats",
]);

/**
 * Cronometer throttles its login endpoint per account, and a burst of logins is
 * exactly what trips "Too Many Attempts". These guards are module-level so every
 * client built inside one Worker/Durable Object isolate shares them: a single hot
 * isolate must not be able to stampede the login endpoint.
 *
 * This is the hard guarantee against a re-login spiral. The failure
 * classification below is an optimisation on top of it, not the safety net.
 */
const MIN_LOGIN_INTERVAL_MS = 2_000;

/** After Cronometer throttles a login, refuse to try again for this long. */
const LOGIN_LOCKOUT_MS = 60_000;

/** Minimum gap between consecutive diary writes, to stay under the limiter. */
const MIN_WRITE_INTERVAL_MS = 350;

let lastLoginAt = 0;
let loginLockedOutUntil = 0;
let loginLockoutReason = "";
let inFlightLogin: Promise<CronometerSession> | null = null;
let lastWriteAt = 0;

/**
 * Error text meaning Cronometer is throttling us. Re-authenticating in response
 * to this makes it strictly worse, so these never trigger a login.
 */
const RATE_LIMIT_PATTERNS = [
	"too many attempts",
	"too many requests",
	"rate limit",
	"rate-limit",
	"throttl",
	"try again later",
	"slow down",
];

/** Error text meaning the session itself is bad, where a fresh login helps. */
const AUTH_FAILURE_PATTERNS = [
	"session",
	"not logged in",
	"login required",
	"must log in",
	"unauthorized",
	"unauthenticated",
	"invalid token",
	"bad token",
	"authentication",
	"expired",
];

function matchesAny(text: string, patterns: string[]): boolean {
	const lower = text.toLowerCase();
	return patterns.some((p) => lower.includes(p));
}

export function describesRateLimit(text: string): boolean {
	return matchesAny(text, RATE_LIMIT_PATTERNS);
}

function describesAuthFailure(text: string): boolean {
	return matchesAny(text, AUTH_FAILURE_PATTERNS);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Space out diary writes. Cronometer rejects rapid-fire writes, and the retry
 * that follows a rejection costs more than the wait does.
 */
async function spaceWrites(): Promise<void> {
	const since = Date.now() - lastWriteAt;
	if (since < MIN_WRITE_INTERVAL_MS) {
		await sleep(MIN_WRITE_INTERVAL_MS - since);
	}
	lastWriteAt = Date.now();
}

/**
 * 429 is always safe to retry — a rate-limited request was rejected before it
 * was processed. 5xx is only safe when the endpoint does not mutate anything.
 */
function isRetryable(status: number, replayable: boolean): boolean {
	if (status === 429) return true;
	if (!replayable) return false;
	return status === 500 || status === 502 || status === 503 || status === 504;
}

/** Honour Retry-After when present, else exponential backoff with jitter. */
function retryDelayMs(res: Response | null, attempt: number): number {
	const header = res?.headers.get("Retry-After");
	if (header) {
		const seconds = Number(header);
		if (Number.isFinite(seconds)) {
			return Math.min(seconds * 1000, MAX_BACKOFF_MS);
		}
		const date = Date.parse(header);
		if (!Number.isNaN(date)) {
			return Math.min(Math.max(date - Date.now(), 0), MAX_BACKOFF_MS);
		}
	}
	return Math.min(
		BASE_BACKOFF_MS * 2 ** attempt + Math.random() * BASE_BACKOFF_MS,
		MAX_BACKOFF_MS,
	);
}

/**
 * fetch with a hard timeout, retrying transient failures.
 *
 * Without the timeout a hung Cronometer call would hold the Worker request open
 * until the platform killed it, which surfaces to the user as a dead tool rather
 * than an error they can act on.
 */
async function fetchWithRetry(
	url: string,
	init: RequestInit,
	replayable: boolean,
	label: string,
): Promise<Response> {
	for (let attempt = 0; ; attempt++) {
		try {
			const res = await fetch(url, {
				...init,
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});

			if (attempt < MAX_RETRIES && isRetryable(res.status, replayable)) {
				await sleep(retryDelayMs(res, attempt));
				continue;
			}

			return res;
		} catch (error) {
			// No response was received, so replaying is safe where the endpoint allows it.
			if (replayable && attempt < MAX_RETRIES) {
				await sleep(retryDelayMs(null, attempt));
				continue;
			}

			const timedOut = error instanceof Error && error.name === "TimeoutError";
			throw new CronometerApiError(
				timedOut
					? `Cronometer ${label} timed out after ${REQUEST_TIMEOUT_MS}ms`
					: `Could not reach Cronometer (${label}): ${error instanceof Error ? error.message : "network error"}`,
				504,
				{ attempts: attempt + 1 },
			);
		}
	}
}

/** Canonical Cronometer nutrient IDs (per-100g basis). */
export const NUTRIENT_IDS = {
	energy: 208,
	protein: 203,
	fat: 204,
	carbs: 205,
	fiber: 291,
	sugar: 269,
	sodium: 307,
	netCarbs: -1205,
} as const;

export class CronometerApiError extends Error {
	status: number;
	data?: unknown;

	constructor(message: string, status: number, data?: unknown) {
		super(message);
		this.name = "CronometerApiError";
		this.status = status;
		this.data = data;
	}
}

export interface CronometerSession {
	userId: number;
	sessionKey: string;
}

export interface CronometerClientConfig {
	email: string;
	password: string;
	/** Optional cached session to reuse before attempting a fresh login. */
	session?: CronometerSession | null;
	/** Called whenever a new session is minted (e.g. to persist it). */
	onSession?: (session: CronometerSession) => void;
	baseUrl?: string;
}

export class CronometerClient {
	private email: string;
	private password: string;
	private baseUrl: string;
	private onSession?: (session: CronometerSession) => void;

	private userId: number | null = null;
	private sessionKey: string | null = null;

	constructor(config: CronometerClientConfig) {
		this.email = config.email;
		this.password = config.password;
		this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
		this.onSession = config.onSession;
		if (config.session) {
			this.userId = config.session.userId;
			this.sessionKey = config.session.sessionKey;
		}
	}

	/** The Cronometer numeric user id (after login). */
	getUserId(): number | null {
		return this.userId;
	}

	getSession(): CronometerSession | null {
		return this.userId != null && this.sessionKey != null
			? { userId: this.userId, sessionKey: this.sessionKey }
			: null;
	}

	// ============================================
	// AUTH
	// ============================================

	/**
	 * Authenticate and cache the session key.
	 *
	 * Concurrent callers share one round-trip (single-flight) and the attempt is
	 * throttled, so a burst of tool calls that all find an empty cache cannot turn
	 * into a burst of logins.
	 */
	async login(): Promise<CronometerSession> {
		if (inFlightLogin) {
			return inFlightLogin;
		}
		inFlightLogin = this.performLogin().finally(() => {
			inFlightLogin = null;
		});
		return inFlightLogin;
	}

	private async performLogin(): Promise<CronometerSession> {
		if (!this.email || !this.password) {
			throw new CronometerApiError(
				"Cronometer credentials are not configured. Set the CRONOMETER_EMAIL and CRONOMETER_PASSWORD Worker secrets.",
				401,
			);
		}

		const lockoutRemaining = loginLockedOutUntil - Date.now();
		if (lockoutRemaining > 0) {
			throw new CronometerApiError(
				`Cronometer is rate-limiting logins for this account${
					loginLockoutReason ? ` (${loginLockoutReason})` : ""
				}. Not retrying for another ${Math.ceil(lockoutRemaining / 1000)}s — the cached session will be reused as soon as one is available.`,
				429,
				{ locked_out_for_ms: lockoutRemaining },
			);
		}

		const sinceLastLogin = Date.now() - lastLoginAt;
		if (sinceLastLogin < MIN_LOGIN_INTERVAL_MS) {
			await sleep(MIN_LOGIN_INTERVAL_MS - sinceLastLogin);
		}
		lastLoginAt = Date.now();

		const payload = {
			email: this.email,
			password: this.password,
			timezone: "UTC",
			userCode: null,
			build: APP_BUILD,
			device: APP_DEVICE,
			firebaseToken: "",
			features: {
				food_search_config: '{"newSearch": true, "newSpellcheck": true}',
				use_gpt_autofill: "true",
			},
			auth: { userId: null, token: null, ...APP_AUTH_META },
			lastSeen: 0,
			config: { call_version: 2 },
		};

		const res = await fetchWithRetry(
			`${this.baseUrl}/api/v2/login`,
			{
				method: "POST",
				headers: {
					"Content-Type": "text/plain; charset=utf-8",
					"User-Agent": USER_AGENT,
					Accept: "application/json",
				},
				body: JSON.stringify(payload),
			},
			true, // minting a session twice is harmless
			"login",
		);

		const data = await this.parseBody(res);
		const obj = (data ?? {}) as Record<string, unknown>;

		// "Too Many Attempts" arrives as a login rejection, not an HTTP 429. Treat
		// it as a lockout so the next caller waits instead of hammering the limiter.
		const bodyText =
			typeof data === "string" ? data : JSON.stringify(obj ?? {});
		const detail = String(obj.error ?? obj.message ?? bodyText ?? "");
		if (res.status === 429 || describesRateLimit(detail)) {
			loginLockedOutUntil = Date.now() + LOGIN_LOCKOUT_MS;
			loginLockoutReason = detail.slice(0, 120);
			throw new CronometerApiError(
				`Cronometer rejected the login as rate-limited: ${detail || "too many attempts"}. Pausing logins for ${LOGIN_LOCKOUT_MS / 1000}s.`,
				429,
				data,
			);
		}

		if (!res.ok) {
			throw new CronometerApiError(
				`Cronometer login failed: ${res.status} ${res.statusText}`,
				res.status,
				data,
			);
		}

		const sessionKey = obj.sessionKey;
		const id = obj.id;

		if (obj.result === "FAIL" || obj.error || typeof sessionKey !== "string") {
			throw new CronometerApiError(
				`Cronometer login failed: ${String(obj.error ?? "invalid email or password")}`,
				401,
				data,
			);
		}

		// A successful login clears any stale lockout.
		loginLockedOutUntil = 0;
		loginLockoutReason = "";

		this.userId = typeof id === "number" ? id : Number(id);
		this.sessionKey = sessionKey;
		const session = { userId: this.userId, sessionKey };
		this.onSession?.(session);
		return session;
	}

	/** Verify credentials work by logging in. Returns the resolved user id. */
	async verifyAuth(): Promise<{ userId: number }> {
		const session = await this.ensureAuth(true);
		return { userId: session.userId };
	}

	private async ensureAuth(force = false): Promise<CronometerSession> {
		if (!force && this.userId != null && this.sessionKey != null) {
			return { userId: this.userId, sessionKey: this.sessionKey };
		}
		return this.login();
	}

	private authBlock(): Record<string, unknown> {
		return { userId: this.userId, token: this.sessionKey, ...APP_AUTH_META };
	}

	private async parseBody(res: Response): Promise<unknown> {
		const text = await res.text();
		if (!text) {
			return null;
		}
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	}

	// ============================================
	// CORE v2 REQUEST
	// ============================================

	/**
	 * Send a v2 POST request with the JSON auth block. Re-authenticates and
	 * retries once if the session is rejected (401/403 or result: "FAILURE").
	 */
	private async v2<T>(
		endpoint: string,
		payload: Record<string, unknown>,
		isRetry = false,
	): Promise<T> {
		await this.ensureAuth();

		const replayable = READ_ONLY_ENDPOINTS.has(endpoint);
		if (!replayable) {
			await spaceWrites();
		}

		const body = { ...payload, auth: this.authBlock(), lastSeen: 0 };

		const res = await fetchWithRetry(
			`${this.baseUrl}${endpoint}`,
			{
				method: "POST",
				headers: {
					"Content-Type": "text/plain; charset=utf-8",
					"User-Agent": USER_AGENT,
					Accept: "application/json",
				},
				body: JSON.stringify(body),
			},
			replayable,
			endpoint,
		);

		const data = await this.parseBody(res);
		const obj =
			data && typeof data === "object" ? (data as Record<string, unknown>) : {};
		const detail = String(
			obj.error ?? obj.message ?? (typeof data === "string" ? data : ""),
		);

		// Throttling is handled first, and never followed by a login: re-authenticating
		// is what turns one rate-limited call into "Too Many Attempts" for the account.
		if (res.status === 429 || describesRateLimit(detail)) {
			throw new CronometerApiError(
				`Cronometer is rate-limiting this account: ${detail || "too many requests"}. Wait before retrying — the cached session is still valid, so no re-login is needed.`,
				429,
				data,
			);
		}

		if (res.status === 401 || res.status === 403) {
			if (isRetry) {
				throw new CronometerApiError(
					`Cronometer rejected the request even after re-authenticating: ${res.status} ${res.statusText}`,
					res.status,
					data,
				);
			}
			await this.ensureAuth(true);
			return this.v2<T>(endpoint, payload, true);
		}

		if (!res.ok) {
			throw new CronometerApiError(
				`Cronometer API request failed: ${res.status} ${res.statusText}`,
				res.status,
				data,
			);
		}

		// Some endpoints signal failure in the body of an HTTP 200.
		const result = obj.result;
		if (result === "FAILURE" || result === "FAIL") {
			// Only a genuine session problem justifies spending a login. A rejected
			// write (bad measure_id, unknown food_id) is not an auth failure, and
			// re-authenticating for those is what exhausted the login limiter before.
			// An unclassifiable failure still gets one attempt, because a silently
			// expired session reports nothing useful — the login throttle bounds the
			// cost so this cannot become a spiral.
			if (!isRetry && (describesAuthFailure(detail) || detail.trim() === "")) {
				await this.ensureAuth(true);
				return this.v2<T>(endpoint, payload, true);
			}

			throw new CronometerApiError(
				`Cronometer rejected the request: ${detail || "request failed"}`,
				502,
				data,
			);
		}

		return data as T;
	}

	// ============================================
	// NUTRITION / DIARY
	// ============================================

	/** Search the Cronometer food database. */
	async searchFood(query: string): Promise<any> {
		return this.v2<any>("/api/v2/find_food", {
			query,
			tab: "ALL",
			sources: ["All"],
			config: { newSearch: true, newSpellcheck: true, call_version: 1 },
		});
	}

	/** Fetch full food details (measures, default measure id, nutrients). */
	async getFood(foodId: number): Promise<any> {
		return this.v2<any>("/api/v2/get_food", {
			id: foodId,
			config: { call_version: 1 },
		});
	}

	/**
	 * Diary for a day (YYYY-M-D). The response is rich: `diary[]` holds the
	 * logged servings, `summary.consumed` the day's consumed macro totals, and
	 * `summary.macros` the computed goal targets — so this one call powers the
	 * diary, summary, and goals tools.
	 */
	async getDiary(day: string): Promise<any> {
		return this.v2<any>("/api/v2/get_diary", {
			day,
			config: { call_version: 1 },
		});
	}

	// ============================================
	// GOALS / MACRO TARGETS
	// ============================================

	/**
	 * Read the account's macro target templates.
	 *
	 * The diary response carries the *resolved* targets in `summary.macros` plus
	 * the active template in `summary.template`; this endpoint returns the stored
	 * templates themselves, which is what a goal change has to write back.
	 */
	async getMacroTargetTemplates(): Promise<any> {
		return this.v2<any>("/api/v2/get_macro_target_templates", {
			config: { call_version: 1 },
		});
	}

	/**
	 * Candidate endpoints for writing macro targets, most likely first.
	 *
	 * Cronometer documents no API, and the mobile app's setter for this is not
	 * among the calls we have observed, so the name has to be established
	 * empirically. The v2 API names things get_x / set_x / add_x consistently
	 * (get_diary / set_complete / add_serving / add_food), which is what this list
	 * follows. Every attempt is verified against the diary afterwards, so a wrong
	 * guess is reported as "not applied" rather than assumed to have worked.
	 */
	private static readonly MACRO_TARGET_WRITE_ENDPOINTS = [
		"/api/v2/set_macro_target_template",
		"/api/v2/save_macro_target_template",
		"/api/v2/set_macro_targets",
		"/api/v2/add_macro_target_template",
	] as const;

	/**
	 * Write macro targets, then confirm from the diary that they took effect.
	 *
	 * Cronometer stores macro targets as a template that is either percentage-based
	 * (`grams: false`, the default) or gram-based (`grams: true`). Gram targets are
	 * therefore written by flipping the template into gram mode. The calorie figure
	 * is a separate field on the template's resolved output and is passed through
	 * when supplied.
	 *
	 * Returns what was attempted and what actually changed, so the caller can tell
	 * a real success from a silently ignored write.
	 */
	async setMacroTargets(target: {
		calories?: number;
		protein_g?: number;
		carbs_g?: number;
		fat_g?: number;
	}): Promise<{
		applied: boolean;
		endpoint?: string;
		before: Record<string, unknown>;
		after: Record<string, unknown>;
		templateBefore: Record<string, unknown>;
		templateSent: Record<string, unknown>;
		storedTemplates: unknown;
		attempts: Array<{ endpoint: string; ok: boolean; message: string }>;
	}> {
		const today = `${new Date().getUTCFullYear()}-${new Date().getUTCMonth() + 1}-${new Date().getUTCDate()}`;

		const diaryBefore = await this.getDiary(today);
		const before = (diaryBefore?.summary?.macros ?? {}) as Record<
			string,
			unknown
		>;
		const templateBefore = (diaryBefore?.template ?? {}) as Record<
			string,
			unknown
		>;

		// Read the stored templates too: the diary exposes the active one, but the
		// write has to round-trip whatever the store actually holds.
		let storedTemplates: unknown = null;
		try {
			storedTemplates = await this.getMacroTargetTemplates();
		} catch (error) {
			storedTemplates = {
				error: error instanceof Error ? error.message : String(error),
			};
		}

		const gramsGiven =
			target.protein_g != null ||
			target.carbs_g != null ||
			target.fat_g != null;

		const templateSent: Record<string, unknown> = {
			...templateBefore,
			id: templateBefore.id ?? 0,
			name: templateBefore.name ?? "Default Macronutrient Targets",
		};

		if (gramsGiven) {
			// Gram mode: the three macro fields carry grams rather than percentages.
			templateSent.grams = true;
			if (target.protein_g != null) templateSent.protein = target.protein_g;
			if (target.carbs_g != null) templateSent.carbs = target.carbs_g;
			if (target.fat_g != null) templateSent.fat = target.fat_g;
		}
		if (target.calories != null) {
			templateSent.energy = target.calories;
			templateSent.calories = target.calories;
		}

		const attempts: Array<{ endpoint: string; ok: boolean; message: string }> =
			[];
		let endpointUsed: string | undefined;

		for (const endpoint of CronometerClient.MACRO_TARGET_WRITE_ENDPOINTS) {
			try {
				await this.v2(endpoint, {
					template: templateSent,
					data: templateSent,
					config: { call_version: 1 },
				});
				attempts.push({ endpoint, ok: true, message: "accepted" });
				endpointUsed = endpoint;
				break;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				attempts.push({ endpoint, ok: false, message });

				// A rate limit is about us, not about the endpoint being wrong. Stop
				// immediately rather than burning the remaining candidates on it.
				if (error instanceof CronometerApiError && error.status === 429) {
					break;
				}
			}
		}

		const diaryAfter = await this.getDiary(today);
		const after = (diaryAfter?.summary?.macros ?? {}) as Record<
			string,
			unknown
		>;

		const changed = (field: string, want?: number) =>
			want == null || Math.abs(Number(after[field] ?? 0) - want) < 1;

		const applied =
			endpointUsed != null &&
			JSON.stringify(before) !== JSON.stringify(after) &&
			changed("protein", target.protein_g) &&
			changed("carbs", target.carbs_g) &&
			changed("fat", target.fat_g) &&
			changed("energy", target.calories);

		return {
			applied,
			endpoint: endpointUsed,
			before,
			after,
			templateBefore,
			templateSent,
			storedTemplates,
			attempts,
		};
	}

	/**
	 * Send an arbitrary v2 call with the session attached.
	 *
	 * The Cronometer API is reverse-engineered, so confirming an endpoint's real
	 * request/response shape is sometimes the only way to implement against it.
	 * Treated as non-replayable, so a call is never retried automatically.
	 */
	async rawV2<T = any>(
		endpoint: string,
		payload: Record<string, unknown> = {},
	): Promise<T> {
		if (!endpoint.startsWith("/api/")) {
			throw new CronometerApiError(
				`Refusing to call "${endpoint}": endpoint must start with /api/`,
				400,
			);
		}
		return this.v2<T>(endpoint, payload);
	}

	/** Log a food serving to the diary. */
	async addServing(entry: {
		foodId: number;
		measureId: number;
		grams: number;
		day: string;
		time: string;
		mealGroup: number;
		translationId?: number;
	}): Promise<any> {
		await this.ensureAuth(); // must run before building serving so this.userId is populated
		const serving = {
			order: (entry.mealGroup << 16) | 1,
			day: entry.day,
			time: entry.time,
			offset: null,
			source: null,
			userId: this.userId,
			servingId: null,
			type: "Serving",
			foodId: entry.foodId,
			measureId: entry.measureId,
			grams: entry.grams,
			translationId: entry.translationId ?? 0,
		};
		return this.v2<any>("/api/v2/add_serving", {
			serving,
			config: { call_version: 2 },
		});
	}

	/**
	 * Update an existing diary serving by replacing it (delete + re-add with new
	 * values). Both operations are confirmed working, making this approach safe
	 * even though it changes the servingId.
	 */
	async updateServing(options: {
		day: string; // Cronometer format, e.g. "2026-5-26"
		servingId: string | number;
		grams?: number;
		mealGroup?: number;
	}): Promise<any> {
		const diary = await this.getDiary(options.day);
		const entries: any[] = Array.isArray(diary?.diary) ? diary.diary : [];
		const entry = entries.find(
			(e) => String(e?.servingId ?? e?.id) === String(options.servingId),
		);
		if (!entry) {
			throw new Error(
				`Serving id ${options.servingId} not found in diary for ${options.day}`,
			);
		}

		await this.deleteServings(options.day, [options.servingId]);

		const now = new Date();
		const nowTimeStr = `${now.getUTCHours()}:${now.getUTCMinutes()}:${now.getUTCSeconds()}`;
		const mealGroup =
			options.mealGroup ??
			(typeof entry.order === "number" ? entry.order >> 16 : 1);
		const grams = options.grams ?? entry.grams;

		return this.addServing({
			foodId: entry.foodId,
			measureId: entry.measureId,
			grams,
			day: options.day,
			time: entry.time ?? nowTimeStr,
			mealGroup,
			translationId: entry.translationId ?? 0,
		});
	}

	/**
	 * Delete diary servings by their servingId. Fetches the day's diary to get
	 * the full serving objects (required by the v3 API), then issues a v3 DELETE
	 * (auth via x-crono-session header). Returns the count removed.
	 */
	async deleteServings(
		day: string,
		servingIds: Array<string | number>,
	): Promise<number> {
		await this.ensureAuth();
		const diary = await this.getDiary(day);
		const entries: any[] = Array.isArray(diary?.diary) ? diary.diary : [];
		const idSet = new Set(servingIds.map((s) => String(s)));
		const toDelete = entries.filter((e) =>
			idSet.has(String(e?.servingId ?? e?.id)),
		);
		if (toDelete.length === 0) {
			return 0;
		}

		await spaceWrites();

		const res = await fetchWithRetry(
			`${this.baseUrl}/api/v3/user/${this.userId}/diary-entries`,
			{
				method: "DELETE",
				headers: {
					"x-crono-session": this.sessionKey ?? "",
					"x-crono-app-os": "android",
					"x-crono-app-build-number": "2807",
					"x-crono-app-version": "4.48.2",
					"Content-Type": "application/json; charset=utf-8",
					"User-Agent": USER_AGENT,
				},
				body: JSON.stringify({ diaryEntries: toDelete }),
			},
			false, // a replayed delete can 404 on the second pass — fail fast instead
			"delete diary entries",
		);

		if (res.status !== 204 && !res.ok) {
			const data = await this.parseBody(res);
			throw new CronometerApiError(
				`Cronometer delete failed: ${res.status} ${res.statusText}`,
				res.status,
				data,
			);
		}
		return toDelete.length;
	}

	// ============================================
	// DIARY UTILITIES
	// ============================================

	/** Copy diary entries from one day to another. Defaults to yesterday → today. */
	async copyDay(from: string, to: string): Promise<any> {
		return this.v2<any>("/api/v2/copy", {
			from,
			to,
			diaryGroupNumber: null,
			config: { call_version: 1 },
		});
	}

	/** Mark a diary day as complete (or incomplete). */
	async setDayComplete(day: string, complete: boolean): Promise<any> {
		return this.v2<any>("/api/v2/set_complete", {
			day,
			complete,
			config: { call_version: 1 },
		});
	}

	// ============================================
	// NUTRITION SCORES
	// ============================================

	/**
	 * Get Cronometer's nutrition quality scores for a day. Scores reflect how
	 * well consumed foods hit micronutrient targets (A-F style ratings per
	 * category). The servingIds for the day are resolved from get_diary first.
	 */
	async getNutritionScores(day: string): Promise<any> {
		const diary = await this.getDiary(day);
		const entries: any[] = Array.isArray(diary?.diary) ? diary.diary : [];
		const servingIds = entries
			.filter((e) => e?.type === undefined || e?.type === "Serving")
			.map((e) => e.servingId)
			.filter((id) => id != null);
		return this.v2<any>("/api/v2/get_nutrition_scores", {
			startDay: "1900-1-1",
			endDay: "1900-1-1",
			servingIds,
			supplements: "true",
			config: { call_version: 1 },
		});
	}

	// ============================================
	// CUSTOM FOODS
	// ============================================

	/**
	 * Create a custom food in the user's Cronometer food database. All nutrient
	 * values passed are per-serving; they are auto-scaled to per-100g for storage.
	 */
	async createCustomFood(food: {
		name: string;
		calories: number;
		protein_g: number;
		fat_g: number;
		carbs_g: number;
		fiber_g?: number;
		sugar_g?: number;
		sodium_mg?: number;
		serving_name?: string;
		serving_grams?: number;
	}): Promise<{ food_id: number | null }> {
		const servingGrams = food.serving_grams ?? 100;
		const scale = servingGrams > 0 ? 100 / servingGrams : 1;
		const fiber = food.fiber_g ?? 0;
		const netCarbs = Math.max(0, food.carbs_g - fiber);

		const r = (x: number) => Math.round(x * 100) / 100;
		const nutrients = [
			{ id: 208, amount: r(food.calories * scale) },
			{ id: 203, amount: r(food.protein_g * scale) },
			{ id: 204, amount: r(food.fat_g * scale) },
			{ id: 205, amount: r(food.carbs_g * scale) },
			{ id: 291, amount: r(fiber * scale) },
			{ id: 269, amount: r((food.sugar_g ?? 0) * scale) },
			{ id: 307, amount: r((food.sodium_mg ?? 0) * scale) },
			{ id: -203, amount: r(food.protein_g * scale) },
			{ id: -204, amount: r(food.fat_g * scale) },
			{ id: -205, amount: r(food.carbs_g * scale) },
			{ id: -221, amount: 0 },
			{ id: -1205, amount: r(netCarbs * scale) },
		];

		const data = await this.v2<any>("/api/v2/add_food", {
			data: {
				id: 0,
				name: food.name,
				category: 0,
				owner: null,
				retired: null,
				source: null,
				defaultMeasureId: 0,
				comments: null,
				alternateId: null,
				measures: [
					{
						id: 0,
						name: food.serving_name ?? "1 serving",
						value: servingGrams,
						amount: 1.0,
						type: "Atomic",
					},
				],
				labelType: "AMERICAN_2016",
				nutrients,
				properties: {},
				foodTags: [],
			},
			config: { call_version: 1 },
		});
		return { food_id: data?.id ?? null };
	}

	// ============================================
	// FASTING
	// ============================================

	/** Get fasting sessions within a date range (Cronometer format YYYY-M-D). */
	async getFastingHistory(start: string, end: string): Promise<any> {
		return this.v2<any>("/api/v2/get_fasting_with_date_range", {
			start,
			end,
			config: { call_version: 1 },
		});
	}

	/** Get overall fasting statistics (totals, longest fast, averages). */
	async getFastingStats(): Promise<any> {
		return this.v2<any>("/api/v2/get_fasting_stats", {
			config: { call_version: 1 },
		});
	}
}
