import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	CronometerClient,
	type CronometerSession,
} from "./lib/client.js";
import { handleError } from "./lib/errors.js";
import {
	type Macros,
	averageMacros,
	enumerateDates,
	MEAL_GROUPS,
	MEAL_NAMES,
	type MealName,
	nowTime,
	parseConsumed,
	parseDiary,
	parseFoodSearch,
	parseGoals,
	toCronoDay,
	todayDate,
	validateDate,
} from "./lib/transforms.js";
import type { Env, Props } from "./types.js";

function macroLine(m: Macros): string {
	return `${m.calories} kcal · P ${m.protein}g · C ${m.carbs}g · F ${m.fat}g`;
}

type AgentState = {
	session: CronometerSession | null;
};

export class MyMCP extends McpAgent<Env, AgentState, Props> {
	server = new McpServer({
		name: "Cronometer",
		version: "1.0.0",
		title: "Cronometer Nutrition",
	});

	initialState: AgentState = { session: null };

	private getSessionStub() {
		return this.env.SESSION_STORE.get(
			this.env.SESSION_STORE.idFromName("default"),
		);
	}

	private async getSharedSession(): Promise<CronometerSession | null> {
		try {
			const res = await this.getSessionStub().fetch("http://internal/get");
			if (!res.ok) return null;
			return (await res.json()) as CronometerSession | null;
		} catch {
			return null;
		}
	}

	private saveSharedSession(session: CronometerSession): void {
		this.getSessionStub()
			.fetch("http://internal/set", {
				method: "POST",
				body: JSON.stringify(session),
			})
			.catch((err) => console.error("SessionStore write failed:", err));
	}

	/**
	 * Build a Cronometer client, reusing any cached session.
	 *
	 * Fast path (same MCP session): reads from this DO's SQLite state (no network).
	 * Cross-session path (new conversation): falls back to the SessionStore DO so
	 * we don't need a fresh Cronometer login on every new claude.ai conversation.
	 */
	private async getClient(): Promise<CronometerClient> {
		const email = this.env.CRONOMETER_EMAIL;
		const password = this.env.CRONOMETER_PASSWORD;
		if (!email || !password) {
			throw new Error(
				"Cronometer credentials are not configured. Set the CRONOMETER_EMAIL and CRONOMETER_PASSWORD secrets with `wrangler secret put`.",
			);
		}

		// Use this DO's persisted state (fast, no network hop).
		let session = this.state.session;

		// On a brand-new MCP session (state is empty), try the shared singleton store.
		if (!session) {
			session = await this.getSharedSession();
			if (session) {
				// Cache locally so subsequent calls in this session skip the network hop.
				this.setState({ session });
			}
		}

		return new CronometerClient({
			email,
			password,
			session,
			onSession: (s) => {
				this.setState({ session: s });   // sync: local SQLite
				this.saveSharedSession(s);        // async fire-and-forget: shared store
			},
		});
	}

	async init() {
		// ============================================
		// READ — DIARY (per-day food log + daily totals)
		// ============================================
		this.server.tool(
			"get_nutrition_diary",
			{
				date: z
					.string()
					.optional()
					.describe("Date in YYYY-MM-DD format. Defaults to today."),
			},
			async ({ date }) => {
				try {
					const d = date ?? todayDate();
					validateDate(d, "date");
					const cronoDay = toCronoDay(d);

					const client = await this.getClient();
					const diaryRaw = await client.getDiary(cronoDay);

					const entries = parseDiary(diaryRaw);
					const totals = parseConsumed(diaryRaw);

					// Resolve real food names via get_food for each unique foodId.
					const nameById = new Map<number, string>();
					const uniqueIds = [
						...new Set(
							entries
								.map((e) => e.foodId)
								.filter((id): id is number => typeof id === "number"),
						),
					].slice(0, 30);
					await Promise.all(
						uniqueIds.map(async (id) => {
							try {
								const food = await client.getFood(id);
								if (food?.name) nameById.set(id, String(food.name));
							} catch {
								/* leave unresolved — falls back to the parsed name */
							}
						}),
					);

					const list =
						entries.length > 0
							? entries
									.map((e) => {
										const name =
											(e.foodId != null && nameById.get(e.foodId)) || e.name;
										const grams = e.grams != null ? ` — ${e.grams} g` : "";
										const meal =
											e.mealGroup != null && MEAL_NAMES[e.mealGroup]
												? ` [${MEAL_NAMES[e.mealGroup]}]`
												: "";
										const sid =
											e.servingId != null
												? ` [serving_id: ${e.servingId}]`
												: "";
										return `   - ${name}${grams}${meal}${sid}`;
									})
									.join("\n")
							: "No food logged for this date.";

					return {
						content: [
							{
								type: "text",
								text: `Nutrition diary for ${d}\nDaily totals: ${macroLine(totals)}`,
							},
							{ type: "text", text: `Logged foods:\n${list}` },
							{
								type: "text",
								text: `\n\nRaw diary:\n${JSON.stringify(diaryRaw, null, 2)}`,
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			},
		);

		// ============================================
		// READ — SUMMARY OVER A RANGE
		// ============================================
		this.server.tool(
			"get_nutrition_summary",
			{
				start_date: z.string().describe("Start date (YYYY-MM-DD), inclusive."),
				end_date: z.string().describe("End date (YYYY-MM-DD), inclusive."),
			},
			async ({ start_date, end_date }) => {
				try {
					validateDate(start_date, "start_date");
					validateDate(end_date, "end_date");

					const dates = enumerateDates(start_date, end_date, 31);
					const client = await this.getClient();

					const daily: Array<{ date: string } & Macros> = [];
					for (const d of dates) {
						const diaryRaw = await client.getDiary(toCronoDay(d));
						const m = parseConsumed(diaryRaw);
						daily.push({ date: d, ...m });
					}

					const overall = averageMacros(daily);
					const last7 = averageMacros(daily.slice(-7));

					const rows = daily.map((d) => `${d.date}: ${macroLine(d)}`).join("\n");

					return {
						content: [
							{
								type: "text",
								text: `Nutrition summary ${start_date} → ${end_date} (${daily.length} days)`,
							},
							{
								type: "text",
								text: `Average over range: ${macroLine(overall)}\n7-day average (most recent): ${macroLine(last7)}`,
							},
							{ type: "text", text: `Daily totals:\n${rows}` },
							{ type: "text", text: `\n\nRaw daily data:\n${JSON.stringify(daily, null, 2)}` },
						],
					};
				} catch (error) {
					return handleError(error);
				}
			},
		);

		// ============================================
		// READ — GOALS (macro targets)
		// ============================================
		this.server.tool("get_goals", {}, async () => {
			try {
				const client = await this.getClient();
				const diaryRaw = await client.getDiary(toCronoDay(todayDate()));
				const { goals, raw } = parseGoals(diaryRaw);

				return {
					content: [
						{
							type: "text",
							text: `Daily goals\nCalories: ${goals.calories} kcal\nProtein: ${goals.protein} g\nCarbs: ${goals.carbs} g\nFat: ${goals.fat} g`,
						},
						{ type: "text", text: `\n\nRaw summary:\n${JSON.stringify(raw, null, 2)}` },
					],
				};
			} catch (error) {
				return handleError(error);
			}
		});

		// ============================================
		// READ — NUTRITION SCORES
		// ============================================
		this.server.tool(
			"get_nutrition_scores",
			{
				date: z
					.string()
					.optional()
					.describe("Date in YYYY-MM-DD format. Defaults to today."),
			},
			async ({ date }) => {
				try {
					const d = date ?? todayDate();
					validateDate(d, "date");
					const client = await this.getClient();
					const raw = await client.getNutritionScores(toCronoDay(d));

					return {
						content: [
							{
								type: "text",
								text: `Nutrition quality scores for ${d}`,
							},
							{
								type: "text",
								text: `\n\nRaw scores:\n${JSON.stringify(raw, null, 2)}`,
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			},
		);

		// ============================================
		// READ — FOOD SEARCH
		// ============================================
		this.server.tool(
			"search_food",
			{
				query: z.string().describe("Food to search for, e.g. 'chicken breast'."),
				max_results: z
					.number()
					.int()
					.min(1)
					.max(20)
					.optional()
					.default(5)
					.describe("Maximum number of results (default 5, max 20)."),
			},
			async ({ query, max_results }) => {
				try {
					const client = await this.getClient();
					const raw = await client.searchFood(query);
					const results = parseFoodSearch(raw).slice(0, max_results);

					const list =
						results.length > 0
							? results
									.map((r, i) => {
										const src = r.source ? ` [${r.source}]` : "";
										const ids =
											`\n   food_id: ${r.id ?? "?"}` +
											(r.measureId != null ? `, measure_id: ${r.measureId}` : "");
										return `${i + 1}. ${r.name}${src}${ids}`;
									})
									.join("\n")
							: "No foods found (see raw response).";

					return {
						content: [
							{ type: "text", text: `Search results for "${query}"` },
							{ type: "text", text: list },
							{ type: "text", text: `\n\nRaw API response:\n${JSON.stringify(raw, null, 2)}` },
						],
					};
				} catch (error) {
					return handleError(error);
				}
			},
		);

		// ============================================
		// WRITE — LOG FOOD (add a serving to the diary)
		// ============================================
		this.server.tool(
			"log_food",
			{
				meal_name: z
					.enum(["breakfast", "lunch", "dinner", "snacks"])
					.describe("Which meal to log under."),
				food_id: z
					.number()
					.int()
					.describe("Cronometer food_id (from search_food)."),
				grams: z
					.number()
					.positive()
					.describe("Amount in grams to log."),
				measure_id: z
					.number()
					.int()
					.optional()
					.describe(
						"Measure/unit id (from search_food). Required for database foods; 0 is only valid for custom foods.",
					),
				date: z
					.string()
					.optional()
					.describe("Date in YYYY-MM-DD format. Defaults to today."),
			},
			async ({ meal_name, food_id, grams, measure_id, date }) => {
				try {
					const d = date ?? todayDate();
					validateDate(d, "date");

					const client = await this.getClient();

					let resolvedMeasureId = measure_id;
					if (resolvedMeasureId == null) {
						const food = await client.getFood(food_id);
						resolvedMeasureId =
							food?.defaultMeasureId ??
							food?.measures?.[0]?.id ??
							0;
					}

					const raw = await client.addServing({
						foodId: food_id,
						measureId: resolvedMeasureId ?? 0,
						grams,
						day: toCronoDay(d),
						time: nowTime(),
						mealGroup: MEAL_GROUPS[meal_name as MealName],
					});

					return {
						content: [
							{
								type: "text",
								text: `✓ Logged ${grams} g of food ${food_id} to ${meal_name} on ${d}.`,
							},
							{ type: "text", text: `\n\nRaw API response:\n${JSON.stringify(raw, null, 2)}` },
						],
					};
				} catch (error) {
					return handleError(error);
				}
			},
		);

		// ============================================
		// WRITE — DELETE FOOD (remove diary entries)
		// ============================================
		this.server.tool(
			"delete_food",
			{
				serving_ids: z
					.array(z.union([z.string(), z.number()]))
					.min(1)
					.describe(
						"One or more serving_id values to delete. Get these from get_nutrition_diary.",
					),
				date: z
					.string()
					.optional()
					.describe("Date the entries are on (YYYY-MM-DD). Defaults to today."),
			},
			async ({ serving_ids, date }) => {
				try {
					const d = date ?? todayDate();
					validateDate(d, "date");
					const client = await this.getClient();
					const count = await client.deleteServings(toCronoDay(d), serving_ids);
					return {
						content: [
							{
								type: "text",
								text:
									count > 0
										? `✓ Deleted ${count} serving(s) from ${d}.`
										: `No matching servings found on ${d}. Check the serving_ids from get_nutrition_diary.`,
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			},
		);

		// ============================================
		// WRITE — UPDATE FOOD (change amount or meal)
		// ============================================
		this.server.tool(
			"update_food",
			{
				serving_id: z
					.union([z.string(), z.number()])
					.describe(
						"serving_id of the entry to update. Get this from get_nutrition_diary.",
					),
				grams: z
					.number()
					.positive()
					.optional()
					.describe("New amount in grams."),
				meal_name: z
					.enum(["breakfast", "lunch", "dinner", "snacks"])
					.optional()
					.describe("Move the entry to a different meal."),
				date: z
					.string()
					.optional()
					.describe("Date the entry is on (YYYY-MM-DD). Defaults to today."),
			},
			async ({ serving_id, grams, meal_name, date }) => {
				try {
					const d = date ?? todayDate();
					validateDate(d, "date");
					if (grams == null && meal_name == null) {
						return {
							content: [
								{
									type: "text",
									text: "Provide at least one of: grams, meal_name.",
								},
							],
						};
					}
					const client = await this.getClient();
					const mealGroup =
						meal_name != null ? MEAL_GROUPS[meal_name as MealName] : undefined;
					const raw = await client.updateServing({
						day: toCronoDay(d),
						servingId: serving_id,
						grams,
						mealGroup,
					});
					const parts: string[] = [];
					if (grams != null) parts.push(`${grams} g`);
					if (meal_name != null) parts.push(`moved to ${meal_name}`);
					return {
						content: [
							{
								type: "text",
								text: `✓ Updated serving ${serving_id} on ${d}: ${parts.join(", ")}.`,
							},
							{ type: "text", text: `\n\nRaw API response:\n${JSON.stringify(raw, null, 2)}` },
						],
					};
				} catch (error) {
					return handleError(error);
				}
			},
		);

		// ============================================
		// WRITE — COPY DAY (duplicate diary to another day)
		// ============================================
		this.server.tool(
			"copy_day",
			{
				from_date: z
					.string()
					.optional()
					.describe(
						"Date to copy FROM (YYYY-MM-DD). Defaults to yesterday.",
					),
				to_date: z
					.string()
					.optional()
					.describe("Date to copy TO (YYYY-MM-DD). Defaults to today."),
			},
			async ({ from_date, to_date }) => {
				try {
					// Default: yesterday → today
					const today = todayDate();
					const yesterday = new Date(Date.now() - 86_400_000)
						.toISOString()
						.slice(0, 10);
					const toD = to_date ?? today;
					const fromD = from_date ?? yesterday;
					validateDate(fromD, "from_date");
					validateDate(toD, "to_date");

					const client = await this.getClient();
					const raw = await client.copyDay(toCronoDay(fromD), toCronoDay(toD));

					return {
						content: [
							{
								type: "text",
								text: `✓ Copied diary entries from ${fromD} to ${toD}.`,
							},
							{ type: "text", text: `\n\nRaw API response:\n${JSON.stringify(raw, null, 2)}` },
						],
					};
				} catch (error) {
					return handleError(error);
				}
			},
		);

		// ============================================
		// WRITE — MARK DAY COMPLETE
		// ============================================
		this.server.tool(
			"mark_day_complete",
			{
				date: z
					.string()
					.optional()
					.describe("Date in YYYY-MM-DD format. Defaults to today."),
				complete: z
					.boolean()
					.optional()
					.default(true)
					.describe("true = mark complete, false = mark incomplete."),
			},
			async ({ date, complete }) => {
				try {
					const d = date ?? todayDate();
					validateDate(d, "date");
					const client = await this.getClient();
					const raw = await client.setDayComplete(toCronoDay(d), complete ?? true);
					const status = (complete ?? true) ? "complete" : "incomplete";
					return {
						content: [
							{ type: "text", text: `✓ Marked ${d} as ${status}.` },
							{ type: "text", text: `\n\nRaw API response:\n${JSON.stringify(raw, null, 2)}` },
						],
					};
				} catch (error) {
					return handleError(error);
				}
			},
		);

		// ============================================
		// WRITE — CREATE CUSTOM FOOD
		// ============================================
		this.server.tool(
			"create_custom_food",
			{
				name: z.string().describe("Food name (e.g. 'My Protein Bar')."),
				calories: z.number().nonnegative().describe("Calories per serving."),
				protein_g: z.number().nonnegative().describe("Protein in grams per serving."),
				fat_g: z.number().nonnegative().describe("Fat in grams per serving."),
				carbs_g: z.number().nonnegative().describe("Carbohydrates in grams per serving."),
				fiber_g: z
					.number()
					.nonnegative()
					.optional()
					.default(0)
					.describe("Fiber in grams per serving (default 0)."),
				sugar_g: z
					.number()
					.nonnegative()
					.optional()
					.default(0)
					.describe("Sugar in grams per serving (default 0)."),
				sodium_mg: z
					.number()
					.nonnegative()
					.optional()
					.default(0)
					.describe("Sodium in milligrams per serving (default 0)."),
				serving_name: z
					.string()
					.optional()
					.default("1 serving")
					.describe("Display name for the serving (default '1 serving')."),
				serving_grams: z
					.number()
					.positive()
					.optional()
					.default(100)
					.describe("Weight of one serving in grams (default 100)."),
			},
			async ({
				name,
				calories,
				protein_g,
				fat_g,
				carbs_g,
				fiber_g,
				sugar_g,
				sodium_mg,
				serving_name,
				serving_grams,
			}) => {
				try {
					const client = await this.getClient();
					const result = await client.createCustomFood({
						name,
						calories,
						protein_g,
						fat_g,
						carbs_g,
						fiber_g,
						sugar_g,
						sodium_mg,
						serving_name,
						serving_grams,
					});
					return {
						content: [
							{
								type: "text",
								text:
									result.food_id != null
										? `✓ Created custom food "${name}" (food_id: ${result.food_id}). Use log_food with this food_id to add it to your diary.`
										: `Custom food "${name}" may have been created (no id returned — check search_food to confirm).`,
							},
						],
					};
				} catch (error) {
					return handleError(error);
				}
			},
		);

		// ============================================
		// READ — FASTING HISTORY
		// ============================================
		this.server.tool(
			"get_fasting_history",
			{
				start_date: z
					.string()
					.optional()
					.describe("Start date (YYYY-MM-DD). Defaults to 30 days ago."),
				end_date: z
					.string()
					.optional()
					.describe("End date (YYYY-MM-DD). Defaults to today."),
			},
			async ({ start_date, end_date }) => {
				try {
					const today = todayDate();
					const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000)
						.toISOString()
						.slice(0, 10);
					const end = end_date ?? today;
					const start = start_date ?? thirtyDaysAgo;
					validateDate(start, "start_date");
					validateDate(end, "end_date");

					const client = await this.getClient();
					const raw = await client.getFastingHistory(toCronoDay(start), toCronoDay(end));

					return {
						content: [
							{ type: "text", text: `Fasting history ${start} → ${end}` },
							{ type: "text", text: `\n\nRaw API response:\n${JSON.stringify(raw, null, 2)}` },
						],
					};
				} catch (error) {
					return handleError(error);
				}
			},
		);

		// ============================================
		// READ — FASTING STATS
		// ============================================
		this.server.tool("get_fasting_stats", {}, async () => {
			try {
				const client = await this.getClient();
				const raw = await client.getFastingStats();

				return {
					content: [
						{ type: "text", text: "Overall fasting statistics" },
						{ type: "text", text: `\n\nRaw API response:\n${JSON.stringify(raw, null, 2)}` },
					],
				};
			} catch (error) {
				return handleError(error);
			}
		});
	}
}
