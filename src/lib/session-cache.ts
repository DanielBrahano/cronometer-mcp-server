/**
 * Worker-side access to the shared Cronometer session.
 *
 * The session lives in the SessionStore Durable Object under a single fixed name,
 * so every caller — each per-conversation MCP Durable Object, and the Worker's own
 * routes — reads and writes the same record. Without this, a new MCP session (a new
 * claude.ai conversation gets a fresh Durable Object with empty state) would have to
 * log in again, and a burst of those logins is what trips Cronometer's limiter.
 */

import type { CronometerSession } from "./client.js";
import type { Env } from "../types.js";

function stub(env: Env) {
	return env.SESSION_STORE.get(env.SESSION_STORE.idFromName("default"));
}

/** Read the shared session, or null when none is cached or the store is unreachable. */
export async function readSharedSession(
	env: Env,
): Promise<CronometerSession | null> {
	try {
		const res = await stub(env).fetch("http://internal/get");
		if (!res.ok) {
			return null;
		}
		return (await res.json()) as CronometerSession | null;
	} catch {
		// A cache miss must never fail the caller — it just means a login is needed.
		return null;
	}
}

/**
 * Persist a newly minted session for every other caller to reuse.
 *
 * Returns the in-flight promise so a caller that can wait (the Worker) may await
 * it; callers in a synchronous callback can let it settle on its own.
 */
export function writeSharedSession(
	env: Env,
	session: CronometerSession,
): Promise<void> {
	return stub(env)
		.fetch("http://internal/set", {
			method: "POST",
			body: JSON.stringify(session),
		})
		.then(() => undefined)
		.catch((err) => {
			console.error("SessionStore write failed:", err);
		});
}
