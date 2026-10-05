/**
 * Validation and nutrition-parsing helpers for the Cronometer mobile API.
 *
 * The mobile API's JSON response shapes are reverse-engineered, so the parsers
 * are intentionally defensive: they accept several field-name / structure
 * variants and coerce values rather than assuming one rigid schema. Every tool
 * also returns the raw API JSON, so data is usable even if a field differs.
 */

import { NUTRIENT_IDS } from "./client.js";

export class ValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ValidationError";
	}
}

/** Macro totals used throughout the tools. */
export interface Macros {
	calories: number;
	protein: number;
	carbs: number;
	fat: number;
}

/** Cronometer meal groups. */
export const MEAL_GROUPS = {
	breakfast: 1,
	lunch: 2,
	dinner: 3,
	snacks: 4,
} as const;

export type MealName = keyof typeof MEAL_GROUPS;

/** Reverse map: meal group number → name (for display). */
export const MEAL_NAMES: Record<number, string> = {
	1: "breakfast",
	2: "lunch",
	3: "dinner",
	4: "snacks",
};

/** Today's date in YYYY-MM-DD (UTC). */
export function todayDate(): string {
	return new Date().toISOString().slice(0, 10);
}

/** Validate a YYYY-MM-DD date string. */
export function validateDate(date: string, fieldName: string): void {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		throw new ValidationError(
			`${fieldName} must be in YYYY-MM-DD format (e.g., 2026-05-26), got "${date}"`,
		);
	}
	const parsed = new Date(`${date}T00:00:00Z`);
	if (Number.isNaN(parsed.getTime())) {
		throw new ValidationError(`${fieldName} is not a valid date: "${date}"`);
	}
}

/**
 * Convert YYYY-MM-DD to Cronometer's non-zero-padded YYYY-M-D format.
 * e.g. "2026-05-06" → "2026-5-6".
 */
export function toCronoDay(date: string): string {
	const [y, m, d] = date.split("-");
	return `${Number(y)}-${Number(m)}-${Number(d)}`;
}

/** Current local-ish time as H:M:S (used when logging a serving). */
export function nowTime(): string {
	const now = new Date();
	return `${now.getUTCHours()}:${now.getUTCMinutes()}:${now.getUTCSeconds()}`;
}

/** Coerce a value that may be a number, numeric string, or { value/amount }. */
function num(value: unknown): number {
	if (value == null) {
		return 0;
	}
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : 0;
	}
	if (typeof value === "string") {
		const n = Number.parseFloat(value);
		return Number.isFinite(n) ? n : 0;
	}
	if (typeof value === "object") {
		const v = value as Record<string, unknown>;
		return num(v.amount ?? v.value);
	}
	return 0;
}

/** Round a macro block for display: whole kcal, one decimal on grams. */
export function roundMacros(m: Macros): Macros {
	return round(m);
}

function round(m: Macros): Macros {
	return {
		calories: Math.round(m.calories),
		protein: Math.round(m.protein * 10) / 10,
		carbs: Math.round(m.carbs * 10) / 10,
		fat: Math.round(m.fat * 10) / 10,
	};
}

function addMacros(a: Macros, b: Macros): Macros {
	return {
		calories: a.calories + b.calories,
		protein: a.protein + b.protein,
		carbs: a.carbs + b.carbs,
		fat: a.fat + b.fat,
	};
}

/**
 * Daily consumed macro totals, read from a get_diary response's
 * `summary.consumed` block: { total (kcal), protein_g, carbs_g, fat_g }.
 */
export function parseConsumed(diaryResponse: any): Macros {
	const c = diaryResponse?.summary?.consumed ?? {};
	return round({
		calories: num(c.total ?? c.energy_kcal ?? c.kcal),
		protein: num(c.protein_g),
		carbs: num(c.carbs_g),
		fat: num(c.fat_g),
	});
}

export interface DiaryEntry {
	name: string;
	servingId?: string | number;
	foodId?: number;
	grams?: number;
	mealGroup?: number;
	/** Measure the entry was logged against (0 when logged by raw grams). */
	measureId?: number;
}

/**
 * Per-100g macros for a food, read from a get_food response.
 *
 * Cronometer stores every food's nutrients on a per-100g basis (the same basis
 * create_custom_food scales to when writing), so a logged entry's contribution
 * is these figures times grams/100.
 */
export interface FoodNutrients {
	caloriesPer100g: number;
	proteinPer100g: number;
	carbsPer100g: number;
	fatPer100g: number;
}

/**
 * Extract per-100g macros from a get_food response.
 *
 * The nutrients block is parsed defensively: the API returns an array of
 * `{ id, amount }`, but variants key the amounts by nutrient id instead.
 * Returns null when no nutrient data is present, so callers can degrade to
 * showing the entry without macros rather than reporting zeroes as fact.
 */
export function parseFoodNutrients(food: any): FoodNutrients | null {
	const raw = food?.nutrients;
	if (!raw) {
		return null;
	}

	const byId = new Map<number, number>();
	if (Array.isArray(raw)) {
		for (const n of raw) {
			const id = Number(n?.id);
			if (Number.isFinite(id)) {
				byId.set(id, num(n?.amount ?? n?.value));
			}
		}
	} else if (typeof raw === "object") {
		for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
			const id = Number(key);
			if (Number.isFinite(id)) {
				byId.set(id, num(value));
			}
		}
	}

	if (byId.size === 0) {
		return null;
	}

	return {
		caloriesPer100g: byId.get(NUTRIENT_IDS.energy) ?? 0,
		proteinPer100g: byId.get(NUTRIENT_IDS.protein) ?? 0,
		carbsPer100g: byId.get(NUTRIENT_IDS.carbs) ?? 0,
		fatPer100g: byId.get(NUTRIENT_IDS.fat) ?? 0,
	};
}

/** Per-100g macros as a Macros block (for reporting a food's density). */
export function nutrientsToMacros(n: FoodNutrients): Macros {
	return round({
		calories: n.caloriesPer100g,
		protein: n.proteinPer100g,
		carbs: n.carbsPer100g,
		fat: n.fatPer100g,
	});
}

/** Scale per-100g macros to the amount actually logged. */
export function scaleNutrients(n: FoodNutrients, grams: number): Macros {
	const factor = grams / 100;
	return round({
		calories: n.caloriesPer100g * factor,
		protein: n.proteinPer100g * factor,
		carbs: n.carbsPer100g * factor,
		fat: n.fatPer100g * factor,
	});
}

/**
 * Gram weight of a measure from its display name, e.g.
 * "1 piece - 140g" → 140, "4 oz - 112g" → 112, "1g" → 1.
 * find_food returns no gram field, but it encodes one in this label.
 */
export function parseMeasureGrams(displayName: unknown): number | undefined {
	if (typeof displayName !== "string") {
		return undefined;
	}
	const suffixed = displayName.match(/-\s*([\d.]+)\s*g\s*$/i);
	if (suffixed) {
		const grams = Number.parseFloat(suffixed[1]);
		return Number.isFinite(grams) ? grams : undefined;
	}
	const bare = displayName.match(/^\s*([\d.]+)\s*g\s*$/i);
	if (bare) {
		const grams = Number.parseFloat(bare[1]);
		return Number.isFinite(grams) ? grams : undefined;
	}
	return undefined;
}

/** Gram weight of a specific measure id from a get_food response. */
export function measureGramsFromFood(
	food: any,
	measureId: number | undefined,
): number | undefined {
	const measures: any[] = Array.isArray(food?.measures) ? food.measures : [];
	if (measures.length === 0) {
		return undefined;
	}
	const match =
		measureId != null
			? measures.find((m) => Number(m?.id) === Number(measureId))
			: undefined;
	const chosen =
		match ??
		(food?.defaultMeasureId != null
			? measures.find((m) => Number(m?.id) === Number(food.defaultMeasureId))
			: undefined) ??
		measures[0];
	const grams = num(chosen?.value);
	return grams > 0 ? grams : undefined;
}

/** Parse a get_diary response into a compact list of logged entries. */
export function parseDiary(response: any): DiaryEntry[] {
	const items: any[] = Array.isArray(response?.diary)
		? response.diary
		: Array.isArray(response?.entries)
			? response.entries
			: Array.isArray(response)
				? response
				: [];

	return items
		.filter((e) => e && (e.type === undefined || e.type === "Serving"))
		.map((e) => ({
			name:
				e.foodName ??
				e.name ??
				e.description ??
				e.food?.name ??
				`Food ${e.foodId ?? "?"}`,
			servingId: e.servingId ?? e.id,
			foodId: e.foodId,
			grams: typeof e.grams === "number" ? e.grams : undefined,
			mealGroup: typeof e.order === "number" ? e.order >> 16 : undefined,
			measureId: typeof e.measureId === "number" ? e.measureId : undefined,
		}));
}

export interface FoodResult {
	id?: number;
	name: string;
	measureId?: number;
	translationId?: number;
	source?: string;
	/** Gram weight of this result's measure, when the API encodes one. */
	measureGrams?: number;
	/** Human label for the measure, e.g. "1 piece - 140g". */
	measureName?: string;
	/** Per-100g macros. Only set once food details have been resolved. */
	per100g?: Macros;
}

/** Parse a find_food response into a compact result list. */
export function parseFoodSearch(response: any): FoodResult[] {
	const foods: any[] = Array.isArray(response?.foods)
		? response.foods
		: Array.isArray(response?.results)
			? response.results
			: Array.isArray(response)
				? response
				: [];

	return foods.map((f) => ({
		id: f.id ?? f.foodId,
		name: f.name ?? f.description ?? f.measureDisplayName ?? "Unknown food",
		measureId: f.measureId ?? f.measure_id,
		translationId: f.translationId ?? f.translation_id ?? 0,
		source: f.source,
		measureName:
			typeof f.measureDisplayName === "string" ? f.measureDisplayName : undefined,
		measureGrams: parseMeasureGrams(f.measureDisplayName),
	}));
}

/**
 * Daily macro goal targets. Cronometer computes these into a get_diary
 * response's `summary.macros` block: { energy (kcal), protein, carbs, fat }
 * in grams. (The get_macro_target_templates endpoint returns only percentages
 * and is often empty, so the diary summary is the reliable source.)
 */
export function parseGoals(diaryResponse: any): { goals: Macros; raw: any } {
	const m = diaryResponse?.summary?.macros ?? {};
	return {
		goals: round({
			calories: num(m.energy ?? m.kcal),
			protein: num(m.protein),
			carbs: num(m.carbs ?? m.total_carbs ?? m.carbohydrates),
			fat: num(m.fat),
		}),
		raw: diaryResponse?.summary ?? diaryResponse,
	};
}

/** Average a list of macro totals. */
export function averageMacros(days: Macros[]): Macros {
	if (days.length === 0) {
		return { calories: 0, protein: 0, carbs: 0, fat: 0 };
	}
	let sum: Macros = { calories: 0, protein: 0, carbs: 0, fat: 0 };
	for (const d of days) {
		sum = addMacros(sum, d);
	}
	return round({
		calories: sum.calories / days.length,
		protein: sum.protein / days.length,
		carbs: sum.carbs / days.length,
		fat: sum.fat / days.length,
	});
}

/**
 * Inclusive list of YYYY-MM-DD dates from start to end. Throws if the range is
 * reversed or exceeds maxDays.
 */
export function enumerateDates(start: string, end: string, maxDays = 31): string[] {
	const startMs = Date.parse(`${start}T00:00:00Z`);
	const endMs = Date.parse(`${end}T00:00:00Z`);
	if (endMs < startMs) {
		throw new ValidationError("end_date must be on or after start_date");
	}
	const dayMs = 86_400_000;
	const count = Math.floor((endMs - startMs) / dayMs) + 1;
	if (count > maxDays) {
		throw new ValidationError(
			`Date range too large: ${count} days (max ${maxDays}). Narrow start_date/end_date.`,
		);
	}
	const dates: string[] = [];
	for (let i = 0; i < count; i++) {
		dates.push(new Date(startMs + i * dayMs).toISOString().slice(0, 10));
	}
	return dates;
}
