import { Hono } from "hono";
import type { Env, Variables } from "../types.js";
import { CronometerClient } from "../lib/client.js";
import { TOOL_CATALOG, TOOL_COUNT, TOOL_NAMES } from "../lib/tool-catalog.js";

const utilityRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * Health check.
 *
 * Reports whether credentials are configured, the tool manifest, and — with
 * ?verify=1 — whether a live Cronometer login succeeds. Tool names come from the
 * same TOOL_CATALOG that mcp-agent.ts registers from, so this cannot drift from
 * what the Durable Object actually exposes. Pass ?verbose=1 for descriptions.
 */
utilityRoutes.get("/health", async (c) => {
	const hasCreds = !!(c.env.CRONOMETER_EMAIL && c.env.CRONOMETER_PASSWORD);
	let loginOk: boolean | undefined;
	let loginError: string | undefined;

	if (hasCreds && c.req.query("verify") === "1") {
		try {
			const client = new CronometerClient({
				email: c.env.CRONOMETER_EMAIL,
				password: c.env.CRONOMETER_PASSWORD,
			});
			await client.verifyAuth();
			loginOk = true;
		} catch (error) {
			loginOk = false;
			loginError = error instanceof Error ? error.message : "Unknown error";
		}
	}

	return c.json({
		status: "healthy",
		transport: "streamable-http",
		version: "1.0.0",
		auth: "static-bearer",
		credentials_configured: hasCreds,
		tool_count: TOOL_COUNT,
		tools: TOOL_NAMES,
		...(c.req.query("verbose") === "1" ? { tool_descriptions: TOOL_CATALOG } : {}),
		...(loginOk !== undefined ? { login_ok: loginOk } : {}),
		...(loginError ? { login_error: loginError } : {}),
	});
});

const PAGE_STYLE = `
	* { margin: 0; padding: 0; box-sizing: border-box; }
	body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
		line-height: 1.6; color: #1e293b; background: #f1f5f9; padding: 2rem; }
	.container { max-width: 720px; margin: 0 auto; background: #fff; border-radius: 14px;
		box-shadow: 0 10px 30px rgba(0,0,0,0.12); overflow: hidden; }
	.header { background: linear-gradient(135deg, #16a34a 0%, #059669 100%); color: #fff;
		padding: 2rem; }
	.header h1 { font-size: 1.8rem; }
	.body { padding: 2rem; }
	code { background: #f1f5f9; padding: 0.1rem 0.35rem; border-radius: 4px; font-size: 0.85rem; }
	pre { background: #0f172a; color: #e2e8f0; padding: 1rem; border-radius: 8px; overflow-x: auto;
		font-size: 0.82rem; margin: 0.6rem 0; }
	ol { margin: 0.5rem 0 0 1.2rem; } ol li { margin-bottom: 0.4rem; }
	.note { background: #dcfce7; border: 1px solid #86efac; border-radius: 8px; padding: 0.8rem 1rem;
		margin-top: 1rem; font-size: 0.9rem; }
	a { color: #059669; }
`;

// Home page
utilityRoutes.get("/", (c) => {
	return c.html(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Cronometer MCP Server</title><style>${PAGE_STYLE}</style></head>
<body><div class="container">
	<div class="header"><h1>Cronometer MCP Server</h1>
		<p>Read and log your Cronometer nutrition data from Claude.</p></div>
	<div class="body">
		<p>This is a personal, single-user MCP server. Configuration is done with
			Cloudflare secrets — there is no web setup form (your password never
			passes through a browser form).</p>
		<ol>
			<li>Set your Cronometer login as Worker secrets:
				<pre>wrangler secret put CRONOMETER_EMAIL
wrangler secret put CRONOMETER_PASSWORD</pre></li>
			<li>Set the bearer token Claude must send:
				<pre>wrangler secret put MCP_AUTH_TOKEN</pre></li>
			<li>Verify it works: <a href="/health?verify=1">/health?verify=1</a></li>
			<li>Add this server to Claude with your bearer token (see README).</li>
		</ol>
		<div class="note"><strong>Read:</strong> <code>get_nutrition_diary</code>, <code>get_nutrition_summary</code>,
			<code>get_goals</code>, <code>get_nutrition_scores</code>, <code>search_food</code>,
			<code>get_fasting_history</code>, <code>get_fasting_stats</code><br>
			<strong>Write:</strong> <code>log_food</code>, <code>delete_food</code>, <code>update_food</code>,
			<code>copy_day</code>, <code>mark_day_complete</code>, <code>create_custom_food</code></div>
		<p style="margin-top:1rem"><a href="/health">Health check</a></p>
	</div>
</div></body></html>`);
});

export default utilityRoutes;
