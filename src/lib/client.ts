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

	/** Authenticate with email + password and cache the session key. */
	async login(): Promise<CronometerSession> {
		if (!this.email || !this.password) {
			throw new CronometerApiError(
				"Cronometer credentials are not configured. Set the CRONOMETER_EMAIL and CRONOMETER_PASSWORD Worker secrets.",
				401,
			);
		}

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

		const res = await fetch(`${this.baseUrl}/api/v2/login`, {
			method: "POST",
			headers: {
				"Content-Type": "text/plain; charset=utf-8",
				"User-Agent": USER_AGENT,
				Accept: "application/json",
			},
			body: JSON.stringify(payload),
		});

		const data = await this.parseBody(res);

		if (!res.ok) {
			throw new CronometerApiError(
				`Cronometer login failed: ${res.status} ${res.statusText}`,
				res.status,
				data,
			);
		}

		const obj = (data ?? {}) as Record<string, unknown>;
		const sessionKey = obj.sessionKey;
		const id = obj.id;

		if (obj.result === "FAIL" || obj.error || typeof sessionKey !== "string") {
			throw new CronometerApiError(
				`Cronometer login failed: ${String(obj.error ?? "invalid email or password")}`,
				401,
				data,
			);
		}

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

		const body = { ...payload, auth: this.authBlock(), lastSeen: 0 };

		const res = await fetch(`${this.baseUrl}${endpoint}`, {
			method: "POST",
			headers: {
				"Content-Type": "text/plain; charset=utf-8",
				"User-Agent": USER_AGENT,
				Accept: "application/json",
			},
			body: JSON.stringify(body),
		});

		if ((res.status === 401 || res.status === 403) && !isRetry) {
			await this.ensureAuth(true);
			return this.v2<T>(endpoint, payload, true);
		}

		const data = await this.parseBody(res);

		if (!res.ok) {
			throw new CronometerApiError(
				`Cronometer API request failed: ${res.status} ${res.statusText}`,
				res.status,
				data,
			);
		}

		// Some endpoints signal auth/session failure in the JSON body.
		if (data && typeof data === "object") {
			const result = (data as Record<string, unknown>).result;
			if ((result === "FAILURE" || result === "FAIL") && !isRetry) {
				await this.ensureAuth(true);
				return this.v2<T>(endpoint, payload, true);
			}
			if (result === "FAILURE" || result === "FAIL") {
				throw new CronometerApiError(
					`Cronometer API error: ${String((data as Record<string, unknown>).error ?? "request failed")}`,
					502,
					data,
				);
			}
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
	async deleteServings(day: string, servingIds: Array<string | number>): Promise<number> {
		await this.ensureAuth();
		const diary = await this.getDiary(day);
		const entries: any[] = Array.isArray(diary?.diary) ? diary.diary : [];
		const idSet = new Set(servingIds.map((s) => String(s)));
		const toDelete = entries.filter((e) => idSet.has(String(e?.servingId ?? e?.id)));
		if (toDelete.length === 0) {
			return 0;
		}

		const res = await fetch(
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
