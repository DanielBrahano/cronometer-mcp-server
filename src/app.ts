import { Hono } from "hono";
import type { Env, Variables } from "./types.js";
import { createMcpRoutes } from "./routes/mcp.js";
import utilityRoutes from "./routes/utility.js";
import oauthRoutes from "./routes/oauth.js";
import { mcpHandlers } from "./mcp-handlers.js";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Global CORS
app.use("*", async (c, next) => {
	if (c.req.method === "OPTIONS") {
		return new Response(null, {
			status: 204,
			headers: {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
				"Access-Control-Allow-Headers": "Content-Type, Authorization",
				"Access-Control-Max-Age": "86400",
			},
		});
	}

	await next();

	c.res.headers.set("Access-Control-Allow-Origin", "*");
	c.res.headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
	c.res.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
});

app.onError((err, c) => {
	console.error("Unhandled error:", err);
	return c.json({ error: "internal_server_error", message: "An unexpected error occurred" }, 500);
});

// Mount routes (OAuth before MCP so metadata endpoints are unauthenticated)
app.route("/", oauthRoutes);
app.route("/", createMcpRoutes(mcpHandlers));
app.route("/", utilityRoutes);

app.notFound((c) => c.text("Not found", 404));

export default app;
