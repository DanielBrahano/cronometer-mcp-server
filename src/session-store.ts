import type { CronometerSession } from "./lib/client.js";

/**
 * Fixed-name Durable Object that holds the Cronometer session key across ALL
 * MCP sessions.  Each new claude.ai conversation creates a fresh per-session DO
 * (random name), so Agent.setState() alone is not enough — those per-session
 * DOs have no prior state.  This singleton (idFromName("default")) gives every
 * per-session DO a place to read and write a shared session on first request.
 */
export class SessionStore {
	ctx: DurableObjectState;

	constructor(ctx: DurableObjectState) {
		this.ctx = ctx;
	}

	async fetch(req: Request): Promise<Response> {
		const url = new URL(req.url);

		if (url.pathname === "/get") {
			const session = await this.ctx.storage.get<CronometerSession>("session");
			return Response.json(session ?? null);
		}

		if (url.pathname === "/set" && req.method === "POST") {
			const session = (await req.json()) as CronometerSession;
			await this.ctx.storage.put("session", session);
			return new Response(null, { status: 204 });
		}

		return new Response("Not found", { status: 404 });
	}
}
