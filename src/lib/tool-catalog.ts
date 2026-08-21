/**
 * Single source of truth for tool names and descriptions.
 *
 * Both `MyMCP.init()` (which registers the tools inside the Durable Object) and
 * the `/health` route (which runs in the Worker and cannot see the DO's registry)
 * read from this object, so the health endpoint can never drift from what is
 * actually registered.
 *
 * Registering a tool whose name is not a key here is a compile-time error,
 * because `init()` passes `TOOL_CATALOG.<name>` as the description argument.
 * A runtime parity test asserts the reverse direction.
 *
 * A remote MCP client ranks and filters tools primarily on this text, so each
 * description says what the tool does, when to reach for it, and what comes back.
 */
export const TOOL_CATALOG = {
	// ============================================
	// READ — DIARY AND TOTALS
	// ============================================
	get_nutrition_diary:
		"Return everything eaten on one day: each logged food with its meal, serving_id, amount and calories, plus the day's consumed totals for calories, protein, carbs and fat. Use for 'what did I eat today', 'how many calories so far', 'what's in my lunch'. The serving_id on each entry is what delete_food and update_food need. Defaults to today.",

	get_nutrition_summary:
		"Return calorie and macro totals across a date range, with per-day figures and the average across the range. Use for multi-day questions: 'what did I average last week', 'how have my calories looked this month', 'am I hitting protein consistently'. For a single day's individual food entries use get_nutrition_diary.",

	get_goals:
		"Return the daily nutrition targets set in Cronometer — calorie goal plus protein, carb and fat targets in grams. Use to answer 'what are my macros', or as the denominator when reporting how much of the day's budget is left.",

	get_nutrition_scores:
		"Return Cronometer's nutrient-quality scoring for a day — how well micronutrient and macronutrient targets were met, beyond raw calories. Use for diet-quality questions: 'how balanced was my day', 'what nutrients am I short on'. Defaults to today.",

	// ============================================
	// READ — FOOD DATABASE
	// ============================================
	search_food:
		"Search the Cronometer food database by name and return matching foods with their food_id, measure_id and source. Use to resolve a food the user names in plain language into the food_id and measure_id that log_food requires. Always search before logging an unfamiliar food.",

	// ============================================
	// WRITE — DIARY ENTRIES
	// ============================================
	log_food:
		"Add a food to the diary for a given meal and date, in grams. Use when the user says they ate something. Requires a food_id from search_food, and a measure_id for database foods. Returns the updated day so the new totals are visible immediately.",

	delete_food:
		"Remove one or more logged entries from the diary by serving_id. Use when the user says they did not eat something, logged it twice, or wants a day cleared. Get serving_id values from get_nutrition_diary first.",

	update_food:
		"Change an already-logged diary entry — adjust the amount in grams, or move it to a different meal. Use for 'I actually had 200g not 150g' or 'that was lunch, not dinner'. Needs the entry's serving_id from get_nutrition_diary.",

	copy_day:
		"Copy every food entry from one date onto another date. Use when the user ate the same thing as a previous day and wants it duplicated rather than re-logged item by item. Defaults to copying yesterday onto today.",

	mark_day_complete:
		"Mark a day's diary as complete, or reopen it by passing complete: false. Completing a day is what makes Cronometer finalise it for streaks and trend reporting. Defaults to marking today complete.",

	create_custom_food:
		"Create a custom food in the Cronometer account from its nutrition label — name, calories and macros per serving, with optional fiber, sugar and sodium. Use for homemade recipes or products missing from the database. Returns the new food_id, which log_food can then use.",

	// ============================================
	// READ — FASTING
	// ============================================
	get_fasting_history:
		"Return individual fasting periods over a date range, each with its start, end and duration. Use for 'how long did I fast yesterday', 'show my fasting windows this month'. Defaults to the last 30 days.",

	get_fasting_stats:
		"Return aggregate fasting statistics for the account — longest fast, current and longest streak, and averages. Use for overall fasting-habit questions rather than individual fasting windows.",
} as const;

/** Every registered tool name, derived from the catalog. */
export type ToolName = keyof typeof TOOL_CATALOG;

/** Tool names in registration order. */
export const TOOL_NAMES = Object.keys(TOOL_CATALOG) as ToolName[];

/** Number of tools the server registers. */
export const TOOL_COUNT = TOOL_NAMES.length;
